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
    ROTATION_DESTINATION_UNPROVEN,
    ROTATION_EXPIRED,
    ROTATION_FRONT_LOST,
    ROTATION_MAX_ACTIVATION_LOSSES,
    ROTATION_MAX_AGE_MS,
    ROTATION_PROCESS_CHANGED,
    ROTATION_SCREEN_LOCKED,
    ROTATION_SESSION_OPENED,
    ROTATION_SUPERSEDED,
    SESSION_ROTATE_EVENT_TYPE,
    admittedEventType,
    buildRotationEnvelope,
    evaluateHumanInput,
    hasReceiptIdentity,
    isHumanInputDefer,
    isPostSessionFrontLost,
    isPreKeystrokeFailure,
    isPreSessionFailure,
    isRotationExpired,
    isSessionRotation,
    rotationDeadline,
    rotationEventId,
    rotationPrompt,
    routeAdmits
} from '../../../../../../ai/daemons/wake/sessionRotation.mjs';
import {
    buildOsascriptArgs,
    dispatchLocalWake,
    readHumanIdleMs,
    readScreenLocked
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
    readScreenLocked     : () => false,
    spawnAsync           : async () => '',
    ...overrides
});

const typedPaste = calls => calls.filter(call => call.args.some(arg => String(arg).includes('keystroke "v"')));

// The script's first key of any kind: a fence that should stop a script typing nothing is checked against this.
const isKey    = line => /^\s*(keystroke|key code)\b/.test(line);
const firstKey = lines => lines.findIndex(isKey);

// A rotation whose earlier attempt opened its session in the process the resolver still returns (`4242`), a second
// ago: quietEffects' idle reading (HUMAN_INPUT_QUIET_MS) covers that second, so no one has touched the input since.
const resumedRecord = () => ({...rotationRecord(), sessionOpened: true, sessionOpenedAt: new Date(Date.now() - 1000).toISOString(), sessionOpenedPid: 4242});

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
        const acceptedAt = '2026-11-14T21:54:52.831Z',
              accepted   = Date.parse(acceptedAt);

        expect(isRotationExpired({acceptedAt}, accepted + ROTATION_MAX_AGE_MS - 1)).toBe(false);
        expect(isRotationExpired({acceptedAt}, accepted + ROTATION_MAX_AGE_MS)).toBe(true);
        // The 21:54Z receipt was typed 9 min after its accept, into a seat restarted by hand.
        expect(isRotationExpired({acceptedAt}, Date.parse('2026-11-14T22:03:55.277Z'))).toBe(true);
        expect(isRotationExpired({}, accepted)).toBe(true)
    });

    test('#1770: under the plane\'s hold, the hold alone ends the wait', () => {
        // Ada's 22:28Z rotation: accepted 22:28:59.604Z, failed `session-rotate-expired` at 22:30:00.065Z after ten
        // `human-input-active` defers. The hold is the one its handover would carry: sent 22:28:36.733Z, plus 3 h.
        const acceptedAt = '2026-11-15T22:28:59.604Z',
              holdUntil  = '2026-11-16T01:28:36.733Z',
              envelope   = rotationEnvelope({payload: {holdUntil}});

        expect(isRotationExpired({acceptedAt, envelope}, Date.parse('2026-11-15T22:30:00.065Z'))).toBe(false);
        expect(isRotationExpired({acceptedAt, envelope}, Date.parse(holdUntil) - 1)).toBe(false);
        expect(isRotationExpired({acceptedAt, envelope}, Date.parse(holdUntil))).toBe(true);
        // A hold that ends inside the minute wins too.
        expect(rotationDeadline({acceptedAt, envelope: rotationEnvelope({payload: {holdUntil: '2026-11-15T22:29:10.000Z'}})}))
            .toBe(Date.parse('2026-11-15T22:29:10.000Z'));
        // A record that cannot be aged is late, hold or not.
        expect(isRotationExpired({envelope}, Date.parse(acceptedAt))).toBe(true)
    });

    test('#1770 AC-4 (Emmy\'s Round 1): without a valid signed hold, the bound stays the wall-clock minute', () => {
        const acceptedAt = '2026-11-15T00:00:00.000Z',
              accepted   = Date.parse(acceptedAt);

        // An older plane sends no hold; a malformed one is no hold either.
        for (const envelope of [undefined, rotationEnvelope(), rotationEnvelope({payload: {holdUntil: 'not-a-date'}})]) {
            const label = JSON.stringify(envelope?.payload ?? null);

            expect(isRotationExpired({acceptedAt, envelope}, accepted + ROTATION_MAX_AGE_MS - 1), label).toBe(false);
            expect(isRotationExpired({acceptedAt, envelope}, accepted + ROTATION_MAX_AGE_MS), label).toBe(true);
            expect(rotationDeadline({acceptedAt, envelope}), label).toBe(accepted + ROTATION_MAX_AGE_MS)
        }
    });

    test('#1770: the lock flag is read from the IORegistry root without a grant', () => {
        const users = locked => '+-o Root  <class IORegistryEntry>\n    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,' +
                  `${locked ? '"CGSSessionScreenIsLocked"=Yes,' : ''}"kCGSSessionUserIDKey"=501})\n`,
              calls = [],
              ioreg = result => (command, args) => { calls.push([command, ...args]); return {status: 0, signal: null, ...result} };

        expect(readScreenLocked({platform: 'darwin', spawnSyncFn: ioreg({stdout: users(true)})})).toBe(true);
        expect(calls[0]).toEqual(['ioreg', '-n', 'Root', '-d', '1']);
        expect(readScreenLocked({platform: 'darwin', spawnSyncFn: ioreg({stdout: users(false)})})).toBe(false);
        // Without the console sessions, the flag's absence proves nothing.
        expect(readScreenLocked({platform: 'darwin', spawnSyncFn: ioreg({stdout: '+-o Root\n'})})).toBeNull();
        expect(readScreenLocked({platform: 'darwin', spawnSyncFn: ioreg({status: 1, stdout: users(true)})})).toBeNull();
        expect(readScreenLocked({platform: 'linux', spawnSyncFn: ioreg({stdout: users(true)})})).toBeNull()
    });

    test('#1770: the envelope carries the plane\'s hold only when the plane sends one', () => {
        const base = {
            subscription    : {id: 'WAKE_SUB:rotate', properties: {agentIdentity: '@neo-opus-ada'}},
            receiptMessageId: 'MESSAGE:r1',
            oldSessionId    : 'session-old',
            prompt          : PROMPT,
            emittedAt       : '2026-11-15T19:43:21.851Z'
        };

        expect(buildRotationEnvelope({...base, holdUntil: '2026-11-15T22:43:00.000Z'}).payload.holdUntil).toBe('2026-11-15T22:43:00.000Z');
        expect(buildRotationEnvelope(base).payload).not.toHaveProperty('holdUntil')
    });

    test('#1770 (Emmy\'s Round 1): a lost front before Cmd+N opened nothing; the holder and cutoff refusals stay final', () => {
        expect(isPreSessionFailure('4154:4160: execution error: Target app lost frontmost status after activation (-2700)')).toBe(true);
        expect(isPreSessionFailure('execution error: Target app lost frontmost status before fresh session (-2700)')).toBe(true);
        expect(isPreSessionFailure('execution error: Seat holder changed before the fresh session (-2700)')).toBe(false);
        expect(isPreSessionFailure('execution error: Rotation deadline passed before the fresh session (-2700)')).toBe(false);
        expect(isPreSessionFailure('execution error: Target app lost frontmost status before prompt clear (-2700)')).toBe(false);
        expect(isPreSessionFailure(undefined)).toBe(false)
    });

    test('#1871: only a front lost after Cmd+N resumes in the session it opened', () => {
        // Vega's 2026-11-20 rotation, verbatim from the receiver's record.
        expect(isPostSessionFrontLost('4848:4854: execution error: Target app lost frontmost status before wake paste (-2700)')).toBe(true);
        expect(isPostSessionFrontLost('execution error: Target app lost frontmost status before prompt clear (-2700)')).toBe(true);
        expect(isPostSessionFrontLost('execution error: Target app lost frontmost status before wake clipboard set (-2700)')).toBe(true);
        expect(isPostSessionFrontLost('execution error: Target app lost frontmost status before fresh session (-2700)')).toBe(false);
        expect(isPostSessionFrontLost('execution error: Seat holder changed before the fresh session (-2700)')).toBe(false);
        expect(isPostSessionFrontLost(undefined)).toBe(false)
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

    test('#1871: a front lost before the first keystroke asks again, one lost after Cmd+N resumes, and a refusal stays final', async () => {
        const run = message => dispatchLocalWake(rotationRecord(), quietEffects({
            spawnAsync: async (command, args) => {
                if (args.some(arg => String(arg).includes('keystroke "v"'))) throw new Error(message);
                return ''
            }
        }));

        expect(await run('4154:4160: execution error: Target app lost frontmost status after activation (-2700)'))
            .toEqual({outcome: 'deferred', outcomeReason: ROTATION_ACTIVATION_LOST});
        // The opened session's process travels with the defer, so the resume can be bound to it.
        expect(await run('4848:4854: execution error: Target app lost frontmost status before wake paste (-2700)'))
            .toEqual({outcome: 'deferred', outcomeReason: ROTATION_SESSION_OPENED, sessionOpenedAt: expect.any(String), sessionOpenedPid: 4242});
        expect(await run('execution error: Seat holder changed before the fresh session (-2700)'))
            .toMatchObject({outcome: 'failed'})
    });

    test('#1871 (Euclid\'s Round 1): a resume runs its holder, front and cutoff checks before its first key, Claude\'s tab shortcut included', async () => {
        const calls  = [];
        const result = await dispatchLocalWake(resumedRecord(), quietEffects({
            rotationHolder: {path: '/seats/neo-opus-ada/listener.json', sessionId: 'session-old'},
            spawnAsync    : async (command, args) => { calls.push({command, args}); return '' }
        }));

        expect(result).toBe('delivered');

        const lines = typedPaste(calls)[0].args.map(String),
              key   = firstKey(lines),
              at    = text => lines.findIndex(line => line.includes(text));

        // Claude's defaults make the tab shortcut the first key; no second Cmd+N follows it.
        expect(lines[key]).toBe('      keystroke "3" using command down');
        expect(lines).not.toContain('      keystroke "n" using command down');

        for (const check of ['Seat holder changed before the fresh session', '"before fresh session"', 'Rotation deadline passed before the fresh session']) {
            expect(at(check)).toBeGreaterThan(-1);
            expect(at(check)).toBeLessThan(key)
        }
        expect(lines.at(-1)).toBe(PROMPT)
    });

    test('#1871 (Euclid\'s Round 1): a holder that changes after the receiver\'s check stops the resumed script before any key', async () => {
        const passed = [];
        const result = await dispatchLocalWake(resumedRecord(), quietEffects({
            rotationGuard : () => null,
            rotationHolder: {path: '/seats/neo-opus-ada/listener.json', sessionId: 'session-old'},
            // The script as it runs once another session owns the record: the holder comparison is where it stops.
            spawnAsync    : async (command, args) => {
                if (!args.some(arg => String(arg).includes('keystroke "v"'))) return '';

                for (const line of args.map(String)) {
                    if (line.includes('Seat holder changed before the fresh session')) {
                        throw new Error('execution error: Seat holder changed before the fresh session (-2700)')
                    }
                    if (isKey(line)) passed.push(line)
                }
                return ''
            }
        }));

        expect(result).toEqual({outcome: 'failed', outcomeReason: 'execution error: Seat holder changed before the fresh session (-2700)'});
        expect(passed).toEqual([])
    });

    test('#1871 (Euclid\'s Round 1): a resume whose profile now resolves to another process stops without a key; its own process resumes', async () => {
        const calls = [],
              run   = pid => dispatchLocalWake(resumedRecord(), quietEffects({
                  resolveGuiInstancePid: async () => pid,
                  rotationGuard        : () => null,
                  rotationHolder       : {path: '/seats/neo-opus-ada/listener.json', sessionId: 'session-old'},
                  spawnAsync           : async (command, args) => { calls.push({command, args}); return '' }
              }));

        // The app restarted behind the same profile, and no session claimed the seat: nothing runs at all.
        expect(await run(4343)).toEqual({outcome: 'failed', outcomeReason: ROTATION_PROCESS_CHANGED});
        expect(calls).toEqual([]);

        expect(await run(4242)).toBe('delivered');

        const lines = typedPaste(calls)[0].args.map(String);

        expect(lines).toContain('  set targetProcessId to "4242"');
        expect(lines).not.toContain('      keystroke "n" using command down')
    });

    test('#1871 (Euclid\'s Round 2): a resume stops without a key once someone used the keyboard or pointer since the front was lost', async () => {
        const calls = [],
              run   = record => dispatchLocalWake(record, quietEffects({
                  rotationGuard: () => null,
                  // Quiet for five seconds: long enough to type, too short to cover the minute since the loss
                  readHumanIdleMs: () => 5000,
                  spawnAsync     : async (command, args) => { calls.push({command, args}); return '' }
              })),
              anyKey = () => calls.some(call => call.args.some(arg => isKey(String(arg))));

        expect(await run({...resumedRecord(), sessionOpenedAt: new Date(Date.now() - 60_000).toISOString()}))
            .toEqual({outcome: 'failed', outcomeReason: ROTATION_DESTINATION_UNPROVEN});
        // A loss with no recorded moment proves nothing either
        expect(await run({...resumedRecord(), sessionOpenedAt: undefined}))
            .toEqual({outcome: 'failed', outcomeReason: ROTATION_DESTINATION_UNPROVEN});
        expect(anyKey()).toBe(false);

        // The same reading covers a loss four seconds ago: nothing touched the input since, so the resume types
        expect(await run({...resumedRecord(), sessionOpenedAt: new Date(Date.now() - 4000).toISOString()})).toBe('delivered');
        expect(typedPaste(calls)).toHaveLength(1)
    });

    test('#1871 (Euclid\'s Round 3): the loss dates from the attempt that pressed Cmd+N, so a chat switched during its wait never resumes', async () => {
        const start = Date.now();
        let   clock = start;

        // The attempt presses Cmd+N, waits, and loses the front 5.4 s after it began
        const lost = await dispatchLocalWake(rotationRecord(), quietEffects({
            now       : () => clock,
            spawnAsync: async (command, args) => {
                if (args.some(arg => String(arg).includes('keystroke "v"'))) {
                    clock += 5400;
                    throw new Error('4848:4854: execution error: Target app lost frontmost status before wake paste (-2700)')
                }
                return ''
            }
        }));

        expect(lost).toMatchObject({outcome: 'deferred', outcomeReason: ROTATION_SESSION_OPENED, sessionOpenedAt: new Date(start).toISOString()});

        // Someone switched the chat 1.5 s into the attempt, during the wait after Cmd+N, then left the window. 12.4 s
        // after the loss the idle reading covers the time since the loss but not the time since the attempt began.
        clock += 12_400;

        const calls  = [];
        const resume = await dispatchLocalWake({...resumedRecord(), sessionOpenedAt: lost.sessionOpenedAt}, quietEffects({
            now            : () => clock,
            readHumanIdleMs: () => clock - (start + 1500),
            rotationGuard  : () => null,
            spawnAsync     : async (command, args) => { calls.push({command, args}); return '' }
        }));

        expect(resume).toEqual({outcome: 'failed', outcomeReason: ROTATION_DESTINATION_UNPROVEN});
        expect(calls.some(call => call.args.some(arg => isKey(String(arg))))).toBe(false)
    });

    test('#1871: a seat claimed since the shortcut vetoes a resumed attempt without a keystroke', async () => {
        const calls  = [];
        const result = await dispatchLocalWake(resumedRecord(), quietEffects({
            rotationGuard: () => ROTATION_SUPERSEDED,
            spawnAsync   : async (command, args) => { calls.push({command, args}); return '' }
        }));

        expect(result).toEqual({outcome: 'failed', outcomeReason: ROTATION_SUPERSEDED});
        expect(typedPaste(calls)).toHaveLength(0)
    });

    test('#1770 (Emmy\'s Round 1): a lock that engages while the pid is resolved defers the rotation without a keystroke', async () => {
        let   locked = false;
        const calls  = [];
        const result = await dispatchLocalWake(rotationRecord(), quietEffects({
            resolveGuiInstancePid: async () => { locked = true; return 4242 },
            readScreenLocked     : () => locked,
            spawnAsync           : async (command, args) => { calls.push({command, args}); return '' }
        }));

        expect(result).toEqual({outcome: 'deferred', outcomeReason: ROTATION_SCREEN_LOCKED});
        expect(typedPaste(calls)).toHaveLength(0)
    });

    test('#1770 (Emmy\'s Round 1): a lock seen after a failed activation defers as a lock; after Cmd+N the rotation resumes in its session (#1871)', async () => {
        let   locked = false;
        const run    = message => dispatchLocalWake(rotationRecord(), quietEffects({
            readScreenLocked: () => locked,
            spawnAsync      : async (command, args) => {
                if (args.some(arg => String(arg).includes('keystroke "v"'))) { locked = true; throw new Error(message) }
                return ''
            }
        }));

        expect(await run('4154:4160: execution error: Target app lost frontmost status after activation (-2700)'))
            .toEqual({outcome: 'deferred', outcomeReason: ROTATION_SCREEN_LOCKED});

        locked = false;

        // Past Cmd+N the session is open: the next attempt waits for the unlock, then resumes without a second Cmd+N.
        expect(await run('execution error: Target app lost frontmost status before wake paste (-2700)'))
            .toEqual({outcome: 'deferred', outcomeReason: ROTATION_SESSION_OPENED, sessionOpenedAt: expect.any(String), sessionOpenedPid: 4242})
    });

    test('#1770 (Emmy\'s Round 1): a front lost right before Cmd+N defers the rotation, as a lock when the script ran into one', async () => {
        let   locked = false, lockInScript = false;
        const run    = () => dispatchLocalWake(rotationRecord(), quietEffects({
            readScreenLocked: () => locked,
            spawnAsync      : async (command, args) => {
                if (args.some(arg => String(arg).includes('keystroke "v"'))) {
                    locked = lockInScript;
                    throw new Error('5120:5126: execution error: Target app lost frontmost status before fresh session (-2700)')
                }
                return ''
            }
        }));

        // Only the tab shortcut preceded the check, and it opens no session, so asking again is safe.
        expect(await run()).toEqual({outcome: 'deferred', outcomeReason: ROTATION_ACTIVATION_LOST});

        lockInScript = true;

        expect(await run()).toEqual({outcome: 'deferred', outcomeReason: ROTATION_SCREEN_LOCKED})
    });

    test('#1770 (Emmy\'s Round 1): the adapter hands the script the record\'s own deadline, not the time left', async () => {
        const acceptedAt = new Date(Date.now() - 20_000).toISOString(),
              calls      = [];

        await dispatchLocalWake(rotationRecord({acceptedAt}), quietEffects({
            spawnAsync: async (command, args) => { calls.push(args.map(String)); return '' }
        }));

        const typed = calls.find(args => args.some(arg => arg.includes('keystroke "v"')));

        expect(typed).toContain(`      if rotationNow >= ${Math.floor((Date.parse(acceptedAt) + ROTATION_MAX_AGE_MS) / 1000)} then error "Rotation deadline passed before the fresh session"`)
    });

    test('#1770: under the plane\'s hold, the script\'s cutoff is the hold\'s end', async () => {
        const holdUntil = new Date(Date.now() + 3 * 60 * ROTATION_MAX_AGE_MS).toISOString(),
              calls     = [];

        await dispatchLocalWake(rotationRecord({envelope: {payload: {...rotationEnvelope().payload, holdUntil}}}), quietEffects({
            spawnAsync: async (command, args) => { calls.push(args.map(String)); return '' }
        }));

        const typed = calls.find(args => args.some(arg => arg.includes('keystroke "v"')));

        expect(typed).toContain(`      if rotationNow >= ${Math.floor(Date.parse(holdUntil) / 1000)} then error "Rotation deadline passed before the fresh session"`)
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

    test('#1770 (Emmy\'s Round 1): the script checks an absolute cutoff last, after the holder, so a late child opens nothing late', () => {
        const lines = buildOsascriptArgs({
                  appName           : 'Claude', digest: 'boot', instancePid: 4242, freshSessionShortcut: 'n', freshSessionCutoffSec: 1763247600,
                  freshSessionHolder: {path: '/seats/ada/listeners/neo-opus-ada.json', sessionId: 'old-session'}
              }).map(String),
              fresh = lines.indexOf('      keystroke "n" using command down');

        expect(lines[fresh - 8]).toBe('      if rotationHolderNow is not "old-session" then error "Seat holder changed before the fresh session"');
        // A lock that engaged after the activation is caught at the front, before Cmd+N.
        expect(lines[fresh - 6]).toBe('      my assertTargetFrontmost(targetAppName, targetBundleId, targetProcessId, targetAutomationId, "before fresh session")');
        expect(lines[fresh - 4]).toBe('      tell current application to set rotationNow to ((do shell script "/bin/date +%s") as integer)');
        expect(lines[fresh - 2]).toBe('      if rotationNow >= 1763247600 then error "Rotation deadline passed before the fresh session"');
        // No duration anywhere: a timer the script starts would begin when a late child does.
        expect(lines.some(line => line.includes('(current date)'))).toBe(false)
    });

    test('Emmy\'s Round-2 control: the script re-reads the seat holder right before the fresh-session keystroke', () => {
        const lines = buildOsascriptArgs({
                  appName           : 'Claude', digest: 'boot', instancePid: 4242, freshSessionShortcut: 'n', freshSessionCutoffSec: 1763247600,
                  freshSessionHolder: {path: '/seats/ada/listeners/neo-opus-ada.json', sessionId: 'old-session'}
              }).map(String),
              fresh = lines.indexOf('      keystroke "n" using command down');

        // Exactly the owner, never `delivered.sessionId`, which can still name the old session. Only the front
        // and cutoff checks sit between it and Cmd+N.
        expect(lines[fresh - 10]).toBe('      tell current application to set rotationHolderNow to (do shell script "/usr/bin/plutil -extract owner.sessionId raw -o - " & quoted form of "/seats/ada/listeners/neo-opus-ada.json")');
        expect(lines[fresh - 8]).toBe('      if rotationHolderNow is not "old-session" then error "Seat holder changed before the fresh session"')
    });

    test('Emmy\'s Round-2 control: with no holder at the first attempt, the script requires the record still absent before Cmd+N', () => {
        const lines = buildOsascriptArgs({
                  appName           : 'Claude', digest: 'boot', instancePid: 4242, freshSessionShortcut: 'n', freshSessionCutoffSec: 1763247600,
                  freshSessionHolder: {path: '/seats/ada/listeners/neo-opus-ada.json', sessionId: null}
              }).map(String),
              fresh = lines.indexOf('      keystroke "n" using command down');

        expect(lines[fresh - 10]).toBe('      tell current application to set rotationHolderNow to (do shell script "test -e " & quoted form of "/seats/ada/listeners/neo-opus-ada.json" & " && echo present || true")');
        expect(lines[fresh - 8]).toBe('      if rotationHolderNow is not "" then error "Seat holder appeared before the fresh session"')
    });

    test('the receiver hands the adapter the expected absence when the first attempt found no holder', async () => {
        const stateDir         = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-rotation-absent-')),
              listenerStateDir = path.join(stateDir, 'listeners'),
              state            = new WakeReceiverState({stateDir}),
              seen             = [];

        try {
            await state.init();
            const receiver = createWakeReceiver({
                manifest: {schemaVersion: 1, routes: {'WAKE_SUB:rotate': {
                    signingKey           : 'e'.repeat(64), agentIdentity: '@neo-opus-ada', admits: SESSION_ROTATE_EVENT_TYPE,
                    harnessTargetMetadata: {adapter: 'osascript', appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/seats/ada'},
                    adapterConfig        : {attemptTimeoutMs: 100}
                }}},
                state, listenerStateDir, logger: {error() {}, warn() {}, log() {}}, readScreenLocked: () => false,
                dispatch: async (record, deps) => { seen.push(deps); return 'delivered' }
            });

            await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
            await receiver.drain();

            expect(seen[0].rotationHolder).toEqual({path: path.join(listenerStateDir, 'neo-opus-ada.json'), sessionId: null});
            await new Promise(resolve => receiver.server.close(() => resolve()));
        } finally {
            await fs.rm(stateDir, {recursive: true, force: true})
        }
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
            logger      : {error() {}, warn() {}, log() {}},
            // The host's own lock state never reaches a spec: an arm that needs a lock says so.
            readScreenLocked: () => false
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
        dispatch        : async record => { dispatched.push(record); return results.shift() ?? 'delivered' },
        logger          : {error() {}, warn() {}, log() {}},
        readScreenLocked: () => false,
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

    test('a rotation\'s end is one receiver line beside its record, and a skip keeps its reason', async () => {
        const lines   = [],
              logger  = {log: line => lines.push(line), warn: line => lines.push(line), error() {}},
              reason  = 'instance-unresolved: No running Claude instance found for userDataDir=\'/seats/ada\'.',
              ended   = () => lines.filter(line => line.startsWith('[Wake Receiver] rotation ')),
              another = async (receipt, result) => {
                  const eventId = `session-rotate:MESSAGE:${receipt}`;

                  await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId, envelope: rotationEnvelope({
                      eventId,
                      payload: {receiptMessageId: `MESSAGE:${receipt}`, oldSessionId: 'session-old', reason: 'sunset_restart', prompt: PROMPT}
                  })});
                  await rotationReceiver([result], {logger}).drain()
              };

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await rotationReceiver([{outcome: 'skipped', outcomeReason: reason}], {logger}).drain();

        expect(await state.read(rotationKey)).toMatchObject({state: 'skipped', outcomeReason: reason});
        expect(ended()).toEqual([`[Wake Receiver] rotation skipped WAKE_SUB:rotate (${reason})`]);

        await another('r2', 'delivered');
        await another('r3', {outcome: 'failed', outcomeReason: 'Seat holder changed before the fresh session'});

        expect(ended()).toEqual([
            `[Wake Receiver] rotation skipped WAKE_SUB:rotate (${reason})`,
            '[Wake Receiver] rotation delivered WAKE_SUB:rotate',
            '[Wake Receiver] rotation failed WAKE_SUB:rotate (Seat holder changed before the fresh session)'
        ])
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

    test('a lost activation is asked again, like a person at the keyboard', async () => {
        const quick = rotationReceiver([{outcome: 'deferred', outcomeReason: ROTATION_ACTIVATION_LOST}], {rotationRetryMs: 20});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await quick.drain();

        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('delivered');
        expect(dispatched).toHaveLength(2)
    });

    const heldEnvelope = () => rotationEnvelope({
        payload: {...rotationEnvelope().payload, holdUntil: new Date(Date.now() + 3 * 60 * ROTATION_MAX_AGE_MS).toISOString()}
    });

    test('#1770: under the plane\'s hold, a person working past the minute keeps the rotation waiting; it types at the first pause', async () => {
        let   offset = 0;
        const quick  = rotationReceiver(
            Array.from({length: 10}, () => ({outcome: 'deferred', outcomeReason: HUMAN_INPUT_ACTIVE})),
            {rotationRetryMs: 60_000, clock: () => Date.now() + offset}
        );

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: heldEnvelope()});

        // Ada's 22:28Z rotation: ten such defers across its first minute, then `session-rotate-expired`.
        for (let defer = 0; defer < 10; defer++) {
            offset = defer * 6_000;
            await quick.drain()
        }

        expect(await state.read(rotationKey)).toMatchObject({state: 'pending', deferReason: HUMAN_INPUT_ACTIVE, deferCount: 10});

        offset = 2 * ROTATION_MAX_AGE_MS;
        await quick.drain();

        expect((await state.read(rotationKey)).state).toBe('delivered');
        expect(dispatched).toHaveLength(11)
    });

    test('#1770: lost activations fail the rotation at their cap, and a person at the keyboard is not one', async () => {
        const lost  = () => ({outcome: 'deferred', outcomeReason: ROTATION_ACTIVATION_LOST}),
              quick = rotationReceiver([
                  ...Array.from({length: ROTATION_MAX_ACTIVATION_LOSSES - 1}, lost),
                  {outcome: 'deferred', outcomeReason: HUMAN_INPUT_ACTIVE},
                  lost()
              ], {rotationRetryMs: 20});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: heldEnvelope()});
        await quick.drain();

        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('failed');
        expect(await state.read(rotationKey)).toMatchObject({
            outcomeReason : ROTATION_FRONT_LOST,
            frontLostCount: ROTATION_MAX_ACTIVATION_LOSSES,
            deferCount    : ROTATION_MAX_ACTIVATION_LOSSES + 1
        });
        expect(dispatched).toHaveLength(ROTATION_MAX_ACTIVATION_LOSSES + 1)
    });

    test('#1871: a front lost after Cmd+N is asked again in the opened session\'s process, and fails at the cap with it marked open', async () => {
        // Only the first opening names the process and the moment; a later result naming others cannot move them.
        const first  = '2026-11-20T00:06:43.814Z',
              opened = (_, attempt) => ({
                  outcome         : 'deferred',
                  outcomeReason   : ROTATION_SESSION_OPENED,
                  sessionOpenedAt : attempt ? '2026-11-20T00:07:00.000Z' : first,
                  sessionOpenedPid: attempt ? 4343 : 4242
              }),
              quick  = rotationReceiver(Array.from({length: ROTATION_MAX_ACTIVATION_LOSSES}, opened), {rotationRetryMs: 20});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: heldEnvelope()});
        await quick.drain();

        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('failed');
        expect(dispatched[0].sessionOpened).toBeUndefined();
        expect(dispatched[1]).toMatchObject({sessionOpened: true, sessionOpenedAt: first, sessionOpenedPid: 4242, frontLostCount: 1});
        expect(dispatched.at(-1)).toMatchObject({sessionOpened: true, sessionOpenedAt: first, sessionOpenedPid: 4242});
        expect(await state.read(rotationKey)).toMatchObject({
            outcomeReason   : ROTATION_FRONT_LOST,
            frontLostCount  : ROTATION_MAX_ACTIVATION_LOSSES,
            sessionOpened   : true,
            sessionOpenedAt : first,
            sessionOpenedPid: 4242
        })
    });

    test('#1770 AC-2: a rotation accepted on a locked screen waits past its minute with no dispatch, then types after the unlock', async () => {
        let   locked = true, offset = 0;
        const quick  = rotationReceiver([], {rotationRetryMs: 20, clock: () => Date.now() + offset, readScreenLocked: () => locked}),
              holdUntil = new Date(Date.now() + 3 * 60 * ROTATION_MAX_AGE_MS).toISOString();

        // The plane's signed hold is what lets the rotation wait past the minute.
        await state.accept({
            subscriptionId: 'WAKE_SUB:rotate',
            eventId       : 'session-rotate:MESSAGE:r1',
            envelope      : rotationEnvelope({payload: {...rotationEnvelope().payload, holdUntil}})
        });
        await quick.drain();

        expect(await state.read(rotationKey)).toMatchObject({state: 'pending', deferReason: ROTATION_SCREEN_LOCKED});

        // The 19:27Z and 19:43Z rotations each expired 60 s after their accept, behind this lock.
        offset = 5 * ROTATION_MAX_AGE_MS;
        await quick.drain();

        expect((await state.read(rotationKey)).state).toBe('pending');
        expect(dispatched).toEqual([]);

        locked = false;

        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('delivered');
        expect(dispatched).toHaveLength(1)
    });

    test('#1770 AC-3: a seat claimed during the lock fails the rotation superseded after the unlock, with no dispatch', async () => {
        const listenerStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-rotation-listeners-')),
              holder           = sessionId => fs.writeFile(path.join(listenerStateDir, 'neo-opus-ada.json'), JSON.stringify({owner: {sessionId, session: {pid: 7}}}));
        let   locked = true;
        const quick  = rotationReceiver([], {rotationRetryMs: 20, listenerStateDir, readScreenLocked: () => locked});

        try {
            await holder('old-session');
            await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
            await quick.drain();

            // The first pass recorded the holder although the lock kept the adapter from running.
            expect(await state.read(rotationKey)).toMatchObject({state: 'pending', deferReason: ROTATION_SCREEN_LOCKED, seatHolder: 'old-session#7'});

            await holder('opened-from-elsewhere');
            locked = false;

            await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('failed');
            expect((await state.read(rotationKey)).outcomeReason).toBe(ROTATION_SUPERSEDED);
            expect(dispatched).toEqual([])
        } finally {
            await fs.rm(listenerStateDir, {recursive: true, force: true})
        }
    });

    test('#1770 AC-4: a lock that outlasts the plane\'s hold fails the rotation expired, with no dispatch', async () => {
        let   offset    = 0;
        const holdUntil = new Date(Date.now() + 2 * ROTATION_MAX_AGE_MS).toISOString(),
              quick     = rotationReceiver([], {rotationRetryMs: 20, clock: () => Date.now() + offset, readScreenLocked: () => true});

        await state.accept({
            subscriptionId: 'WAKE_SUB:rotate',
            eventId       : 'session-rotate:MESSAGE:r1',
            envelope      : rotationEnvelope({payload: {...rotationEnvelope().payload, holdUntil}})
        });
        await quick.drain();

        expect((await state.read(rotationKey)).deferReason).toBe(ROTATION_SCREEN_LOCKED);

        offset = 3 * ROTATION_MAX_AGE_MS;

        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('failed');
        expect((await state.read(rotationKey)).outcomeReason).toBe(ROTATION_EXPIRED);
        expect(dispatched).toEqual([])
    });

    test('#1770: while the lock holds, a waiting rotation is neither claimed nor rewritten', async () => {
        let   locked = true;
        const quick  = rotationReceiver([], {rotationRetryMs: 20, readScreenLocked: () => locked});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await quick.drain();

        const waiting = await state.read(rotationKey);

        // Its retries keep asking about every 20 ms: none of them may touch the record.
        await new Promise(resolve => setTimeout(resolve, 150));
        await quick.drain();

        expect(await state.read(rotationKey)).toEqual(waiting);
        expect(dispatched).toEqual([]);

        locked = false;
        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('delivered')
    });

    test('#1770 AC-4 (Emmy\'s Round 1): behind a lock, a rotation from an older plane still expires a minute after its accept', async () => {
        let   offset = 0;
        const quick  = rotationReceiver([], {rotationRetryMs: 20, clock: () => Date.now() + offset, readScreenLocked: () => true});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await quick.drain();

        expect((await state.read(rotationKey)).deferReason).toBe(ROTATION_SCREEN_LOCKED);

        offset = ROTATION_MAX_AGE_MS;

        await expect.poll(async () => (await state.read(rotationKey)).state, {timeout: 2_000}).toBe('failed');
        expect((await state.read(rotationKey)).outcomeReason).toBe(ROTATION_EXPIRED);
        expect(dispatched).toEqual([])
    });

    test('#1770 (Emmy\'s Round 1): a lock the adapter saw at its last boundary parks the rotation as a lock', async () => {
        const quick = rotationReceiver([{outcome: 'deferred', outcomeReason: ROTATION_SCREEN_LOCKED}], {rotationRetryMs: 60_000});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await quick.drain();

        expect(dispatched).toHaveLength(1);
        expect(await state.read(rotationKey)).toMatchObject({state: 'pending', deferReason: ROTATION_SCREEN_LOCKED, deferCount: 1, frontLostCount: 0})
    });

    test('#1770: an unreadable lock state keeps today\'s path', async () => {
        const quick = rotationReceiver([], {readScreenLocked: () => null});

        await state.accept({subscriptionId: 'WAKE_SUB:rotate', eventId: 'session-rotate:MESSAGE:r1', envelope: rotationEnvelope()});
        await quick.drain();

        expect(dispatched).toHaveLength(1);
        expect((await state.read(rotationKey)).state).toBe('delivered')
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
