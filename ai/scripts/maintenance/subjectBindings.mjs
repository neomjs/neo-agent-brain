#!/usr/bin/env node
import Database  from 'better-sqlite3';
import {Command} from 'commander';
import fs        from 'node:fs';
import path      from 'node:path';

import {isEntryModule}                                 from '../../services/shared/isEntryModule.mjs';
import {readIdentityFoundingSourceInTransaction}       from '../../services/memory-core/helpers/identityFoundingStorage.mjs';
import {readIdentityPublicationAuthorityInTransaction} from '../../services/memory-core/helpers/identityPublicationLineage.mjs';
import {
    bindAdministratively,
    foundingSubjectMappings,
    planAdministrativeBind,
    readSubjectBindingRecords
} from '../../services/memory-core/helpers/subjectBinding.mjs';

/**
 * @module ai/scripts/maintenance/subjectBindings
 * @summary The plane-local administrative path for the subject-binding relation, and the only caller of
 * its administrative writer: no MCP tool, HTTP route or Fleet wire reaches it. Host access to the Memory
 * Core data root is its authority, so it runs on the plane host and nowhere else. `bind` and `seed` are
 * dry runs, on a read-only connection, unless `--apply` is given.
 *
 * ```
 * subjectBindings.mjs list --db-path <graph.sqlite>
 * subjectBindings.mjs bind --db-path <graph.sqlite> --auth-provider github
 *                          --provider-base-url https://api.github.com --provider-user-id <id> --identity <id> [--apply]
 * subjectBindings.mjs seed --db-path <graph.sqlite> [--apply]
 * ```
 *
 * A bind targets an identity the graph already holds: a new identity binds only at its first admission.
 * It records the retained founding source's revision, read under the lineage the plane is bound to now,
 * so a bind never rests on a revision its caller typed. An endpoint move (the same account at a new
 * `--provider-base-url`) keeps the identity, so its history stays reachable; any other conflict refuses
 * by name and writes nothing.
 *
 * `seed` binds what the retained founding record authorizes on its own: each subject it maps to exactly
 * one identity the graph holds. It names, and binds nothing for, a subject mapped to several identities
 * or to one the graph lacks. It only binds a free pair: an identity an administrative move placed
 * elsewhere is held, and a subject bound elsewhere refuses by name.
 */

const COMMANDS = Object.freeze(['list', 'bind', 'seed']);

/** @summary Builds a named refusal, the shape the relation's own refusals take. */
function refusal(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/** @summary Whether two paths name one existing file; a missing path never matches. */
function sameFile(a, b) {
    try {
        return typeof a === 'string' && typeof b === 'string' && fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
        return false;
    }
}

/** @summary Whether the graph holds `identityId` as an `AgentIdentity` node. */
function holdsIdentity(db, identityId) {
    const row = typeof identityId === 'string' ? db.prepare('SELECT data FROM Nodes WHERE id = ?').get(identityId) : null;
    let node = null;

    try {
        node = row && JSON.parse(row.data);
    } catch {}

    // Stored nodes carry their type as `label`; older rows as `type`, as the founding storage also reads them.
    return node?.label === 'AgentIdentity' || node?.type === 'AgentIdentity';
}

/** @summary Refuses an identity the graph does not hold. */
function requireIdentity(db, identityId) {
    if (!holdsIdentity(db, identityId)) {
        throw refusal('SUBJECT_BINDING_IDENTITY_UNKNOWN',
            `${identityId} is no identity this graph holds; a new identity binds only at its first admission.`);
    }
}

/**
 * @summary Reads the retained founding source, qualified the way identity admission qualifies it: the
 * plane is bound, and the source was installed by that lineage's issuer at its current head.
 * @returns {{foundingRevision: String, seed: Object}}
 * @throws {Error} `IDENTITY_FOUNDING_SOURCE_UNAVAILABLE`, or `SUBJECT_BINDING_FOUNDING_UNQUALIFIED`.
 */
function qualifiedFounding(db, bootText, target) {
    const
        authority = readIdentityPublicationAuthorityInTransaction(db, bootText, target),
        founding  = readIdentityFoundingSourceInTransaction(db, {target});

    if (authority.state !== 'bound' || founding.provenance.issuer !== authority.issuer ||
        founding.provenance.lineageHead !== authority.head) {
        throw refusal('SUBJECT_BINDING_FOUNDING_UNQUALIFIED',
            'The retained founding source is not qualified by the lineage this plane is bound to; an administrative bind rests on it.');
    }

    return {foundingRevision: founding.provenance.sourceRevision, seed: founding.seed};
}

/**
 * @summary Seeds the bindings the retained founding record authorizes on its own, inside the caller's
 * transaction: each subject mapped to exactly one held identity, and only where neither side is bound.
 * @returns {Object} `{foundingRevision, bound, matching, held, refused, unresolved}`.
 */
function seedFromFounding(db, {bootText, target, apply, now}) {
    const
        {foundingRevision, seed} = qualifiedFounding(db, bootText, target),
        outcome                  = {bound: [], matching: [], held: [], refused: [], unresolved: []};

    for (const {subject, identityIds} of foundingSubjectMappings(seed)) {
        const [identityId] = identityIds;

        if (identityIds.length > 1 || !holdsIdentity(db, identityId)) {
            outcome.unresolved.push({subject, identityIds, reason: identityIds.length > 1 ? 'several-identities' : 'identity-unknown'});
            continue;
        }

        try {
            const {state} = planAdministrativeBind(db, {subject, identityId});

            if (state === 'bound' && apply) {
                bindAdministratively(db, {subject, identityId, foundingRevision, at: now()});
            }
            outcome[state === 'moved' ? 'held' : state].push({subject, identityId});
        } catch (error) {
            if (!error.code?.startsWith('SUBJECT_BINDING_')) throw error;
            outcome.refused.push({subject, identityId, code: error.code});
        }
    }

    return {foundingRevision, ...outcome};
}

/**
 * @summary Runs one command against an explicit graph file. `bind` and `seed` decide inside one transaction,
 * on a read-only connection for a dry run, and decide again inside the write transaction when applied.
 * @param {Object}   options
 * @param {String}   options.dbPath                Explicit live graph SQLite path; must exist.
 * @param {String}   options.command               `list`, `bind` or `seed`.
 * @param {Object}   [options.subject]             `{authProvider, providerBaseUrl, providerUserId}`, for `bind`.
 * @param {String}   [options.identityId]          The existing identity to bind, for `bind`.
 * @param {Boolean}  [options.apply=false]         Write; otherwise report what would be written.
 * @param {String}   [options.bootText]            The plane's identity-publication boot descriptor, for `bind` and `seed`.
 * @param {Object}   [options.target]              The plane's `{planeId, dataRoot}`, for `bind` and `seed`.
 * @param {String}   [options.configuredGraphPath] The configured live graph; an applied write must target it.
 * @param {Function} [options.now=Date.now]
 * @returns {Object} `{ok, command, records}` for `list`; `{ok, command, applied, state, identityId, foundingRevision}`
 * for `bind`; `{ok, command, applied, foundingRevision, bound, matching, held, refused, unresolved}` for `seed`.
 * @throws {Error} A named refusal; nothing is written.
 */
export function runSubjectBindingAdmin({dbPath, command, subject, identityId, apply = false, bootText, target, configuredGraphPath, now = Date.now} = {}) {
    if (!COMMANDS.includes(command)) throw refusal('SUBJECT_BINDING_INVALID', `The command must be one of ${COMMANDS.join(', ')}.`);
    if (typeof dbPath !== 'string' || !dbPath.trim()) throw refusal('SUBJECT_BINDING_INVALID', 'The graph database path is explicit.');
    if (apply && !sameFile(dbPath, configuredGraphPath)) {
        throw refusal('SUBJECT_BINDING_TARGET_MISMATCH', 'An applied bind must target the configured live graph.');
    }

    const db = new Database(path.resolve(dbPath), {fileMustExist: true, readonly: !apply, timeout: 10000});

    try {
        if (command === 'list') return {ok: true, command, records: readSubjectBindingRecords(db)};

        if (command === 'seed') {
            const run     = () => seedFromFounding(db, {bootText, target, apply, now}),
                  outcome = apply ? db.transaction(run).immediate() : db.transaction(run).deferred();

            return {ok: outcome.refused.length === 0, command, applied: apply, ...outcome};
        }

        const decide = () => {
            requireIdentity(db, identityId);
            return {foundingRevision: qualifiedFounding(db, bootText, target).foundingRevision, plan: planAdministrativeBind(db, {subject, identityId})};
        };

        if (!apply) {
            const {foundingRevision, plan} = db.transaction(decide).deferred();
            return {ok: true, command, applied: false, state: plan.state, identityId, foundingRevision};
        }

        return db.transaction(() => {
            const {foundingRevision} = decide(),
                  {state}            = bindAdministratively(db, {subject, identityId, foundingRevision, at: now()});

            return {ok: true, command, applied: true, state, identityId, foundingRevision};
        }).immediate();
    } finally {
        db.close();
    }
}

/**
 * @summary Builds the CLI: a command, the mandatory `--db-path`, the subject and identity for `bind`, and `--apply`.
 * @returns {Command}
 */
export function createCommand() {
    return new Command('subjectBindings')
        .description('Bind provider subjects to existing identities on the plane host, one at a time or from the founding record. Dry run unless --apply.')
        .argument('<command>', COMMANDS.join(' | '))
        .requiredOption('--db-path <path>', 'live graph SQLite file (explicit, must exist)')
        .option('--auth-provider <provider>', 'the subject\'s forge, as admissions present it')
        .option('--provider-base-url <url>', 'the forge API base, as admissions present it')
        .option('--provider-user-id <id>', 'the forge account id, never its login')
        .option('--identity <id>', 'the existing AgentIdentity the subject acts as')
        .option('--apply', 'write the bind; without it the command reports what it would do', false);
}

/**
 * @summary Parses `argv` and runs the command; `bind` and `seed` read the plane's boot descriptor, target and
 * graph path from config.
 * @param {String[]} [argv=process.argv]
 * @returns {Promise<Object>}
 */
export async function runCli(argv = process.argv) {
    const
        program = createCommand().parse(argv),
        options = program.opts(),
        command = program.args[0];

    if (command !== 'bind' && command !== 'seed') return runSubjectBindingAdmin({dbPath: options.dbPath, command});

    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');
    const {default: aiConfig} = await import('../../mcp/server/memory-core/config.mjs');

    return runSubjectBindingAdmin({
        dbPath             : options.dbPath,
        command,
        subject            : {authProvider: options.authProvider, providerBaseUrl: options.providerBaseUrl, providerUserId: options.providerUserId},
        identityId         : options.identity,
        apply              : options.apply,
        bootText           : aiConfig.identityPublicationBoot,
        target             : {planeId: aiConfig.plane.id, dataRoot: aiConfig.plane.dataRoot},
        configuredGraphPath: aiConfig.storagePaths.graph
    });
}

if (isEntryModule(import.meta.url)) {
    runCli().then(result => console.log(JSON.stringify(result, null, 2)), error => {
        console.error(`[subjectBindings] ${error.code ? `${error.code}: ` : ''}${error.message}`);
        process.exit(1);
    });
}
