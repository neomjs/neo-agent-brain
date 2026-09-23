import {setup}                       from '../../../../setup.mjs';
import {test, expect}                from '@playwright/test';
import Neo                           from 'neo.mjs/src/Neo.mjs';
import * as core                     from 'neo.mjs/src/core/_export.mjs';
import {resolveContentOrigins,
        wireFleetActivityReadSource} from '../../../../../../ai/services/fleet/wireFleetActivityReadSource.mjs';
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

        const result = wireFleetActivityReadSource({
            issuesDir   : '/synced/issues',
            listMessages: () => [],
            graphService: {},
            limit       : 25,
            bridge,
            createSource: opts => { captured = opts; return created }
        });

        expect(result).toBe(created);
        expect(bridge.activitySource).toBe(created);
        expect(typeof captured.readA2ASnapshot).toBe('function');
        expect(typeof captured.readPrLaneSnapshot).toBe('function');
        expect(captured.limit).toBe(25);
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
