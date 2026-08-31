import {test, expect} from '@playwright/test';

import fs   from 'fs-extra';
import os   from 'os';
import path from 'path';

import 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/Base.mjs';

/**
 * @summary An export that captured nothing must not report the same shape as one that captured
 * everything.
 *
 * Six of ten retained bundles carried zero KB rows and every one of them recorded a completion
 * message, so the failure mode is the steady state rather than an edge case. A zero-row export
 * against a POPULATED collection already throws `PARTIAL_COLLECTION_EXPORT`; what these specs pin is
 * the other half — a genuinely empty corpus is a real state, and saying "Export complete" about it is
 * what let four consecutive backups present as recovery sources while holding nothing.
 */
test.describe('KB export receipt on an empty collection', () => {
    let root, DatabaseService, ChromaManager, originalResolve;

    test.beforeAll(async () => {
        ({default: DatabaseService} = await import('../../../../../../ai/services/knowledge-base/DatabaseService.mjs'));
        ({default: ChromaManager}   = await import('../../../../../../ai/services/knowledge-base/ChromaManager.mjs'));
        originalResolve = ChromaManager.getKnowledgeBaseCollection;
    });

    test.afterAll(() => { ChromaManager.getKnowledgeBaseCollection = originalResolve });

    test.beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-kb-export-'));
        // `ChromaManager` is a singleton shared by every spec in this worker, and
        // `knowledgeBaseCollectionBootstrapped` describes whichever resolution ran last — including
        // one performed by a different spec file. Pinned per test so these assertions read the state
        // they declare rather than the residue of whatever ran before them.
        ChromaManager.knowledgeBaseCollectionBootstrapped = null;
    });
    test.afterEach (async () => { await fs.remove(root) });

    /**
     * @param {Number} count Rows the stubbed collection reports.
     * @returns {Promise<Object>} The export receipt.
     */
    function exportWithCollectionCount(count) {
        const collection = {
            id  : 'ab75f86b-1651-4865-96f4-0287acd42ea7',
            name: 'neo-knowledge-base',
            async count() { return count },
            async get() { return {ids: [], documents: [], embeddings: [], metadatas: []} }
        };

        // Stub only the collection SOURCE — no chroma, no network. The export path itself runs for
        // real, so the receipt under assertion is the one production builds.
        ChromaManager.getKnowledgeBaseCollection = async () => collection;

        return DatabaseService.exportDatabase({backupPath: root})
    }

    test('an empty collection is degraded WITH a reason, never complete', async () => {
        const receipt = await exportWithCollectionCount(0);

        // The branchable field. Without it a consumer must parse prose to learn the bundle is empty,
        // which is what every one of the six zero-row bundles required.
        expect(receipt.status).toBe('degraded');
        expect(receipt.status).not.toBe('complete');
        expect(receipt.reason).toBe('source-collection-empty');

        expect(receipt.message).not.toContain('Export complete');
        expect(receipt.count).toBe(0);
        expect(receipt.expected).toBe(0);
    });

    test('a collection that GREW during export is degraded, not complete', async () => {
        // Review finding, reproduced as its repro: a binary empty-or-complete status certifies the
        // classifier's `grew` outcome as a clean capture. That branch's own source says it is
        // complete-or-better but NOT provably exact, because the export pages by offset — so the
        // receipt would claim more than the producer can establish.
        //
        // One expected row, two returned. Pre-fix this reported {status: 'complete', count: 2,
        // expected: 1}.
        let   served     = 0;
        const collection = {
            id  : 'ab75f86b-1651-4865-96f4-0287acd42ea7',
            name: 'neo-knowledge-base',
            async count() { return 1 },
            async get() {
                // Two rows arrive where one was snapshotted — a late write landing mid-export.
                if (served++ > 0) { return {ids: [], documents: [], embeddings: [], metadatas: []} }

                return {
                    ids       : ['a', 'b'],
                    documents : ['one', 'two'],
                    embeddings: [[0.1], [0.2]],
                    metadatas : [{}, {}]
                }
            }
        };

        ChromaManager.getKnowledgeBaseCollection = async () => collection;

        const receipt = await DatabaseService.exportDatabase({backupPath: root});

        expect(receipt.count, 'the written total is reported').toBe(2);
        expect(receipt.expected, 'the pre-pass snapshot is reported beside it').toBe(1);

        // The property under test: growth is NOT certified as a clean capture.
        expect(receipt.status).toBe('degraded');
        expect(receipt.status).not.toBe('complete');
        expect(receipt.reason).toBe('source-grew-during-export');
        expect(receipt.message).not.toContain('Export complete');
    });

    test.describe('a BOOTSTRAPPED collection is unresolved, not empty (#270)', () => {
        // Both states hand the exporter a valid collection handle whose `count()` is `0`, so no
        // number on the receipt can separate them — `expected` and `count` are both zero either way,
        // and `expected` is read through the same resolution that produced the zero, so it agrees
        // with it rather than checking it. The discriminator has to come from the resolver, which
        // knows whether it FOUND the canonical collection or CREATED one after failing to.
        //
        // Left unsplit, one code answered "this corpus is empty" and "I could not find this corpus",
        // states with opposite operational meanings — the first is routine, the second is the
        // 2026-08-30T19:18 bundle that exported zero rows against a live 68,207 and published.
        test.afterEach(() => { ChromaManager.knowledgeBaseCollectionBootstrapped = null });

        test('a collection the resolver CREATED reports source-collection-unresolved', async () => {
            ChromaManager.knowledgeBaseCollectionBootstrapped = true;

            const receipt = await exportWithCollectionCount(0);

            expect(receipt.status).toBe('degraded');
            expect(receipt.reason).toBe('source-collection-unresolved');
            expect(receipt.reason).not.toBe('source-collection-empty');
        });

        test('a collection the resolver FOUND still reports source-collection-empty', async () => {
            // The control that keeps the split honest. Identical counts, identical status, identical
            // everything the receipt can measure — only the resolution path differs. If this returned
            // the new code too, the split would be renaming the state rather than dividing it.
            ChromaManager.knowledgeBaseCollectionBootstrapped = false;

            const receipt = await exportWithCollectionCount(0);

            expect(receipt.status).toBe('degraded');
            expect(receipt.reason).toBe('source-collection-empty');
        });

        test('an unreported resolution keeps the existing code, so older callers are unaffected', async () => {
            // `null` is "no resolution has been recorded" — every consumer that never reads the flag,
            // and every bundle written before it existed, keeps the meaning it already had.
            ChromaManager.knowledgeBaseCollectionBootstrapped = null;

            expect((await exportWithCollectionCount(0)).reason).toBe('source-collection-empty');
        });

        test('bootstrapping does not degrade a capture that actually wrote rows', async () => {
            // The flag qualifies a ZERO. A bootstrapped collection holding rows is a first-run
            // deployment that then ingested, and its capture is clean — reading the flag earlier than
            // the zero would fail it for its own history.
            ChromaManager.knowledgeBaseCollectionBootstrapped = true;

            // Serves the row it counts. `exportWithCollectionCount` reports a count without serving
            // anything, which is a genuinely PARTIAL export — it can only build the zero case.
            let   served     = 0;
            const collection = {
                id  : 'ab75f86b-1651-4865-96f4-0287acd42ea7',
                name: 'neo-knowledge-base',
                async count() { return 1 },
                async get() {
                    if (served++ > 0) { return {ids: [], documents: [], embeddings: [], metadatas: []} }

                    return {ids: ['a'], documents: ['one'], embeddings: [[0.1]], metadatas: [{}]}
                }
            };

            ChromaManager.getKnowledgeBaseCollection = async () => collection;

            const receipt = await DatabaseService.exportDatabase({backupPath: root});

            expect(receipt.count).toBe(1);
            expect(receipt.status).toBe('complete');
            expect(receipt.reason).toBeNull();
        });
    });

    test('the receipt carries `expected`, so a zero has something to be zero against', async () => {
        const receipt = await exportWithCollectionCount(0);

        // `mc` and `graph` already report expected/exported. The KB's omission is why a zero-row
        // export could not fail its own contract — it had none.
        expect(Object.keys(receipt)).toContain('expected');
        expect(receipt.collectionId).toBe('ab75f86b-1651-4865-96f4-0287acd42ea7');
    });
});
