#!/usr/bin/env node
import Database  from 'better-sqlite3';
import {Command} from 'commander';
import crypto    from 'node:crypto';
import fs        from 'node:fs';
import path      from 'node:path';

import {FORMER_LOGIN_TO_IDENTITY}                      from '../../services/graph/agentFamilyResolution.mjs';
import {stringifyCanonicalJson}                        from '../../services/shared/canonicalJson.mjs';
import {isEntryModule}                                 from '../../services/shared/isEntryModule.mjs';
import {readIdentityPublicationAuthorityInTransaction} from '../../services/memory-core/helpers/identityPublicationLineage.mjs';
import {
    activateSubjectBinding,
    bindAdministratively,
    foundingSubjectMappings,
    planAdministrativeBind,
    readQualifiedFoundingInTransaction,
    readSubjectBindingRecords,
    SUBJECT_BINDING_ACTIVATION_RECORD,
    SUBJECT_BINDING_RECORD
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
 * subjectBindings.mjs inventory --db-path <graph.sqlite>
 * subjectBindings.mjs activate --db-path <graph.sqlite> --cutover-revision <revision> [--apply]
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
 *
 * `inventory` is the cutover's read-only census (#1814): what activating selection by subject would meet
 * on this plane, read in one snapshot. It names every unresolved row with its remedy and binding authority,
 * and the blockers that keep activation shut. An identity's provider properties appear as a candidate only:
 * the relation and the qualified founding record are the only evidence. Memory and session rows live in
 * Chroma; `renameAgentIdentities.mjs --chroma-only` counts and re-keys theirs.
 *
 * `activate` writes the activation record that turns selection by subject on for every leaf at once. It
 * names the revision of the inventory its operator reviewed, takes the inventory again inside its write
 * transaction, and refuses while that inventory moved or still has a blocker. Activation only moves forward.
 */

const COMMANDS = Object.freeze(['list', 'bind', 'seed', 'inventory', 'activate']);

/** @summary An unbound identity outside the founding record's singleton seeds binds through one of these. */
const EXPLICIT_BIND = Object.freeze({remedy: 'an explicit administrative bind', authority: '#1297 on a Fleet plane; a reviewed cutover bind elsewhere'});

/** @summary The remedy and binding authority of every unresolved state the inventory names. */
const REMEDIES = Object.freeze({
    'founding-unavailable'      : {remedy: 'provision identity publication on this plane: a bound lineage and an installed founding source', authority: 'the lineage issuer'},
    'seedable'                  : {remedy: '`seed --apply`', authority: 'the qualified founding record'},
    'ambiguous-founding'        : EXPLICIT_BIND,
    'non-rostered'              : EXPLICIT_BIND,
    'held'                      : {remedy: 'a reviewed reconciliation of the earlier administrative move', authority: 'the plane operator'},
    'refused'                   : {remedy: 'a reviewed reconciliation of the conflicting binding', authority: 'the plane operator'},
    'identity-unknown'          : {remedy: 'none while the mapped identity is absent from this graph', authority: 'the qualified founding record'},
    'legacy-rows'               : {remedy: 're-key them to the canonical identity: `renameAgentIdentities.mjs --graph-only --apply`', authority: 'the plane host'},
    'ambiguous-legacy-ownership': {remedy: 'a reviewed reconciliation: the spelling is a live identity of its own', authority: 'the plane operator'}
});

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
    const row  = typeof identityId === 'string' ? db.prepare('SELECT data FROM Nodes WHERE id = ?').get(identityId) : null;
    let   node = null;

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
 * @summary Seeds the bindings the retained founding record authorizes on its own, inside the caller's
 * transaction: each subject mapped to exactly one held identity, and only where neither side is bound.
 * @returns {Object} `{foundingRevision, bound, matching, held, refused, unresolved}`.
 */
function seedFromFounding(db, {bootText, target, apply, now}) {
    const
        {foundingRevision, seed} = readQualifiedFoundingInTransaction(db, bootText, target),
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

/** @summary A handle's `@` form, or `null` for anything that names no handle. */
function handleOf(value) {
    const bare = typeof value === 'string' ? value.trim().replace(/^@+/, '') : '';
    return bare && !bare.includes(':') ? `@${bare}` : null;
}

/** @summary Every stored spelling of one handle, as mailbox storage has written them. */
function storageSpellings(handle) {
    const bare = handle.slice(1);
    return [handle, bare, `@${handle}`, `AGENT:${handle}`, `AGENT:${bare}`];
}

/** @summary The graph's `AgentIdentity` nodes as `{id, properties}`, in id order; a malformed row matches nothing. */
function readIdentityNodes(db) {
    return db.prepare(`SELECT id, data FROM Nodes WHERE CASE WHEN json_valid(data)
        THEN json_extract(data, '$.label') = 'AgentIdentity' OR json_extract(data, '$.type') = 'AgentIdentity' ELSE 0 END ORDER BY id`).all()
        .map(row => ({id: row.id, properties: JSON.parse(row.data).properties ?? {}}));
}

/**
 * @summary Classifies the founding side: the qualified record's seed outcome as a dry run, or the named reason
 * it cannot be read. Never throws for an unprovisioned or unqualified plane; that is the inventory's first row.
 * @returns {Object} `{state: 'qualified', foundingRevision, bound, matching, held, refused, unresolved}` or `{state: 'unavailable', code}`.
 */
function classifyFounding(db, {bootText, target, now}) {
    try {
        const authority = readIdentityPublicationAuthorityInTransaction(db, bootText, target);
        if (authority.state !== 'bound') return {state: 'unavailable', code: authority.code ?? 'founding-lineage-unbound'};

        return {state: 'qualified', ...seedFromFounding(db, {bootText, target, apply: false, now})};
    } catch (error) {
        if (typeof error.code !== 'string') throw error;
        return {state: 'unavailable', code: error.code};
    }
}

/**
 * @summary Each former spelling the plane or its resolver knows, with the rows still stored under it: graph
 * `formerLogins` and the roster's redirect table, which retires at the cutover. A spelling another identity
 * also claims, or that is a live identity of its own while rows remain, is ambiguous legacy ownership.
 * @returns {Object[]} `{spelling, identityIds, sources, reclaimed, messages, edges, state}` in spelling order.
 */
function readFormerSpellings(db, identities) {
    const
        held      = new Set(identities.map(({id}) => id)),
        spellings = new Map(),
        claim     = (raw, identityId, source) => {
            const spelling = handleOf(raw);
            if (!spelling) return;
            if (!spellings.has(spelling)) spellings.set(spelling, {spelling, identityIds: new Set(), sources: new Set(), messages: 0, edges: []});
            spellings.get(spelling).identityIds.add(identityId);
            spellings.get(spelling).sources.add(source);
        };

    identities.forEach(({id, properties}) => (Array.isArray(properties.formerLogins) ? properties.formerLogins : []).forEach(raw => claim(raw, id, 'graph')));
    Object.entries(FORMER_LOGIN_TO_IDENTITY).forEach(([raw, {id}]) => claim(raw, id, 'roster'));

    const spellingOf = new Map([...spellings.keys()].flatMap(spelling => storageSpellings(spelling).map(value => [value, spelling])));

    if (spellingOf.size > 0) {
        const values = [...spellingOf.keys()], marks = values.map(() => '?').join(', ');

        db.prepare(`SELECT json_extract(data, '$.properties.to') AS too, json_extract(data, '$.properties.from') AS frm FROM Nodes
            WHERE id LIKE 'MESSAGE:%' AND CASE WHEN json_valid(data) THEN json_extract(data, '$.properties.to') IN (${marks})
                OR json_extract(data, '$.properties.from') IN (${marks}) ELSE 0 END`).all(...values, ...values)
            .forEach(({too, frm}) => spellings.get(spellingOf.get(too) ?? spellingOf.get(frm)).messages++);

        db.prepare(`SELECT id, type, source, target FROM Edges WHERE source IN (${marks}) OR target IN (${marks}) ORDER BY id`).all(...values, ...values)
            .forEach(edge => spellings.get(spellingOf.get(edge.source) ?? spellingOf.get(edge.target)).edges.push({...edge}));
    }

    return [...spellings.values()].sort((a, b) => a.spelling.localeCompare(b.spelling)).map(entry => {
        const
            rows      = entry.messages + entry.edges.length,
            reclaimed = held.has(entry.spelling),
            state     = entry.identityIds.size > 1 || (reclaimed && rows > 0) ? 'ambiguous-legacy-ownership' : rows > 0 ? 'legacy-rows' : 'clear';

        return {...entry, identityIds: [...entry.identityIds].sort(), sources: [...entry.sources].sort(), reclaimed, state};
    });
}

/**
 * @summary The cutover inventory, inside the caller's read transaction: the activation record, the founding
 * side, every identity with its binding or its remedy, every former spelling with its stored rows, the
 * unresolved rows, and the blockers that keep activation shut. Its revision digests all of it, so an
 * activation can name the exact inventory it rests on.
 * @returns {Object} `{revision, readyToActivate, activation, founding, identities, foundingSubjects, formerSpellings, unresolved, blockers}`.
 */
function inventoryCutover(db, {bootText, target, now}) {
    const
        records    = readSubjectBindingRecords(db),
        bindingOf  = new Map(records.filter(({type}) => type === SUBJECT_BINDING_RECORD).map(({data}) => [data.identityId, data])),
        activated  = records.find(({type}) => type === SUBJECT_BINDING_ACTIVATION_RECORD)?.data,
        activation = activated ? {state: 'active', cutoverRevision: activated.cutoverRevision, activatedAt: activated.activatedAt} : {state: 'dormant'},
        nodes      = readIdentityNodes(db),
        founding   = classifyFounding(db, {bootText, target, now}),
        qualified  = founding.state === 'qualified',
        seedState  = new Map();

    if (qualified) {
        founding.unresolved.filter(({reason}) => reason === 'several-identities')
            .forEach(({identityIds}) => identityIds.forEach(identityId => seedState.set(identityId, 'ambiguous-founding')));
        ['bound', 'held', 'refused'].forEach(outcome => founding[outcome].forEach(({identityId}) =>
            seedState.set(identityId, {bound: 'seedable', held: 'held', refused: 'refused'}[outcome])));
    }

    const
        identities = nodes.map(({id, properties}) => {
            const
                binding   = bindingOf.get(id),
                state     = binding ? 'bound' : qualified ? seedState.get(id) ?? 'non-rostered' : 'founding-unavailable',
                // last-seen provider properties are the operator's candidate, never collision evidence
                candidate = ['authProvider', 'providerBaseUrl', 'providerUserId'].every(key => typeof properties[key] === 'string' && properties[key])
                    ? {authProvider: properties.authProvider, providerBaseUrl: properties.providerBaseUrl, providerUserId: properties.providerUserId}
                    : null;

            return {
                id,
                accountType        : properties.accountType ?? null,
                participationStatus: properties.participationStatus || 'active',
                state,
                ...(binding ? {binding: {authProvider: binding.authProvider, providerBaseUrl: binding.providerBaseUrl, providerUserId: binding.providerUserId, writer: binding.writer}} : {}),
                candidate
            };
        }),
        foundingSubjects = qualified ? founding.unresolved.filter(({reason}) => reason === 'identity-unknown')
            .map(({subject, identityIds}) => ({subject, identityIds: [...identityIds]})) : [],
        formerSpellings  = readFormerSpellings(db, nodes),
        unresolved       = [
            ...(qualified ? [] : [{row: 'founding', state: 'founding-unavailable', code: founding.code, ...REMEDIES['founding-unavailable']}]),
            ...identities.filter(({state}) => state !== 'bound').map(({id, state}) => ({row: id, state, ...REMEDIES[state]})),
            ...foundingSubjects.map(({subject, identityIds}) => ({row: `${subject.authProvider} ${subject.providerBaseUrl} ${subject.providerUserId}`, state: 'identity-unknown', identityIds, ...REMEDIES['identity-unknown']})),
            ...formerSpellings.filter(({state}) => state !== 'clear').map(({spelling, state}) => ({row: spelling, state, ...REMEDIES[state]}))
        ],
        unboundActive    = identities.filter(({state, participationStatus}) => state !== 'bound' && participationStatus === 'active').map(({id}) => id),
        heldRows         = formerSpellings.filter(({state}) => state !== 'clear').map(({spelling}) => spelling),
        blockers         = [
            ...(qualified ? [] : [{blocker: 'founding-unavailable', code: founding.code}]),
            ...(unboundActive.length > 0 ? [{blocker: 'unbound-active-identities', identities: unboundActive}] : []),
            ...(heldRows.length > 0 ? [{blocker: 'former-spelling-rows', spellings: heldRows}] : [])
        ],
        body             = {
            activation,
            founding: qualified ? {state: 'qualified', foundingRevision: founding.foundingRevision} : {state: 'unavailable', code: founding.code},
            identities, foundingSubjects, formerSpellings, unresolved, blockers
        };

    return {
        revision       : `cutover-inventory-${crypto.createHash('sha256').update(stringifyCanonicalJson(body)).digest('hex')}`,
        readyToActivate: blockers.length === 0,
        ...body
    };
}

/**
 * @summary Decides an activation against the inventory taken inside the caller's transaction: already active,
 * stale against the reviewed revision, blocked, or ready. Applied, a ready decision writes the record.
 * @returns {Object} `{state: 'active'|'ready'|'activated', revision, activation?}`.
 * @throws {Error} `SUBJECT_BINDING_CUTOVER_STALE` or `SUBJECT_BINDING_CUTOVER_BLOCKED` (with its `blockers`); nothing is written.
 */
function activateCutover(db, {cutoverRevision, apply, bootText, target, now}) {
    const inventory = inventoryCutover(db, {bootText, target, now});

    if (inventory.activation.state === 'active') return {state: 'active', revision: inventory.revision, activation: inventory.activation};

    if (inventory.revision !== cutoverRevision) {
        throw refusal('SUBJECT_BINDING_CUTOVER_STALE', `The inventory moved since ${cutoverRevision}; review ${inventory.revision} and name it.`);
    }

    if (!inventory.readyToActivate) {
        const error = refusal('SUBJECT_BINDING_CUTOVER_BLOCKED', `Activation stays shut: ${inventory.blockers.map(({blocker}) => blocker).join(', ')}.`);
        error.blockers = inventory.blockers;
        throw error;
    }

    if (!apply) return {state: 'ready', revision: inventory.revision};

    return {state: 'activated', revision: inventory.revision, activation: activateSubjectBinding(db, {cutoverRevision, at: now()})};
}

/**
 * @summary Runs one command against an explicit graph file. `bind` and `seed` decide inside one transaction,
 * on a read-only connection for a dry run, and decide again inside the write transaction when applied.
 * @param {Object}   options
 * @param {String}   options.dbPath                Explicit live graph SQLite path; must exist.
 * @param {String}   options.command               `list`, `bind`, `seed`, `inventory` or `activate`.
 * @param {Object}   [options.subject]             `{authProvider, providerBaseUrl, providerUserId}`, for `bind`.
 * @param {String}   [options.identityId]          The existing identity to bind, for `bind`.
 * @param {String}   [options.cutoverRevision]     The reviewed inventory revision, for `activate`.
 * @param {Boolean}  [options.apply=false]         Write; otherwise report what would be written. `inventory` never writes.
 * @param {String}   [options.bootText]            The plane's identity-publication boot descriptor, for every command but `list`.
 * @param {Object}   [options.target]              The plane's `{planeId, dataRoot}`, for every command but `list`.
 * @param {String}   [options.configuredGraphPath] The configured live graph; an applied write must target it.
 * @param {Function} [options.now=Date.now]
 * @returns {Object} `{ok, command, records}` for `list`; `{ok, command, applied, state, identityId, foundingRevision}`
 * for `bind`; `{ok, command, applied, foundingRevision, bound, matching, held, refused, unresolved}` for `seed`;
 * `{ok, command, revision, readyToActivate, activation, founding, identities, foundingSubjects, formerSpellings,
 * unresolved, blockers}` for `inventory`; `{ok, command, applied, state, revision, activation?}` for `activate`.
 * @throws {Error} A named refusal; nothing is written.
 */
export function runSubjectBindingAdmin({dbPath, command, subject, identityId, cutoverRevision, apply = false, bootText, target, configuredGraphPath, now = Date.now} = {}) {
    if (!COMMANDS.includes(command)) throw refusal('SUBJECT_BINDING_INVALID', `The command must be one of ${COMMANDS.join(', ')}.`);
    if (typeof dbPath !== 'string' || !dbPath.trim()) throw refusal('SUBJECT_BINDING_INVALID', 'The graph database path is explicit.');
    if (apply && command === 'inventory') throw refusal('SUBJECT_BINDING_INVALID', 'The inventory only reads; it takes no --apply.');
    if (apply && !sameFile(dbPath, configuredGraphPath)) {
        throw refusal('SUBJECT_BINDING_TARGET_MISMATCH', 'An applied bind must target the configured live graph.');
    }

    const db = new Database(path.resolve(dbPath), {fileMustExist: true, readonly: !apply, timeout: 10000});

    try {
        if (command === 'list') return {ok: true, command, records: readSubjectBindingRecords(db)};

        if (command === 'inventory') return {ok: true, command, ...db.transaction(() => inventoryCutover(db, {bootText, target, now})).deferred()};

        if (command === 'activate') {
            if (typeof cutoverRevision !== 'string' || !cutoverRevision) {
                throw refusal('SUBJECT_BINDING_INVALID', 'Activation names the revision of the inventory its operator reviewed.');
            }

            const
                run     = () => activateCutover(db, {cutoverRevision, apply, bootText, target, now}),
                outcome = apply ? db.transaction(run).immediate() : db.transaction(run).deferred();

            return {ok: true, command, applied: outcome.state === 'activated', ...outcome};
        }

        if (command === 'seed') {
            const run     = () => seedFromFounding(db, {bootText, target, apply, now}),
                  outcome = apply ? db.transaction(run).immediate() : db.transaction(run).deferred();

            return {ok: outcome.refused.length === 0, command, applied: apply, ...outcome};
        }

        const decide = () => {
            requireIdentity(db, identityId);
            return {foundingRevision: readQualifiedFoundingInTransaction(db, bootText, target).foundingRevision, plan: planAdministrativeBind(db, {subject, identityId})};
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
        .description('Bind provider subjects to existing identities on the plane host, one at a time or from the founding record, or take the cutover inventory. Dry run unless --apply.')
        .argument('<command>', COMMANDS.join(' | '))
        .requiredOption('--db-path <path>', 'live graph SQLite file (explicit, must exist)')
        .option('--auth-provider <provider>', 'the subject\'s forge, as admissions present it')
        .option('--provider-base-url <url>', 'the forge API base, as admissions present it')
        .option('--provider-user-id <id>', 'the forge account id, never its login')
        .option('--identity <id>', 'the existing AgentIdentity the subject acts as')
        .option('--cutover-revision <revision>', 'the reviewed inventory revision an activation rests on')
        .option('--apply', 'write; without it the command reports what it would do', false);
}

/**
 * @summary Parses `argv` and runs the command; every command but `list` reads the plane's boot descriptor, target
 * and graph path from config.
 * @param {String[]} [argv=process.argv]
 * @returns {Promise<Object>}
 */
export async function runCli(argv = process.argv) {
    const
        program = createCommand().parse(argv),
        options = program.opts(),
        command = program.args[0];

    if (command === 'list' || !COMMANDS.includes(command)) return runSubjectBindingAdmin({dbPath: options.dbPath, command});

    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');
    const {default: aiConfig} = await import('../../mcp/server/memory-core/config.mjs');

    return runSubjectBindingAdmin({
        dbPath             : options.dbPath,
        command,
        subject            : {authProvider: options.authProvider, providerBaseUrl: options.providerBaseUrl, providerUserId: options.providerUserId},
        identityId         : options.identity,
        cutoverRevision    : options.cutoverRevision,
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
