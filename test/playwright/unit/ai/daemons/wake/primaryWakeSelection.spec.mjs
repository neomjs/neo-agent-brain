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
});
