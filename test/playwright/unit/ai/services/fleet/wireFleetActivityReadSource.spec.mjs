import {setup}                       from '../../../../setup.mjs';
import {test, expect}                from '@playwright/test';
import Neo                           from 'neo.mjs/src/Neo.mjs';
import * as core                     from 'neo.mjs/src/core/_export.mjs';
import {wireFleetActivityReadSource} from '../../../../../../ai/services/fleet/wireFleetActivityReadSource.mjs';
import {resolveContentOrigins}       from '../../../../../../ai/services/graph/contentOrigins.mjs';
import {createPlaneMailboxClient}    from '../../../../../../ai/services/fleet/planeMailboxClient.mjs';
import {FLEET_COCKPIT_SOURCES}       from '../../../../../../src/fleet/contract/cockpit.mjs';
import fs                            from 'node:fs';
import os                            from 'node:os';
import path                          from 'node:path';

/**
 * @summary Contract of the composer→bridge wiring: it INSTALLS a real composed source, never a stub,
 * and degrades honestly. The live wired/degraded receipt is the running-devFleetServer e2e's concern
 * (it needs the real memory-core singletons); this unit pins the pure wiring decisions with an
 * injected bridge + composer factory — no Neo instance, no real singletons.
 */
test.describe('Neo.ai.services.fleet.wireFleetActivityReadSource', () => {
    const stubBridge = () => ({activitySource: 'UNTOUCHED'});

    test('fail-soft: neither slot readable → returns null and leaves the bridge unwired (never fabricates)', () => {
        const bridge = stubBridge();

        const result = wireFleetActivityReadSource({bridge, createSource: () => ({readActivitySnapshot() {}})});

        expect(result).toBeNull();
        // the by-construction not-wired default must stand — no fabricated source installed
        expect(bridge.activitySource).toBe('UNTOUCHED');
    });

    test('both sources present → installs the composed source and hands the factory BOTH slot readers', () => {
        const bridge   = stubBridge();
        let   captured = null;
        const created  = {readActivitySnapshot() {}};

        const laneClaimStore = {load: () => null, save() {}};

        const result = wireFleetActivityReadSource({
            issuesDir            : '/synced/issues',
            listMessages         : () => [],
            resolveViewerIdentity: () => '@viewer',
            graphService         : {},
            limit                : 25,
            laneClaimStore,
            laneClaimSource      : 'plane:https://plane-a.example',
            bridge,
            createSource         : opts => { captured = opts; return created }
        });

        expect(result).toBe(created);
        expect(bridge.activitySource).toBe(created);
        expect(typeof captured.readA2ASnapshot).toBe('function');
        expect(typeof captured.readPrLaneSnapshot).toBe('function');
        expect(captured.limit).toBe(25);
        expect(captured.resolveViewerIdentity()).toBe('@viewer');
        // the per-seat lane record's store, and the mailbox it is saved for, reach the composer
        expect(captured.laneClaimStore).toBe(laneClaimStore);
        expect(captured.laneClaimSource).toBe('plane:https://plane-a.example');
    });

    test('an injected readPrLane IS the PR/lane slot — plane mode reads the plane, and the content root is never read', () => {
        const readPrLane = async () => ({capability: {state: 'wired'}, counts: [], events: []});
        let   captured   = null;

        const result = wireFleetActivityReadSource({
            contentRoot : '/a/tree/this/process/does/not/have',
            readPrLane,
            bridge      : stubBridge(),
            createSource: opts => { captured = opts; return {readActivitySnapshot() {}} }
        });

        expect(result).not.toBeNull();
        expect(captured.readPrLaneSnapshot).toBe(readPrLane)
    });

    test('with the open-work producer, the PR/lane slot wraps the plane reader: the producer\'s transitions are the PR events, the plane keeps the rest (#763)', async () => {
        // the wrapper reads the real clock here (the wiring injects no `now`), so the pulse is fresh
        const
            pulse      = new Date().toISOString(),
            earlier    = new Date(Date.now() - 60_000).toISOString(),
            readPrLane = async () => ({
                capability: {source: FLEET_COCKPIT_SOURCES.activity, state: 'wired', confidence: 'observed', capturedAt: earlier, reason: null},
                counts    : [],
                events    : [
                    {eventId: 'github-workflow:pull-requests:neo#1', type: 'pr-activity', source: FLEET_COCKPIT_SOURCES.githubPr, occurredAt: earlier, payload: {number: 1, repoSlug: 'neo'}},
                    {eventId: 'github-workflow:issues:neo#2', type: 'issue-activity', source: FLEET_COCKPIT_SOURCES.githubIssue, occurredAt: earlier, payload: {number: 2, repoSlug: 'neo'}}
                ]
            }),
            producer   = {getState: () => ({observedAt: pulse, coverage: 'complete', reason: null, transitions: [
                {id: `neomjs/neo-agent-brain#764@da3bf6a:merged:open->merged#${pulse}`, key: 'neomjs/neo-agent-brain#764', repo: 'neomjs/neo-agent-brain', number: 764, head: 'da3bf6a', owner: {kind: 'seat', seat: '@neo-opus-grace', login: 'neo-opus-grace'}, kind: 'merged', from: 'open', to: 'merged', pulse}
            ]})};
        let captured = null;

        wireFleetActivityReadSource({
            readPrLane,
            openWorkProducer: () => producer,
            bridge          : stubBridge(),
            createSource    : opts => { captured = opts; return {readActivitySnapshot() {}} }
        });

        expect(captured.readPrLaneSnapshot).not.toBe(readPrLane);

        const snapshot = await captured.readPrLaneSnapshot({limit: 10});

        expect(snapshot.events.map(event => [event.type, event.payload.repoSlug, event.payload.number])).toEqual([
            ['pr-activity',    'neo-agent-brain', 764],
            ['issue-activity', 'neo',             2]
        ]);
        expect(snapshot.capability.producer.observedAt).toBe(pulse)
    });

    test('a producer alone is a readable PR/lane slot: no tree, no plane, no mailbox — the source is wired and answers the producer\'s events', async () => {
        const
            pulse  = new Date().toISOString(),
            bridge = stubBridge();
        let captured = null;

        const result = wireFleetActivityReadSource({
            openWorkProducer: {getState: () => ({observedAt: pulse, coverage: 'complete', reason: null, transitions: [
                {id: `neomjs/neo#19364@343c56c:opened:null->open#${pulse}`, key: 'neomjs/neo#19364', repo: 'neomjs/neo', number: 19364, head: '343c56c', owner: {kind: 'seat', seat: '@neo-opus-vega', login: 'neo-opus-vega'}, kind: 'opened', from: null, to: 'open', pulse}
            ]})},
            bridge,
            createSource: opts => { captured = opts; return {readActivitySnapshot() {}} }
        });

        expect(result).not.toBeNull();
        expect(bridge.activitySource).toBe(result);

        const snapshot = await captured.readPrLaneSnapshot({limit: 10});

        expect(snapshot.events.map(event => event.payload.number)).toEqual([19364]);
        // a pulse this fresh is inside the stale bound: the slot is wired on the producer alone
        expect(snapshot.capability.state).toBe('wired')
    });

    test('an ABSENT slot source degrades honestly — its reader throws (contained by the composer), never a fabricated read', async () => {
        // Only the PR/lane source is present; the A2A slot has no listMessages.
        let captured = null;
        wireFleetActivityReadSource({
            issuesDir   : '/synced/issues',
            bridge      : stubBridge(),
            createSource: opts => { captured = opts; return {readActivitySnapshot() {}} }
        });

        // The A2A reader must throw (so the composer's per-slot catch degrades it naming the slot),
        // rather than silently returning an empty-but-'wired'-looking snapshot.
        await expect((async () => captured.readA2ASnapshot({limit: 5}))()).rejects.toThrow(/a2a activity source not wired/);
        // The present PR/lane slot is a real reader, not the throwing sentinel.
        expect(typeof captured.readPrLaneSnapshot).toBe('function');
    });

    test('the A2A slot pages the mailbox: the offset reaches listMessages, and the first page asks without one', async () => {
        const asks   = [];
        const source = wireFleetActivityReadSource({
            listMessages: async args => {
                asks.push(args);
                return {messages: [], offset: args.offset ?? 0, totalCount: 120, truncated: true}
            },
            readPrLane: async () => ({capability: {source: FLEET_COCKPIT_SOURCES.activity, state: 'wired'}, counts: [], events: []}),
            bridge    : stubBridge()
        });

        await source.readActivitySnapshot({limit: 50});
        const history = await source.readActivitySnapshot({limit: 50, offset: 50, slots: ['a2a']});

        // both bindings (in-process MailboxService, the plane client's list_messages) take these args as they are
        expect(asks.map(args => args.offset)).toEqual([undefined, 50]);
        // a later page still knows the population, so its total stays; its last-24h count cannot be complete
        expect(history.counts.filter(row => row.scope === 'total').map(row => row.value)).toEqual([120]);
        expect(history.counts.some(row => row.scope === 'last24h')).toBe(false)
    });

    test('a CONFIGURED-but-unreadable pullsDir degrades the PR/lane slot — degraded capability + source-degraded event', async () => {
        // Absent-vs-unreadable: a configured pulls directory that cannot be collected must reach
        // makeReadPrLaneSnapshot's catch → the builder's `error` path (degraded), NOT masquerade as a
        // 'wired' empty snapshot. issuesDir is a real empty temp dir; the reader throws first on the
        // missing pullsDir, so the issue/stall readers never run.
        const issuesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synced-issues-'));
        let   captured  = null;

        try {
            wireFleetActivityReadSource({
                issuesDir,
                pullsDir    : path.join(issuesDir, 'no-such-pulls'),
                bridge      : stubBridge(),
                createSource: opts => { captured = opts; return {readActivitySnapshot() {}} }
            });

            const snapshot = await captured.readPrLaneSnapshot({limit: 5});

            expect(snapshot.capability.state).toBe('degraded');
            expect(snapshot.events.some(event => event.type === 'source-degraded')).toBe(true)
        } finally {
            fs.rmSync(issuesDir, {recursive: true, force: true})
        }
    });
});

test.describe('Fleet Activity — explicit mailbox observation', () => {
    const observer    = {scope: 'all'},
          observation = {viewer: 'neo-gpt', planeId: 'test-plane', scope: 'all', policy: 'team', clamped: false, admissionKey: 'admitted-test'},
          message     = (id, subject = 'mail') => ({messageId: `MESSAGE:${id}`, from: '@alice', to: '@bob', subject, sentAt: '2026-10-09T12:00:00.000Z'}),
          page        = (messages = [], overrides = {}) => ({messages, totalCount: messages.length, truncated: false, nextOffset: null, limit: 2, offset: 0, observation, ...overrides}),
          prEvent     = {eventId: 'pr:new', source: FLEET_COCKPIT_SOURCES.prLane, occurredAt: '2026-10-09T13:00:00.000Z'},
          prLane      = async () => ({capability: {state: 'wired'}, events: [prEvent]}),
          source      = (listMessages, options = {}) => wireFleetActivityReadSource({bridge: {}, listMessages, readPrLane: prLane, ...options});

    test('forwards the closed observer selector through the local list binding and preserves canonical admission', async () => {
            const asks = [],
                  read = source(async args => {
                      asks.push(args);
                      return page([message('later')], {offset: 2, totalCount: 3, limit: 2})
                  }),
                  result = await read.readActivitySnapshot({observer, limit: 2, offset: 2, slots: ['a2a']});

            expect(asks).toEqual([{box: 'all', status: 'all', limit: 2, offset: 2, observer}]);
            expect(result.a2a).toEqual({observation, page: {totalCount: 3, truncated: false, nextOffset: null, limit: 2, offset: 2}, continuation: null});
            expect(result.events[0].payload.messageId).toBe('MESSAGE:later')
        })

    for (const supported of [true, false]) {
        test(`real plane client keeps observer schema admission (supported: ${supported})`, async () => {
            const calls  = [],
                  client = createPlaneMailboxClient({baseUrl: 'https://plane.example/mc/mcp', createSession: () => ({
                      transport: {close: async () => {}},
                      client   : {
                          connect  : async () => {}, close: async () => {},
                          listTools: async () => ({tools: [{name: 'list_messages', inputSchema: {type: 'object', properties: supported
                              ? {observer: {type: 'object', properties: {scope: {type: 'string', enum: ['all']}}}}
                              : {}}}]}),
                          callTool: async ({name, arguments: args}) => {
                              calls.push({name, args});
                              return {content: [{type: 'text', text: JSON.stringify(name === 'list_permissions' ? {identity: '@neo-gpt'} : page())}]}
                          }
                      }
                  })});

            try {
                expect((await client.init({expectedIdentity: '@neo-gpt'})).ok).toBe(true);
                const result = await source(args => client.listMessages(args)).readActivitySnapshot({observer, limit: 2});
                expect(result.capability.slots.a2a.state).toBe(supported ? 'wired' : 'degraded');
                expect(calls.filter(call => call.name === 'list_messages')).toEqual(supported
                    ? [{name: 'list_messages', args: {box: 'all', status: 'all', limit: 2, observer}}] : []);
                expect(result.capability.slots['pr-lane'].state).toBe('wired')
            } finally {
                await client.close()
            }
        })
    }

    test('a mixed display cut restarts the source page; A2A-only continuation reaches later authorized mail', async () => {
        const asks = [],
              read = source(async args => {
                  asks.push(args);
                  return args.offset === 2
                      ? page([message('later')], {offset: 2, totalCount: 3})
                      : page([message('first'), message('second')], {totalCount: 3, truncated: true, nextOffset: 2})
              }),
              mixed = await read.readActivitySnapshot({observer, limit: 2});

        expect(mixed.events.map(event => event.eventId)).toContain('pr:new');
        expect(mixed.a2a.page.nextOffset).toBe(2);
        expect(mixed.a2a.continuation).toEqual({slots: ['a2a'], offset: 0});
        const full = await read.readActivitySnapshot({observer, limit: 2, ...mixed.a2a.continuation});
        expect(full.events.map(event => event.payload.messageId)).toEqual(['MESSAGE:first', 'MESSAGE:second']);
        expect(full.a2a.continuation).toEqual({slots: ['a2a'], offset: 2});
        const later = await read.readActivitySnapshot({observer, limit: 2, ...full.a2a.continuation});
        expect(later.events.map(event => event.payload.messageId)).toEqual(['MESSAGE:later']);
        expect(later.a2a.continuation).toBeNull();
        expect(asks.map(args => args.offset)).toEqual([undefined, undefined, 2])
    });

    for (const refusal of [undefined, {}, {messages: 'malformed'}, {status: 'rejected', reason: 'schema unsupported'}, page([], {observation: undefined}), page([], {nextOffset: 9}), page([null]), page([message('wrong-count')], {totalCount: 0}), page([], {status: 'not-wired'})]) {
        test(`malformed/refused observer result ${JSON.stringify(refusal)} degrades only A2A`, async () => {
            const result = await source(async () => refusal).readActivitySnapshot({observer, limit: 2});

            expect(result.capability.state).toBe('degraded');
            expect(result.capability.slots.a2a.state).toBe('degraded');
            expect(result.capability.slots['pr-lane'].state).toBe('wired');
            expect(result.events.some(event => event.eventId === 'pr:new')).toBe(true);
            expect(result.counts).toEqual([]);
            expect(result.a2a).toBeUndefined()
        })
    }

    test('empty, clamped and unavailable remain distinct', async () => {
        const empty       = await source(async () => page()).readActivitySnapshot({observer, limit: 2}),
              clamped     = await source(async () => page([], {observation: {...observation, policy: 'private', clamped: true}})).readActivitySnapshot({observer, limit: 2}),
              unavailable = await wireFleetActivityReadSource({bridge: {}, readPrLane: prLane}).readActivitySnapshot({observer, limit: 2});

        expect(empty.a2a.page.totalCount).toBe(0);
        expect(empty.a2a.observation.clamped).toBe(false);
        expect(clamped.a2a.observation).toEqual({...observation, policy: 'private', clamped: true});
        expect(unavailable.a2a).toBeUndefined();
        expect(unavailable.capability.state).toBe('degraded')
    });

    for (const params of [{observer: {...observer, viewer: '@bob'}}, {observer, viewer: '@bob'}, {observer, to: '@bob'}, {observer, agentIdentity: '@bob'}, {observer: null}]) {
        test(`identity/selector override ${JSON.stringify(params)} never reaches storage`, async () => {
            let   reads  = 0;
            const result = await source(async () => { reads++; return page() }).readActivitySnapshot({...params, limit: 2});
            expect(reads).toBe(0);
            expect(result.capability.state).toBe('degraded');
            expect(result.events.some(event => event.eventId === 'pr:new')).toBe(true)
        })
    }

    for (const observerFinishesFirst of [true, false]) {
        test(`explicit observer never displaces ordinary held mail or lane claims (observer first: ${observerFinishesFirst})`, async () => {
            const waits = [], saves = [],
                  read  = source(args => new Promise(resolve => waits.push({args, resolve})), {
                      resolveViewerIdentity: () => '@viewer',
                      laneClaimSource      : 'test-mailbox',
                      laneClaimStore       : {load: () => null, save: value => saves.push(value)}
                  });
            const ordinary       = read.readActivitySnapshot({limit: 2}),
                  observed       = read.readActivitySnapshot({observer, limit: 2}),
                  ordinaryResult = page([message('own', '[lane-claim] own lane')]),
                  observedResult = page([message('foreign', '[lane-claim] foreign lane')]);

            const first = observerFinishesFirst ? 1 : 0, second = 1 - first;
            waits[first].resolve(first === 0 ? ordinaryResult : observedResult);
            await (first === 0 ? ordinary : observed);
            waits[second].resolve(second === 0 ? ordinaryResult : observedResult);
            await Promise.all([ordinary, observed]);
            expect(waits[0].args.observer).toBeUndefined();
            expect(read.readHeldA2ASnapshot().events[0].payload.messageId).toBe('MESSAGE:own');
            expect(read.readHeldA2ASnapshot().laneClaims.map(row => row.payload.subject)).toEqual(['[lane-claim] own lane']);
            expect(saves).toHaveLength(1)
        })
    }
});

/**
 * @summary The origin walk over a content root: the pre-split single-origin tree keeps today's bare
 * ids; a corpus checkout root reads every origin the index declares and keys colliding numbers apart;
 * an origin the tree lacks degrades the slot BY NAME while the others' rows stay; only a root with no
 * readable origin takes the whole slot down. Real temp trees, the real readers, a stub graph.
 */
test.describe('Neo.ai.services.fleet.wireFleetActivityReadSource — corpus origins', () => {
    const stubBridge = () => ({activitySource: 'UNTOUCHED'});

    function writeIssue(dir, number, {title = `issue ${number}`, updatedAt = '2026-09-22T10:00:00Z'} = {}) {
        fs.mkdirSync(path.join(dir, 'chunk-1'), {recursive: true});
        fs.writeFileSync(path.join(dir, 'chunk-1', `issue-${number}.md`),
            `---\nid: ${number}\ntitle: ${title}\nstate: OPEN\nlabels: []\nassignees: []\ncreatedAt: '${updatedAt}'\nupdatedAt: '${updatedAt}'\ngithubUrl: 'https://example.test/issues/${number}'\n---\nbody\n`)
    }

    function writePull(dir, number, {title = `pr ${number}`, updatedAt = '2026-09-22T10:00:00Z'} = {}) {
        fs.mkdirSync(path.join(dir, 'chunk-1'), {recursive: true});
        fs.writeFileSync(path.join(dir, 'chunk-1', `pr-${number}.md`),
            `---\nnumber: ${number}\ntitle: '${title}'\nauthor: someone\nstate: OPEN\ncreatedAt: '${updatedAt}'\nupdatedAt: '${updatedAt}'\nurl: 'https://example.test/pull/${number}'\n---\nbody\n`)
    }

    function writeIndex(root, slugs) {
        fs.writeFileSync(path.join(root, '_index.json'), JSON.stringify(
            slugs.map(repoSlug => ({repoSlug, type: 'issues', id: 7, version: null, chunkNumber: 1, path: `${repoSlug}/issues/chunk-1/issue-7.md`}))
        ))
    }

    function readPrLane(contentRoot, params = {limit: 10}) {
        let captured = null;

        wireFleetActivityReadSource({
            contentRoot,
            graphService: {},   // the stall inference's graph joins are guarded; a stub keeps the unit off the singleton
            bridge      : stubBridge(),
            createSource: opts => { captured = opts; return {readActivitySnapshot() {}} }
        });

        return captured.readPrLaneSnapshot(params)
    }

    test('a legacy root (issues/ directly under it) is the Graph origin with bare ids — even beside a corpus-shaped index', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-legacy-'));

        try {
            writeIssue(path.join(root, 'issues'), 7);
            writePull(path.join(root, 'pulls'), 7);
            // The orchestrator's materialized root keeps the corpus index verbatim beside a single
            // materialized origin: the directory decides, the index must not.
            writeIndex(root, ['neo', 'neo-agent-brain']);

            expect(resolveContentOrigins(root)).toEqual([{repoSlug: 'neo', issuesDir: path.join(root, 'issues'), pullsDir: path.join(root, 'pulls')}]);

            const snapshot = await readPrLane(root);

            expect(snapshot.capability.state).toBe('wired');
            expect(snapshot.events.map(event => event.eventId).sort()).toEqual([`${FLEET_COCKPIT_SOURCES.githubIssue}:7`, `${FLEET_COCKPIT_SOURCES.githubPr}:7`].sort());
            expect(snapshot.events.every(event => event.payload.repoSlug === 'neo')).toBe(true)
        } finally {
            fs.rmSync(root, {recursive: true, force: true})
        }
    });

    test('a corpus root reads every origin the index declares and keys colliding numbers apart', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-corpus-'));

        try {
            writeIndex(root, ['neo-agent-brain', 'neo']);
            writeIssue(path.join(root, 'neo', 'issues'), 7, {title: 'home seven'});
            fs.mkdirSync(path.join(root, 'neo', 'pulls'), {recursive: true});
            writeIssue(path.join(root, 'neo-agent-brain', 'issues'), 7, {title: 'brain seven'});
            writePull(path.join(root, 'neo-agent-brain', 'pulls'), 7);

            expect(resolveContentOrigins(root).map(origin => origin.repoSlug)).toEqual(['neo', 'neo-agent-brain']);

            const snapshot = await readPrLane(root),
                  ids      = snapshot.events.map(event => event.eventId).sort();

            expect(snapshot.capability.state).toBe('wired');
            expect(ids).toEqual([
                `${FLEET_COCKPIT_SOURCES.githubIssue}:7`,
                `${FLEET_COCKPIT_SOURCES.githubIssue}:neo-agent-brain#7`,
                `${FLEET_COCKPIT_SOURCES.githubPr}:neo-agent-brain#7`
            ].sort());
            expect(snapshot.events.find(event => event.eventId === `${FLEET_COCKPIT_SOURCES.githubIssue}:neo-agent-brain#7`).payload).toMatchObject({number: 7, repoSlug: 'neo-agent-brain', title: 'brain seven'})
        } finally {
            fs.rmSync(root, {recursive: true, force: true})
        }
    });

    test('an origin the index names but the tree lacks degrades the slot BY NAME and keeps the other origin\'s rows', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-partial-'));

        try {
            writeIndex(root, ['neo', 'devindex']);
            writeIssue(path.join(root, 'neo', 'issues'), 7);
            fs.mkdirSync(path.join(root, 'neo', 'pulls'), {recursive: true});

            const snapshot = await readPrLane(root);

            expect(snapshot.capability.state).toBe('degraded');
            expect(snapshot.capability.reason).toContain('devindex');
            expect(snapshot.events.map(event => event.type).sort()).toEqual(['issue-activity', 'source-degraded'])
        } finally {
            fs.rmSync(root, {recursive: true, force: true})
        }
    });

    test('a corpus root with no readable origin at all takes the whole slot down — the pre-existing contract', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-dead-'));

        try {
            writeIndex(root, ['neo', 'devindex']);

            const snapshot = await readPrLane(root);

            expect(snapshot.capability).toMatchObject({state: 'degraded', confidence: 'none'});
            expect(snapshot.events.map(event => event.type)).toEqual(['source-degraded'])
        } finally {
            fs.rmSync(root, {recursive: true, force: true})
        }
    });

    test('the PR bound ranks by the event time: an older-numbered PR updated today survives a limit that a newer-numbered January PR does not', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-prbound-'));

        try {
            writeIndex(root, ['neo']);
            fs.mkdirSync(path.join(root, 'neo', 'issues'), {recursive: true});
            writePull(path.join(root, 'neo', 'pulls'), 8, {updatedAt: '2026-01-15T00:00:00Z'});
            writePull(path.join(root, 'neo', 'pulls'), 7, {updatedAt: '2026-09-22T12:00:00Z'});

            const snapshot = await readPrLane(root, {limit: 1});

            expect(snapshot.events.map(event => event.eventId)).toEqual([`${FLEET_COCKPIT_SOURCES.githubPr}:7`])
        } finally {
            fs.rmSync(root, {recursive: true, force: true})
        }
    });

    test('the bound applies after the merge: a quiet origin\'s newest row is never cut by a busy origin\'s older rows', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-bound-'));

        try {
            writeIndex(root, ['neo', 'neo-agent-institution']);
            for (const number of [1, 2, 3, 4, 5]) {
                writeIssue(path.join(root, 'neo', 'issues'), number, {updatedAt: `2026-01-0${number}T00:00:00Z`})
            }
            fs.mkdirSync(path.join(root, 'neo', 'pulls'), {recursive: true});
            writeIssue(path.join(root, 'neo-agent-institution', 'issues'), 9, {updatedAt: '2026-09-22T12:00:00Z'});
            fs.mkdirSync(path.join(root, 'neo-agent-institution', 'pulls'), {recursive: true});

            const snapshot = await readPrLane(root, {limit: 3});

            expect(snapshot.events).toHaveLength(3);
            expect(snapshot.events[0].eventId).toBe(`${FLEET_COCKPIT_SOURCES.githubIssue}:neo-agent-institution#9`)
        } finally {
            fs.rmSync(root, {recursive: true, force: true})
        }
    })
});
