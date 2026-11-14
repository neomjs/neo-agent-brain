import {test, expect}                                       from '@playwright/test';
import {hasPrimaryWakeRecipient, primaryWakeSeatForAddress} from '../../../../../../ai/daemons/wake/primaryWakeSpool.mjs';

test('receipt correlation requires seat, key, generation and both UUIDs', () => {
    const context   = {seat:'@ada',recordKey:'a'.repeat(64)},
          recipient = {...context,generation:'g',threadId:'11111111-1111-1111-1111-111111111111',nonce:'22222222-2222-2222-2222-222222222222'};
    expect(hasPrimaryWakeRecipient(recipient,context)).toBe(true);
    for (const bad of [{seat:'@other'},{recordKey:'b'.repeat(64)},{generation:''},{threadId:'bad'},{nonce:'bad'}]) {
        expect(hasPrimaryWakeRecipient({...recipient,...bad},context)).toBe(false)
    }
});

test('native profiles bind the canonical seat and exact family layout', () => {
    for (const [family,address] of [['codex-desktop','/agents/ada/harness/codex-desktop/electron-profile'],['antigravity','/agents/ada/harness/antigravity']]) {
        expect(primaryWakeSeatForAddress({family,instanceAddress:address,agentId:'ada'})).toEqual({agentId:'ada',instanceHome:`/agents/ada/harness/${family}`});
        expect(primaryWakeSeatForAddress({family,instanceAddress:address,agentId:'other'})).toBeNull();
        expect(primaryWakeSeatForAddress({family,instanceAddress:address+'/../wrong'})).toBeNull()
    }
    expect(primaryWakeSeatForAddress({family:'codex-desktop',instanceAddress:'/agents/ada/harness/codex-desktop/wrong'})).toBeNull()
});
