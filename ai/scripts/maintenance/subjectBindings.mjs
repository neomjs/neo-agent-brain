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
    planAdministrativeBind,
    readSubjectBindingRecords
} from '../../services/memory-core/helpers/subjectBinding.mjs';

/**
 * @module ai/scripts/maintenance/subjectBindings
 * @summary The plane-local administrative path for the subject-binding relation, and the only caller of
 * its administrative writer: no MCP tool, HTTP route or Fleet wire reaches it. Host access to the Memory
 * Core data root is its authority, so it runs on the plane host and nowhere else. A bind is a dry run,
 * on a read-only connection, unless `--apply` is given.
 *
 * ```
 * subjectBindings.mjs list --db-path <graph.sqlite>
 * subjectBindings.mjs bind --db-path <graph.sqlite> --auth-provider github
 *                          --provider-base-url https://api.github.com --provider-user-id <id> --identity <id> [--apply]
 * ```
 *
 * A bind targets an identity the graph already holds: a new identity binds only at its first admission.
 * It records the retained founding source's revision, read under the lineage the plane is bound to now,
 * so a bind never rests on a revision its caller typed. An endpoint move (the same account at a new
 * `--provider-base-url`) keeps the identity, so its history stays reachable; any other conflict refuses
 * by name and writes nothing.
 */

const COMMANDS = Object.freeze(['list', 'bind']);

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

/** @summary Refuses an identity the graph does not hold as an `AgentIdentity` node. */
function requireIdentity(db, identityId) {
    const row = typeof identityId === 'string' ? db.prepare('SELECT data FROM Nodes WHERE id = ?').get(identityId) : null;
    let node = null;

    try {
        node = row && JSON.parse(row.data);
    } catch {}

    // Stored nodes carry their type as `label`; older rows as `type`, as the founding storage also reads them.
    if (node?.label !== 'AgentIdentity' && node?.type !== 'AgentIdentity') {
        throw refusal('SUBJECT_BINDING_IDENTITY_UNKNOWN',
            `${identityId} is no identity this graph holds; a new identity binds only at its first admission.`);
    }
}

/**
 * @summary Reads the retained founding source revision, qualified the way identity admission qualifies
 * it: the plane is bound, and the source was installed by that lineage's issuer at its current head.
 * @returns {String}
 * @throws {Error} `IDENTITY_FOUNDING_SOURCE_UNAVAILABLE`, or `SUBJECT_BINDING_FOUNDING_UNQUALIFIED`.
 */
function qualifiedFoundingRevision(db, bootText, target) {
    const
        authority = readIdentityPublicationAuthorityInTransaction(db, bootText, target),
        founding  = readIdentityFoundingSourceInTransaction(db, {target});

    if (authority.state !== 'bound' || founding.provenance.issuer !== authority.issuer ||
        founding.provenance.lineageHead !== authority.head) {
        throw refusal('SUBJECT_BINDING_FOUNDING_UNQUALIFIED',
            'The retained founding source is not qualified by the lineage this plane is bound to; an administrative bind rests on it.');
    }

    return founding.provenance.sourceRevision;
}

/**
 * @summary Runs one command against an explicit graph file. `bind` decides inside one transaction, on a
 * read-only connection for a dry run, and decides again inside the write transaction when applied.
 * @param {Object}   options
 * @param {String}   options.dbPath                Explicit live graph SQLite path; must exist.
 * @param {String}   options.command               `list` or `bind`.
 * @param {Object}   [options.subject]             `{authProvider, providerBaseUrl, providerUserId}`, for `bind`.
 * @param {String}   [options.identityId]          The existing identity to bind, for `bind`.
 * @param {Boolean}  [options.apply=false]         Write the bind; otherwise report it.
 * @param {String}   [options.bootText]            The plane's identity-publication boot descriptor, for `bind`.
 * @param {Object}   [options.target]              The plane's `{planeId, dataRoot}`, for `bind`.
 * @param {String}   [options.configuredGraphPath] The configured live graph; an applied bind must target it.
 * @param {Function} [options.now=Date.now]
 * @returns {Object} `{ok, command, records}` for `list`; `{ok, command, applied, state, identityId, foundingRevision}` for `bind`.
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

        const decide = () => {
            requireIdentity(db, identityId);
            return {foundingRevision: qualifiedFoundingRevision(db, bootText, target), plan: planAdministrativeBind(db, {subject, identityId})};
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
        .description('Bind a provider subject to an existing identity on the plane host. A bind is a dry run unless --apply.')
        .argument('<command>', COMMANDS.join(' | '))
        .requiredOption('--db-path <path>', 'live graph SQLite file (explicit, must exist)')
        .option('--auth-provider <provider>', 'the subject\'s forge, as admissions present it')
        .option('--provider-base-url <url>', 'the forge API base, as admissions present it')
        .option('--provider-user-id <id>', 'the forge account id, never its login')
        .option('--identity <id>', 'the existing AgentIdentity the subject acts as')
        .option('--apply', 'write the bind; without it the command reports what it would do', false);
}

/**
 * @summary Parses `argv` and runs the command; `bind` reads the plane's boot descriptor, target and graph path from config.
 * @param {String[]} [argv=process.argv]
 * @returns {Promise<Object>}
 */
export async function runCli(argv = process.argv) {
    const
        program = createCommand().parse(argv),
        options = program.opts(),
        command = program.args[0];

    if (command !== 'bind') return runSubjectBindingAdmin({dbPath: options.dbPath, command});

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
