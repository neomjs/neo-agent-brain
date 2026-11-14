import { setup } from '../../../../setup.mjs';

const appName = 'GraphServiceReadSceneGraphTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import                                    'neo.mjs/src/manager/Instance.mjs';
import SQLite                        from '../../../../../../ai/graph/storage/SQLite.mjs';
import fs                            from 'fs-extra';
import path                          from 'path';
import Ajv                           from 'ajv';
import * as yaml                     from 'js-yaml';
import {createFleetGraphSceneSource} from '../../../../../../ai/services/fleet/fleetGraphSceneSource.mjs';

/**
 * `GraphService.readSceneGraph` over a real SQLite store: the SQL RLS clause and the `isRlsVisible` recheck
 * decide what a requester sees, and the scene holds all of it, in columnar form.
 */

const
    node = (id, properties = {}) => ({id, label: properties.kind ?? 'ISSUE', properties: {name: `name ${id}`, ...properties}}),
    edge = (id, source, target, type = 'REL', properties = {}) => ({id, source, target, type, properties: {weight: 1, ...properties}});

/**
 * @summary Read the columnar answer back as rows, so an assertion names ids rather than indices.
 * @param {Object} answer
 * @returns {{nodes: String[], edges: String[]}}
 */
function rowsOf(answer) {
    const
        {ids} = answer.nodes,
        edges = [];

    for (let index = 0; index < answer.edges.length; index += 3) {
        edges.push(`${ids[answer.edges[index]]} -${answer.types[answer.edges[index + 2]]}-> ${ids[answer.edges[index + 1]]}`)
    }

    return {nodes: ids, edges}
}

test.describe('GraphService.readSceneGraph — the whole graph one viewer may see', () => {
    let GraphService, originalDb, storage, dbPath, requester;

    test.beforeAll(async () => {
        GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        dbPath       = path.resolve(process.cwd(), 'tmp', `graph-scene-${globalThis.crypto.randomUUID()}.sqlite`);
        storage      = Neo.create(SQLite, {dbPath});

        // Neo.create already runs initAsync: a second call races it, and the loser's service import lands
        // after the stub below, which is how a CI worker read this graph as nobody
        await storage.ready();

        storage.RequestContextService = {getUserId: () => requester};

        storage.addNodes([
            node('shared-a'),
            node('shared-b', {kind: 'CONCEPT'}),
            node('own-x',   {userId: 'tenant-x'}),
            node('other-y', {userId: 'tenant-y'}),
            node('team-t',  {userId: 'tenant-y', visibility: 'team'}),
            node('lonely')
        ]);
        storage.addEdges([
            edge('e1', 'shared-a', 'shared-b'),
            edge('e2', 'shared-a', 'shared-b'),                                  // a parallel edge of one type
            edge('e3', 'shared-a', 'own-x', 'REL', {userId: 'tenant-x'}),
            edge('e4', 'shared-a', 'other-y'),                                   // its endpoint is tenant-y's
            edge('e5', 'shared-b', 'team-t', 'PRIVATE', {userId: 'tenant-y'}),  // a private edge between visible nodes
            edge('e6', 'shared-b', 'team-t', 'GUIDES', {visibility: 'team'})
        ])
    });

    test.beforeEach(() => {
        originalDb      = GraphService.db;
        GraphService.db = {storage};
        requester       = '@tenant-x'
    });

    test.afterEach(() => {
        GraphService.db = originalDb
    });

    test.afterAll(() => {
        if (storage.db?.open) {
            storage.db.close()
        }

        for (const suffix of ['', '-wal', '-shm']) {
            fs.removeSync(dbPath + suffix)
        }
    });

    test('RLS on nodes and edges: an unseen node leaves with its edges, a private edge between visible nodes is absent, and neither is a cut', async () => {
        const answer = await GraphService.readSceneGraph();

        expect(rowsOf(answer)).toEqual({
            nodes: ['lonely', 'own-x', 'shared-a', 'shared-b', 'team-t'],
            edges: ['shared-a -REL-> own-x', 'shared-a -REL-> shared-b', 'shared-b -GUIDES-> team-t']
        });
        expect(answer.counts, 'the node with no visible relation is in the scene, and counted').toEqual({nodes: 5, edges: 3, unlinked: 1});
        expect(answer.truncated).toEqual({nodes: false, edges: false});
        expect(answer.nodes.labels).toEqual(['name lonely', 'name own-x', 'name shared-a', 'name shared-b', 'name team-t']);
        expect(answer.kinds[answer.nodes.kinds[3]]).toBe('CONCEPT');
        expect(JSON.stringify(answer), 'display fields only: no owner, no property bag').not.toMatch(/tenant-|properties|weight/)
    });

    test('another requester sees its own graph through the same read', async () => {
        requester = 'tenant-y';

        expect(rowsOf(await GraphService.readSceneGraph())).toEqual({
            nodes: ['lonely', 'other-y', 'shared-a', 'shared-b', 'team-t'],
            edges: ['shared-a -REL-> other-y', 'shared-a -REL-> shared-b', 'shared-b -GUIDES-> team-t', 'shared-b -PRIVATE-> team-t']
        })
    });

    test('a node budget keeps the best-connected nodes and the edges among them, and says truncated', async () => {
        const answer = await GraphService.readSceneGraph({maxNodes: 2});

        expect(rowsOf(answer), 'the unlinked node goes first').toEqual({nodes: ['shared-a', 'shared-b'], edges: ['shared-a -REL-> shared-b']});
        expect(answer.budget).toEqual({maxNodes: 2, maxEdges: 500000});
        expect(answer.truncated).toEqual({nodes: true, edges: true})
    });

    test('an edge budget cuts the edge list in its order and leaves the nodes whole', async () => {
        const answer = await GraphService.readSceneGraph({maxEdges: 1});

        expect(rowsOf(answer).edges).toEqual(['shared-a -REL-> own-x']);
        expect(answer.counts, 'unlinked counts the answer: the nodes no answered edge names').toEqual({nodes: 5, edges: 1, unlinked: 3});
        expect(answer.truncated).toEqual({nodes: false, edges: true})
    });

    test('without the durable store the read refuses rather than answer the node cache as the graph', async () => {
        GraphService.db = {nodes: {items: []}};

        await expect(GraphService.readSceneGraph()).rejects.toThrow(/needs the SQLite store/)
    });
});

test.describe('GraphService.readSceneGraph — paged across a large graph', () => {
    test('the Fleet wire preserves two-origin attribution, unknown lists and RLS through projection', async () => {
        const
            GraphService                  = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default,
            {default: FleetControlBridge} = await import('../../../../../../ai/services/fleet/FleetControlBridge.mjs'),
            originalDb                    = GraphService.db,
            dbPath                        = path.resolve(process.cwd(), 'tmp', `graph-actors-${globalThis.crypto.randomUUID()}.sqlite`),
            storage                       = Neo.create(SQLite, {dbPath});

        try {
            await storage.ready();
            storage.RequestContextService = {getUserId: () => 'tenant-x'};
            storage.addNodes([
                node('neomjs/neo#issue-1', {author: 'alice', assignees: []}),
                node('neomjs/brain#issue-1', {author: '@bob', assignees: ['bob', '@carol']}),
                node('neomjs/neo#pr-2', {kind: 'PULL_REQUEST'}),
                node('private-3', {userId: 'tenant-y', author: 'hidden-actor', assignees: ['hidden-assignee']}),
                node('memory-1', {kind: 'AGENT_MEMORY', agentIdentity: '@alice', author: 'wrong-kind-author'}),
                node('concept-1', {kind: 'CONCEPT', author: 'wrong-kind-concept'})
            ]);
            storage.addEdges([
                edge('origins', 'neomjs/neo#issue-1', 'neomjs/brain#issue-1'),
                edge('hidden', 'private-3', 'neomjs/neo#issue-1')
            ]);
            GraphService.db = {storage};
            const wire = await GraphService.readSceneGraph();
            expect([...wire.actors].sort()).toEqual(['@alice', '@bob', '@carol']);
            const specification = yaml.load(await fs.readFile(path.resolve('ai/mcp/server/memory-core/openapi.yaml'), 'utf8'));
            const validate      = new Ajv({strict: false}).compile(specification.paths['/graph/scene'].post.responses['200'].content['application/json'].schema);
            expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
            expect(validate({...wire, nodes: {...wire.nodes, assignedTo: [[-1]]}})).toBe(false);
            const source = createFleetGraphSceneSource({
                getGraphScene   : () => GraphService.readSceneGraph(),
                getComputedRoute: async () => ({status: 'available', route: {route: {items: [{id: 'neomjs/brain#issue-1'}]}}})
            });
            const read = await FleetControlBridge.fleetGraphScene.call({graphSceneSource: source});
            const byId = new Map(read.scene.nodes.map(row => [row.id, row]));
            expect(byId.get('neomjs/neo#issue-1')).toMatchObject({authoredBy: '@alice', assignedTo: []});
            expect(byId.get('neomjs/brain#issue-1')).toMatchObject({authoredBy: '@bob', assignedTo: ['@bob', '@carol']});
            expect(byId.get('neomjs/neo#pr-2')).toMatchObject({authoredBy: null, assignedTo: null});
            expect(byId.get('neomjs/neo#memory-1')).toMatchObject({memoryOf: '@alice'});
            expect(byId.get('neomjs/neo#concept-1')).not.toHaveProperty('authoredBy');
            expect(JSON.stringify(read)).not.toMatch(/hidden-|private-3|wrong-kind/);
            expect(read.scene.edges).toEqual([{from: 'neomjs/neo#issue-1', to: 'neomjs/brain#issue-1', type: 'REL'}]);
            expect(read.scene.route).toEqual(['neomjs/brain#issue-1']);
            expect((await source.readGraphScene()).snapshotId).toBe(read.snapshotId);
            const bounded = await GraphService.readSceneGraph({maxNodes: 1});
            expect(bounded.nodes.ids).toEqual(['neomjs/brain#issue-1']);
            expect([...bounded.actors].sort()).toEqual(['@bob', '@carol']);
            storage.addNodes([node('neomjs/neo#issue-1', {author: 'dana', assignees: []})]);
            const changed = await source.readGraphScene();
            expect(changed.snapshotId).not.toBe(read.snapshotId);
            expect(changed.scene.nodes.find(row => row.id === 'neomjs/brain#issue-1').authoredBy).toBe('@bob');
        } finally {
            GraphService.db = originalDb;
            if (storage.db?.open) storage.db.close();
            for (const suffix of ['', '-wal', '-shm']) fs.removeSync(dbPath + suffix);
        }
    });

    test('the geometry columns align with the ids, read each kind\'s named field, and a hidden node contributes nothing', async () => {
        const
            GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default,
            originalDb   = GraphService.db,
            dbPath       = path.resolve(process.cwd(), 'tmp', `graph-geometry-${globalThis.crypto.randomUUID()}.sqlite`),
            storage      = Neo.create(SQLite, {dbPath});

        try {
            await storage.ready();
            storage.RequestContextService = {getUserId: () => 'tenant-x'};
            const assertedAt = new Date().toISOString();

            storage.addNodes([
                node('issue-1',   {gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.8, updatedAt: '2026-09-28T10:00:00.000Z'}),
                node('issue-2'),
                node('issue-3',   {updatedAt: 'not a time'}),
                node('file-1',    {kind: 'FILE', mtimeMs: 1790590000000.625}),
                node('memory-1',  {kind: 'AGENT_MEMORY', timestamp: '2026-09-28T09:00:00Z', gravity_well: 'yes', gravity_well_asserted_at: assertedAt}),
                node('concept-1', {kind: 'CONCEPT', gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.5, updatedAt: '2026-09-28T08:00:00Z'}),
                node('private-1', {userId: 'tenant-y', gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.99, updatedAt: '2026-09-28T11:00:00Z'})
            ]);
            GraphService.db = {storage};

            const
                wire = await GraphService.readSceneGraph(),
                row  = id => ['gravityWell', 'strategicWeight', 'lastActivityAt'].map(column => wire.nodes[column][wire.nodes.ids.indexOf(id)]);

            expect(Object.keys(wire.activitySources)).toEqual(Object.keys(GraphService.sceneActivitySources));
            expect(wire.activitySources.ISSUE, 'no source records its capture time, so its freshness is stated unknown').toEqual({field: 'updatedAt', sourceCapturedAt: null});
            expect(wire.activitySources.FILE).toEqual({field: 'mtimeMs', sourceCapturedAt: null});
            expect(wire.nodes.ids).toEqual(['concept-1', 'file-1', 'issue-1', 'issue-2', 'issue-3', 'memory-1']);
            expect(row('issue-1')).toEqual([1, 0.8, Date.parse('2026-09-28T10:00:00.000Z')]);
            expect(row('issue-2'), 'a mapped kind without its field').toEqual([0, null, null]);
            expect(row('issue-3'), 'an unreadable field').toEqual([0, null, null]);
            expect(row('file-1'), 'a file mtime, in whole ms').toEqual([0, null, 1790590000001]);
            expect(row('memory-1'), 'only a boolean anchor is a well').toEqual([0, null, Date.parse('2026-09-28T09:00:00Z')]);
            expect(row('concept-1'), 'a kind without a source reads null, whatever fields it carries').toEqual([1, 0.5, null]);
            expect(JSON.stringify(wire), 'the hidden node leaves no trace').not.toMatch(/private-1|0\.99|gravity_well_asserted_at/);

            const
                specification = yaml.load(await fs.readFile(path.resolve('ai/mcp/server/memory-core/openapi.yaml'), 'utf8')),
                validate      = new Ajv({strict: false}).compile(specification.paths['/graph/scene'].post.responses['200'].content['application/json'].schema);

            expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
            expect(validate({...wire, nodes: {...wire.nodes, gravityWell: wire.nodes.gravityWell.map(() => 2)}})).toBe(false)
        } finally {
            GraphService.db = originalDb;
            if (storage.db?.open) storage.db.close();
            for (const suffix of ['', '-wal', '-shm']) fs.removeSync(dbPath + suffix);
        }
    });

    test('the state column codes each issue, PR and discussion by its stored state, and -1 for every other kind', async () => {
        const
            GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default,
            originalDb   = GraphService.db,
            dbPath       = path.resolve(process.cwd(), 'tmp', `graph-state-${globalThis.crypto.randomUUID()}.sqlite`),
            storage      = Neo.create(SQLite, {dbPath});

        try {
            await storage.ready();
            storage.RequestContextService = {getUserId: () => 'tenant-x'};
            storage.addNodes([
                node('issue-1',      {state: 'CLOSED'}),
                node('issue-2'),
                node('pr-3',         {kind: 'PULL_REQUEST', state: 'MERGED'}),
                node('discussion-4', {kind: 'DISCUSSION', state: 'OPEN'}),
                node('memory-5',     {kind: 'AGENT_MEMORY', state: 'OPEN'}),
                node('private-6',    {userId: 'tenant-y', state: 'DRAFT'})
            ]);
            GraphService.db = {storage};

            const
                wire = await GraphService.readSceneGraph(),
                code = id => wire.nodes.state[wire.nodes.ids.indexOf(id)];

            expect(wire.nodes.ids).toEqual(['discussion-4', 'issue-1', 'issue-2', 'memory-5', 'pr-3']);
            expect(['issue-1', 'pr-3', 'discussion-4'].map(id => wire.states[code(id)])).toEqual(['CLOSED', 'MERGED', 'OPEN']);
            expect(code('issue-2'), 'a work item with no stored state').toBe(-1);
            expect(code('memory-5'), 'a kind without a lifecycle codes -1, whatever it carries').toBe(-1);
            expect([...wire.states].sort(), 'the dictionary holds the answered states only').toEqual(['CLOSED', 'MERGED', 'OPEN']);
            expect(JSON.stringify(wire), 'the hidden node leaves no trace').not.toMatch(/private-6|DRAFT/);

            const
                specification = yaml.load(await fs.readFile(path.resolve('ai/mcp/server/memory-core/openapi.yaml'), 'utf8')),
                validate      = new Ajv({strict: false}).compile(specification.paths['/graph/scene'].post.responses['200'].content['application/json'].schema);

            expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
            expect(validate({...wire, nodes: {...wire.nodes, state: wire.nodes.state.map(() => -2)}})).toBe(false)
        } finally {
            GraphService.db = originalDb;
            if (storage.db?.open) storage.db.close();
            for (const suffix of ['', '-wal', '-shm']) fs.removeSync(dbPath + suffix);
        }
    });

    test('every page lands, and the plane runs other work between pages', async () => {
        const
            GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default,
            originalDb   = GraphService.db,
            dbPath       = path.resolve(process.cwd(), 'tmp', `graph-scene-pages-${globalThis.crypto.randomUUID()}.sqlite`),
            storage      = Neo.create(SQLite, {dbPath}),
            count        = 12000,
            id           = index => `n-${String(index).padStart(5, '0')}`;

        try {
            await storage.ready();
            storage.RequestContextService = {getUserId: () => null};

            // a chain across three 5,000-row pages of each table: a page boundary that skipped a row would break it
            storage.addNodes(Array.from({length: count}, (item, index) => node(id(index))));
            storage.addEdges(Array.from({length: count - 1}, (item, index) => edge(`e-${id(index)}`, id(index), id(index + 1))));

            GraphService.db = {storage};

            let between = false;

            setImmediate(() => between = true);

            const answer = await GraphService.readSceneGraph();

            expect(between, 'a task queued behind the read ran before it finished').toBe(true);
            expect(answer.counts).toEqual({nodes: count, edges: count - 1, unlinked: 0});
            expect(answer.nodes.ids[count - 1]).toBe(id(count - 1))
        } finally {
            GraphService.db = originalDb;

            if (storage.db?.open) {
                storage.db.close()
            }

            for (const suffix of ['', '-wal', '-shm']) {
                fs.removeSync(dbPath + suffix)
            }
        }
    });

    test('closed or merged work-item anchors read gravityWell 0 and lose the flag on upsert, while open ones read 1 (#1685)', async () => {
        const
            GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default,
            CoreDatabase = (await import('../../../../../../ai/graph/Database.mjs')).default,
            originalDb   = GraphService.db,
            dbPath       = path.resolve(process.cwd(), 'tmp', `graph-anchor-state-${globalThis.crypto.randomUUID()}.sqlite`),
            storage      = Neo.create(SQLite, {dbPath}),
            db           = Neo.create(CoreDatabase, {id: `graph-anchor-state-${globalThis.crypto.randomUUID()}`, storage}),
            assertedAt   = new Date().toISOString();

        try {
            await storage.ready();
            storage.RequestContextService = {getUserId: () => 'tenant-x'};

            storage.addNodes([
                node('issue-open',        {state: 'OPEN',   gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.9}),
                node('issue-closed',      {state: 'CLOSED', gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.9}),
                node('pr-open',           {kind: 'PULL_REQUEST', state: 'OPEN',   gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.85}),
                node('pr-merged',         {kind: 'PULL_REQUEST', state: 'MERGED', gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.85}),
                node('pr-closed',         {kind: 'PULL_REQUEST', state: 'CLOSED', gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.7}),
                node('discussion-open',   {kind: 'DISCUSSION',   state: 'OPEN',   gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.8}),
                node('discussion-closed', {kind: 'DISCUSSION',   state: 'CLOSED', gravity_well: true, gravity_well_asserted_at: assertedAt, strategic_weight: 0.8})
            ]);
            await storage.load();
            GraphService.db = db;

            const
                wire = await GraphService.readSceneGraph(),
                well = id => wire.nodes.gravityWell[wire.nodes.ids.indexOf(id)],
                wt   = id => wire.nodes.strategicWeight[wire.nodes.ids.indexOf(id)];

            expect(well('issue-open')).toBe(1);
            expect(well('pr-open')).toBe(1);
            expect(well('discussion-open')).toBe(1);
            expect(well('issue-closed')).toBe(0);
            expect(well('pr-merged')).toBe(0);
            expect(well('pr-closed')).toBe(0);
            expect(well('discussion-closed')).toBe(0);
            expect(wt('issue-closed'), 'historical weight stays while the anchor flag is cleared').toBe(0.9);

            // When ingestion learns an open work item closed or merged, upsertNode clears gravity_well
            GraphService.upsertNode({id: 'issue-open', type: 'ISSUE', state: 'CLOSED', properties: {state: 'CLOSED'}});
            GraphService.upsertNode({id: 'pr-open',    type: 'PULL_REQUEST', state: 'MERGED'});
            GraphService.upsertNode({id: 'discussion-open', type: 'DISCUSSION', state: 'CLOSED', properties: {state: 'CLOSED'}});

            expect(db.nodes.get('issue-open').properties.gravity_well).toBe(false);
            expect(db.nodes.get('issue-open').properties.strategic_weight).toBe(0.9);
            expect(db.nodes.get('pr-open').properties.gravity_well).toBe(false);
            expect(db.nodes.get('discussion-open').properties.gravity_well).toBe(false);

            // A later extraction pass naming an already-closed item cannot revive its anchor flag
            GraphService.upsertNode({
                id        : 'issue-open',
                type      : 'ISSUE',
                properties: {gravity_well: true, gravity_well_asserted_at: new Date().toISOString()}
            });
            expect(db.nodes.get('issue-open').properties.gravity_well).toBe(false);

            const afterClose = await GraphService.readSceneGraph();
            expect(afterClose.nodes.gravityWell).toEqual([0, 0, 0, 0, 0, 0, 0]);
        } finally {
            GraphService.db = originalDb;
            db.destroy();
            if (storage.db?.open) storage.db.close();
            for (const suffix of ['', '-wal', '-shm']) fs.removeSync(dbPath + suffix);
        }
    });

    test('an anchor asserted outside strategicAnchorWindowMs reads 0, and a pass naming it again restores 1 (#1685)', async () => {
        const
            aiConfig               = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default,
            GraphService           = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default,
            SemanticGraphExtractor = (await import('../../../../../../ai/services/graph/SemanticGraphExtractor.mjs')).default,
            CoreDatabase           = (await import('../../../../../../ai/graph/Database.mjs')).default,
            originalDb             = GraphService.db,
            dbPath                 = path.resolve(process.cwd(), 'tmp', `graph-anchor-window-${globalThis.crypto.randomUUID()}.sqlite`),
            storage                = Neo.create(SQLite, {dbPath}),
            db                     = Neo.create(CoreDatabase, {id: `graph-anchor-window-${globalThis.crypto.randomUUID()}`, storage}),
            windowMs               = aiConfig.strategicAnchorWindowMs,
            nowMs                  = Date.now(),
            fallbackWindowMs       = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 30 * 24 * 60 * 60 * 1000,
            expiredAt              = new Date(nowMs - fallbackWindowMs - 60_000).toISOString(),
            freshAt                = new Date(nowMs - 60_000).toISOString();

        try {
            await storage.ready();
            storage.RequestContextService = {getUserId: () => null};

            storage.addNodes([
                node('expired-concept',            {kind: 'CONCEPT', gravity_well: true, gravity_well_asserted_at: expiredAt, strategic_weight: 0.85}),
                node('session:v13_3_1_release',    {kind: 'SESSION', gravity_well: true, strategic_weight: 0.95}),
                node('fresh-concept',              {kind: 'CONCEPT', gravity_well: true, gravity_well_asserted_at: freshAt, strategic_weight: 0.75})
            ]);
            await storage.load();
            GraphService.db = db;

            expect(Number.isFinite(windowMs) && windowMs > 0, 'window is a positive configured leaf').toBe(true);

            const
                before = await GraphService.readSceneGraph(),
                wellIn = (scene, id) => scene.nodes.gravityWell[scene.nodes.ids.indexOf(id)];

            expect(wellIn(before, 'expired-concept')).toBe(0);
            expect(wellIn(before, 'session:v13_3_1_release')).toBe(0);
            expect(wellIn(before, 'fresh-concept')).toBe(1);

            await SemanticGraphExtractor.commitTriVectorPayload({
                session_artifact: {
                    graph: {
                        nodes: [{
                            id              : 'CONCEPT:ExpiredConcept',
                            type            : 'CONCEPT',
                            name            : 'ExpiredConcept',
                            description     : 'Re-asserted roadmap anchor.',
                            gravity_well    : true,
                            strategic_weight: 0.9
                        }],
                        edges: []
                    }
                }
            }, {
                id  : 'reassert-vector',
                meta: {sessionId: 'reassert-session'}
            });

            const afterReassert = await GraphService.readSceneGraph();
            expect(wellIn(afterReassert, 'expired-concept')).toBe(1);

            const stampedAt = db.nodes.get('expired-concept').properties.gravity_well_asserted_at;
            expect(Number.isFinite(Date.parse(stampedAt))).toBe(true);

            // A later pass mentioning the same concept without gravity_well neither wipes nor refreshes its active window
            await SemanticGraphExtractor.commitTriVectorPayload({
                session_artifact: {
                    graph: {
                        nodes: [{
                            id              : 'CONCEPT:ExpiredConcept',
                            type            : 'CONCEPT',
                            name            : 'ExpiredConcept',
                            description     : 'Passing mention in a minor fix.',
                            gravity_well    : false,
                            strategic_weight: 0.2
                        }],
                        edges: []
                    }
                }
            }, {
                id  : 'passing-mention-vector',
                meta: {sessionId: 'passing-mention-session'}
            });

            expect(db.nodes.get('expired-concept').properties.gravity_well_asserted_at).toBe(stampedAt);
            expect(wellIn(await GraphService.readSceneGraph(), 'expired-concept')).toBe(1);
        } finally {
            GraphService.db = originalDb;
            db.destroy();
            if (storage.db?.open) storage.db.close();
            for (const suffix of ['', '-wal', '-shm']) fs.removeSync(dbPath + suffix);
        }
    });
});
