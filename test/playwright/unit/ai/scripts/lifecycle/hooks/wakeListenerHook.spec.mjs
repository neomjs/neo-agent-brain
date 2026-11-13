import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';

import {
    decideClaim,
    findSessionProcess,
    LISTENER_STATE_RELATIVE,
    MAX_BACKOFF_MS,
    POLL_INTERVAL_MS,
    runListener
} from '../../../../../../../ai/scripts/lifecycle/hooks/claude/wakeListenerHook.mjs';

/**
 * The Claude seat's wake listener (`wakeListenerHook.mjs`): it exits 2 with the
 * digest exactly when events arrive past its stored watermark, never on the seat's backlog, and one
 * listener holds a seat at a time — that of the live session prompted last.
 */

const
    IDENTITY = 'neo-seat',
    SOURCE   = 'http://127.0.0.1:3102',
    OLDER    = {pid: 100, ppid: 1, startedAt: 'Fri Oct 2 10:00:00 2026', command: '/Applications/Claude.app/claude'},
    NEWER    = {pid: 200, ppid: 1, startedAt: 'Fri Oct 2 11:00:00 2026', command: '/Applications/Claude.app/claude'},
    LISTENER = {pid: 900, ppid: 100, startedAt: 'Fri Oct 2 12:00:00 2026', command: 'node wakeListenerHook.mjs'};

let homeDir;

test.beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-listener-'))
});

test.afterEach(() => {
    fs.rmSync(homeDir, {force: true, recursive: true})
});

const statePath = () => path.join(homeDir, LISTENER_STATE_RELATIVE, `${IDENTITY}.json`);

const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));

function writeState(record) {
    fs.mkdirSync(path.dirname(statePath()), {recursive: true});
    fs.writeFileSync(statePath(), JSON.stringify(record))
}

/**
 * @summary Runs the listener of one session against a scripted plane and process table.
 * @param {Object} options
 * @param {Object[]} options.answers `poll-digest` answers in order; an `Error` is thrown instead.
 * @param {Object} [options.session=OLDER] The session this listener runs under.
 * @param {Function} [options.onSleep] Runs at each sleep, before the next cycle.
 * @param {Object} [options.refusal] What `connect` answers instead of a client.
 * @returns {Promise<Object>} `{outcome, polls, sleeps, connects}`
 */
async function listen({answers = [], session = OLDER, sessionId = 'session-older', event = 'Stop', error, pid = LISTENER.pid, procs, onPoll, onSleep, config, refusal} = {}) {
    const
        table    = procs ?? new Map([[OLDER.pid, OLDER], [NEWER.pid, NEWER], [LISTENER.pid, LISTENER]]),
        polls    = [],
        sleeps   = [],
        connects = [],
        client   = {
            async callTool(name, args) {
                polls.push(args.sinceLogId);
                onPoll?.();

                const answer = answers.shift();

                if (answer instanceof Error) throw answer;
                if (!answer) throw new Error('the script ran out of answers');

                return answer
            },
            async close() {}
        };

    const outcome = await runListener({
        payload     : {session_id: sessionId, hook_event_name: event, ...(error ? {error} : {})},
        homeDir,
        config      : config ?? {planeBase: SOURCE, planeBearer: 'token', identity: `@${IDENTITY}`},
        connect     : async options => {connects.push(options); return refusal ?? {client, identity: `@${IDENTITY}`}},
        resolveRoute: async () => 'WAKE_SUB:pull',
        findSession : async () => session,
        read        : async pid => table.get(pid) ?? null,
        pid,
        sleep       : async ms => {
            sleeps.push(ms);
            if (sleeps.length > 20) throw new Error('the listener never stopped');
            await onSleep?.(sleeps.length, table)
        }
    });

    return {outcome, polls, sleeps, connects}
}

test.describe('AC-2: a digest wakes, the backlog does not', () => {
    test('a first poll records the baseline; the next event wakes with the digest exactly', async () => {
        const {outcome, polls} = await listen({answers: [
            {pending: 1849, digest: '[WAKE] 1849 events (the backlog)', watermark: 100},
            {pending: 0, watermark: 105},
            {pending: 1, digest: '[WAKE][priority:normal] 1 events for @neo-seat', watermark: 110}
        ]});

        expect(outcome).toEqual({exit: 2, digest: '[WAKE][priority:normal] 1 events for @neo-seat'});
        expect(polls).toEqual([0, 100, 105]);
        expect(readState()).toMatchObject({watermark: 110, listener: null})
    });

    test('a stored watermark wakes on the first poll past it', async () => {
        writeState({watermark: 50, source: SOURCE});

        const {outcome, polls} = await listen({answers: [{pending: 2, digest: 'D', watermark: 60}]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(polls).toEqual([50])
    });

    test('a watermark another plane wrote is not carried over: the seat rebaselines on its own plane', async () => {
        // Plane A's log ran to 1000; this plane's head is 50. Sent as a cursor, 1000 would sit ahead
        // of every new event, and the seat would never wake.
        writeState({watermark: 1000, source: 'https://plane-a.example'});

        const {outcome, polls} = await listen({answers: [
            {pending: 0, watermark: 50},
            {pending: 1, digest: 'D', watermark: 51}
        ]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(polls).toEqual([0, 50]);
        expect(readState()).toMatchObject({source: SOURCE, watermark: 51})
    });

    test('failures back off and retry, and pending events without a digest never wake', async () => {
        writeState({watermark: 7, source: SOURCE});

        const {outcome, sleeps} = await listen({answers: [
            new Error('plane unreachable'),
            new Error('plane unreachable'),
            {pending: 3, watermark: 8},
            {pending: 1, digest: 'D', watermark: 9}
        ]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(sleeps).toEqual([POLL_INTERVAL_MS, 2 * POLL_INTERVAL_MS, POLL_INTERVAL_MS])
    });

    test('a prompted session takes the seat, so an older poll in flight cannot consume its digest', async () => {
        // The prompt's run claims and exits; the older listener re-reads after its poll and stands
        // down without the watermark moving, and the prompted session's first Stop gets the event.
        const
            CLAIMER = {pid: 901, ppid: NEWER.pid, startedAt: 'Fri Oct 2 12:05:00 2026', command: 'node wakeListenerHook.mjs'},
            POLLER  = {pid: 902, ppid: NEWER.pid, startedAt: 'Fri Oct 2 12:10:00 2026', command: 'node wakeListenerHook.mjs'},
            table   = new Map([[OLDER.pid, OLDER], [NEWER.pid, NEWER], [LISTENER.pid, LISTENER], [CLAIMER.pid, CLAIMER]]);

        writeState({watermark: 10, source: SOURCE});

        let release, polling;
        const inFlight = new Promise(resolve => {polling = resolve}),
              older    = listen({procs: table, onPoll: polling, answers: [new Promise(resolve => {release = resolve})]});

        await inFlight;

        const claimed = await listen({procs: table, event: 'UserPromptSubmit', session: NEWER, sessionId: 'session-newer', pid: CLAIMER.pid});

        expect(claimed.outcome).toEqual({exit: 0, reason: 'claimed'});
        expect([claimed.connects, claimed.polls, claimed.sleeps]).toEqual([[], [], []]);
        expect(readState().owner.sessionId).toBe('session-newer');
        expect(readState().listener).toBe(null);

        release({pending: 1, digest: 'D', watermark: 11});

        expect((await older).outcome).toEqual({exit: 0, reason: 'superseded'});
        expect(readState().watermark).toBe(10);

        table.delete(CLAIMER.pid);
        table.set(POLLER.pid, POLLER);

        const first = await listen({procs: table, session: NEWER, sessionId: 'session-newer', pid: POLLER.pid,
            answers: [{pending: 1, digest: 'D', watermark: 11}]});

        expect(first.outcome).toEqual({exit: 2, digest: 'D'});
        expect(first.polls).toEqual([10])
    });

    test('a resumed session that nobody prompts never takes the seat, so the live listener still wakes', async () => {
        // A resume starts a new process for an old session and fires SessionStart without a prompt. The
        // run touches nothing: the older session's poll in flight keeps the seat and wakes with the digest.
        const
            RESUMER = {pid: 901, ppid: NEWER.pid, startedAt: 'Fri Oct 2 12:05:00 2026', command: 'node wakeListenerHook.mjs'},
            table   = new Map([[OLDER.pid, OLDER], [NEWER.pid, NEWER], [LISTENER.pid, LISTENER], [RESUMER.pid, RESUMER]]);

        writeState({watermark: 10, source: SOURCE});

        let release, polling;
        const inFlight = new Promise(resolve => {polling = resolve}),
              older    = listen({procs: table, onPoll: polling, answers: [new Promise(resolve => {release = resolve})]});

        await inFlight;

        const before  = readState(),
              resumed = await listen({procs: table, event: 'SessionStart', session: NEWER, sessionId: 'session-newer', pid: RESUMER.pid});

        expect(resumed.outcome).toEqual({exit: 0, reason: 'a session start claims nothing'});
        expect([resumed.connects, resumed.polls, resumed.sleeps]).toEqual([[], [], []]);
        expect(readState()).toEqual(before);

        release({pending: 1, digest: 'D', watermark: 11});

        expect((await older).outcome).toEqual({exit: 2, digest: 'D'});
        expect(readState().owner.sessionId).toBe('session-older')
    });

    test('a second Stop in the owning session, with its listener alive, arms nothing new', async () => {
        writeState({owner: {sessionId: 'session-older', session: OLDER}, listener: {pid: 901, startedAt: 'Fri Oct 2 12:30:00 2026'}, watermark: 3});

        const procs               = new Map([[OLDER.pid, OLDER], [901, {pid: 901, ppid: 100, startedAt: 'Fri Oct 2 12:30:00 2026', command: 'node'}]]),
              {outcome, connects} = await listen({procs});

        expect(outcome).toEqual({exit: 0, reason: 'already-listening'});
        expect(connects).toEqual([]);
        expect(readState().listener.pid).toBe(901)
    });

    test('a resumed session takes the seat back from its own dead incarnation, PID reused and old listener alive', async () => {
        // The session id survives a resume, and the OS may hand the new process the old PID. Only
        // the start time tells the incarnations apart.
        writeState({
            owner    : {sessionId: 'session-older', session: {pid: OLDER.pid, startedAt: 'Fri Oct 2 09:00:00 2026'}},
            listener : {pid: 901, startedAt: 'Fri Oct 2 09:30:00 2026'},
            watermark: 3,
            source   : SOURCE
        });

        const procs               = new Map([[OLDER.pid, OLDER], [LISTENER.pid, LISTENER], [901, {pid: 901, ppid: 1, startedAt: 'Fri Oct 2 09:30:00 2026', command: 'node'}]]),
              {outcome, connects} = await listen({procs, answers: [{pending: 1, digest: 'D', watermark: 4}]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(connects).toHaveLength(1);
        expect(readState().owner.session.startedAt).toBe(OLDER.startedAt)
    });

    test('a credential the plane binds to another identity stops by name instead of retrying', async () => {
        const reason                   = 'the plane credential did not prove @neo-seat: plane identity mismatch',
              {outcome, polls, sleeps} = await listen({refusal: {reason, refused: true}});

        expect(outcome).toEqual({exit: 0, reason});
        expect(polls).toEqual([]);
        expect(sleeps).toEqual([])
    });

    test('an unconfigured plane is a named skip that claims nothing', async () => {
        const {outcome} = await listen({config: {planeBase: '', planeBearer: '', identity: `@${IDENTITY}`}});

        expect(outcome.exit).toBe(0);
        expect(outcome.reason).toMatch(/seat\.planeBase is not configured/);
        expect(fs.existsSync(statePath())).toBe(false)
    })
});

test.describe('AC-3: the live session prompted last owns the seat', () => {
    test('a polling listener exits once another session takes the seat', async () => {
        const {outcome} = await listen({
            answers: [{pending: 0, watermark: 10}],
            onSleep: () => writeState({...readState(), owner: {sessionId: 'session-newer', session: NEWER}, listener: null})
        });

        expect(outcome).toEqual({exit: 0, reason: 'superseded'});
        expect(readState().owner.sessionId).toBe('session-newer')
    });

    test('a Stop yields to a live owner prompted later, whichever process started first, without touching the plane', async () => {
        writeState({owner: {sessionId: 'session-older', session: OLDER}, listener: null});

        const {outcome, connects} = await listen({session: NEWER, sessionId: 'session-newer'});

        expect(outcome).toEqual({exit: 0, reason: 'superseded'});
        expect(connects).toEqual([])
    });

    test('a prompt takes the seat from a live owner whose process started later, and its Stop then polls', async () => {
        writeState({owner: {sessionId: 'session-newer', session: NEWER}, listener: null, watermark: 20, source: SOURCE});

        const prompted = await listen({event: 'UserPromptSubmit'});

        expect(prompted.outcome).toEqual({exit: 0, reason: 'claimed'});
        expect(readState().owner.sessionId).toBe('session-older');

        const stopped = await listen({answers: [{pending: 1, digest: 'D', watermark: 21}]});

        expect(stopped.outcome).toEqual({exit: 2, digest: 'D'});
        expect(stopped.polls).toEqual([20])
    });

    test('a prompt in the owning session keeps its running listener', async () => {
        writeState({owner: {sessionId: 'session-older', session: OLDER}, listener: {pid: LISTENER.pid, startedAt: LISTENER.startedAt}, watermark: 5, source: SOURCE});

        const {outcome, connects} = await listen({event: 'UserPromptSubmit', pid: 903});

        expect(outcome).toEqual({exit: 0, reason: 'already-owner'});
        expect(connects).toEqual([]);
        expect(readState().listener.pid).toBe(LISTENER.pid)
    });

    test('a dead owner frees the seat, even for an older session', async () => {
        const GONE = {pid: 300, startedAt: 'Fri Oct 2 13:00:00 2026'};

        writeState({owner: {sessionId: 'session-gone', session: GONE}, listener: null, watermark: 30, source: SOURCE});

        const {outcome} = await listen({answers: [{pending: 1, digest: 'D', watermark: 31}]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(readState().owner.sessionId).toBe('session-older')
    });

    test('a listener whose session ended stops polling', async () => {
        const {outcome, polls} = await listen({
            answers: [{pending: 0, watermark: 10}],
            onSleep: (count, table) => table.delete(OLDER.pid)
        });

        expect(outcome).toEqual({exit: 0, reason: 'its session ended'});
        expect(polls).toEqual([0])
    });

    test('decideClaim: process start order decides nothing; a prompt claims, a Stop yields to any other live owner', () => {
        const newer = {sessionId: 'b', session: {pid: 2, startedAt: NEWER.startedAt}},
              older = {sessionId: 'b', session: {pid: 2, startedAt: OLDER.startedAt}};

        expect(decideClaim({event: 'Stop', record: {owner: {sessionId: 'a', session: OLDER}}, me: newer, live: {owner: true}})).toBe('superseded');
        expect(decideClaim({event: 'UserPromptSubmit', record: {owner: {sessionId: 'a', session: NEWER}}, me: older, live: {owner: true}})).toBe('claim');
        expect(decideClaim({event: 'Stop', record: null, me: older, live: {}})).toBe('listen');
        expect(decideClaim({event: 'UserPromptSubmit', record: null, me: older, live: {}})).toBe('claim')
    });

    test('decideClaim: a matching session id and PID are not the owner while the owner is dead', () => {
        const record = {owner: {sessionId: 's', session: {pid: 1, startedAt: 'then'}}},
              me     = {sessionId: 's', session: {pid: 1, startedAt: 'now'}};

        expect(decideClaim({event: 'Stop', record, me, live: {owner: false, listener: true}})).toBe('listen');
        expect(decideClaim({event: 'Stop', record, me, live: {owner: true, listener: true}})).toBe('already-listening');
        expect(decideClaim({event: 'UserPromptSubmit', record, me, live: {owner: false, listener: true}})).toBe('claim');
        expect(decideClaim({event: 'UserPromptSubmit', record, me, live: {owner: true, listener: true}})).toBe('already-owner')
    })
});

/**
 * A woken turn that fails before `Stop` runs `StopFailure` instead. The wake had already moved the
 * watermark past the events it delivered, so without these arms the seat loses them and keeps no listener.
 */
test.describe('a failed turn neither loses its wake nor leaves the seat deaf', () => {
    const delivered = {
        owner    : {sessionId: 'session-older', session: OLDER},
        listener : null,
        watermark: 11,
        source   : SOURCE,
        delivered: {sessionId: 'session-older', from: 10}
    };

    test('a wake records the session it went to and the cursor it delivered from', async () => {
        writeState({watermark: 10, source: SOURCE});

        const {outcome} = await listen({answers: [{pending: 1, digest: 'D', watermark: 11}]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(readState()).toMatchObject({watermark: 11, listener: null, delivered: {sessionId: 'session-older', from: 10}})
    });

    test('the woken turn reaching Stop commits its delivery and clears the failure count', async () => {
        writeState({...delivered, failure: {error: 'rate_limit', count: 2}});

        const {polls} = await listen({answers: [{pending: 0, watermark: 11}], onSleep: (count, table) => table.delete(OLDER.pid)});

        expect(polls).toEqual([11]);
        expect(readState().delivered).toBeUndefined();
        expect(readState().failure).toBeUndefined()
    });

    test('a transient failure rolls the cursor back and re-arms after a back-off, so the same events wake once more', async () => {
        writeState(delivered);

        const {outcome, polls, sleeps} = await listen({event: 'StopFailure', error: 'rate_limit', answers: [{pending: 1, digest: 'D', watermark: 11}]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(sleeps).toEqual([POLL_INTERVAL_MS]);
        expect(polls).toEqual([10]);
        expect(readState()).toMatchObject({watermark: 11, delivered: {sessionId: 'session-older', from: 10}, failure: {error: 'rate_limit', count: 1}})
    });

    test('consecutive transient failures double the back-off up to its ceiling', async () => {
        writeState({...delivered, failure: {error: 'overloaded', count: 3}});

        const {sleeps} = await listen({event: 'StopFailure', error: 'overloaded', answers: [{pending: 1, digest: 'D', watermark: 11}]});

        expect(sleeps).toEqual([Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** 3)])
    });

    test('an auth failure re-arms nothing and keeps the lost events for the next turn that reaches Stop', async () => {
        writeState(delivered);

        const failed = await listen({event: 'StopFailure', error: 'authentication_failed'});

        expect(failed.outcome.exit).toBe(0);
        expect(failed.outcome.reason).toMatch(/authentication_failed/);
        expect([failed.connects, failed.polls, failed.sleeps]).toEqual([[], [], []]);
        expect(readState()).toMatchObject({watermark: 10, listener: null, failure: {error: 'authentication_failed', count: 1}});
        expect(readState().delivered).toBeUndefined();

        // The operator signs the seat in and prompts it: that turn's Stop delivers what the failed turn lost.
        const signedIn = await listen({answers: [{pending: 1, digest: 'D', watermark: 11}]});

        expect(signedIn.outcome).toEqual({exit: 2, digest: 'D'});
        expect(signedIn.polls).toEqual([10])
    });

    test('a failure no rewake cures waits as an auth failure does', async () => {
        writeState(delivered);

        const {outcome, connects} = await listen({event: 'StopFailure', error: 'invalid_request'});

        expect(outcome.exit).toBe(0);
        expect(connects).toEqual([]);
        expect(readState()).toMatchObject({watermark: 10, failure: {error: 'invalid_request', count: 1}})
    });

    test('a failed turn in another session rolls back nothing the wake delivered elsewhere', async () => {
        writeState({...delivered, delivered: {sessionId: 'session-newer', from: 10}});

        await listen({event: 'StopFailure', error: 'rate_limit', answers: [{pending: 0, watermark: 11}], onSleep: (count, table) => table.delete(OLDER.pid)});

        expect(readState()).toMatchObject({watermark: 11, delivered: {sessionId: 'session-newer', from: 10}})
    });

    test('a turn ending in a session that lost the seat neither clears nor sets the owner\'s failure', async () => {
        const owner = {owner: {sessionId: 'session-newer', session: NEWER}, listener: null, watermark: 11, source: SOURCE};

        writeState({...owner, failure: {error: 'authentication_failed', count: 1}});
        expect((await listen({event: 'Stop'})).outcome.reason).toBe('superseded');
        expect(readState().failure).toEqual({error: 'authentication_failed', count: 1});

        writeState(owner);
        expect((await listen({event: 'StopFailure', error: 'authentication_failed'})).outcome.reason).toBe('superseded');
        expect(readState().failure).toBeUndefined()
    });

    test('an auth failure stands down the listener already running, even mid-poll, and the wake waits for sign-in', async () => {
        const
            FAILER = {pid: 903, ppid: OLDER.pid, startedAt: 'Fri Oct 2 12:20:00 2026', command: 'node wakeListenerHook.mjs'},
            table  = new Map([[OLDER.pid, OLDER], [NEWER.pid, NEWER], [LISTENER.pid, LISTENER], [FAILER.pid, FAILER]]);

        let release, polling;

        const pending = new Promise(resolve => {release = resolve}),
              started = new Promise(resolve => {polling = resolve});

        writeState({owner: {sessionId: 'session-older', session: OLDER}, listener: null, watermark: 10, source: SOURCE});

        // This session's Stop arms the listener, which records itself and is mid-poll when the turn below fails.
        const running = listen({procs: table, answers: [pending], onPoll: polling});

        await started;

        // The operator prompts the same session, and that turn fails on its sign-in.
        expect((await listen({procs: table, event: 'UserPromptSubmit', pid: FAILER.pid})).outcome.reason).toBe('already-owner');
        expect((await listen({procs: table, event: 'StopFailure', error: 'authentication_failed', pid: FAILER.pid})).outcome.reason).toMatch(/authentication_failed/);

        release({pending: 1, digest: 'D', watermark: 11});

        expect((await running).outcome).toEqual({exit: 0, reason: 'superseded'});
        expect(readState()).toMatchObject({watermark: 10, listener: null, failure: {error: 'authentication_failed', count: 1}});

        // Signed in again, the next turn that reaches Stop delivers the pending events exactly once.
        const recovered = await listen({procs: table, pid: FAILER.pid, answers: [{pending: 1, digest: 'D', watermark: 11}]});

        expect(recovered.outcome).toEqual({exit: 2, digest: 'D'});
        expect(recovered.polls).toEqual([10]);
        expect(readState()).toMatchObject({watermark: 11, delivered: {sessionId: 'session-older', from: 10}});
        expect(readState().failure).toBeUndefined()
    })
});

test.describe('findSessionProcess', () => {
    test('walks past the shells the harness runs a hook through', async () => {
        const table = new Map([
            [10, {pid: 10, ppid: 11, startedAt: 's', command: '/bin/zsh -c node hook.mjs'}],
            [11, {pid: 11, ppid: 12, startedAt: 's', command: '/usr/bin/env node hook.mjs'}],
            [12, {pid: 12, ppid: 1,  startedAt: 's', command: '/Users/x/Library/Application Support/Claude/claude-code/claude --output-format stream-json'}]
        ]);

        expect((await findSessionProcess({ppid: 10, read: async pid => table.get(pid) ?? null})).pid).toBe(12)
    });

    test('names no session when the ancestry ends in shells or a gone process', async () => {
        expect(await findSessionProcess({ppid: 10, read: async () => null})).toBe(null)
    })
});
