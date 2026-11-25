import {setup} from '../../../../setup.mjs';
setup({appConfig: {name: 'OpenWorkWakeIntakeTest'}, neoConfig: {unitTestMode: true}});

import {test, expect} from '@playwright/test';
import {spawnSync}    from 'node:child_process';
import Neo            from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import 'neo.mjs/src/manager/Instance.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {SYSTEM_SENDER}       from '../../../../../../ai/graph/mailboxRoots.mjs';

/** @summary The plane composes the Fleet's open-work wakes and sends them as `@system`, from the operator's session only. */
test.describe.configure({mode: 'serial'});
test.describe('openWorkWakeIntake', () => {
    let MailboxService, GraphService, admitOpenWorkWake, resetOpenWorkWakeAdmissions, callTool, originalAutoSave, seededSystem = false;

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
        ({admitOpenWorkWake, resetOpenWorkWakeAdmissions} = await import('../../../../../../ai/services/memory-core/openWorkWakeIntake.mjs'));
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

    // Each test admits its observations afresh; a repeated admission is its own test
    test.beforeEach(() => resetOpenWorkWakeAdmissions?.());

    test.afterAll(() => {
        GraphService.removeNodes([...owned, ...(seededSystem ? [SYSTEM_SENDER.id] : [])]);
        GraphService.db.autoSave = originalAutoSave
    });

    test('a repeated admission of one wake answers its first receipt and writes nothing, even while the first is in flight; a failed write keeps no receipt (#1678)', async () => {
        const
            args                 = observation({episode: '2026-11-13T05:54:27.971Z'}),
            [first, overlapping] = await Promise.all([as(operator, () => admitOpenWorkWake(args)), as(operator, () => admitOpenWorkWake(args))]),
            repeated             = await as(operator, () => admitOpenWorkWake(args)),
            another              = await as(operator, () => admitOpenWorkWake({...args, episode: '2026-11-13T06:00:00.000Z'}));

        [first, another].forEach(({messageId}) => owned.add(messageId));
        expect(overlapping.messageId).toBe(first.messageId);
        expect(repeated.messageId).toBe(first.messageId);
        expect(another.messageId).not.toBe(first.messageId);

        const addMessage = MailboxService.addMessage, retried = observation({episode: '2026-11-13T07:00:00.000Z'});
        MailboxService.addMessage = async () => { throw new Error('plane busy') };
        try {
            await expect(as(operator, () => admitOpenWorkWake(retried))).rejects.toThrow('plane busy')
        } finally {
            MailboxService.addMessage = addMessage
        }
        const {messageId} = await as(operator, () => admitOpenWorkWake(retried));
        owned.add(messageId);
        expect(messageId).toMatch(/^MESSAGE:/)
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

    test('a closeout observation with head: null passes the strict schema and stores naming the parent issue without a Head line (#1919)', async () => {
        const
            args        = {repo: 'acme/app', number: 15, head: null, kind: 'closeout', episode: '2026-11-25T12:00:00.000Z', to: seat},
            {messageId} = await as(operator, () => callTool('admit_open_work_wake', args));

        owned.add(messageId);
        await MailboxService.drainPendingMessageGraphProjections({ids: [messageId]});
        const
            stored  = GraphService.db.nodes.get(messageId).properties,
            fetched = await as(seat, () => MailboxService.getMessage({messageId}));

        expect(stored).toMatchObject({from: SYSTEM_SENDER.id, to: seat, senderPrincipalClass: 'system', priority: 'normal', wakeSuppressed: false});
        expect(stored.subject).toBe('[open-work:closeout] acme/app#15: observed every sub of this issue is closed: close it, or file the missing subs');
        expect(fetched.body.startsWith('https://github.com/acme/app/issues/15\n')).toBe(true);
        expect(fetched.body).not.toContain('Head:');
        expect(stored.task).toMatchObject({kind: 'closeout', head: null, episode: args.episode, observedBy: operator, assignee: seat});

        await expect(as(operator, () => callTool('admit_open_work_wake', {...args, head: HEAD}))).rejects.toThrow(/head must be null for closeout/);
        await expect(as(operator, () => callTool('admit_open_work_wake', {...observation(), head: null, failedChecks: null, kind: 'review'}))).rejects.toThrow(/head must be a full 40-character lowercase commit id/)
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

    test('the delivery read answers each wake message from the receiver\'s own records, to the operator only', async () => {
        const
            [{default: fs}, {default: os}, {default: path}] = await Promise.all([import('fs/promises'), import('os'), import('path')]),
            {default: wakeSubscriptions}                    = await import('../../../../../../ai/services/memory-core/WakeSubscriptionService.mjs'),
            {readWakeDelivery}                              = await import('../../../../../../ai/services/memory-core/wakeDeliveryReader.mjs'),
            {readOpenWorkWakeDelivery}                      = await import('../../../../../../ai/services/memory-core/openWorkWakeIntake.mjs'),
            records                                         = await fs.mkdtemp(path.join(os.tmpdir(), 'open-work-delivery-')),
            prior                                           = wakeSubscriptions.wakeDeliveryReadFn;

        await fs.writeFile(path.join(records, 'k1.json'), JSON.stringify({recordKey: 'k1', subscriptionId: 'WAKE_SUB:seat', state: 'delivered',
            sourceEventIds: ['MESSAGE:delivered'], acceptedAt: '2026-11-13T00:00:00.000Z', dispatchFinishedAt: '2026-11-13T00:00:01.000Z'}));
        wakeSubscriptions.wakeDeliveryReadFn = options => readWakeDelivery({...options, recordsDir: records});

        try {
            expect(await as(operator, () => callTool('read_open_work_wake_delivery', {messageIds: ['MESSAGE:delivered', 'MESSAGE:absent']}))).toEqual({
                deliveryReadable: true, deliveryReadReason: 'observed', messages: {
                    'MESSAGE:delivered': {state: 'delivered', at: '2026-11-13T00:00:01.000Z'},
                    'MESSAGE:absent'   : {state: 'undelivered', at: null}
                }
            });

            const staged = await as(operator, () => callTool('read_open_work_wake_delivery', {
                messageIds   : ['MESSAGE:delivered', 'MESSAGE:absent'],
                includeStages: true
            }));
            expect(staged.messages).toEqual({
                'MESSAGE:delivered': {state: 'delivered', at: '2026-11-13T00:00:01.000Z'},
                'MESSAGE:absent'   : {state: 'undelivered', at: null}
            });
            expect(staged.messageStages['MESSAGE:delivered']).toMatchObject({
                stage  : 'delivered',
                settled: true
            });
            expect(staged.messageStages['MESSAGE:absent']).toMatchObject({
                stage  : 'undelivered',
                settled: false
            });

            for (const caller of ['@intake-agent', '@intake-outsider', '@intake-not-operator']) {
                await expect(as(caller, () => readOpenWorkWakeDelivery({messageIds: ['MESSAGE:delivered']})), caller).rejects.toThrow(/human operator only/)
            }
            for (const messageIds of [[], ['not-a-message'], Array.from({length: 101}, (_, index) => `MESSAGE:${index}`)]) {
                await expect(as(operator, () => readOpenWorkWakeDelivery({messageIds})), String(messageIds.length)).rejects.toThrow(/messageIds must be/)
            }
        } finally {
            wakeSubscriptions.wakeDeliveryReadFn = prior;
            await fs.rm(records, {recursive: true, force: true})
        }
    });
});

test('outside repair planner, wire, schema and intake preserve exact evidence with isolated mailbox dependencies', () => {
    const intakeUrl  = new URL('../../../../../../ai/services/memory-core/openWorkWakeIntake.mjs', import.meta.url).href,
          wireUrl    = new URL('../../../../../../ai/services/fleet/wireFleetOpenWorkWakes.mjs', import.meta.url).href,
          contextUrl = new URL('../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs', import.meta.url).href,
          schemaUrl  = new URL('../../../../../../ai/mcp/server/memory-core/openapi.yaml', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import {registerHooks} from 'node:module';
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        import Ajv from 'ajv';
        import {load} from 'js-yaml';
        await import('neo.mjs/src/Neo.mjs');
        await import('neo.mjs/src/core/_export.mjs');
        const {default: context} = await import(${JSON.stringify(contextUrl)});
        const {wireFleetOpenWorkWakes} = await import(${JSON.stringify(wireUrl)});
        const intakeUrl = ${JSON.stringify(intakeUrl)};
        const HEAD = 'a'.repeat(40), KEY = 'b'.repeat(64), SEAT = '@neo-opus-ada', OPERATOR = '@fixture-operator';
        const start = Date.parse('2026-11-16T06:00:00.000Z'), iso = minute => new Date(start + minute * 60000).toISOString();
        const stored = [];
        globalThis.fixtureOpenWorkMailbox = {
            isReachableTarget: id => id === SEAT,
            async addMessage(message, options) {
                assert.equal(options.deferProjection, true);
                stored.push({...structuredClone(message), from: context.getAgentIdentityNodeId()});
                return {messageId: 'MESSAGE:fixture-' + stored.length};
            }
        };
        const modules = new Map([
            ['./GraphService.mjs', 'export default {requireDb() {return {};}};'],
            ['./MailboxService.mjs', 'export default globalThis.fixtureOpenWorkMailbox; export const isHumanOperatorIdentity = (db, id) => id === "@fixture-operator"; export const resolvePrincipalClass = (db, id) => id === "@neo-opus-ada" ? "agent" : null;'],
            ['./WakeSubscriptionService.mjs', 'export default {};']
        ]);
        const hooks = registerHooks({resolve(specifier, info, nextResolve) {
            if (info.parentURL === intakeUrl && modules.has(specifier)) {
                return {url: 'data:text/javascript,' + encodeURIComponent(modules.get(specifier)), shortCircuit: true};
            }
            return nextResolve(specifier, info);
        }});
        const schema = load(fs.readFileSync(new URL(${JSON.stringify(schemaUrl)}), 'utf8'))
            .paths['/mailbox/open-work/admit'].post.requestBody.content['application/json'].schema;
        const validate = new Ajv({strict: false}).compile(schema);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-repair-intake-'));
        try {
            const {admitOpenWorkWake, resetOpenWorkWakeAdmissions} = await import(intakeUrl);
            for (const mode of ['unclassified', 'mechanical', 'unknown', 'capacity', 'comment-only', 'partial', 'legacy']) {
                resetOpenWorkWakeAdmissions();
                fs.mkdirSync(path.join(directory, mode));
                let minute = 0, nameReads = 0;
                const observed = (minute, ci, unread = false) => {
                    const row = {key: 'acme/app#7', repo: 'acme/app', number: 7, head: HEAD, ci,
                        owner: mode === 'legacy' ? {kind: 'seat', seat: SEAT} : {kind: 'outside', seat: null, login: 'contributor'},
                        bot: false, authorAssociation: 'CONTRIBUTOR', draft: false, partial: false, mergeable: 'MERGEABLE',
                        requested: [], reviews: [], opinions: [], observedAt: iso(minute)};
                    if (mode !== 'legacy') {
                        row.reviews = mode === 'comment-only' ? [] : [{reviewer: '@neo-opus-grace', state: 'COMMENTED', onHead: true, bot: false}];
                        row.ciRepairEvidence = mode === 'unknown' || mode === 'partial' || unread ? null : {head: HEAD, key: KEY,
                            failedChecks: mode === 'capacity' ? Array.from({length: 100}, (_, index) => 'unit-' + index) : ['snapshot-unit']};
                        row.ciRepairClassification = ['mechanical', 'unknown', 'capacity', 'comment-only'].includes(mode)
                            ? {head: HEAD, evidenceKey: KEY, kind: 'mechanical', maintainer: '@neo-opus-grace', receiptUrl: 'https://github.com/acme/app/pull/7#issuecomment-101'} : null;
                        if (mode === 'comment-only') {
                            const source = {provider: 'github', apiBase: 'https://api.github.com', repo: 'acme/app', prId: 'PR_7', number: 7};
                            row.ciRepairRead = {head: HEAD, source, touch: {head: HEAD, commentId: 'COMMENT_101', maintainer: '@neo-opus-grace',
                                receiptUrl: 'https://github.com/acme/app/pull/7#issuecomment-101', source,
                                author: {id: 'USER_GRACE', kind: 'User', login: 'neo-opus-grace'}}};
                        }
                        if (mode === 'partial') {
                            row.partial = true;
                            row.ciRepairIncompleteReads = minute < 2 ? ['comments', 'reviews', 'checks', 'legacy-coverage'] : ['comments', 'check-suites'];
                        }
                    }
                    return {observedAt: iso(minute), coverage: mode === 'partial' ? 'partial' : 'complete', snapshot: {rows: {[row.key]: row}, closed: {}},
                        transitions: [], pulses: [{at: iso(-1500)}, {at: iso(minute)}]};
                };
                const round = wireFleetOpenWorkWakes({
                    registry: {getDataDir: () => path.join(directory, mode), listAgents: () => [{id: 'ada', githubUsername: 'neo-opus-ada'}],
                        resolveCredential: () => 'fixture-token'},
                    createQuery: () => async () => {
                        nameReads++;
                        return {repository: {object: {statusCheckRollup: {contexts: {pageInfo: {hasNextPage: false},
                            nodes: [{name: 'native-later-read', conclusion: 'FAILURE'}]}}}}};
                    },
                    gateOf: () => ({holds: true}), now: () => start + minute * 60000, rotationSeats: [SEAT],
                    admitWake: observation => {
                        assert.equal(validate(observation), true, JSON.stringify(validate.errors));
                        return admitOpenWorkWake(observation);
                    }, log: {}
                });
                const prior = stored.length;
                await context.run({agentIdentityNodeId: OPERATOR}, () => round(observed(0, 'pending')));
                minute = 1;
                await context.run({agentIdentityNodeId: OPERATOR}, () => round(observed(1, 'red')));
                if (mode === 'comment-only') {
                    minute = 2;
                    await context.run({agentIdentityNodeId: OPERATOR}, () => round(observed(2, 'red', true)));
                    minute = 3;
                    await context.run({agentIdentityNodeId: OPERATOR}, () => round(observed(3, 'red')));
                }
                if (mode === 'partial') {
                    minute = 2;
                    await context.run({agentIdentityNodeId: OPERATOR}, () => round(observed(2, 'red')));
                }
                await round.stop();
                assert.equal(stored.length, prior + 1, mode);
                const message = stored.at(-1);
                assert.equal(message.from, '@system');
                assert.equal(message.task.observedBy, OPERATOR);
                assert.equal(message.task.state, 'Submitted');
                assert.equal(message.task.head, HEAD);
                assert.equal(Object.hasOwn(message.task, 'ciRepair'), false);
                if (mode === 'legacy') {
                    assert.equal(nameReads, 1);
                    assert.match(message.body, /Failing checks: native-later-read/);
                    assert.equal(message.body.includes('Evidence key:'), false);
                } else {
                    assert.equal(nameReads, 0);
                    if (mode === 'unknown' || mode === 'partial') {
                        assert.match(message.body, /Evidence key: unknown/);
                        assert.match(message.body, /Observed classification: unclassified/);
                        assert.equal(message.body.includes('<!-- neo-ci-repair-classification:'), false);
                        if (mode === 'partial') {
                            assert.match(message.body, /Incomplete reads: comments, reviews, checks, legacy-coverage/);
                            assert.match(message.body, /Inspect beyond the reported read windows before another classification/);
                            assert.equal(Object.hasOwn(message.task, 'incompleteReads'), false);
                        }
                    } else {
                        if (mode === 'capacity') {
                            assert.match(message.body, /producer-snapshot check names are unavailable for this wake/);
                            assert.equal(message.body.includes('unit-0'), false);
                        } else assert.match(message.body, /Failing checks: snapshot-unit/);
                        assert.ok(message.body.includes('Evidence key: ' + KEY));
                        assert.ok(message.body.includes('"head":"' + HEAD + '","evidenceKey":"' + KEY + '"'));
                        assert.ok(message.body.includes('Observed classification: ' + (['capacity', 'comment-only'].includes(mode) ? 'mechanical' : mode)));
                    }
                }
            }
            const observation = {repo: 'acme/app', number: 7, head: HEAD, kind: 'repair-ci', episode: iso(2), to: SEAT};
            for (const ciRepair of [{evidenceKey: KEY, kind: 'mechanical', extra: true}, {evidenceKey: 'bad', kind: 'unclassified'}]) {
                assert.equal(validate({...observation, ciRepair}), false);
            }
            for (const incompleteReads of [[], ['checks', 'checks'], ['unknown'], Array(1), Array(8).fill('comments')]) {
                assert.equal(validate({...observation, ciRepair: {evidenceKey: null, kind: 'unclassified', incompleteReads}}), false);
            }
            const count = stored.length;
            await assert.rejects(context.run({agentIdentityNodeId: OPERATOR}, () => admitOpenWorkWake({...observation,
                kind: 'review', ciRepair: {evidenceKey: KEY, kind: 'unclassified'}})), /ciRepair belongs to repair-ci only/);
            await assert.rejects(context.run({agentIdentityNodeId: OPERATOR}, () => admitOpenWorkWake({...observation,
                ciRepair: {evidenceKey: null, kind: 'mechanical'}})), /mechanical requires a known key/);
            assert.equal(stored.length, count);
        } finally {hooks.deregister(); fs.rmSync(directory, {recursive: true, force: true});}
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {encoding: 'utf8', timeout: 15000});
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
});
