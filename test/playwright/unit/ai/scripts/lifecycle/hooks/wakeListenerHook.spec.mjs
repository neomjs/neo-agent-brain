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
    POLL_INTERVAL_MS,
    runListener
} from '../../../../../../../ai/scripts/lifecycle/hooks/claude/wakeListenerHook.mjs';

/**
 * The Claude seat's wake listener (`wakeListenerHook.mjs`): it exits 2 with the
 * digest exactly when events arrive past its stored watermark, never on the seat's backlog, and one
 * listener holds a seat at a time — the newest live session's.
 */

const
    IDENTITY = 'neo-seat',
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
async function listen({answers = [], session = OLDER, sessionId = 'session-older', event = 'Stop', procs, onSleep, config, refusal} = {}) {
    const
        table    = procs ?? new Map([[OLDER.pid, OLDER], [NEWER.pid, NEWER], [LISTENER.pid, LISTENER]]),
        polls    = [],
        sleeps   = [],
        connects = [],
        client   = {
            async callTool(name, args) {
                polls.push(args.sinceLogId);

                const answer = answers.shift();

                if (answer instanceof Error) throw answer;
                if (!answer) throw new Error('the script ran out of answers');

                return answer
            },
            async close() {}
        };

    const outcome = await runListener({
        payload     : {session_id: sessionId, hook_event_name: event},
        homeDir,
        config      : config ?? {planeBase: 'http://127.0.0.1:3102', planeBearer: 'token', identity: `@${IDENTITY}`},
        connect     : async options => {connects.push(options); return refusal ?? {client, identity: `@${IDENTITY}`}},
        resolveRoute: async () => 'WAKE_SUB:pull',
        findSession : async () => session,
        read        : async pid => table.get(pid) ?? null,
        pid         : LISTENER.pid,
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
        writeState({watermark: 50});

        const {outcome, polls} = await listen({answers: [{pending: 2, digest: 'D', watermark: 60}]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(polls).toEqual([50])
    });

    test('failures back off and retry, and pending events without a digest never wake', async () => {
        writeState({watermark: 7});

        const {outcome, sleeps} = await listen({answers: [
            new Error('plane unreachable'),
            new Error('plane unreachable'),
            {pending: 3, watermark: 8},
            {pending: 1, digest: 'D', watermark: 9}
        ]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(sleeps).toEqual([POLL_INTERVAL_MS, 2 * POLL_INTERVAL_MS, POLL_INTERVAL_MS])
    });

    test('at SessionStart the first poll waits one interval for the arming hook', async () => {
        writeState({watermark: 1});

        const {sleeps, polls} = await listen({event: 'SessionStart', answers: [{pending: 1, digest: 'D', watermark: 2}]});

        expect(sleeps).toEqual([POLL_INTERVAL_MS]);
        expect(polls).toEqual([1])
    });

    test('a second Stop in the owning session, with its listener alive, arms nothing new', async () => {
        writeState({owner: {sessionId: 'session-older', session: OLDER}, listener: {pid: 901, startedAt: 'Fri Oct 2 12:30:00 2026'}, watermark: 3});

        const procs               = new Map([[OLDER.pid, OLDER], [901, {pid: 901, ppid: 100, startedAt: 'Fri Oct 2 12:30:00 2026', command: 'node'}]]),
              {outcome, connects} = await listen({procs});

        expect(outcome).toEqual({exit: 0, reason: 'already-listening'});
        expect(connects).toEqual([]);
        expect(readState().listener.pid).toBe(901)
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
        expect(outcome.reason).toMatch(/fleet\.planeBase is not configured/);
        expect(fs.existsSync(statePath())).toBe(false)
    })
});

test.describe('AC-3: the newest live session owns the seat', () => {
    test('an older session\'s listener exits once a newer session claims the seat', async () => {
        const {outcome} = await listen({
            answers: [{pending: 0, watermark: 10}],
            onSleep: () => writeState({...readState(), owner: {sessionId: 'session-newer', session: NEWER}, listener: {pid: 902, startedAt: 'x'}})
        });

        expect(outcome).toEqual({exit: 0, reason: 'superseded'});
        expect(readState().owner.sessionId).toBe('session-newer')
    });

    test('an older session\'s Stop yields to a live newer owner without touching the plane', async () => {
        writeState({owner: {sessionId: 'session-newer', session: NEWER}, listener: null});

        const {outcome, connects} = await listen();

        expect(outcome).toEqual({exit: 0, reason: 'superseded'});
        expect(connects).toEqual([])
    });

    test('a newer session takes the seat from a live older owner', async () => {
        writeState({owner: {sessionId: 'session-older', session: OLDER}, listener: null, watermark: 20});

        const {outcome} = await listen({session: NEWER, sessionId: 'session-newer', answers: [{pending: 1, digest: 'D', watermark: 21}]});

        expect(outcome).toEqual({exit: 2, digest: 'D'});
        expect(readState().owner.sessionId).toBe('session-newer')
    });

    test('a dead owner frees the seat, even for an older session', async () => {
        const GONE = {pid: 300, startedAt: 'Fri Oct 2 13:00:00 2026'};

        writeState({owner: {sessionId: 'session-gone', session: GONE}, listener: null, watermark: 30});

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

    test('decideClaim: a tie on start time keeps the current owner', () => {
        const me = {sessionId: 'b', session: {pid: 2, startedAt: OLDER.startedAt}};

        expect(decideClaim({record: {owner: {sessionId: 'a', session: OLDER}}, me, live: {owner: true}})).toBe('superseded');
        expect(decideClaim({record: null, me, live: {}})).toBe('listen')
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
