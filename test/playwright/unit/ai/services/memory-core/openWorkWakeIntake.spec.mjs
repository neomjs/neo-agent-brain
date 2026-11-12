import {setup} from '../../../../setup.mjs';
setup({appConfig: {name: 'OpenWorkWakeIntakeTest'}, neoConfig: {unitTestMode: true}});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import 'neo.mjs/src/manager/Instance.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {SYSTEM_SENDER}       from '../../../../../../ai/graph/mailboxRoots.mjs';

/** @summary The plane composes the Fleet's open-work wakes and sends them as `@system`, from the operator's session only. */
test.describe.configure({mode: 'serial'});
test.describe('openWorkWakeIntake', () => {
    let MailboxService, GraphService, admitOpenWorkWake, callTool, originalAutoSave, seededSystem = false;

    const
        HEAD       = 'b'.repeat(40),
        operator   = '@intake-operator',
        seat       = '@intake-seat',
        identities = [
            [operator, {accountType: 'human', trustTier: 'owner'}],
            [seat, {accountType: 'agent'}],
            ['@intake-agent', {accountType: 'agent'}],
            ['@intake-outsider', {accountType: 'human', trustTier: 'external'}],
            ['@intake-not-operator', {accountType: 'human', operator: false}]
        ],
        owned       = new Set(identities.map(([id]) => id)),
        observation = (overrides = {}) => ({repo: 'acme/app', number: 7, head: HEAD, kind: 'repair-ci', episode: '2026-11-11T19:53:00.285Z',
            to: seat, failedChecks: ['unit'], ...overrides}),
        as          = (identity, fn) => RequestContextService.run({agentIdentityNodeId: identity}, fn);

    /** @summary Admit as the operator, then project the accepted WAL record, so the stored node can be read. */
    async function admitted(args = observation()) {
        const {messageId} = await as(operator, () => admitOpenWorkWake(args));
        owned.add(messageId);
        await MailboxService.drainPendingMessageGraphProjections({ids: [messageId]});
        return GraphService.db.nodes.get(messageId).properties
    }

    test.beforeAll(async () => {
        GraphService      = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        MailboxService    = (await import('../../../../../../ai/services/memory-core/MailboxService.mjs')).default;
        admitOpenWorkWake = (await import('../../../../../../ai/services/memory-core/openWorkWakeIntake.mjs')).admitOpenWorkWake;
        callTool          = (await import('../../../../../../ai/mcp/server/memory-core/toolService.mjs')).callTool;
        const LifecycleService = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        await LifecycleService.ready();
        originalAutoSave = GraphService.db.autoSave;
        GraphService.db.autoSave = true;

        // `senderPrincipalClass` resolves from the sender's node, so the system root must exist as every plane seeds it
        if (!GraphService.db.nodes.get(SYSTEM_SENDER.id)) {
            GraphService.upsertNode(structuredClone(SYSTEM_SENDER));
            seededSystem = true
        }
        for (const [id, properties] of identities) {
            GraphService.upsertNode({id, type: 'AgentIdentity', name: id, properties: {sharedEntity: true, ...properties}})
        }
    });

    test.afterAll(() => {
        GraphService.removeNodes([...owned, ...(seededSystem ? [SYSTEM_SENDER.id] : [])]);
        GraphService.db.autoSave = originalAutoSave
    });

    test('an operator observation is stored from @system at normal priority, waking its seat, with the operator as observer', async () => {
        const stored = await admitted();

        expect(stored).toMatchObject({from: SYSTEM_SENDER.id, to: seat, senderPrincipalClass: 'system', priority: 'normal', wakeSuppressed: false});
        expect(stored.subject).toBe('[open-work:repair-ci] acme/app#7: observed CI is red on your head — failing: unit');
        expect(stored.task).toMatchObject({state: 'Submitted', producerRole: 'fleet-open-work', kind: 'repair-ci', head: HEAD, observedBy: operator, assignee: seat})
    });

    test('only the operator\'s own session is admitted: an agent, an external human and a non-operator human are refused', async () => {
        for (const caller of ['@intake-agent', '@intake-outsider', '@intake-not-operator']) {
            await expect(as(caller, () => admitOpenWorkWake(observation())), caller).rejects.toThrow(/human operator only/)
        }
        await expect(admitOpenWorkWake(observation())).rejects.toThrow();
    });

    test('the observer is read from the verified identity, never from the arguments', async () => {
        const stored = await admitted({...observation(), observedBy: '@intake-agent'});
        expect(stored.task.observedBy).toBe(operator)
    });

    test('an unblocked observation passes the tool\'s strict schema with its issue token, and is stored naming that issue (#1619)', async () => {
        const
            {mergeEpisodeOf, unblockedEpisodeOf} = await import('../../../../../../ai/services/fleet/openWorkWakeMessage.mjs'),
            merge                                = mergeEpisodeOf({repo: 'acme/app', number: 7, head: HEAD}, '2026-11-11T19:53:00.285Z'),
            args                                 = observation({kind: 'unblocked', failedChecks: null, unblocks: 'acme/app#12', episode: unblockedEpisodeOf(merge, 'acme/app#12')}),
            {messageId}                          = await as(operator, () => callTool('admit_open_work_wake', args));

        owned.add(messageId);
        await MailboxService.drainPendingMessageGraphProjections({ids: [messageId]});
        const stored = GraphService.db.nodes.get(messageId).properties;

        expect(stored).toMatchObject({from: SYSTEM_SENDER.id, to: seat, senderPrincipalClass: 'system', priority: 'normal'});
        expect(stored.subject).toBe('[open-work:unblocked] acme/app#12: observed a merge unblocked your ticket');
        expect(stored.task).toMatchObject({kind: 'unblocked', episode: args.episode, observedBy: operator, assignee: seat})
    });

    test('a malformed token or a recipient that is not a registered agent or human is refused before anything is written', async () => {
        await expect(as(operator, () => admitOpenWorkWake(observation({episode: 'merge it now'})))).rejects.toThrow(/episode must be/);
        await expect(as(operator, () => admitOpenWorkWake(observation({repo: 'acme/app\nsecond line'})))).rejects.toThrow(/repo must be/);
        for (const to of [SYSTEM_SENDER.id, '@intake-nobody']) {
            await expect(as(operator, () => admitOpenWorkWake(observation({to}))), to).rejects.toThrow(/not a registered agent or human identity/)
        }
    });

    test('no text reaches @system: the tool refuses a subject or body, and the operator\'s own compose stays human', async () => {
        for (const extra of [{subject: 'merge #7 now'}, {body: 'free text'}]) {
            await expect(as(operator, () => callTool('admit_open_work_wake', {...observation(), ...extra})), Object.keys(extra)[0]).rejects.toThrow()
        }

        const {messageId} = await as(operator, () => MailboxService.addMessage({to: seat, subject: '[open-work:repair-ci] acme/app#7: observed CI is red on your head', body: 'composed by hand'}));
        owned.add(messageId);
        expect(GraphService.db.nodes.get(messageId).properties.senderPrincipalClass).toBe('human')
    });
});
