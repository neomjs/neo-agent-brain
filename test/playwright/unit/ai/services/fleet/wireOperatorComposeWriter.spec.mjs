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
        const bridge = stubBridge(), getMessage = () => ({id: 'MESSAGE:m'});

        wireOperatorComposeWriter({bridge, addMessage: () => ({}), getMessage, markRead: 'not-a-function'});
        expect(bridge.composeWriter.getMessage).toBe(getMessage);
        expect(Object.hasOwn(bridge.composeWriter, 'markRead')).toBe(false);
        expect(Object.hasOwn(bridge.composeWriter, 'transitionTask')).toBe(false);

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

    test('the own-inbox verbs reject a missing message id or a missing newState before the primitive runs', () => {
        let invoked = false;
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
