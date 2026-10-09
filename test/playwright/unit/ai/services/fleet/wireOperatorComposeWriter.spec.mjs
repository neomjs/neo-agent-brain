import {setup}                     from '../../../../setup.mjs';
import {test, expect}              from '@playwright/test';
import fs                          from 'fs';
import Neo                         from 'neo.mjs/src/Neo.mjs';
import * as core                   from 'neo.mjs/src/core/_export.mjs';
import {wireOperatorComposeWriter} from '../../../../../../ai/services/fleet/wireOperatorComposeWriter.mjs';
import FleetControlBridge          from '../../../../../../ai/services/fleet/FleetControlBridge.mjs';
import {dispatchFleetRequest}      from '../../../../../../ai/services/fleet/dispatchFleetRequest.mjs';
import {createFleetWireOffer}      from '../../../../../../src/fleet/contract/wire.mjs';

/**
 * @summary Contract of the compose-writer wiring + the composeOperatorMessage verb: the wire's
 * first WRITE seam installs a real injected writer (never an imported singleton), refuses honestly
 * when unwired, and is smuggling-proof by construction — the verb's payload is whitelisted
 * field-by-field, so caller-supplied identity fields never reach the mailbox primitive; the sender
 * is exclusively the ambient request identity the authenticated ingress stamped, resolved inside
 * `MailboxService.addMessage` as the server-stamped principal. This unit pins the pure
 * wiring + verb decisions with injected doubles; the live stamped-chain receipt is the running
 * devFleetServer's concern.
 */
test.describe('Neo.ai.services.fleet.wireOperatorComposeWriter', () => {
    const stubBridge = () => ({composeWriter: null});

    test.afterEach(() => {
        FleetControlBridge.composeWriter = null;
    });

    test('fail-soft: no addMessage function → returns null and leaves the bridge unwired (never fabricates a writer)', () => {
        const bridge = {composeWriter: 'UNTOUCHED'};

        expect(wireOperatorComposeWriter({bridge})).toBeNull();
        expect(wireOperatorComposeWriter({bridge, addMessage: 'not-a-function'})).toBeNull();
        // the honest not-wired default must stand — no fabricated writer installed
        expect(bridge.composeWriter).toBe('UNTOUCHED');
    });

    test('installs the injected writer on the bridge and returns it', () => {
        const bridge     = stubBridge();
        const addMessage = () => ({messageId: 'MESSAGE:x'});

        const writer = wireOperatorComposeWriter({bridge, addMessage});

        expect(writer).toBe(bridge.composeWriter);
        expect(bridge.composeWriter.addMessage).toBe(addMessage);
    });

    test('composeOperatorMessage answers an honest not-wired refusal when no writer is installed', () => {
        const result = FleetControlBridge.composeOperatorMessage({to: 'AGENT:*', subject: 's', body: 'b'});

        expect(result.status).toBe('not-wired');
        expect(result.reason).toContain('not wired');
    });

    test('#15379 smuggling negative: caller-supplied identity fields NEVER reach the writer — the payload is whitelisted by construction', async () => {
        let captured = null;
        wireOperatorComposeWriter({addMessage: payload => { captured = payload; return {messageId: 'MESSAGE:ok'}; }});

        const result = await FleetControlBridge.composeOperatorMessage({
            to            : 'AGENT:*',
            subject       : 'weekend focus',
            body          : 'steer payload',
            priority      : 'high',
            wakeSuppressed: false,
            relatedTickets: ['#15379'],
            // The smuggling attempt: every sender-shaped field a hostile caller could try. None of
            // these may reach the mailbox primitive — the author is the transport-stamped ambient
            // identity, resolved inside addMessage, never a wire parameter.
            from                : '@mallory',
            sender              : '@mallory',
            senderPrincipalClass: 'human',
            agentIdentityNodeId : '@mallory',
            userId              : 'mallory'
        });

        expect(result.messageId).toBe('MESSAGE:ok');

        // Whitelisted fields pass through exactly...
        expect(captured).toEqual({
            to            : 'AGENT:*',
            subject       : 'weekend focus',
            body          : 'steer payload',
            priority      : 'high',
            wakeSuppressed: false,
            relatedTickets: ['#15379']
        });
        // ...and the assertion above is exhaustive (toEqual): no identity-shaped key survived.
        for (const smuggled of ['from', 'sender', 'senderPrincipalClass', 'agentIdentityNodeId', 'userId']) {
            expect(Object.hasOwn(captured, smuggled), `${smuggled} must never cross the seam`).toBe(false);
        }
    });

    test('omitted priority/wakeSuppressed are NOT sent as undefined — the sender-class defaults stay the primitive\'s decision', async () => {
        let captured = null;
        wireOperatorComposeWriter({addMessage: payload => { captured = payload; return {messageId: 'MESSAGE:ok'}; }});

        await FleetControlBridge.composeOperatorMessage({to: '@neo-fable', subject: 's', body: 'b'});

        // Absent keys (not undefined values): addMessage's sender-class default resolution
        // (human ⇒ quiet + high) must see a genuinely-omitted field, not an explicit undefined.
        expect(Object.hasOwn(captured, 'priority')).toBe(false);
        expect(Object.hasOwn(captured, 'wakeSuppressed')).toBe(false);
        expect(Object.hasOwn(captured, 'relatedTickets')).toBe(false);
    });

    test('#15400 shape-guard: a non-array relatedTickets is REJECTED and the writer is NEVER invoked', async () => {
        // Finding-1 of the compose verb's break-it review: the fleet wire has no schema layer, and
        // MailboxService.addMessage spreads relatedTickets — so a string would CHAR-SPLIT into garbage
        // WAL refs (e.g. '15379' stores ['1','5','3','7','9']) and a number would THROW mid-send. The
        // verb rejects at the seam, before the writer is ever invoked. undefined (omit) + a real array
        // pass-through are pinned by the sibling witnesses above.
        for (const bad of ['15379', 42, {0: '15379'}]) {
            let invoked = false;
            wireOperatorComposeWriter({addMessage: () => { invoked = true; return {messageId: 'MESSAGE:x'}; }});

            const result = await FleetControlBridge.composeOperatorMessage({to: 'AGENT:*', subject: 's', body: 'b', relatedTickets: bad});

            expect(result.status, `${JSON.stringify(bad)} must be rejected`).toBe('rejected');
            expect(result.reason).toContain('relatedTickets must be an array');
            expect(invoked, `the writer must NEVER be invoked for a non-array relatedTickets (${JSON.stringify(bad)})`).toBe(false);
        }
    });

    test('a reply carries inReplyTo to the writer, and a non-string inReplyTo is rejected before it', async () => {
        let captured = null;
        wireOperatorComposeWriter({addMessage: payload => { captured = payload; return {messageId: 'MESSAGE:reply'}; }});

        await FleetControlBridge.composeOperatorMessage({to: '@neo-gpt', subject: 'Re: q', body: 'a', inReplyTo: 'MESSAGE:q'});
        expect(captured).toEqual({to: '@neo-gpt', subject: 'Re: q', body: 'a', inReplyTo: 'MESSAGE:q'});

        captured = null;
        const result = await FleetControlBridge.composeOperatorMessage({to: '@neo-gpt', subject: 's', body: 'b', inReplyTo: 42});

        expect(result.status).toBe('rejected');
        expect(captured, 'the writer must not run for a non-string inReplyTo').toBeNull()
    });

    test('the own-inbox primitives are installed only when given, and each missing one leaves only its verb not-wired', async () => {
        const
            bridge         = stubBridge(),
            getMessage     = () => ({id: 'MESSAGE:m'}),
            observeMessages = () => ({messages: []});

        wireOperatorComposeWriter({bridge, addMessage: () => ({}), getMessage, observeMessages, markRead: 'not-a-function'});
        expect(bridge.composeWriter.getMessage).toBe(getMessage);
        expect(bridge.composeWriter.observeMessages).toBe(observeMessages);
        expect(Object.hasOwn(bridge.composeWriter, 'markRead')).toBe(false);
        expect(Object.hasOwn(bridge.composeWriter, 'transitionTask')).toBe(false);
        expect(Object.hasOwn(bridge.composeWriter, 'observeMessages')).toBe(false);

        wireOperatorComposeWriter({bridge, addMessage: () => ({}), getMessage});
        expect(Object.hasOwn(bridge.composeWriter, 'observeMessages')).toBe(false);

        wireOperatorComposeWriter({addMessage: () => ({}), getMessage});
        expect(await FleetControlBridge.fleetOwnMessage({messageId: 'MESSAGE:m'})).toEqual({id: 'MESSAGE:m'});
        expect(FleetControlBridge.markOwnMessageRead({messageId: 'MESSAGE:m'}).status).toBe('not-wired');
        expect(FleetControlBridge.transitionOwnTask({messageId: 'MESSAGE:m', newState: 'Completed'}).status).toBe('not-wired')
    });

    test('the own-inbox verbs pass exactly their whitelisted args: one message, never a bulk read or a caller identity', async () => {
        const calls = [];
        wireOperatorComposeWriter({
            addMessage    : () => ({}),
            getMessage    : args => { calls.push(['getMessage', args]); return {ok: true} },
            markRead      : args => { calls.push(['markRead', args]); return {ok: true} },
            transitionTask: args => { calls.push(['transitionTask', args]); return {ok: true} }
        });

        await FleetControlBridge.fleetOwnMessage({messageId: 'MESSAGE:a', from: '@mallory'});
        await FleetControlBridge.markOwnMessageRead({messageId: 'MESSAGE:a', all: true, includeUnseen: true});
        await FleetControlBridge.transitionOwnTask({messageId: 'MESSAGE:t', newState: 'Working'});
        await FleetControlBridge.transitionOwnTask({messageId: 'MESSAGE:t', newState: 'Completed', expectedCurrentState: 'Working', assignee: '@mallory'});

        expect(calls).toEqual([
            ['getMessage',     {messageId: 'MESSAGE:a'}],
            ['markRead',       {messageId: 'MESSAGE:a'}],
            ['transitionTask', {taskId: 'MESSAGE:t', newState: 'Working'}],
            ['transitionTask', {taskId: 'MESSAGE:t', newState: 'Completed', expectedCurrentState: 'Working'}]
        ])
    });

    test('fleetOwnMessage forwards its optional closed observer and leaves the omitted body-read route unchanged', async () => {
        const
            oldWriter = FleetControlBridge.composeWriter,
            calls     = [];

        try {
            wireOperatorComposeWriter({
                addMessage: () => ({}),
                getMessage: args => { calls.push(args); return {messageId: args.messageId, observer: args.observer ?? null} }
            });

            expect(await FleetControlBridge.fleetOwnMessage({messageId: 'MESSAGE:ordinary', from: '@mallory'})).toEqual({
                messageId: 'MESSAGE:ordinary', observer: null
            });
            expect(await FleetControlBridge.fleetOwnMessage({
                messageId: 'MESSAGE:observed',
                observer : {scope: 'own', memorySharing: 'private'},
                from     : '@mallory',
                userId   : 'mallory'
            })).toEqual({messageId: 'MESSAGE:observed', observer: {scope: 'own', memorySharing: 'private'}});

            expect(await FleetControlBridge.fleetOwnMessage({
                messageId: 'MESSAGE:invalid', observer: {scope: 'own', userId: 'mallory'}
            })).toEqual({status: 'rejected', reason: 'getMessage: mailbox observer has unsupported field(s): userId'});
            expect(calls).toEqual([
                {messageId: 'MESSAGE:ordinary'},
                {messageId: 'MESSAGE:observed', observer: {scope: 'own', memorySharing: 'private'}}
            ])
        } finally {
            FleetControlBridge.composeWriter = oldWriter
        }
    });

    test('the own-inbox verbs reject a missing message id or a missing newState before the primitive runs', () => {
        let   invoked   = false;
        const primitive = () => { invoked = true; return {} };
        wireOperatorComposeWriter({addMessage: () => ({}), getMessage: primitive, markRead: primitive, transitionTask: primitive});

        for (const result of [
            FleetControlBridge.fleetOwnMessage({}),
            FleetControlBridge.markOwnMessageRead({messageId: ''}),
            FleetControlBridge.markOwnMessageRead(null),
            FleetControlBridge.transitionOwnTask({messageId: 'MESSAGE:t'}),
            FleetControlBridge.transitionOwnTask({newState: 'Completed'})
        ]) {
            expect(result.status).toBe('rejected')
        }

        expect(invoked).toBe(false)
    });

    test('the open questions read the viewer\'s own non-terminal Tasks, archived ones included, priority then age, as body-free rows with the complete count', async () => {
        const calls = [];
        wireOperatorComposeWriter({
            addMessage     : () => ({}),
            observeMessages: args => {
                calls.push(args);
                return {totalCount: 3, truncated: true, nextOffset: 1, limit: 1, offset: 0, messages: [{messageId: 'MESSAGE:q', subject: 'which way?', from: '@neo-gpt', to: '@tobiu', priority: 'high', task: {state: 'InputRequired'}, sentAt: '2026-10-08T22:00:00.000Z', archivedAt: '2026-10-08T23:00:00.000Z', bodyText: 'never on the wire'}]}
            }
        });

        const answer = await FleetControlBridge.fleetOwnQuestions({limit: 1, to: '@mallory'});

        // no identity-shaped field crosses: the seam reads under the transport-stamped viewer
        expect(calls).toEqual([{box: 'inbox', status: 'all', includeArchived: true, taskStates: ['InputRequired', 'Submitted', 'Working'], taskOrder: 'priority-age', limit: 1, offset: 0}]);
        expect(answer).toMatchObject({state: 'ok', reason: null, count: 3, page: {limit: 1, offset: 0, count: 1, hasMore: true}});
        expect(Date.parse(answer.capturedAt)).not.toBeNaN();
        // an archived question is still open: its row says it was archived
        expect(answer.rows).toEqual([expect.objectContaining({messageId: 'MESSAGE:q', taskState: 'InputRequired', priority: 'high', from: '@neo-gpt', archivedAt: '2026-10-08T23:00:00.000Z'})]);
        expect(JSON.stringify(answer)).not.toContain('never on the wire');

        // the page is bounded like the mailbox mirror's
        for (const [params, page] of [[{limit: 0}, {limit: 1, offset: 0}], [{limit: 999, offset: -4}, {limit: 200, offset: 0}], [{limit: '9'}, {limit: 50, offset: 0}]]) {
            await FleetControlBridge.fleetOwnQuestions(params);
            expect(calls.at(-1)).toMatchObject(page)
        }

        expect(await dispatchFleetRequest({method: 'fleetOwnQuestions', params: {limit: 1}, protocol: createFleetWireOffer()}))
            .toMatchObject({ok: true, state: 'ok', result: {state: 'ok', count: 3}})
    });

    test('an unwired, failed or countless questions read answers unavailable with its reason, never an empty list or a zero', async () => {
        expect(await FleetControlBridge.fleetOwnQuestions()).toMatchObject({state: 'unavailable', reason: 'fleet: no read here lists the open questions without marking them seen', count: null, rows: []});

        wireOperatorComposeWriter({addMessage: () => ({}), observeMessages: async () => { throw new Error('sqlite at /private/plane is locked') }});
        const failed = await FleetControlBridge.fleetOwnQuestions();

        expect(failed).toMatchObject({state: 'unavailable', reason: 'fleet: the open-questions read failed', count: null, rows: []});
        expect(Date.parse(failed.capturedAt)).not.toBeNaN();
        expect(JSON.stringify(failed)).not.toContain('/private/plane');

        wireOperatorComposeWriter({addMessage: () => ({}), observeMessages: async () => ({messages: []})});
        expect(await FleetControlBridge.fleetOwnQuestions()).toMatchObject({state: 'unavailable', count: null});

        wireOperatorComposeWriter({addMessage: () => ({}), observeMessages: async () => ({totalCount: 1, messages: []})});
        expect(await FleetControlBridge.fleetOwnQuestions(), 'a page without its continuation cannot say whether more remain')
            .toMatchObject({state: 'unavailable', reason: 'fleet: the open-questions read answered without its continuation', count: null})
    });

    test('a list that marks what it lists as seen never serves the open questions, nor their count', async () => {
        const seen = [], stamping = args => { seen.push(args); return {totalCount: 1, truncated: false, messages: []} };

        // the plane's binding: its one list is the model-visible tool, which records seenAt
        wireOperatorComposeWriter({addMessage: () => ({}), listMessages: stamping});
        expect(Object.hasOwn(FleetControlBridge.composeWriter, 'listMessages'), 'the seam takes no other list').toBe(false);

        FleetControlBridge.composeWriter.listMessages = stamping;
        expect(await FleetControlBridge.fleetOwnQuestions()).toMatchObject({state: 'unavailable', reason: 'fleet: no read here lists the open questions without marking them seen', count: null});
        expect((await FleetControlBridge.fleetOpenWork()).questions).toMatchObject({state: 'unavailable', count: null});
        expect(seen, 'the seen-marking list never ran').toEqual([])
    });

    test('the page continues as the mailbox served it: a projection hole neither ends a middle page nor extends a final one', async () => {
        const question = id => ({messageId: id, from: '@neo-gpt', to: '@tobiu', task: {state: 'InputRequired'}, sentAt: '2026-10-08T22:00:00.000Z'});

        // the final page served one row the graph could not project
        wireOperatorComposeWriter({addMessage: () => ({}), observeMessages: async () => ({totalCount: 1, messages: [], truncated: false, nextOffset: null, limit: 50, offset: 0})});
        expect(await FleetControlBridge.fleetOwnQuestions()).toMatchObject({state: 'ok', count: 1, rows: [], page: {limit: 50, offset: 0, count: 0, hasMore: false}});

        // a middle page served two rows, one of them a hole: the next window starts after both
        wireOperatorComposeWriter({addMessage: () => ({}), observeMessages: async () => ({totalCount: 3, messages: [question('MESSAGE:a')], truncated: true, nextOffset: 2, limit: 2, offset: 0})});
        const middle = await FleetControlBridge.fleetOwnQuestions({limit: 2});

        expect(middle).toMatchObject({state: 'ok', count: 3, page: {limit: 2, offset: 0, count: 1, hasMore: true}});
        expect(middle.page.offset + middle.page.limit, 'the consumer\'s next offset is the mailbox\'s nextOffset').toBe(2)
    });

    test('open work carries the questions count from a one-row page of the same read, beside its source envelope untouched', async () => {
        const original = FleetControlBridge.openWorkSource, calls = [];

        try {
            FleetControlBridge.openWorkSource = null;
            expect((await FleetControlBridge.fleetOpenWork()).questions).toEqual({state: 'unavailable', count: null, reason: 'fleet: no read here lists the open questions without marking them seen'});

            wireOperatorComposeWriter({addMessage: () => ({}), observeMessages: args => { calls.push(args); return {totalCount: 7, truncated: true, nextOffset: 1, messages: [{messageId: 'MESSAGE:q'}]} }});
            FleetControlBridge.openWorkSource = {readOpenWork: params => ({state: 'ok', coverage: 'complete', seats: {ada: {}}, params})};

            expect(await FleetControlBridge.fleetOpenWork({seat: 'ada'})).toEqual({
                state: 'ok', coverage: 'complete', seats: {ada: {}}, params: {seat: 'ada'}, questions: {state: 'ok', count: 7, reason: null}
            });
            expect(calls).toEqual([expect.objectContaining({limit: 1, offset: 0})])
        } finally {
            FleetControlBridge.openWorkSource = original
        }
    });

    test('a refused move crosses the whole wire as its code and a fixed reason, in process and from a plane; a lost race as the primitive returned it', async () => {
        const
            move     = () => dispatchFleetRequest({method: 'transitionOwnTask', params: {messageId: 'MESSAGE:t', newState: 'Working'}, protocol: createFleetWireOffer()}),
            throwing = message => async () => { throw new Error(message) },
            denial   = 'Unauthorized: @tobiu as assignee cannot transition `Completed → Working`';

        for (const message of [denial, `Error executing transition_task: ${denial}`]) {
            wireOperatorComposeWriter({addMessage: () => ({}), transitionTask: throwing(message)});

            expect(await move()).toMatchObject({ok: true, state: 'ok', result: {success: false, code: 'transition-refused', reason: 'the assignee cannot move this Task from Completed to Working'}})
        }

        wireOperatorComposeWriter({addMessage: () => ({}), transitionTask: throwing('Unauthorized: @tobiu is neither originator nor assignee for task MESSAGE:t')});
        expect((await move()).result).toEqual({success: false, rowsAffected: 0, code: 'not-a-participant', reason: "only the Task's originator or assignee can move it"});

        // control: a returned state conflict passes through unchanged
        const conflict = {success: false, rowsAffected: 0, reason: 'State mismatch: expected Working, got Completed', task: {state: 'Completed'}};
        wireOperatorComposeWriter({addMessage: () => ({}), transitionTask: async () => conflict});
        expect((await move()).result).toEqual(conflict);

        // a fault is no refusal: it stays generic, and its text never crosses
        wireOperatorComposeWriter({addMessage: () => ({}), transitionTask: throwing('Task MESSAGE:t has ambiguous originators: expected 1 SENT_BY edge, got 2')});
        const fault = await move();
        expect(fault).toMatchObject({ok: false, state: 'operation-failed', error: "fleet: 'transitionOwnTask' failed"});
        expect(JSON.stringify(fault)).not.toContain('SENT_BY')
    });

    test('each refusal shape the bridge recognizes is one the primitive throws', () => {
        const source = fs.readFileSync(new URL('../../../../../../ai/services/memory-core/MailboxService.mjs', import.meta.url), 'utf8');

        for (const template of [
            'Invalid new task state: ${newState}',
            'Task not found: ${taskId}',
            'Message ${taskId} is not an A2A Task (missing task.state)',
            'Unauthorized: ${me} is neither originator nor assignee for task ${taskId}',
            'Unauthorized: ${me} as ${role} cannot transition \\`${currentState} → ${newState}\\`'
        ]) {
            expect(source, template).toContain(template)
        }
    });
});
