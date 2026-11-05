import {setup} from '../../../../setup.mjs';

const appName = 'IngestTenantCliTest';

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
import {Readable}     from 'stream';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {acquireHeavyMaintenanceLease, inspectHeavyMaintenanceLease, releaseHeavyMaintenanceLease,
        withHeavyMaintenanceLease} from '../../../../../../ai/daemons/orchestrator/services/HeavyMaintenanceLeaseService.mjs';

/**
 * Unit coverage for the `ai:ingest-tenant` Phase 2C bulk-facade CLI.
 *
 * Tests the three exported pure units — `parseArgs`, `readJsonlRecords`, `runIngest` —
 * substrate-free: `runIngest` takes an injected `ingestFn`, so batching / error-handling /
 * summary-aggregation are verified without the Knowledge Base. The module is dynamically
 * imported in `beforeAll` (after `setup()`), and its `import.meta` main guard keeps the CLI
 * from auto-running when imported here. End-to-end CLI + Chroma behaviour is the separate
 * integration test.
 */

/**
 * Wraps an array as an async iterable for `runIngest`'s `records` parameter.
 * @param {Array} entries
 * @returns {AsyncIterable}
 */
async function* asAsyncIterable(entries) {
    for (const entry of entries) {
        yield entry;
    }
}

test.describe('ai/scripts/maintenance/ingestTenant — Phase 2C CLI (#11635)', () => {
    let parseArgs, readJsonlRecords, runIngest, runIngestTask, retainIngestRemainder, removeIngestResume, reportIngestOutcome, finalizeIngestTask;

    test.beforeAll(async () => {
        ({parseArgs, readJsonlRecords, runIngest, runIngestTask, retainIngestRemainder, removeIngestResume, reportIngestOutcome, finalizeIngestTask} = await import('../../../../../../ai/scripts/maintenance/ingestTenant.mjs'));
    });

    test.describe('parseArgs', () => {
        test('parses the tenantId positional and --from-file', () => {
            expect(parseArgs(['neo-shared', '--from-file', 'chunks.jsonl'])).toEqual({
                tenantId : 'neo-shared',
                fromFile : 'chunks.jsonl',
                fromStdin: false,
                batchSize: 500
            });
        });

        test('parses --from-stdin and a custom --batch-size', () => {
            expect(parseArgs(['tenant-a', '--from-stdin', '--batch-size', '100'])).toEqual({
                tenantId : 'tenant-a',
                fromFile : null,
                fromStdin: true,
                batchSize: 100
            });
        });

        test('defaults batchSize to 500 and tenantId to null when absent', () => {
            expect(parseArgs([])).toEqual({
                tenantId : null,
                fromFile : null,
                fromStdin: false,
                batchSize: 500
            });
        });
    });

    test.describe('readJsonlRecords', () => {
        test('keeps Unicode line separators inside stream records and preserves physical line numbers', async () => {
            const record  = {content: 'first\u2028second\u2029third'};
            const input   = Readable.from([JSON.stringify(record) + '\n\ninvalid\n']);
            const entries = [];

            for await (const entry of readJsonlRecords(input)) entries.push(entry);

            expect(entries).toHaveLength(2);
            expect(entries[0]).toEqual({record, lineNo: 1});
            expect(entries[1]).toMatchObject({lineNo: 3, parseError: expect.any(String)});
        });

        test('yields one record per JSONL line and skips blank lines', async () => {
            const entries = [];

            for await (const entry of readJsonlRecords(Readable.from('{"a":1}\n\n  \n{"a":2}\n'))) {
                entries.push(entry);
            }

            expect(entries).toEqual([
                {record: {a: 1}, lineNo: 1},
                {record: {a: 2}, lineNo: 4}
            ]);
        });

        test('yields a parseError for a malformed line without aborting the stream', async () => {
            const entries = [];

            for await (const entry of readJsonlRecords(Readable.from('{"a":1}\nNOT JSON\n{"a":3}\n'))) {
                entries.push(entry);
            }

            expect(entries[0]).toEqual({record: {a: 1}, lineNo: 1});
            expect(entries[1].lineNo).toBe(2);
            expect(typeof entries[1].parseError).toBe('string');
            expect(entries[1].record).toBeUndefined();
            expect(entries[2]).toEqual({record: {a: 3}, lineNo: 3});
        });
    });

    test.describe('runIngest', () => {
        test('batches records into batchSize groups', async () => {
            const batchSizes = [];
            const records    = asAsyncIterable(
                [1, 2, 3, 4, 5].map(n => ({record: {n}, lineNo: n}))
            );

            const totals = await runIngest({
                records,
                batchSize: 2,
                ingestFn : files => {
                    batchSizes.push(files.length);
                    return {ingested: files.length, embeddingsGenerated: files.length, deleted: 0, errors: []};
                }
            });

            expect(batchSizes).toEqual([2, 2, 1]);
            expect(totals.batches).toBe(3);
            expect(totals.ingested).toBe(5);
            expect(totals.embeddingsGenerated).toBe(5);
        });

        test('counts JSONL parseError entries and records structured errors', async () => {
            const ingested = [];
            const records  = asAsyncIterable([
                {record: {n: 1}, lineNo: 1},
                {parseError: 'Unexpected token', lineNo: 2},
                {record: {n: 3}, lineNo: 3},
                {parseError: 'Unexpected end of JSON input', lineNo: 4}
            ]);

            const totals = await runIngest({
                records,
                batchSize: 10,
                ingestFn : files => {
                    ingested.push(...files);
                    return {ingested: files.length, embeddingsGenerated: files.length, deleted: 0, errors: []};
                }
            });

            expect(totals.parseErrors).toBe(2);
            expect(totals.errors).toHaveLength(2);
            expect(totals.errors[0].code).toBe('KB_INGEST_CLI_JSONL_PARSE_FAILED');
            expect(totals.errors[0].message).toContain('Line 2');
            // ingestFn receives only the valid records
            expect(ingested).toEqual([{n: 1}, {n: 3}]);
            expect(totals.ingested).toBe(2);
        });

        test('propagates per-batch summary errors into totals.errors', async () => {
            const totals = await runIngest({
                records  : asAsyncIterable([{record: {n: 1}, lineNo: 1}]),
                batchSize: 10,
                ingestFn : () => ({
                    ingested           : 1,
                    embeddingsGenerated: 0,
                    deleted            : 0,
                    errors             : [{code: 'KB_VECTOR_EMBED_FAILED', message: 'embed failed'}]
                })
            });

            expect(totals.ingested).toBe(1);
            expect(totals.errors).toHaveLength(1);
            expect(totals.errors[0].code).toBe('KB_VECTOR_EMBED_FAILED');
        });

        test('returns the zero-summary shape for an empty stream and never calls ingestFn', async () => {
            let called = false;

            const totals = await runIngest({
                records  : asAsyncIterable([]),
                batchSize: 10,
                ingestFn : () => {
                    called = true;
                    return {ingested: 0, embeddingsGenerated: 0, deleted: 0, errors: []};
                }
            });

            expect(called).toBe(false);
            expect(totals).toEqual({
                ingested               : 0,
                embeddingsGenerated    : 0,
                deleted                : 0,
                batches                : 0,
                parseErrors            : 0,
                completedInputRecords  : 0,
                acceptedEmbeddingChunks: 0,
                settledEmbeddingChunks : 0,
                errors                 : []
            });
        });
    });

    test('expired inherited lease yields without consuming input or releasing the parent', async () => {
        const dir       = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-lease-')),
              leasePath = path.join(dir, 'lease.json'), original = process.env.NEO_HEAVY_MAINTENANCE_LEASE_INHERITED_TOKEN,
              now       = new Date(), parent = await acquireHeavyMaintenanceLease({leasePath, owner: 'parent', token: 'parent-token', pid: 999999,
                  now: new Date(now.getTime() - 3600000), staleAfterMs: 7200000, isPidAlive: () => true});
        try {
            process.env.NEO_HEAVY_MAINTENANCE_LEASE_INHERITED_TOKEN = 'parent-token';
            let read = 0, calls = 0;
            async function* records() { read++; yield {record: {id: 1}} }
            const result = await withHeavyMaintenanceLease(acquisition => runIngestTask({records: records(), batchSize: 1,
                ingestFn: () => { calls++ }}, acquisition), {leasePath, owner: 'child', now, staleAfterMs: 7200000, isPidAlive: () => true});
            expect(result.status).toBe('inherited');
            expect(result.result.yielded).toBe(true);
            expect([read, calls]).toEqual([0, 0]);
            expect((await inspectHeavyMaintenanceLease({leasePath, now, isPidAlive: () => true})).lease.token).toBe('parent-token');
            await result.result.resume.iterator.return?.();
        } finally {
            if (original === undefined) delete process.env.NEO_HEAVY_MAINTENANCE_LEASE_INHERITED_TOKEN;
            else process.env.NEO_HEAVY_MAINTENANCE_LEASE_INHERITED_TOKEN = original;
            await releaseHeavyMaintenanceLease({leasePath, token: parent.lease.token, now, isPidAlive: () => true});
            await fs.rm(dir, {recursive: true, force: true});
        }
    });

    test('fresh lease yields at a batch boundary and a waiting peer runs before the remainder', async () => {
        const dir       = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-handoff-')),
              leasePath = path.join(dir, 'lease.json'), RealDate = Date,
              start     = RealDate.now(), config = (await import('../../../../../../ai/config.template.mjs')).default,
              bound     = config.orchestrator.heavyMaintenance.maxActiveHoldMs,
              options   = {leasePath, staleAfterMs: bound * 4, now: new RealDate(start)},
              original  = process.env.NEO_HEAVY_MAINTENANCE_LEASE_INHERITED_TOKEN;
        let clock = start;
        delete process.env.NEO_HEAVY_MAINTENANCE_LEASE_INHERITED_TOKEN;
        try {
            const outcome = await withHeavyMaintenanceLease(async acquisition => {
                globalThis.Date = class extends RealDate {
                    constructor(...args) { super(...(args.length ? args : [clock])) }
                    static now() { return clock }
                };
                return runIngestTask({records: asAsyncIterable([1, 2, 3, 4].map(id => ({record: {id}}))), batchSize: 2,
                    ingestFn: async (batch, controls) => {
                        expect(controls.shouldYield()).toBe(false);
                        expect((await withHeavyMaintenanceLease(() => 'peer', {...options, owner: 'peer'})).status).toBe('held');
                        clock = start + bound + 1;
                        expect(controls.shouldYield()).toBe(true);
                        return {ingested: batch.length, acceptedEmbeddingChunks: batch.length, settled: batch.length, errors: []};
                    }}, acquisition);
            }, {...options, owner: 'ingest'});
            globalThis.Date = RealDate;
            expect(outcome.result).toMatchObject({yielded: true, completedInputRecords: 2});
            expect((await withHeavyMaintenanceLease(() => 'peer-ran', {...options, owner: 'peer'})).result).toBe('peer-ran');
            const remaining = [...outcome.result.resume.pendingRecords];
            for await (const entry of outcome.result.resume.iterator) remaining.push(entry.record);
            expect(remaining).toEqual([{id: 3}, {id: 4}]);
            const resumed = await runIngest({records: asAsyncIterable(remaining.map(record => ({record}))), batchSize: 2,
                ingestFn: batch => ({ingested: batch.length, acceptedEmbeddingChunks: batch.length, settled: batch.length, errors: []})});
            expect(resumed.completedInputRecords).toBe(2);
        } finally {
            globalThis.Date = RealDate;
            if (original === undefined) delete process.env.NEO_HEAVY_MAINTENANCE_LEASE_INHERITED_TOKEN;
            else process.env.NEO_HEAVY_MAINTENANCE_LEASE_INHERITED_TOKEN = original;
            await fs.rm(dir, {recursive: true, force: true});
        }
    });

    test('partial batch and unread stream retain original records for the same-tenant resume', async () => {
        const dir      = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-custody-')),
              ordinary = path.join(dir, 'ordinary.jsonl'), records = Array.from({length: 180}, (_, id) => ({id, content: 'x'.repeat(1024)})),
              text     = records.map(JSON.stringify).join('\n') + '\n';
        await fs.writeFile(ordinary, text);
        try {
            let pulled = 0;
            async function* chunks() { for (let i = 0; i < text.length; i += 1024) { pulled++; yield text.slice(i, i + 1024) } }
            const result = await runIngest({records: readJsonlRecords(Readable.from(chunks(), {highWaterMark: 1024})), batchSize: 3,
                ingestFn: async (batch, controls) => {
                    controls.onYieldedRecords(batch.slice(1));
                    return {yielded: true, ingested: 3, acceptedEmbeddingChunks: 3, settled: 1, remaining: 2, errors: []};
                }});
            expect(result).toMatchObject({yielded: true, completedInputRecords: 1, settledEmbeddingChunks: 1});
            expect(pulled).toBeLessThan(records.length);
            const retained = await retainIngestRemainder({resume: result.resume, planeRoot: dir, tenantId: 'tenant-a'}),
                  actual   = (await fs.readFile(retained.resumeFile, 'utf8')).trim().split('\n').map(JSON.parse);
            expect(actual).toEqual(records.slice(1));
            expect(retained).toMatchObject({remainingInputRecords: 179, unreadInputRecords: 177, remainingMalformedLines: 0});
            expect((await fs.stat(path.dirname(path.dirname(retained.resumeFile)))).mode & 0o777).toBe(0o700);
            expect((await fs.stat(path.dirname(retained.resumeFile))).mode & 0o777).toBe(0o700);
            expect((await fs.stat(retained.resumeFile)).mode & 0o777).toBe(0o600);
            expect((await fs.stat(path.join(path.dirname(retained.resumeFile), 'owner.json'))).mode & 0o777).toBe(0o600);
            const lines = [], args = {tenantId: 'tenant-a', batchSize: 3};
            expect(reportIngestOutcome({args, totals: result, retained, log: line => lines.push(line)})).toBe(75);
            expect(JSON.parse(lines.at(-1))).toMatchObject({status: 'yielded', ingested: 1, remainingInputRecords: 179,
                remainingEmbeddingChunks: null, activeBatchRemainingEmbeddingChunks: 2,
                resumeCommand           : `npm run ai:ingest-tenant -- 'tenant-a' --from-file '${retained.resumeFile}' --batch-size 3`});
            expect(await removeIngestResume({fromFile: retained.resumeFile, planeRoot: dir, tenantId: 'wrong'})).toBe(false);
            const resumed = await runIngest({records: readJsonlRecords(Readable.from(await fs.readFile(retained.resumeFile))), batchSize: 20,
                ingestFn: batch => ({ingested: batch.length, acceptedEmbeddingChunks: batch.length, settled: batch.length, errors: []})});
            expect(resumed.completedInputRecords).toBe(179);
            expect(await removeIngestResume({fromFile: retained.resumeFile, planeRoot: dir, tenantId: 'tenant-a'})).toBe(true);
            expect(await removeIngestResume({fromFile: ordinary, planeRoot: dir, tenantId: 'tenant-a'})).toBe(false);
            expect(await fs.readFile(ordinary, 'utf8')).toBe(text);
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('repeat yield replaces the prior owned bundle only after retaining its successor', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-repeat-'));
        try {
            const first = await retainIngestRemainder({planeRoot: dir, tenantId: 'tenant-a',
                resume: {pendingRecords: [{id: 1}, {id: 2}], iterator: asAsyncIterable([])}}),
                  args = {tenantId: 'tenant-a', batchSize: 2, fromFile: first.resumeFile}, lines = [];
            async function* broken() { throw new Error('unread source failed') }
            const failed = {yielded: true, errors: [], resume: {pendingRecords: [{id: 2}], iterator: broken()}};
            await expect(finalizeIngestTask({args, totals: failed, planeRoot: dir, log: line => lines.push(line)}))
                .rejects.toThrow(/retention failed/);
            expect(await fs.readFile(first.resumeFile, 'utf8')).toContain('"id":1');
            expect(lines).toEqual([]);
            const totals = {yielded: true, errors: [], ingested: 1, completedInputRecords: 1, remainingChunks: 1,
                resume: {pendingRecords: [{id: 2}], iterator: asAsyncIterable([])}};
            expect(await finalizeIngestTask({args, totals, planeRoot: dir, log: line => lines.push(line)})).toBe(75);
            const receipt = JSON.parse(lines.at(-1));
            expect(receipt.status).toBe('yielded');
            await expect(fs.stat(first.resumeFile)).rejects.toMatchObject({code: 'ENOENT'});
            expect(await fs.readFile(receipt.resumeFile, 'utf8')).toBe('{"id":2}\n');
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('a failed batch retains its originals and unread input before any later yield can discard them', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-error-custody-'));
        try {
            const first = await retainIngestRemainder({planeRoot: dir, tenantId: 'tenant-a',
                resume: {pendingRecords: [{id: 1}, {id: 2}], iterator: asAsyncIterable([])}});
            let   calls  = 0;
            const totals = await runIngest({records: readJsonlRecords(Readable.from(await fs.readFile(first.resumeFile))), batchSize: 1,
                ingestFn: () => {
                    calls++;
                    return {ingested: 2, acceptedEmbeddingChunks: 2, settled: 1, remaining: 1,
                        errors: [{code: 'KB_EMBED_BATCH_SKIPPED', message: 'one child failed'}]};
                }}), lines = [];
            expect(calls).toBe(1);
            expect(totals).toMatchObject({failed: true, completedInputRecords: null});
            expect(await finalizeIngestTask({args: {tenantId: 'tenant-a', fromFile: first.resumeFile, batchSize: 1},
                totals, planeRoot: dir, log: line => lines.push(line)})).toBe(1);
            const receipt = JSON.parse(lines.at(-1));
            expect(receipt).toMatchObject({status: 'failed', acceptedNormalizedChunks: 2, ingested: null, remainingInputRecords: 2});
            expect(receipt).not.toHaveProperty('acceptedRecords');
            expect(await fs.readFile(receipt.resumeFile, 'utf8')).toBe('{"id":1}\n{"id":2}\n');
            await expect(fs.stat(first.resumeFile)).rejects.toMatchObject({code: 'ENOENT'});
            const thrown = await runIngest({records: readJsonlRecords(Readable.from(await fs.readFile(receipt.resumeFile))), batchSize: 1,
                ingestFn: () => { throw new Error('https://user:secret@example.test/repo') }});
            expect(thrown).toMatchObject({failed: true, completedInputRecords: null, acceptedEmbeddingChunks: null});
            expect(await finalizeIngestTask({args: {tenantId: 'tenant-a', fromFile: receipt.resumeFile, batchSize: 1},
                totals: thrown, planeRoot: dir, log: line => lines.push(line)})).toBe(1);
            expect(lines.at(-1)).not.toContain('secret');
            expect(await fs.readFile(JSON.parse(lines.at(-1)).resumeFile, 'utf8')).toBe('{"id":1}\n{"id":2}\n');
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('missing replay custody and retention failures reject', async () => {
        await expect(runIngest({records: asAsyncIterable([{record: {id: 1}}]), batchSize: 1,
            ingestFn: () => ({yielded: true, remaining: 1, settled: 0})})).rejects.toThrow(/omitted replay records/);
        await expect(runIngest({records: asAsyncIterable([{record: {id: 1}}]), batchSize: 1,
            ingestFn: () => ({ingested: 1, errors: []}), onBatch: () => { throw new Error('callback failed') }}))
            .rejects.toThrow('callback failed');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-failure-'));
        try {
            async function* broken() { throw new Error('source failed') }
            await expect(retainIngestRemainder({resume: {pendingRecords: [{id: 1}], iterator: broken()}, planeRoot: dir, tenantId: 'a'}))
                .rejects.toThrow(/retention failed/);
            const roots = await fs.readdir(path.join(dir, 'ingest-resume'));
            expect(await fs.readFile(path.join(dir, 'ingest-resume', roots[0], 'input.partial'), 'utf8')).toBe('{"id":1}\n');
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });
});
