import {setup} from '../../../../setup.mjs';

const appName = 'AttributePreIdentityMemoriesMigrationTest';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}        from '@playwright/test';
import {spawnSync}           from 'node:child_process';
import Database              from 'better-sqlite3';
import Neo                   from 'neo.mjs/src/Neo.mjs';
import * as core             from 'neo.mjs/src/core/_export.mjs';
import MemoryService         from '../../../../../../ai/services/memory-core/MemoryService.mjs';
import StorageRouter         from '../../../../../../ai/services/memory-core/managers/StorageRouter.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {
    applyAttribution,
    assertPosture,
    envelopeOf,
    parseArgs,
    planAttribution,
    reportPlan,
    reverseAttribution,
    scanRows
} from '../../../../../../ai/scripts/migrations/attributePreIdentityMemories.mjs';

/**
 * @summary The pre-identity attribution migration over synthetic identities: the evidence it accepts and the
 * evidence it refuses, the journal that lets a re-run finish an interrupted apply and a reverse restore it, and the
 * production read paths a re-keyed row then travels.
 */
test.describe('attributePreIdentityMemories — evidence-bound attribution of pre-identity memories (#1018)', () => {
    const
        IDENTITY = '@neo-test-mira',
        ALIAS    = '@neo-test-mira-legacy',
        PEER     = '@neo-test-orin',
        MARKER   = 'This is the Test CLI. We are setting up the context for our chat.',
        row      = (id, metadata) => ({id, metadata: {timestamp: 1, type: 'agent-interaction', ...metadata}}),
        shared   = (id, sessionId, prompt, extra = {}) => row(id, {prompt, sessionId, userId: 'shared', ...extra}),
        plan     = rows => planAttribution({aliases: [ALIAS], harness: [MARKER], identity: IDENTITY, rows}),
        rulesOf  = result => Object.fromEntries(result.attribute.map(({id, rule}) => [id, rule]));

    /**
     * @summary An in-memory collection with Chroma's update semantics: an update merges into the stored metadata,
     * and a `null` deletes its key. `interruptAfter` throws once, after that many updates.
     */
    function createCollection(rows, {interruptAfter = null} = {}) {
        const
            store   = new Map(rows.map(({id, metadata}) => [id, {...metadata}])),
            matches = (metadata, where) => !where
                || (where.$and ? where.$and.every(clause => matches(metadata, clause))
                    : where.$or ? where.$or.some(clause => matches(metadata, clause))
                        : Object.entries(where).every(([key, value]) => metadata[key] === value)),
            select  = where => [...store].filter(([, metadata]) => matches(metadata, where));

        let updated = 0;

        return {
            store,
            async get({limit = Infinity, offset = 0, where} = {}) {
                const entries = select(where).slice(offset, offset + limit);

                return {documents: entries.map(([, m]) => m.prompt ?? ''), ids: entries.map(([id]) => id), metadatas: entries.map(([, m]) => ({...m}))}
            },
            async query({nResults, where}) {
                const entries = select(where).slice(0, nResults);

                return {
                    distances: [entries.map(() => 0)],
                    documents: [entries.map(([, m]) => m.prompt ?? '')],
                    ids      : [entries.map(([id]) => id)],
                    metadatas: [entries.map(([, m]) => ({...m}))]
                }
            },
            async update({ids, metadatas}) {
                if (interruptAfter !== null && updated >= interruptAfter) {
                    interruptAfter = null;
                    throw new Error('the Chroma pass was interrupted')
                }

                ids.forEach((id, index) => {
                    const next = {...store.get(id)};

                    Object.entries(metadatas[index]).forEach(([key, value]) => { value === null ? delete next[key] : next[key] = value });
                    store.set(id, next);
                    updated++
                })
            },
            rows: () => [...store].map(([id, metadata]) => ({id, metadata: {...metadata}}))
        }
    }

    /**
     * @summary An in-memory graph holding one shared `AGENT_MEMORY` node per id.
     */
    function createGraph(ids) {
        const db = new Database(':memory:');

        db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL)');
        ids.forEach(id => db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)')
            .run(id, 'shared', JSON.stringify({id, label: 'AGENT_MEMORY', properties: {sessionId: `s-${id}`}})));

        return db
    }

    /**
     * @summary Adds a `memory:<uuid>` node: REM's legacy projection of a row, or with `chromaId: null` a curated node.
     */
    function addLegacyNode(db, id, {agentIdentity = null, chromaId = id, userId = 'shared'} = {}) {
        db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)').run(`memory:${id}`, userId, JSON.stringify({
            id        : `memory:${id}`,
            label     : 'MEMORY',
            properties: {...(agentIdentity ? {agentIdentity} : {}), ...(chromaId ? {chromaId} : {}), sessionId: `s-${id}`, userId}
        }))
    }

    /**
     * @summary Hands a legacy projection to another owner, as something outside the migration might.
     */
    function setLegacyOwner(db, id, userId, agentIdentity = null) {
        const data = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(`memory:${id}`).data);

        data.properties = {...data.properties, userId};
        agentIdentity ? data.properties.agentIdentity = agentIdentity : delete data.properties.agentIdentity;
        db.prepare('UPDATE Nodes SET user_id = ?, data = ? WHERE id = ?').run(userId, JSON.stringify(data), `memory:${id}`)
    }

    const ownerOf = (db, id) => {
        const {user_id: userId, data}                 = db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get(id),
              {agentIdentity, userId: propertyUserId} = JSON.parse(data).properties;

        return {agentIdentity, propertyUserId, userId}
    };

    test('a dry run is the default; the identity is required, and writes need --offline', () => {
        expect(parseArgs([])).toMatchObject({apply: false, identity: null, reverse: false});
        expect(() => assertPosture(parseArgs([]))).toThrow('--identity expects a direct agent identity');
        expect(parseArgs([
            '--identity', 'neo-test-mira',
            '--alias', 'neo-test-mira-legacy',
            '--harness', MARKER,
            '--harness', 'Other CLI',
            '--agent', 'Antigravity (Gemini 3.1 Pro)',
            '--conflict-agent', 'claude-code',
            '--before', '2026-04-10T00:00:00.000Z'
        ])).toMatchObject({
            agents        : ['Antigravity (Gemini 3.1 Pro)'],
            aliases       : [ALIAS],
            before        : '2026-04-10T00:00:00.000Z',
            beforeMs      : Date.parse('2026-04-10T00:00:00.000Z'),
            conflictAgents: ['claude-code'],
            harness       : [MARKER, 'Other CLI'],
            identity      : IDENTITY
        });
        expect(() => assertPosture(parseArgs(['--identity', IDENTITY, '--apply']))).toThrow('--offline');
        expect(() => assertPosture(parseArgs(['--identity', IDENTITY, '--apply', '--reverse', '--offline']))).toThrow('exclude each other');
        expect(() => parseArgs(['--identity'])).toThrow('--identity expects a value');
        expect(() => parseArgs(['--before', 'not-a-date'])).toThrow('--before expects an ISO-8601 timestamp or epoch milliseconds');
        expect(() => parseArgs(['--bogus'])).toThrow('unknown argument: --bogus')
    });

    test('the CLI help stays boot-safe', () => {
        const run = spawnSync(process.execPath, ['ai/scripts/migrations/attributePreIdentityMemories.mjs', '--help'], {encoding: 'utf8'});

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('--identity <id>')
    });

    test('a marker or wake is evidence only at the envelope prefix: bare or in the harness envelope, never quoted', () => {
        const wake = `[WAKE][priority:high] 2 events for ${IDENTITY}: 1 review request`;

        expect(envelopeOf(`${MARKER}\nToday's date is …`).startsWith(MARKER)).toBe(true);
        expect(envelopeOf(`<session_context>\n${MARKER}\nToday's date is …`).startsWith(MARKER)).toBe(true);
        expect(rulesOf(plan([shared('m-envelope-wake', 's-0', `<session_context>\n${wake}`)]))).toEqual({'m-envelope-wake': 'wake-addressee'});

        const result = plan([
            shared('m-quoted-prompt', 's-1', `Its prompt opens with "${MARKER}"`),
            shared('m-quoted-thought', 's-2', 'a user turn', {thought: MARKER}),
            shared('m-quoted-response', 's-3', 'another turn', {response: MARKER}),
            // another wrapper is a quotation, and lends its session nothing
            ...['example', 'blockquote'].flatMap(tag => [[MARKER, 'marker'], [wake, 'wake']].flatMap(([header, kind]) => [
                shared(`m-${tag}-${kind}`, `s-${tag}-${kind}`, `<${tag}>\n${header}\n</${tag}>`),
                shared(`m-${tag}-${kind}-turn`, `s-${tag}-${kind}`, 'a turn beside it')
            ]))
        ]);

        expect(result.attribute).toEqual([]);
        expect(result.leftShared.map(({reason, rows}) => [reason, rows])).toEqual([
            ...Array(3).fill(['no-evidence', 1]), ...Array(4).fill(['no-evidence', 2])
        ])
    });

    test('a session start carries its session, and so do a wake to an alias and a row already attributed', () => {
        const result = plan([
            shared('m-start', 's-cli', `<session_context>\n${MARKER}\nToday's date is …`),
            shared('m-turn', 's-cli', 'fix the grid'),
            shared('m-wake', 's-wake', `[WAKE][priority:high] 2 events for ${ALIAS}: 1 review request`),
            shared('m-wake-turn', 's-wake', 'next'),
            row('m-own', {agentIdentity: IDENTITY, prompt: 'a later turn', sessionId: 's-known', userId: 'neo-test-mira'}),
            shared('m-known-turn', 's-known', 'an earlier turn'),
            shared('m-lone', undefined, MARKER),
            shared('m-lone-turn', undefined, 'a turn without a session'),
            // an empty session links nothing either
            shared('m-empty', '', MARKER),
            shared('m-empty-turn', '', 'a turn whose session is empty'),
            shared('m-blank-turn', '  ', 'a turn whose session is blank')
        ]);

        expect(rulesOf(result)).toEqual({
            'm-empty'     : 'harness-marker',
            'm-known-turn': 'session',
            'm-lone'      : 'harness-marker',
            'm-start'     : 'harness-marker',
            'm-turn'      : 'session',
            'm-wake'      : 'wake-addressee',
            'm-wake-turn' : 'session'
        });
        expect(result.attribute.find(({id}) => id === 'm-turn').evidence, 'a session row names the row that carried it').toBe('m-start');
        expect(result.attribute.find(({id}) => id === 'm-wake').evidence).toBe(ALIAS);
        expect(result.userId).toBe('neo-test-mira');
        expect(result.leftShared).toEqual(['m-blank-turn', 'm-empty-turn', 'm-lone-turn'].map(id => ({reason: 'no-evidence', rows: 1, session: `row:${id}`})))
    });

    test('a session without evidence, or beside another identity, stays shared as a whole', () => {
        const result = plan([
            shared('m-other-harness', 's-ag', 'You are an agentic AI coding assistant, pair programming with the user.'),
            shared('m-mixed-start', 's-mixed', MARKER),
            row('m-mixed-peer', {agentIdentity: PEER, prompt: 'a peer turn', sessionId: 's-mixed', userId: 'neo-test-orin'}),
            shared('m-mixed-turn', 's-mixed', 'a turn'),
            shared('m-peer-wake', 's-pw', `[WAKE][priority:normal] 1 events for ${PEER}: 1 message`),
            shared('m-peer-wake-start', 's-pw', MARKER)
        ]);

        expect(result.attribute).toEqual([]);
        expect(result.leftShared).toEqual([
            {reason: 'no-evidence', rows: 1, session: 's-ag'},
            {conflicts: [`row of ${PEER}`], reason: 'conflict', rows: 2, session: 's-mixed'},
            {conflicts: [`wake for ${PEER}`], reason: 'conflict', rows: 2, session: 's-pw'}
        ]);
        expect(reportPlan(result).leftShared).toEqual({conflict: {rows: 4, sessions: 2}, 'no-evidence': {rows: 1, sessions: 1}})
    });

    test('user-id, agent-field and before-cutoff rules attribute pre-identity rows, propagate across sessions, and respect conflicts and prior userId on reverse', async () => {
        const
            cutoffIso   = '2026-04-10T00:00:00.000Z',
            beforeEpoch = Date.parse('2026-03-01T12:00:00.000Z'),
            afterEpoch  = Date.parse('2026-04-15T12:00:00.000Z'),
            rows        = [
                // Rule 1: user-id (canonical and alias) without agentIdentity, plus a shared sibling in the same session
                row('m-uid-own', {prompt: 'pre-identity turn with canonical userId', sessionId: 's-uid', timestamp: afterEpoch, userId: 'neo-test-mira'}),
                shared('m-uid-sibling', 's-uid', 'shared sibling in user-id session', {timestamp: afterEpoch}),
                row('m-uid-alias', {prompt: 'pre-identity turn with alias userId', sessionId: 's-uid-alias', timestamp: afterEpoch, userId: 'neo-test-mira-legacy'}),
                // Session conflict from a foreign userId on an unattributed row
                shared('m-foreign-uid-start', 's-foreign-uid', MARKER, {timestamp: afterEpoch}),
                row('m-foreign-uid-peer', {prompt: 'peer userId turn', sessionId: 's-foreign-uid', timestamp: afterEpoch, userId: 'neo-test-orin'}),
                // Rule 2: --agent and --conflict-agent
                shared('m-agent', 's-agent', 'antigravity turn', {agent: 'Antigravity (Gemini 3.1 Pro)', timestamp: afterEpoch}),
                shared('m-agent-sibling', 's-agent', 'follow-up turn', {agent: 'Antigravity', timestamp: afterEpoch}),
                shared('m-agent-conflict-1', 's-agent-mixed', 'gemini turn', {agent: 'Antigravity (Gemini 3.1 Pro)', timestamp: afterEpoch}),
                shared('m-agent-conflict-2', 's-agent-mixed', 'claude turn', {agent: 'claude-code', timestamp: afterEpoch}),
                shared('m-agent-ambiguous', 's-agent-ambiguous', 'bare antigravity turn', {agent: 'Antigravity', timestamp: afterEpoch}),
                // Rule 3: --before cutoff (numeric epoch ms and ISO string) and conflict precedence
                shared('m-before-num', 's-before-1', 'founding turn numeric timestamp', {timestamp: beforeEpoch}),
                shared('m-before-iso', 's-before-2', 'founding turn ISO timestamp', {timestamp: '2025-10-02T09:24:58.842Z'}),
                shared('m-before-conflict', 's-before-conflict', 'early turn with conflict agent', {agent: 'claude-code', timestamp: beforeEpoch})
            ],
            planned = planAttribution({
                agents        : ['Antigravity (Gemini 3.1 Pro)'],
                aliases       : [ALIAS],
                before        : cutoffIso,
                conflictAgents: ['claude-code'],
                harness       : [MARKER],
                identity      : IDENTITY,
                rows
            });

        expect(rulesOf(planned)).toEqual({
            'm-agent'        : 'agent-field',
            'm-agent-sibling': 'session',
            'm-before-iso'   : 'before-cutoff',
            'm-before-num'   : 'before-cutoff',
            'm-uid-alias'    : 'user-id',
            'm-uid-own'      : 'user-id',
            'm-uid-sibling'  : 'session'
        });
        expect(planned.leftShared).toEqual([
            {reason: 'no-evidence', rows: 1, session: 's-agent-ambiguous'},
            {conflicts: ['agent claude-code'], reason: 'conflict', rows: 2, session: 's-agent-mixed'},
            {conflicts: ['agent claude-code'], reason: 'conflict', rows: 1, session: 's-before-conflict'},
            {conflicts: ['userId neo-test-orin'], reason: 'conflict', rows: 1, session: 's-foreign-uid'}
        ]);

        const
            collection = createCollection(rows),
            db         = createGraph(['m-uid-own', 'm-uid-alias', 'm-agent', 'm-before-num']);

        addLegacyNode(db, 'm-uid-alias', {userId: 'neo-test-mira-legacy'});

        await expect(applyAttribution({collection, db, plan: planned}))
            .resolves.toEqual({chromaUpdated: 7, graphMissing: 3, graphUpdated: 4, legacyRefused: 0, legacyUpdated: 1});
        expect(collection.store.get('m-uid-own')).toMatchObject({
            agentIdentity         : IDENTITY,
            attributionEvidence   : 'neo-test-mira',
            attributionPriorUserId: 'neo-test-mira',
            attributionRule       : 'user-id',
            userId                : 'neo-test-mira'
        });
        expect(collection.store.get('m-uid-alias')).toMatchObject({
            agentIdentity         : IDENTITY,
            attributionEvidence   : 'neo-test-mira-legacy',
            attributionPriorUserId: 'neo-test-mira-legacy',
            attributionRule       : 'user-id',
            userId                : 'neo-test-mira'
        });
        expect(ownerOf(db, 'memory:m-uid-alias')).toEqual({agentIdentity: IDENTITY, propertyUserId: 'neo-test-mira', userId: 'neo-test-mira'});

        await expect(reverseAttribution({collection, db, identity: IDENTITY, rows: collection.rows()}))
            .resolves.toEqual({chromaRestored: 7, graphRestored: 4, legacyRefused: 0, legacyRestored: 1});
        expect(collection.store.get('m-uid-own')).toEqual(rows[0].metadata);
        expect(collection.store.get('m-uid-alias')).toEqual(rows[2].metadata);
        expect(ownerOf(db, 'memory:m-uid-alias')).toEqual({agentIdentity: undefined, propertyUserId: 'neo-test-mira-legacy', userId: 'neo-test-mira-legacy'})
    });

    test('before-cutoff fails closed on an unlisted metadata.agent and on a row at the exact cutoff instant', () => {
        const
            cutoffIso   = '2026-04-10T00:00:00.000Z',
            cutoffMs    = Date.parse(cutoffIso),
            beforeEpoch = Date.parse('2026-04-09T23:59:59.999Z'),
            planned     = planAttribution({
                agents        : ['Antigravity (Gemini 3.1 Pro)'],
                before        : cutoffIso,
                conflictAgents: ['claude-code'],
                identity      : IDENTITY,
                rows          : [
                    shared('m-before-clean', 's-clean', 'solo founding turn without agent label', {timestamp: beforeEpoch}),
                    shared('m-before-unlisted', 's-unlisted', 'early turn with unlisted foreign agent', {agent: 'Antigravity (Claude Opus 4.6)', timestamp: beforeEpoch}),
                    shared('m-at-cutoff-iso', 's-boundary-1', 'turn at exact ISO cutoff', {timestamp: cutoffIso}),
                    shared('m-at-cutoff-ms', 's-boundary-2', 'turn at exact numeric cutoff', {timestamp: cutoffMs})
                ]
            });

        expect(rulesOf(planned)).toEqual({'m-before-clean': 'before-cutoff'});
        expect(planned.leftShared).toEqual([
            {reason: 'no-evidence', rows: 1, session: 's-boundary-1'},
            {reason: 'no-evidence', rows: 1, session: 's-boundary-2'},
            {reason: 'no-evidence', rows: 1, session: 's-unlisted'}
        ])
    });

    test('user-id rows trust server-stamped metadata.userId over prompt wake summaries while foreign userIds mark session conflicts', () => {
        const planned = planAttribution({
            aliases       : [ALIAS],
            conflictAgents: ['claude-code'],
            identity      : IDENTITY,
            rows          : [
                row('m-uid-wake-summary', {
                    prompt   : `[WAKE][priority:high] 1 events for ${PEER}: 1 message summarized by ${IDENTITY}`,
                    sessionId: 's-uid-wake',
                    userId   : 'neo-test-mira'
                }),
                shared('m-uid-wake-sibling', 's-uid-wake', 'shared sibling in same session'),
                row('m-uid-foreign', {prompt: 'peer turn', sessionId: 's-uid-mixed', userId: 'neo-test-orin'}),
                row('m-uid-own-mixed', {prompt: 'own turn in mixed session', sessionId: 's-uid-mixed', userId: 'neo-test-mira'})
            ]
        });

        expect(rulesOf(planned)).toEqual({
            'm-uid-wake-sibling': 'session',
            'm-uid-wake-summary': 'user-id'
        });
        expect(planned.leftShared).toEqual([
            {conflicts: ['userId neo-test-orin'], reason: 'conflict', rows: 1, session: 's-uid-mixed'}
        ])
    });

    test('apply re-keys both stores with each row\'s journal; a re-run changes nothing; reverse restores shared', async () => {
        const
            rows       = [shared('m-start', 's-cli', MARKER), shared('m-turn', 's-cli', 'a turn'), shared('m-other', 's-x', 'unattributable')],
            collection = createCollection(rows),
            db         = createGraph(rows.map(({id}) => id));

        await expect(applyAttribution({collection, db, plan: plan(await scanRows(collection))}))
            .resolves.toEqual({chromaUpdated: 2, graphMissing: 0, graphUpdated: 2, legacyRefused: 0, legacyUpdated: 0});

        expect(collection.store.get('m-start')).toMatchObject({
            agentIdentity      : IDENTITY,
            attributionEvidence: MARKER,
            attributionPrior   : JSON.stringify({agentIdentity: null, propertyUserId: null, userId: 'shared'}),
            attributionRule    : 'harness-marker',
            userId             : 'neo-test-mira'
        });
        expect(collection.store.get('m-turn')).toMatchObject({attributionEvidence: 'm-start', attributionRule: 'session'});
        expect(collection.store.get('m-other')).toEqual(rows[2].metadata);
        expect(ownerOf(db, 'm-turn')).toEqual({agentIdentity: IDENTITY, propertyUserId: 'neo-test-mira', userId: 'neo-test-mira'});
        expect(ownerOf(db, 'm-other')).toEqual({agentIdentity: undefined, propertyUserId: undefined, userId: 'shared'});

        const again = plan(collection.rows());

        expect(again.attribute).toEqual([]);
        expect(again.journal.map(({id}) => id)).toEqual(['m-start', 'm-turn']);
        await expect(applyAttribution({collection, db, plan: again})).resolves.toEqual({chromaUpdated: 0, graphMissing: 0, graphUpdated: 0, legacyRefused: 0, legacyUpdated: 0});

        await expect(reverseAttribution({collection, db, identity: IDENTITY, rows: collection.rows()}))
            .resolves.toEqual({chromaRestored: 2, graphRestored: 2, legacyRefused: 0, legacyRestored: 0});
        expect(collection.store.get('m-start')).toEqual(rows[0].metadata);
        expect(ownerOf(db, 'm-start')).toEqual({agentIdentity: undefined, propertyUserId: undefined, userId: 'shared'});
        expect(rulesOf(plan(collection.rows())), 'the restored rows plan as they did before the apply').toEqual({'m-start': 'harness-marker', 'm-turn': 'session'})
    });

    test('a re-run completes an interrupted Chroma pass, and the graph changes once per row', async () => {
        const
            rows       = [shared('m-1', 's-cli', MARKER), shared('m-2', 's-cli', 'two'), shared('m-3', 's-cli', 'three')],
            collection = createCollection(rows, {interruptAfter: 1}),
            db         = createGraph(rows.map(({id}) => id));

        await expect(applyAttribution({batchSize: 1, collection, db, plan: plan(collection.rows())})).rejects.toThrow('interrupted');
        expect(collection.store.get('m-1').attributionRule, 'the first batch landed').toBe('harness-marker');
        expect(ownerOf(db, 'm-1').userId, 'the graph pass never ran').toBe('shared');

        const resumed = plan(collection.rows());

        expect(resumed.attribute.map(({id}) => id)).toEqual(['m-2', 'm-3']);
        expect(resumed.journal.map(({id}) => id)).toEqual(['m-1']);
        await expect(applyAttribution({batchSize: 1, collection, db, plan: resumed})).resolves.toEqual({chromaUpdated: 2, graphMissing: 0, graphUpdated: 3, legacyRefused: 0, legacyUpdated: 0});
        await expect(applyAttribution({collection, db, plan: plan(collection.rows())})).resolves.toEqual({chromaUpdated: 0, graphMissing: 0, graphUpdated: 0, legacyRefused: 0, legacyUpdated: 0});
        expect(rows.map(({id}) => ownerOf(db, id).agentIdentity)).toEqual([IDENTITY, IDENTITY, IDENTITY])
    });

    test.describe('a row\'s legacy memory: projection', () => {
        const
            MIRA      = {agentIdentity: IDENTITY, propertyUserId: 'neo-test-mira', userId: 'neo-test-mira'},
            MIRROR    = {agentIdentity: undefined, propertyUserId: 'shared', userId: 'shared'},
            ORIN      = {agentIdentity: undefined, propertyUserId: 'neo-test-orin', userId: 'neo-test-orin'},
            JOURNALED = JSON.stringify({agentIdentity: null, propertyUserId: 'shared', userId: 'shared'}),
            legacyOf  = (db, ids) => ids.map(id => ownerOf(db, `memory:${id}`)),
            reverse   = (collection, db) => reverseAttribution({collection, db, identity: IDENTITY, rows: collection.rows()});

        // left on `shared`, a projection would conflict with its re-keyed row in the reconciler
        test('moves with its row from the shared mirror, journaled first, and one holding a foreign owner is refused', async () => {
            const
                rows       = [shared('m-start', 's-cli', MARKER), shared('m-legacy', 's-cli', 'a turn'), shared('m-foreign', 's-cli', 'a turn'), shared('m-curated', 's-cli', 'a turn')],
                collection = createCollection(rows),
                db         = createGraph(['m-start']);

            addLegacyNode(db, 'm-start');
            addLegacyNode(db, 'm-legacy');
            addLegacyNode(db, 'm-foreign', {userId: 'neo-test-orin'});
            addLegacyNode(db, 'm-curated', {chromaId: null});

            await expect(applyAttribution({collection, db, plan: plan(collection.rows())}))
                .resolves.toEqual({chromaUpdated: 4, graphMissing: 3, graphUpdated: 1, legacyRefused: 1, legacyUpdated: 2});
            expect(legacyOf(db, ['m-start', 'm-legacy']), 'a twin and a lone projection both move').toEqual([MIRA, MIRA]);
            expect(legacyOf(db, ['m-foreign', 'm-curated'])).toEqual([ORIN, MIRROR]);
            expect(['m-start', 'm-legacy', 'm-foreign'].map(id => collection.store.get(id).attributionLegacyPrior), 'only a moved projection is journaled')
                .toEqual([JOURNALED, JOURNALED, undefined]);

            await expect(applyAttribution({collection, db, plan: plan(collection.rows())}), 'a re-run moves nothing')
                .resolves.toEqual({chromaUpdated: 0, graphMissing: 3, graphUpdated: 0, legacyRefused: 1, legacyUpdated: 0});

            await expect(reverse(collection, db)).resolves.toEqual({chromaRestored: 4, graphRestored: 1, legacyRefused: 0, legacyRestored: 2});
            expect(legacyOf(db, ['m-start', 'm-legacy', 'm-foreign', 'm-curated']), 'a projection the apply never moved is never restored')
                .toEqual([MIRROR, MIRROR, ORIN, MIRROR])
        });

        test('a refused reverse keeps its row attributed, journal included, and a retry finishes it', async () => {
            const
                rows       = [shared('m-start', 's-cli', MARKER)],
                collection = createCollection(rows),
                db         = createGraph([]);

            addLegacyNode(db, 'm-start');
            await applyAttribution({collection, db, plan: plan(collection.rows())});
            setLegacyOwner(db, 'm-start', 'neo-test-orin');

            await expect(reverse(collection, db)).resolves.toEqual({chromaRestored: 0, graphRestored: 0, legacyRefused: 1, legacyRestored: 0});
            expect(collection.store.get('m-start')).toMatchObject({agentIdentity: IDENTITY, attributionLegacyPrior: JOURNALED, attributionRule: 'harness-marker'});

            setLegacyOwner(db, 'm-start', 'neo-test-mira', IDENTITY);

            await expect(reverse(collection, db)).resolves.toEqual({chromaRestored: 1, graphRestored: 0, legacyRefused: 0, legacyRestored: 1});
            expect(collection.store.get('m-start')).toEqual(rows[0].metadata);
            expect(legacyOf(db, ['m-start'])).toEqual([MIRROR])
        });

        test('one the identity already held is left alone by an apply and by its reverse', async () => {
            const
                rows       = [shared('m-start', 's-cli', MARKER)],
                collection = createCollection(rows),
                db         = createGraph([]);

            addLegacyNode(db, 'm-start', {agentIdentity: IDENTITY, userId: 'neo-test-mira'});

            await expect(applyAttribution({collection, db, plan: plan(collection.rows())}))
                .resolves.toEqual({chromaUpdated: 1, graphMissing: 1, graphUpdated: 0, legacyRefused: 0, legacyUpdated: 0});
            expect(collection.store.get('m-start').attributionLegacyPrior).toBeUndefined();

            await expect(reverse(collection, db)).resolves.toEqual({chromaRestored: 1, graphRestored: 0, legacyRefused: 0, legacyRestored: 0});
            expect(legacyOf(db, ['m-start'])).toEqual([MIRA])
        });

        test('a row an earlier apply attributed without it journals and moves it on a re-apply', async () => {
            const
                rows       = [row('m-start', {agentIdentity: IDENTITY, attributionEvidence: MARKER, attributionPrior: 'null', attributionRule: 'harness-marker', prompt: MARKER, sessionId: 's-cli', userId: 'neo-test-mira'})],
                collection = createCollection(rows),
                db         = createGraph([]);

            addLegacyNode(db, 'm-start');

            await expect(applyAttribution({collection, db, plan: plan(collection.rows())}))
                .resolves.toEqual({chromaUpdated: 1, graphMissing: 1, graphUpdated: 0, legacyRefused: 0, legacyUpdated: 1});
            expect(collection.store.get('m-start').attributionLegacyPrior).toBe(JOURNALED);
            expect(legacyOf(db, ['m-start'])).toEqual([MIRA])
        });
    });

    test.describe('the read paths a re-keyed row travels', () => {
        let collection, originalGetMemoryCollection;

        test.beforeEach(async () => {
            const rows = [shared('m-start', 's-cli', MARKER), shared('m-peer', 's-peer', 'a peer\'s own turn', {userId: 'neo-test-orin'})];

            collection                        = createCollection(rows);
            originalGetMemoryCollection       = StorageRouter.getMemoryCollection;
            StorageRouter.getMemoryCollection = async () => collection;

            await applyAttribution({collection, db: createGraph(['m-start']), plan: plan(collection.rows())})
        });

        test.afterEach(() => {
            StorageRouter.getMemoryCollection = originalGetMemoryCollection
        });

        const prompts = (userId, memorySharing) => RequestContextService.run({userId}, () =>
            MemoryService.queryMemories({memorySharing, nResults: 10, query: 'anything'})
        ).then(view => view.results.map(({prompt}) => prompt).sort());

        test('a peer\'s team read still returns it, and a peer\'s private read does not', async () => {
            await expect(prompts('neo-test-orin', 'team')).resolves.toEqual([MARKER, 'a peer\'s own turn']);
            await expect(prompts('neo-test-orin', 'private')).resolves.toEqual(['a peer\'s own turn'])
        });

        test('its author\'s private recall now includes it', async () => {
            await expect(prompts('neo-test-mira', 'private')).resolves.toEqual([MARKER])
        })
    })
});
