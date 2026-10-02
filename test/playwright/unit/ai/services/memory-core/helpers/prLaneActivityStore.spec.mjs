import {test, expect}              from '@playwright/test';
import fs                          from 'node:fs';
import os                          from 'node:os';
import path                        from 'node:path';
import {createPrLaneActivityStore} from '../../../../../../../ai/services/memory-core/helpers/prLaneActivityStore.mjs';
import {makeReadPrLaneSnapshot}    from '../../../../../../../ai/services/fleet/readPrLaneActivitySnapshot.mjs';
import {FLEET_COCKPIT_SOURCES}     from '../../../../../../../src/fleet/contract/cockpit.mjs';

/**
 * The plane half of the Fleet's PR/lane slot: Memory Core runs the slot's own read path over the
 * corpus the orchestrator materializes and answers the bounded snapshot. Real temp trees in the
 * materialized single-origin layout (`issues/`, `pulls/` and `_index.json` directly under the root);
 * a stub graph keeps the unit off the singleton.
 */
test.describe('prLaneActivityStore — the plane serves the Fleet\'s PR/lane slot', () => {
    let root;

    const
        writeIssue = number => {
            fs.mkdirSync(path.join(root, 'issues', 'chunk-1'), {recursive: true});
            fs.writeFileSync(path.join(root, 'issues', 'chunk-1', `issue-${number}.md`),
                `---\nid: ${number}\ntitle: issue ${number}\nstate: OPEN\nlabels: []\nassignees: []\ncreatedAt: '2026-09-22T10:00:00Z'\nupdatedAt: '2026-09-22T10:00:00Z'\ngithubUrl: 'https://example.test/issues/${number}'\n---\nbody\n`)
        },
        writePull  = number => {
            fs.mkdirSync(path.join(root, 'pulls', 'chunk-1'), {recursive: true});
            fs.writeFileSync(path.join(root, 'pulls', 'chunk-1', `pr-${number}.md`),
                `---\nnumber: ${number}\ntitle: 'pr ${number}'\nauthor: someone\nstate: OPEN\ncreatedAt: '2026-09-22T10:00:00Z'\nupdatedAt: '2026-09-22T10:00:00Z'\nurl: 'https://example.test/pull/${number}'\n---\nbody\n`)
        },
        writeIndex = () => fs.writeFileSync(path.join(root, '_index.json'),
            JSON.stringify([{repoSlug: 'neo', type: 'issues', id: 7, version: null, chunkNumber: 1, path: 'issues/chunk-1/issue-7.md'}])),
        countingStore = counter => createPrLaneActivityStore({
            makeReader: options => { counter.reads++; return makeReadPrLaneSnapshot(options) }
        });

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-lane-store-'))
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('a materialized tree answers the slot\'s wired snapshot, stamped with its index instant', async () => {
        writeIssue(7);
        writePull(7);
        writeIndex();

        const answer = await createPrLaneActivityStore().read({root, graphService: {}, limit: 10});

        expect(answer.capability.state).toBe('wired');
        expect(answer.events.map(event => event.eventId).sort()).toEqual([`${FLEET_COCKPIT_SOURCES.githubIssue}:7`, `${FLEET_COCKPIT_SOURCES.githubPr}:7`].sort());
        expect(answer.corpusIndexedAt).toBe(new Date(fs.statSync(path.join(root, '_index.json')).mtimeMs).toISOString())
    });

    test('a tree that was never materialized answers degraded with the reader\'s reason — never an empty success', async () => {
        const answer = await createPrLaneActivityStore().read({root: path.join(root, 'not-materialized'), graphService: {}, limit: 10});

        expect(answer.capability.state).toBe('degraded');
        expect(answer.capability.reason).toMatch(/ENOENT/);
        expect(answer.events.some(event => event.type === 'source-degraded')).toBe(true);
        expect(answer.corpusIndexedAt).toBeNull()
    });

    test('the tree is read once per materialization, and again once the index is rewritten', async () => {
        writeIssue(7);
        writePull(7);
        writeIndex();

        const
            counter = {reads: 0},
            store   = countingStore(counter),
            first   = await store.read({root, graphService: {}, limit: 10}),
            second  = await store.read({root, graphService: {}, limit: 10});

        expect(counter.reads).toBe(1);
        expect(second).toBe(first);

        const rewritten = new Date(Date.now() + 60_000);
        fs.utimesSync(path.join(root, '_index.json'), rewritten, rewritten);

        await store.read({root, graphService: {}, limit: 10});
        expect(counter.reads).toBe(2)
    });

    test('an index over an unreadable tree (mid-swap) is degraded and read again on the next call', async () => {
        writeIndex();

        const counter = {reads: 0},
              store   = countingStore(counter);

        expect((await store.read({root, graphService: {}, limit: 10})).capability.state).toBe('degraded');
        await store.read({root, graphService: {}, limit: 10});
        expect(counter.reads).toBe(2)
    });

    test('a different limit is a different answer', async () => {
        writeIssue(7);
        writePull(7);
        writeIndex();

        const counter = {reads: 0},
              store   = countingStore(counter);

        expect((await store.read({root, graphService: {}, limit: 10})).events).toHaveLength(2);
        expect((await store.read({root, graphService: {}, limit: 1})).events).toHaveLength(1);
        expect(counter.reads).toBe(2)
    });

    test('`prEvents: false` is an answer without pull-request events, kept apart from the full one', async () => {
        writeIssue(7);
        writePull(7);
        writeIndex();

        const counter = {reads: 0},
              store   = countingStore(counter),
              full    = await store.read({root, graphService: {}, limit: 10}),
              lean    = await store.read({root, graphService: {}, limit: 10, prEvents: false});

        expect(full.events.map(event => event.type).sort()).toEqual(['issue-activity', 'pr-activity']);
        expect(lean.events.map(event => event.type)).toEqual(['issue-activity']);
        expect(lean.capability.state).toBe('wired');
        expect(counter.reads).toBe(2);

        // each answer is kept under its own key
        expect(await store.read({root, graphService: {}, limit: 10, prEvents: false})).toBe(lean);
        expect(await store.read({root, graphService: {}, limit: 10})).toBe(full);
        expect(counter.reads).toBe(2)
    });
});
