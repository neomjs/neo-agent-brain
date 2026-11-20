import {test, expect}                from '@playwright/test';
import fs                            from 'node:fs/promises';
import os                            from 'node:os';
import path                          from 'node:path';
import {observePrimaryWakeSelection} from '../../../../../../ai/daemons/wake/primaryWakeSelection.mjs';

test.describe('primary wake selection watermark', () => {
    let dir, selectionPath, live;
    const a       = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const observe = overrides => observePrimaryWakeSelection({selectionPath, seat:'@fixture', family:'codex-desktop',
        generation:'epoch-1', threadId:a, order:100, proof:{verified:true,kind:'codex-start'},
        verifyGeneration: async ({generation}) => generation === live, ...overrides});
    test.beforeEach(async () => {dir = await fs.mkdtemp(path.join(os.tmpdir(),'neo-selection-')); selectionPath = path.join(dir,'selection.json'); live = 'epoch-1'});
    test.afterEach(async () => fs.rm(dir,{recursive:true,force:true}));

    test('persists the observed successor and holds a deleted-successor ABA and a tie', async () => {
        expect((await observe({})).status).toBe('accepted');
        expect((await observe({threadId:b,order:200})).status).toBe('accepted');
        expect((await observe({})).status).toBe('held');
        expect((await observe({threadId:a,order:200})).status).toBe('held');
        expect((await observe({threadId:b,order:200})).status).toBe('accepted');
        expect((await fs.stat(selectionPath)).mode & 0o777).toBe(0o600);
    });

    test('only the live generation can reset the monotonic order', async () => {
        await observe({threadId:b,order:200});
        expect((await observe({generation:'epoch-2'})).status).toBe('held');
        live = 'epoch-2';
        expect((await observe({generation:'epoch-2'})).status).toBe('accepted');
        expect((await observe({threadId:b,order:200})).status).toBe('held');
    });

    test('Antigravity requires an attested sequence, never a Codex clock proof', async () => {
        expect((await observe({family:'antigravity'})).status).toBe('held');
        expect((await observe({family:'antigravity',proof:{verified:true,kind:'antigravity-sequence'}})).status).toBe('accepted');
        expect((await observe({family:'antigravity',threadId:b,order:101,proof:{verified:true,kind:'antigravity-sequence'}})).status).toBe('accepted');
        expect((await observe({family:'antigravity',proof:{verified:true,kind:'antigravity-sequence'}})).status).toBe('held');
    });

    test('missing proof and foreign or corrupt state fail closed', async () => {
        expect((await observe({proof:null})).status).toBe('held');
        await observe({});
        expect((await observe({seat:'@other'})).status).toBe('held');
        await fs.writeFile(selectionPath,'broken');
        await expect(observe({})).rejects.toThrow();
    });

    const root       = '01a1f979-7d2d-7000-8000-000000000001',
          allocation = 1795186851117;
    const rootProof = (threadStartMs=allocation) => ({verified:true, kind:'codex-start', threadStartMs});

    // The installed v1 hook keeps an equal observation unchanged and rewrites only its legacy fields on advance.
    async function observeFromV1(threadId, order) {
        const prior = JSON.parse(await fs.readFile(selectionPath, 'utf8'));
        if (prior.threadId === threadId) return prior.order === order;
        if (order <= prior.order) return false;
        const {version, seat, family, generation, kind} = prior;
        await fs.writeFile(selectionPath, JSON.stringify({version, seat, family, generation, kind, threadId, order}), {mode:0o600});
        return true
    }

    test('the same bound Codex root reconciles a 13 ms index change without changing its allocation order', async () => {
        const before = {threadId:root, order:allocation + 2}, after = {...before, order:allocation + 15};
        await observe(before);
        const original = await fs.readFile(selectionPath,'utf8');
        for (const insufficient of [{}, {proof:rootProof()}, {proof:rootProof(), verifyContinuity:async () => false}]) {
            expect(await observe({...after,...insufficient})).toMatchObject({status:'held',reason:'root start changed'});
            expect(await fs.readFile(selectionPath,'utf8')).toBe(original)
        }
        const verified = {proof:rootProof(), verifyContinuity:async () => true};
        const repaired = await observe({...after,...verified});
        expect(repaired).toMatchObject({status:'accepted',selection:{threadId:root,order:after.order,threadStartMs:allocation}});
        expect(await observe({...after,...verified})).toEqual(repaired);
        expect(await observeFromV1(root, after.order)).toBe(true);
        // A downward index rewrite cannot lower the persisted legacy watermark.
        expect(await observe({...before,...verified})).toEqual(repaired);
        expect(await observeFromV1(root, before.order)).toBe(false);
        expect(JSON.parse(await fs.readFile(selectionPath,'utf8'))).toEqual(repaired.selection)
    });

    test('a witnessed successor survives a v1 overwrite or missing projection before the Fleet binding advances', async () => {
        const successor = root.replace('7d2d', '7d2e'),
              first     = {threadId:root,order:allocation+2,proof:rootProof()},
              next      = {threadId:successor,order:allocation+10,proof:rootProof(allocation+1)};
        await observe(first);
        const selected = await observe(next);
        expect(selected.status).toBe('accepted');
        // No binding change: an older hook can still run and rewrite its own file.
        expect(await observeFromV1(root, allocation+20)).toBe(true);
        expect((await observe({...first,order:allocation+20})).status).toBe('held');
        await fs.rm(selectionPath);
        expect((await observe({...first,order:allocation+20})).status).toBe('held');
        expect((await observe({...next,proof:{verified:true,kind:'codex-start'}})).status).toBe('held');
        const witnessPath = selectionPath + '.codex-witness.json';
        expect((await fs.stat(witnessPath)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await fs.readFile(witnessPath,'utf8'))).toEqual(selected.selection);
        expect((await observe(next)).status).toBe('accepted');
        expect(JSON.parse(await fs.readFile(selectionPath,'utf8'))).toEqual(selected.selection)
    });

    test('a corrupt or foreign protected record cannot be replaced from the v1 projection', async () => {
        const current     = {threadId:root, order:allocation, proof:rootProof()},
              {selection} = await observe(current),
              witnessPath = selectionPath + '.codex-witness.json';
        for (const invalid of [null, {...selection,seat:'@another'}, {...selection,threadStartMs:allocation - 1}]) {
            await fs.writeFile(witnessPath, JSON.stringify(invalid));
            expect(await observe(current)).toMatchObject({status:'held',reason:'stored selection invalid'});
            expect(JSON.parse(await fs.readFile(witnessPath,'utf8'))).toEqual(invalid)
        }
    });

    test('a tied allocation or predecessor cannot replace a legacy or migrated winner using a later index time', async () => {
        const before      = {threadId:root, order:allocation+2}, later = allocation+50,
              predecessor = root.replace('7d2d', '7d2c'), twin = root.replace('7000','7001'),
              successor   = root.replace('7d2d', '7d2e');
        await observe(before);
        for (const upgraded of [false,true]) {
            if (upgraded) await observe({...before,proof:rootProof()});
            for (const [threadId,ms] of [[predecessor,allocation-1],[twin,allocation]]) {
                expect((await observe({threadId,order:later})).status).toBe('held');
                expect((await observe({threadId,order:later,proof:rootProof(ms)})).status).toBe('held')
            }
        }
        expect((await observe({threadId:successor,order:later,proof:rootProof(allocation+1)})).status).toBe('accepted');
        expect((await observe({...before,order:later+1,proof:rootProof()})).status).toBe('held')
    });

    test('an inapplicable witness or missing generation proof cannot rebase a selection', async () => {
        await observe({threadId:root,order:allocation+2});
        for (const extra of [{proof:rootProof(allocation+1)}, {threadId:a,proof:rootProof()},
            {proof:rootProof(),generation:'other'}, {proof:rootProof(),family:'antigravity'}]) {
            expect((await observe({threadId:root,order:allocation+15,verifyContinuity:async () => true,...extra})).status).toBe('held')
        }
    });
});
