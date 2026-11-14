import {test, expect} from '@playwright/test';
import crypto         from 'node:crypto';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';

import {
    HUMAN_INPUT_ACTIVE,
    HUMAN_INPUT_QUIET_MS,
    HUMAN_INPUT_UNKNOWN,
    ROTATION_ACTIVATION_LOST,
    ROTATION_EXPIRED,
    ROTATION_MAX_AGE_MS,
    ROTATION_SUPERSEDED,
    SESSION_ROTATE_EVENT_TYPE,
    admittedEventType,
    evaluateHumanInput,
    hasReceiptIdentity,
    isHumanInputDefer,
    isPreKeystrokeFailure,
    isRotationExpired,
    isSessionRotation,
    rotationEventId,
    rotationPrompt,
    routeAdmits
} from '../../../../../../ai/daemons/wake/sessionRotation.mjs';
import {
    buildOsascriptArgs,
    dispatchLocalWake,
    readHumanIdleMs
} from '../../../../../../ai/daemons/wake/localWakeAdapters.mjs';
import {createWakeReceiver, loadWakeReceiverManifest} from '../../../../../../ai/daemons/wake/receiver.mjs';
import {WakeReceiverState, getWakeRecordKey}          from '../../../../../../ai/daemons/wake/receiverState.mjs';

/**
 * A seat that writes its sunset handover continues in a fresh session: the plane emits one signed
 * `session/rotate` event, and the host wake receiver opens the session in that seat's own window and
 * submits the first prompt. These arms pin the receiver half:
 * - a rotation route admits only rotations, and a wake route only wakes;
 * - the step needs the seat's own instance and the app's fresh-session shortcut;
 * - it never types while a person is using the computer;
 * - a wake's keystrokes are unchanged.
 */

const PROMPT = 'Hi @neo-opus-ada, /context-recovery first please. Handover: MESSAGE:r1.';

const rotationEnvelope = (overrides = {}) => ({
    schemaVersion : '1.0',
    eventType     : SESSION_ROTATE_EVENT_TYPE,
    eventId       : 'session-rotate:MESSAGE:r1',
    subscriptionId: 'WAKE_SUB:rotate',
    agentIdentity : '@neo-opus-ada',
    payload       : {receiptMessageId: 'MESSAGE:r1', oldSessionId: 'session-old', reason: 'sunset_restart', prompt: PROMPT},
    emittedAt     : '2026-11-13T17:00:00.000Z',
    ...overrides
});

const rotationRecord = ({meta = {}, envelope = {}, acceptedAt = new Date().toISOString(), adapterConfig = {attemptTimeoutMs: 10_000}} = {}) => ({
    subscriptionId: 'WAKE_SUB:rotate',
    acceptedAt,
    envelope      : rotationEnvelope(envelope),
    route         : {
        agentIdentity        : '@neo-opus-ada',
        admits               : SESSION_ROTATE_EVENT_TYPE,
        harnessTargetMetadata: {
            adapter        : 'osascript',
            appName        : 'Claude',
            addressType    : 'userDataDir',
            instanceAddress: '/seats/neo-opus-ada/claude-desktop',
            ...meta
        },
        adapterConfig
    }
});

const quietEffects = overrides => ({
    platform             : 'darwin',
    log                  : {log() {}, warn() {}, error() {}},
    homedir              : os.homedir,
    fs,
    fetch                : globalThis.fetch,
    getDefaultTarget     : async () => ({status: 'ok', pid: 4242}),
    resolveGuiInstancePid: async () => 4242,
    readHumanIdleMs      : () => HUMAN_INPUT_QUIET_MS,
    spawnAsync           : async () => '',
    ...overrides
});

const typedPaste = calls => calls.filter(call => call.args.some(arg => String(arg).includes('keystroke "v"')));

test.describe('ai/daemons/wake/sessionRotation — the contract', () => {
    test('only a SESSION_ROTATE route admits session/rotate; every other route admits the wake digest', () => {
        expect(admittedEventType({trigger: 'SESSION_ROTATE'})).toBe(SESSION_ROTATE_EVENT_TYPE);
        expect(admittedEventType({trigger: 'SENT_TO_ME'})).toBeNull();
        expect(admittedEventType()).toBeNull();
        expect(routeAdmits({})).toBe('wake/digest');
        expect(routeAdmits({admits: SESSION_ROTATE_EVENT_TYPE})).toBe(SESSION_ROTATE_EVENT_TYPE);
        expect(isSessionRotation(rotationEnvelope())).toBe(true);
        expect(isSessionRotation({eventType: 'wake/digest'})).toBe(false)
    });

    test('a rotation without a non-blank prompt has nothing to type', () => {
        expect(rotationPrompt(rotationEnvelope())).toBe(PROMPT);
        expect(rotationPrompt(rotationEnvelope({payload: {prompt: '   '}}))).toBeNull();
        expect(rotationPrompt(rotationEnvelope({payload: {}}))).toBeNull()
    });

    test('a rotation types at a 3 s pause, not a quiet minute, and an unreadable clock defers', () => {
        expect(evaluateHumanInput(3_000)).toEqual({action: 'type'});
        expect(evaluateHumanInput(2_999)).toEqual({action: 'defer', reason: HUMAN_INPUT_ACTIVE});
        expect(evaluateHumanInput(null)).toEqual({action: 'defer', reason: HUMAN_INPUT_UNKNOWN});
        expect(isHumanInputDefer(HUMAN_INPUT_ACTIVE)).toBe(true);
        expect(isHumanInputDefer(HUMAN_INPUT_UNKNOWN)).toBe(true);
        expect(isHumanInputDefer('interactive-dialog-pending')).toBe(false)
    });

    test('a rotation is on time for a minute after its accept, and an unreadable accept time is late', () => {
        const accepted = Date.parse('2026-11-14T21:54:52.831Z');

        expect(isRotationExpired('2026-11-14T21:54:52.831Z', accepted + ROTATION_MAX_AGE_MS - 1)).toBe(false);
        expect(isRotationExpired('2026-11-14T21:54:52.831Z', accepted + ROTATION_MAX_AGE_MS)).toBe(true);
        // The 21:54Z receipt was typed 9 min after its accept, into a seat restarted by hand.
        expect(isRotationExpired('2026-11-14T21:54:52.831Z', Date.parse('2026-11-14T22:03:55.277Z'))).toBe(true);
        expect(isRotationExpired(undefined, accepted)).toBe(true)
    });

    test('only a failure in the activation phase typed nothing', () => {
        // Grace's 21:04Z rotation, verbatim from the receiver's record.
        expect(isPreKeystrokeFailure('4154:4160: execution error: Target app lost frontmost status after activation (-2700)')).toBe(true);
        expect(isPreKeystrokeFailure('execution error: Target app lost frontmost status before prompt clear (-2700)')).toBe(false);
        expect(isPreKeystrokeFailure(undefined)).toBe(false)
    });

    test('the idle clock is read from IOHIDSystem without a grant', () => {
        const idle  = '  | "HIDIdleTime" = 61000000000\n',
              ioreg = result => () => ({status: 0, signal: null, ...result});

        expect(readHumanIdleMs({platform: 'darwin', spawnSyncFn: ioreg({stdout: idle})})).toBe(61_000);
        expect(readHumanIdleMs({platform: 'darwin', spawnSyncFn: ioreg({stdout: 'no idle key here'})})).toBeNull();
        expect(readHumanIdleMs({platform: 'linux', spawnSyncFn: ioreg({stdout: idle})})).toBeNull()
    });

    test('a failed, killed or timed-out read is no observation, even with numeric output', () => {
        const idle = '  | "HIDIdleTime" = 61000000000\n';

        for (const failed of [
            {status: 1, signal: null, stdout: idle},
            {status: null, signal: 'SIGTERM', stdout: idle},
            {status: null, signal: null, error: new Error('spawnSync ioreg ETIMEDOUT'), stdout: idle}
        ]) {
            expect(readHumanIdleMs({platform: 'darwin', spawnSyncFn: () => failed}), JSON.stringify(failed)).toBeNull()
        }
    });

    test('a rotation\'s event id is its receipt\'s, so one receipt is one record', () => {
        const envelope = rotationEnvelope();

        expect(envelope.eventId).toBe(rotationEventId('MESSAGE:r1'));
        expect(hasReceiptIdentity(envelope)).toBe(true);
        expect(hasReceiptIdentity(rotationEnvelope({eventId: 'session-rotate:other'}))).toBe(false);
        expect(hasReceiptIdentity(rotationEnvelope({payload: {prompt: PROMPT}}))).toBe(false)
    });
});

test.describe('ai/daemons/wake/sessionRotation — the osascript step', () => {
    test('a quiet keyboard opens a fresh session in the seat\'s window and submits the prompt there', async () => {
        const calls  = [];
        const result = await dispatchLocalWake(rotationRecord(), quietEffects({
            spawnAsync: async (command, args) => { calls.push({command, args}); return '' }
        }));

        expect(result).toBe('delivered');

        const [delivery] = typedPaste(calls),
              lines      = delivery.args.map(String),
              tab        = lines.indexOf('      keystroke "3" using command down'),
              fresh      = lines.indexOf('      keystroke "n" using command down'),
              clear      = lines.findIndex(line => line.includes('"before prompt clear"'));

        expect(tab).toBeGreaterThan(-1);
        expect(fresh).toBeGreaterThan(tab);
        expect(clear).toBeGreaterThan(fresh);
        expect(lines.at(-1)).toBe(PROMPT);
        // Addressed by the seat's own process, never by app name.
        expect(lines.some(line => line.includes('tell application "Claude" to activate'))).toBe(false)
    });

    test('a person at the keyboard defers the rotation without a single keystroke', async () => {
        const calls  = [];
        const result = await dispatchLocalWake(rotationRecord(), quietEffects({
            readHumanIdleMs: () => 1_000,
            spawnAsync     : async (command, args) => { calls.push({command, args}); return '' }
        }));

        expect(result).toEqual({outcome: 'deferred', outcomeReason: HUMAN_INPUT_ACTIVE});
        expect(typedPaste(calls)).toHaveLength(0)
    });

    test('a window that loses the front before the first keystroke defers the rotation; a later loss fails it', async () => {
        const run = message => dispatchLocalWake(rotationRecord(), quietEffects({
            spawnAsync: async (command, args) => {
                if (args.some(arg => String(arg).includes('keystroke "v"'))) throw new Error(message);
                return ''
            }
        }));

        expect(await run('4154:4160: execution error: Target app lost frontmost status after activation (-2700)'))
            .toEqual({outcome: 'deferred', outcomeReason: ROTATION_ACTIVATION_LOST});
        expect(await run('execution error: Target app lost frontmost status before wake paste (-2700)'))
            .toMatchObject({outcome: 'failed'})
    });

    test('Emmy\'s control: a deadline crossed while the idle clock is read opens no session', async () => {
        const calls  = [];
        const result = await dispatchLocalWake(
            rotationRecord({acceptedAt: new Date(Date.now() - (ROTATION_MAX_AGE_MS - 10)).toISOString()}),
            quietEffects({
                readHumanIdleMs: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return HUMAN_INPUT_QUIET_MS },
                spawnAsync     : async (command, args) => { calls.push({command, args}); return '' }
            })
        );

        expect(result).toEqual({outcome: 'failed', outcomeReason: ROTATION_EXPIRED});
        expect(typedPaste(calls)).toHaveLength(0)
    });

    test('Emmy\'s control: an attempt that outlives its adapter timeout opens no session when it settles', async () => {
        const calls  = [];
        const result = await dispatchLocalWake(
            rotationRecord({adapterConfig: {attemptTimeoutMs: 10}}),
            quietEffects({
                readHumanIdleMs: async () => { await new Promise(resolve => setTimeout(resolve, 50)); return HUMAN_INPUT_QUIET_MS },
                spawnAsync     : async (command, args) => { calls.push({command, args}); return '' }
            })
        );

        expect(result).toBe('unknown');
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(typedPaste(calls)).toHaveLength(0)
    });

    test('a seat another session claimed since the first attempt vetoes the keystroke', async () => {
        const calls  = [];
        const result = await dispatchLocalWake(rotationRecord(), quietEffects({
            rotationGuard: () => ROTATION_SUPERSEDED,
            spawnAsync   : async (command, args) => { calls.push({command, args}); return '' }
        }));

        expect(result).toEqual({outcome: 'failed', outcomeReason: ROTATION_SUPERSEDED});
        expect(typedPaste(calls)).toHaveLength(0)
    });

    test('the script refuses the fresh-session keystroke once the rotation\'s seconds run out', () => {
        const lines = buildOsascriptArgs({appName: 'Claude', digest: 'boot', instancePid: 4242, freshSessionShortcut: 'n', freshSessionDeadlineSeconds: 7}).map(String),
              fresh = lines.indexOf('      keystroke "n" using command down');

        expect(lines).toContain('  set rotationDeadline to (current date) + 7');
        expect(lines[fresh - 2]).toBe('      if (current date) > rotationDeadline then error "Rotation deadline passed before the fresh session"')
    });

    test('Emmy\'s Round-2 control: the script re-reads the seat holder right before the fresh-session keystroke', () => {
        const lines = buildOsascriptArgs({
                  appName: 'Claude', digest: 'boot', instancePid: 4242, freshSessionShortcut: 'n', freshSessionDeadlineSeconds: 7,
                  freshSessionHolder: {path: '/seats/ada/listeners/neo-opus-ada.json', sessionId: 'old-session'}
              }).map(String),
              fresh = lines.indexOf('      keystroke "n" using command down');

        expect(lines[fresh - 4]).toBe('      tell current application to set rotationHolderNow to (do shell script "cat " & quoted form of "/seats/ada/listeners/neo-opus-ada.json")');
        expect(lines[fresh - 2]).toBe('      if rotationHolderNow does not contain "old-session" then error "Seat holder changed before the fresh session"')
    });

    test('the idle clock is read last: after the pid lookup and the dialog probe, before the first keystroke', async () => {
        const order  = [];
        const result = await dispatchLocalWake(rotationRecord(), quietEffects({
            resolveGuiInstancePid: async () => { order.push('pid'); return 4242 },
            readHumanIdleMs      : () => { order.push('idle'); return HUMAN_INPUT_QUIET_MS },
            spawnAsync           : async (command, args) => {
                order.push(args.some(arg => String(arg).includes('keystroke "v"')) ? 'type' : 'probe');
                return ''
            }
        }));

        expect(result).toBe('delivered');
        expect(order).toEqual(['pid', 'probe', 'idle', 'type'])
    });

    for (const stage of ['pid lookup', 'dialog probe']) {
        test(`activity that resumes during the ${stage} defers the rotation`, async () => {
            const calls  = [];
            let   busy   = false;
            const result = await dispatchLocalWake(rotationRecord(), quietEffects({
                resolveGuiInstancePid: async () => { if (stage === 'pid lookup') busy = true; return 4242 },
                readHumanIdleMs      : () => busy ? 0 : HUMAN_INPUT_QUIET_MS,
                spawnAsync           : async (command, args) => {
                    calls.push({command, args});
                    if (stage === 'dialog probe') busy = true;
                    return ''
                }
            }));

            expect(result).toEqual({outcome: 'deferred', outcomeReason: HUMAN_INPUT_ACTIVE});
            expect(typedPaste(calls)).toHaveLength(0)
        });
    }

    test('an unreadable idle clock defers rather than guesses', async () => {
        const result = await dispatchLocalWake(rotationRecord(), quietEffects({readHumanIdleMs: () => null}));

        expect(result).toEqual({outcome: 'deferred', outcomeReason: HUMAN_INPUT_UNKNOWN})
    });

    test('a rotation without the seat\'s own instance is refused before any osascript runs', async () => {
        const calls   = [];
        let   lookups = 0;
        const result  = await dispatchLocalWake(
            rotationRecord({meta: {addressType: undefined, instanceAddress: undefined}}),
            quietEffects({
                getDefaultTarget: async () => { lookups++; return {status: 'ok', pid: 4242} },
                spawnAsync      : async (command, args) => { calls.push({command, args}); return '' }
            })
        );

        expect(result).toEqual({outcome: 'failed', outcomeReason: 'session-rotate-requires-addressed-instance'});
        expect(calls).toHaveLength(0);
        expect(lookups, 'the app-name default target is never consulted').toBe(0)
    });

    test('an app with no measured fresh-session shortcut is refused', async () => {
        const result = await dispatchLocalWake(
            rotationRecord({meta: {appName: 'Codex', focusSeedKey: 'r'}}),
            quietEffects()
        );

        expect(result).toEqual({outcome: 'failed', outcomeReason: 'session-rotate-without-fresh-session-shortcut:Codex'})
    });

    test('a rotation without a prompt, or on another transport, is refused', async () => {
        expect(await dispatchLocalWake(rotationRecord({envelope: {payload: {prompt: ''}}}), quietEffects()))
            .toEqual({outcome: 'failed', outcomeReason: 'session-rotate-without-prompt'});
        expect(await dispatchLocalWake(rotationRecord({meta: {adapter: 'tmux', tmuxSession: 'seat'}}), quietEffects()))
            .toEqual({outcome: 'failed', outcomeReason: 'session-rotate-unsupported-adapter:tmux'})
    });

    test('a wake keeps its keystrokes: the fresh-session step adds exactly two lines', () => {
        const wake     = buildOsascriptArgs({appName: 'Claude', digest: 'wake', instancePid: 4242, tabShortcut: '3'}),
              rotation = buildOsascriptArgs({appName: 'Claude', digest: 'wake', instancePid: 4242, tabShortcut: '3', freshSessionShortcut: 'n'}),
              fresh    = rotation.indexOf('      keystroke "n" using command down');

        expect(wake.some(arg => String(arg).includes('keystroke "n"'))).toBe(false);
        expect([...rotation.slice(0, fresh - 1), ...rotation.slice(fresh + 3)]).toEqual(wake)
    });
});

test.describe('ai/daemons/wake/sessionRotation — the receiver', () => {
    const signingKey = 'c'.repeat(64);
    const manifest   = {
        schemaVersion: 1,
        routes       : {
            'WAKE_SUB:wake': {
                signingKey,
                agentIdentity        : '@neo-opus-ada',
                harnessTargetMetadata: {adapter: 'tmux', tmuxSession: 'seat'},
                adapterConfig        : {attemptTimeoutMs: 100, contextGate: {maxContextTokens: 10, warnContextTokens: 5}}
            },
            'WAKE_SUB:rotate': {
                signingKey,
                agentIdentity        : '@neo-opus-ada',
                admits               : SESSION_ROTATE_EVENT_TYPE,
                harnessTargetMetadata: {adapter: 'osascript', appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/seats/ada'},
                adapterConfig        : {attemptTimeoutMs: 100, contextGate: {maxContextTokens: 10, warnContextTokens: 5}}
            }
        }
    };

    let baseUrl, dispatched, dispatchResult, probes, receiver, state, stateDir;

    test.beforeEach(async () => {
        stateDir       = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-session-rotation-'));
        state          = new WakeReceiverState({stateDir});
        await state.init();
        dispatched     = [];
        dispatchResult = 'delivered';
        probes         = 0;
        receiver       = createWakeReceiver({
            manifest,
            state,
            dispatch    : async record => { dispatched.push(record); return dispatchResult },
            contextProbe: async () => { probes++; return null },
            logger      : {error() {}, warn() {}, log() {}}
        });
        await new Promise(resolve => receiver.server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${receiver.server.address().port}`
    });

    test.afterEach(async () => {
        await new Promise(resolve => receiver.server.close(resolve));
        // A 202 answers before its record is written: let the serial drain settle before the directory goes.
        await receiver.drain();
        await fs.rm(stateDir, {recursive: true, force: true})
    });

    const post = (subscriptionId, envelope) => {
        const body = JSON.stringify({...envelope, subscriptionId});

        return fetch(`${baseUrl}/wake`, {
            method : 'POST',
            headers: {
                'content-type'              : 'application/json',
                'x-neo-wake-event-id'       : envelope.eventId,
                'x-neo-wake-subscription-id': subscriptionId,
                'x-neo-wake-schema-version' : '1.0',
                'x-neo-wake-signature'      : crypto.createHmac('sha256', signingKey).update(body).digest('hex')
            },
            body
        })
    };

    const wakeEnvelope = {
        schemaVersion: '1.0',
        eventType    : 'wake/digest',
        eventId      : 'wake-digest:1',
        agentIdentity: '@neo-opus-ada',
        payload      : {totalEvents: 1, sourceEventIds: ['MESSAGE:1']},
        emittedAt    : '2026-11-13T17:00:00.000Z'
    };

    test('a rotation route admits a rotation and refuses a wake; a wake route refuses a rotation', async () => {
        expect((await post('WAKE_SUB:rotate', rotationEnvelope())).status).toBe(202);
        expect((await post('WAKE_SUB:rotate', wakeEnvelope)).status).toBe(409);
        expect((await post('WAKE_SUB:wake', rotationEnvelope())).status).toBe(409);
        expect((await post('WAKE_SUB:wake', wakeEnvelope)).status).toBe(202)
    });

    test('one receipt rotates once: a re-emitted event is a duplicate', async () => {
        expect((await post('WAKE_SUB:rotate', rotationEnvelope())).status).toBe(202);
        await receiver.drain();

        const again = await post('WAKE_SUB:rotate', rotationEnvelope());

        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({status: 'duplicate'});
        await receiver.drain();
        expect(dispatched).toHaveLength(1)
    });

    test('one receipt rotates once: another event id for the same receipt is refused, a new receipt rotates', async () => {
        expect((await post('WAKE_SUB:rotate', rotationEnvelope())).status).toBe(202);
        await receiver.drain();

        const relabelled = await post('WAKE_SUB:rotate', rotationEnvelope({eventId: 'session-rotate:MESSAGE:r1-again'})),
              noReceipt  = await post('WAKE_SUB:rotate', rotationEnvelope({eventId: 'session-rotate:', payload: {prompt: PROMPT}}));

        expect(relabelled.status).toBe(409);
        expect(await relabelled.json()).toEqual({error: 'rotation-receipt-mismatch'});
        expect(noReceipt.status).toBe(409);

        const next = rotationEnvelope({
            eventId: rotationEventId('MESSAGE:r2'),
            payload: {receiptMessageId: 'MESSAGE:r2', oldSessionId: 'session-old-2', reason: 'sunset_restart', prompt: PROMPT}
        });

        expect((await post('WAKE_SUB:rotate', next)).status).toBe(202);
        await receiver.drain();
        expect(dispatched.map(record => record.envelope.payload.receiptMessageId)).toEqual(['MESSAGE:r1', 'MESSAGE:r2'])
    });

    test('the context gate never holds a rotation back: it exists because the session is full', async () => {
        await post('WAKE_SUB:rotate', rotationEnvelope());
        await receiver.drain();
        expect(probes).toBe(0);
        expect(dispatched).toHaveLength(1);

        await post('WAKE_SUB:wake', wakeEnvelope);
        await receiver.drain();
        expect(probes, 'a wake on a gated route is still probed').toBe(1)
    });

    // A receiver of its own over the same state: these arms set the retry interval and the clock.
    const rotationReceiver = (results, options) => createWakeReceiver({
        manifest,
        state,
        dispatch: async record => { dispatched.push(record); return results.shift() ?? 'delivered' },
        logger  : {error() {}, warn() {}, log() {}},
        ...options
    });
    const rotationKey = getWakeRecordKey({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1'});

    test('a person at the keyboard defers the rotation, and it is asked again within a second, not at the next re-drain', async () => {
        const quick = rotationReceiver([{outcome: 'deferred', outcomeReason: HUMAN_INPUT_ACTIVE}], {rotationRetryMs: 20});

        // Accepted directly, as the dialog-gate arms do: an HTTP accept starts a drain of its own.
        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await quick.drain();

        expect(await state.read(rotationKey)).toMatchObject({state: 'pending', deferCount: 1, deferReason: HUMAN_INPUT_ACTIVE});

        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('delivered');
        expect(dispatched).toHaveLength(2)
    });

    test('a rotation past its age fails without a keystroke, however long it was deferred', async () => {
        const late = rotationReceiver([], {clock: () => Date.now() + ROTATION_MAX_AGE_MS});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await late.drain();

        expect(dispatched).toEqual([]);
        expect(await state.read(rotationKey)).toMatchObject({state: 'failed', outcomeReason: 'session-rotate-expired'})
    });

    test('Emmy\'s control: a session opened by hand during a defer supersedes the rotation, with no second dispatch', async () => {
        const listenerStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-rotation-listeners-')),
              holder           = sessionId => fs.writeFile(path.join(listenerStateDir, 'neo-opus-ada.json'), JSON.stringify({owner: {sessionId, session: {pid: 7}}})),
              quick            = rotationReceiver([{outcome: 'deferred', outcomeReason: HUMAN_INPUT_ACTIVE}], {rotationRetryMs: 200, listenerStateDir});

        try {
            await holder('old-session');
            await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
            await quick.drain();

            expect(await state.read(rotationKey)).toMatchObject({state: 'pending', seatHolder: 'old-session#7'});

            await holder('opened-by-hand');

            await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('failed');
            expect((await state.read(rotationKey)).outcomeReason).toBe(ROTATION_SUPERSEDED);
            expect(dispatched).toHaveLength(1)
        } finally {
            await fs.rm(listenerStateDir, {recursive: true, force: true})
        }
    });

    test('Emmy\'s Round-2 control: a holder that appears after an unreadable first read supersedes the rotation', async () => {
        const listenerStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-rotation-listeners-')),
              quick            = rotationReceiver([{outcome: 'deferred', outcomeReason: HUMAN_INPUT_ACTIVE}], {rotationRetryMs: 200, listenerStateDir});

        try {
            await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
            await quick.drain();

            expect(await state.read(rotationKey)).toMatchObject({state: 'pending', seatHolder: null});

            await fs.writeFile(path.join(listenerStateDir, 'neo-opus-ada.json'), JSON.stringify({owner: {sessionId: 'opened-by-hand', session: {pid: 9}}}));

            await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('failed');
            expect((await state.read(rotationKey)).outcomeReason).toBe(ROTATION_SUPERSEDED);
            expect(dispatched).toHaveLength(1)
        } finally {
            await fs.rm(listenerStateDir, {recursive: true, force: true})
        }
    });

    test('a lost activation is asked again inside the age, like a person at the keyboard', async () => {
        const quick = rotationReceiver([{outcome: 'deferred', outcomeReason: ROTATION_ACTIVATION_LOST}], {rotationRetryMs: 20});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await quick.drain();

        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('delivered');
        expect(dispatched).toHaveLength(2)
    });
});

test.describe('ai/daemons/wake/sessionRotation — the manifest loader', () => {
    const route = overrides => ({
        signingKey           : 'd'.repeat(64),
        agentIdentity        : '@neo-opus-ada',
        admits               : SESSION_ROTATE_EVENT_TYPE,
        harnessTargetMetadata: {adapter: 'osascript', appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/seats/ada'},
        adapterConfig        : {attemptTimeoutMs: 100},
        ...overrides
    });

    const load = async routeEntry => {
        const dir          = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-rotation-manifest-')),
              manifestPath = path.join(dir, 'routes.json');

        try {
            await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, routes: {'WAKE_SUB:rotate': routeEntry}}), {mode: 0o600});
            return await loadWakeReceiverManifest(manifestPath)
        } finally {
            await fs.rm(dir, {recursive: true, force: true})
        }
    };

    test('a rotation route loads only when it names the seat\'s own instance on osascript', async () => {
        await expect(load(route())).resolves.toMatchObject({schemaVersion: 1});
        await expect(load(route({harnessTargetMetadata: {adapter: 'osascript', appName: 'Claude'}})))
            .rejects.toThrow('only on an instance-addressed osascript route');
        await expect(load(route({harnessTargetMetadata: {adapter: 'tmux', tmuxSession: 'seat'}})))
            .rejects.toThrow('only on an instance-addressed osascript route');
        await expect(load(route({admits: 'session/clear'}))).rejects.toThrow('unsupported envelope type')
    });
});
