import {EventEmitter} from 'node:events';
import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    ASSISTIVE_ACCESS_REFUSAL_REASON,
    AUTOMATION_ACCESS_REFUSAL_REASON,
    PRIVILEGE_VIOLATION_REFUSAL_REASON,
    SEAT_WINDOW_FILE,
    assistiveAccessRefusal,
    isAssistiveAccessError,
    isWindowRect,
    isWindowRefusal,
    parseWindowRect,
    placeDevToolsWindowRect,
    placeSeatWindow,
    placeWindowRectArgs,
    readSeatWindowRecord,
    readSeatWindowRect,
    readWindowRectArgs,
    sameWindowRect,
    waitForSeatWindowRect,
    windowRefusalRemedy,
    writeSeatWindowRecord
} from '../../../../../../ai/services/fleet/seatWindowRect.mjs';

const
    RECT  = {x: 2056, y: 30, width: 892, height: 1055},
    OTHER = {x: 79, y: 39, width: 1280, height: 820},
    OWNER = {pid: 4242, startedAt: '2026-10-29T10:00:00.000Z'};

test.describe('seatWindowRect — a GUI seat\'s window rectangle across stop and start', () => {
    test('a rectangle is four finite numbers with a positive size; sameness is to the point', () => {
        expect(isWindowRect(RECT)).toBe(true);
        expect(isWindowRect({x: 0, y: 0, width: 0, height: 10})).toBe(false);
        expect(isWindowRect({x: '1', y: 2, width: 3, height: 4})).toBe(false);
        expect(isWindowRect(null)).toBe(false);
        expect(sameWindowRect(RECT, {...RECT, x: 2056.4})).toBe(true);
        expect(sameWindowRect(RECT, {...RECT, x: 2057})).toBe(false);
    });

    test('the CoreGraphics read argv and System Events fallback place argv address the process by unix id, and the answer parses as four integers', () => {
        const read = readWindowRectArgs(71976).join('\n');

        expect(read).toContain('JavaScript');
        expect(read).toContain('CoreGraphics');
        expect(read).toContain('CGWindowListCopyWindowInfo');
        expect(read).toContain('w.kCGWindowOwnerPID === 71976');
        expect(read).toContain('w.kCGWindowLayer === 0');
        expect(read).not.toContain('System Events');
        expect(read).not.toContain('set position');

        const place = placeWindowRectArgs(71976, {x: 2056.4, y: 30, width: 892, height: 1055}).join('\n');

        expect(place).toContain('set position of window 1 to {2056, 30}');
        expect(place).toContain('set size of window 1 to {892, 1055}');
        expect(() => readWindowRectArgs(0)).toThrow(/positive integer pid/);
        expect(() => placeWindowRectArgs('71976; rm', RECT)).toThrow(/positive integer pid/);

        expect(parseWindowRect('2056, 30, 892, 1055\n')).toEqual(RECT);
        expect(parseWindowRect('2056, 30, 892')).toBeNull();
        expect(parseWindowRect('a, b, c, d')).toBeNull();
        expect(parseWindowRect('2056, 30, 0, 1055')).toBeNull();
        expect(parseWindowRect('')).toBeNull();
    });

    test('Antigravity CDP placement proves profile listener ownership via withOwnedAntigravityCdp, grants windowManagement, polls until the frame settles, and falls back to System Events on failure (#1351)', async () => {
        const
            home        = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seat-window-devtools-'))),
            browserPath = '/devtools/browser/7db79dc6-dd64-4a12-9abc-0123456789ab';

        fs.writeFileSync(path.join(home, 'DevToolsActivePort'), `54648\n${browserPath}\n`);

        const
            rpcLog          = [],
            listenerCalls   = [],
            socketOptions   = [];
        let
            polls           = 0,
            evalException   = null;

        class FakeWebSocket extends EventEmitter {
            static OPEN = 1;

            constructor(url, options) {
                super();
                this.url        = url;
                this.readyState = 0;
                socketOptions.push({url, options});
                queueMicrotask(() => {
                    this.readyState = FakeWebSocket.OPEN;
                    this.emit('open')
                })
            }

            send(raw) {
                const msg = JSON.parse(raw);
                rpcLog.push(msg);
                queueMicrotask(() => {
                    if (msg.method === 'Target.getTargets') {
                        polls += 1;
                        const targetInfos = polls === 1
                            ? [{targetId: 't0', type: 'page', url: 'about:blank'}]
                            : [{targetId: 't1', type: 'page', url: 'https://127.0.0.1:49939/c/abc'}];
                        this.emit('message', Buffer.from(JSON.stringify({id: msg.id, result: {targetInfos}})));
                        return
                    }
                    if (msg.method === 'Browser.grantPermissions') {
                        this.emit('message', Buffer.from(JSON.stringify({id: msg.id, result: {}})));
                        return
                    }
                    if (msg.method === 'Target.attachToTarget') {
                        this.emit('message', Buffer.from(JSON.stringify({id: msg.id, result: {sessionId: 'sess-1'}})));
                        return
                    }
                    if (msg.method === 'Runtime.evaluate') {
                        const result = evalException
                            ? {result: {type: 'object'}, exceptionDetails: evalException}
                            : {result: {value: RECT}};
                        this.emit('message', Buffer.from(JSON.stringify({id: msg.id, sessionId: msg.sessionId, result})))
                    }
                })
            }

            close() {
                this.readyState = 3;
                this.emit('close')
            }

            terminate() {
                this.readyState = 3;
                this.emit('close')
            }
        }

        const verifyProfileListener = async input => {
            listenerCalls.push(input);
            return {
                verified           : true,
                processTreeVerified: true,
                profileDirectory   : input.profileDirectory,
                port               : input.port,
                browserPath        : input.browserPath,
                pid                : input.expectedProcess.pid,
                startedAt          : input.expectedProcess.startedAt
            }
        };

        // 1. Unverified listener (pid mismatch) refuses before opening any socket
        const mismatchPlaced = await placeDevToolsWindowRect(RECT, {
            instanceHome         : home,
            expectedProcess      : OWNER,
            verifyProfileListener: async input => ({
                verified           : true,
                processTreeVerified: true,
                profileDirectory   : input.profileDirectory,
                port               : input.port,
                browserPath        : input.browserPath,
                pid                : 9999,
                startedAt          : input.expectedProcess.startedAt
            }),
            WebSocketCtor: FakeWebSocket,
            pollMs       : 1,
            timeoutMs    : 200
        });

        expect(mismatchPlaced).toBe(false);
        expect(socketOptions).toHaveLength(0);

        // 2. Verified listener connects with maxPayload, grants windowManagement, and evaluates moveTo/resizeTo
        const placed = await placeDevToolsWindowRect(
            {...RECT, x: 2056.4},
            {
                instanceHome         : home,
                expectedProcess      : OWNER,
                verifyProfileListener,
                WebSocketCtor        : FakeWebSocket,
                pollMs               : 1,
                timeoutMs            : 500
            }
        );

        expect(placed).toBe(true);
        expect(listenerCalls).toHaveLength(1);
        expect(listenerCalls[0]).toMatchObject({
            profileDirectory: home,
            port            : 54648,
            browserPath,
            expectedProcess : OWNER
        });
        expect(socketOptions[0]).toEqual({
            url    : `ws://127.0.0.1:54648${browserPath}`,
            options: {maxPayload: 4 * 1024 * 1024}
        });
        expect(rpcLog.map(m => m.method)).toEqual([
            'Target.getTargets',
            'Target.getTargets',
            'Browser.grantPermissions',
            'Target.attachToTarget',
            'Runtime.evaluate'
        ]);
        expect(rpcLog[2].params).toEqual({
            permissions: ['windowManagement'],
            origin     : 'https://127.0.0.1:49939'
        });
        expect(rpcLog[4]).toMatchObject({
            sessionId: 'sess-1',
            params   : {
                expression : 'window.moveTo(2056, 30); window.resizeTo(892, 1055); window.moveTo(2056, 30);',
                userGesture: true
            }
        });

        // 3. Runtime.evaluate exceptionDetails is treated as not placed (false)
        evalException = {text: 'TypeError: window.moveTo failed'};
        expect(await placeDevToolsWindowRect(RECT, {
            instanceHome         : home,
            expectedProcess      : OWNER,
            verifyProfileListener,
            WebSocketCtor        : FakeWebSocket,
            pollMs               : 1,
            timeoutMs            : 500
        })).toBe(false);
        evalException = null;

        // 4. placeSeatWindow for antigravity polls readSeatWindowRect until the frame settles, without calling System Events
        const
            osascriptCalls = [],
            readAnswers    = ['79, 39, 1280, 820', '2056, 30, 892, 1055'],
            execFileFn     = async (file, args) => {
                osascriptCalls.push([file, args]);
                return {stdout: readAnswers.shift() ?? '2056, 30, 892, 1055'}
            };

        const observed = await placeSeatWindow(OWNER.pid, RECT, {
            execFileFn,
            platform       : 'darwin',
            instanceHome   : home,
            harnessType    : 'antigravity',
            expectedProcess: OWNER,
            pollMs         : 1,
            placeDevToolsFn: async (rect, opts) => placeDevToolsWindowRect(rect, {
                ...opts,
                verifyProfileListener,
                WebSocketCtor: FakeWebSocket
            })
        });

        expect(observed).toEqual(RECT);
        expect(osascriptCalls).toHaveLength(2);
        expect(osascriptCalls.every(([, args]) => args.join('\n').includes('CGWindowListCopyWindowInfo'))).toBe(true);
        expect(osascriptCalls.some(([, args]) => args.join('\n').includes('set position'))).toBe(false);

        // 5. Non-antigravity harnessType ignores instanceHome CDP and goes straight to System Events
        const nonAgCalls = [];
        let   cdpCalled  = false;
        const nonAgObserved = await placeSeatWindow(OWNER.pid, RECT, {
            execFileFn     : async (file, args) => { nonAgCalls.push([file, args]); return {stdout: '2056, 30, 892, 1055'} },
            platform       : 'darwin',
            instanceHome   : home,
            harnessType    : 'claude-desktop',
            expectedProcess: OWNER,
            placeDevToolsFn: async () => { cdpCalled = true; return true }
        });

        expect(nonAgObserved).toEqual(RECT);
        expect(cdpCalled).toBe(false);
        expect(nonAgCalls).toHaveLength(2);
        expect(nonAgCalls[0][1].join('\n')).toContain('set position of window 1 to {2056, 30}');

        // 6. Antigravity seat where CDP fails falls back to System Events placement and succeeds
        const fallbackCalls = [];
        evalException = {text: 'CDP move failed'};
        const fallbackObserved = await placeSeatWindow(OWNER.pid, RECT, {
            execFileFn     : async (file, args) => { fallbackCalls.push([file, args]); return {stdout: '2056, 30, 892, 1055'} },
            platform       : 'darwin',
            instanceHome   : home,
            harnessType    : 'antigravity',
            expectedProcess: OWNER,
            pollMs         : 1,
            placeDevToolsFn: async (rect, opts) => placeDevToolsWindowRect(rect, {
                ...opts,
                verifyProfileListener,
                WebSocketCtor: FakeWebSocket
            })
        });

        expect(fallbackObserved).toEqual(RECT);
        expect(fallbackCalls).toHaveLength(2);
        expect(fallbackCalls[0][1].join('\n')).toContain('set position of window 1 to {2056, 30}');
        expect(fallbackCalls[1][1].join('\n')).toContain('CGWindowListCopyWindowInfo');
    });

    test('read and place run osascript on darwin only, never throw, and the placement reports the read-back', async () => {
        const calls      = [];
        const execFileFn = async (file, args) => { calls.push([file, args]); return {stdout: '2056, 30, 892, 1055'} };

        expect(await readSeatWindowRect(4242, {execFileFn, platform: 'linux'})).toBeNull();
        expect(calls).toEqual([]);

        expect(await readSeatWindowRect(4242, {execFileFn, platform: 'darwin'})).toEqual(RECT);
        expect(calls[0][0]).toBe('osascript');

        expect(await placeSeatWindow(4242, RECT, {execFileFn, platform: 'darwin'})).toEqual(RECT);
        expect(calls).toHaveLength(3);
        expect(calls[1][1].join('\n')).toContain('set position of window 1 to {2056, 30}');

        const missingWindow = async () => { throw new Error('System Events got an error: Can’t get window 1 of process 1. Invalid index. (-1719)') };
        expect(isAssistiveAccessError(new Error('Can’t get window 1. Invalid index. (-1719)'))).toBe(false);
        expect(await readSeatWindowRect(4242, {execFileFn: missingWindow, platform: 'darwin'})).toBeNull();
        expect(await placeSeatWindow(4242, RECT, {execFileFn: missingWindow, platform: 'darwin'})).toBeNull();

        const refusing = async () => { throw new Error('System Events got an error: osascript is not allowed assistive access. (-25211)') };
        expect(isAssistiveAccessError(new Error('osascript is not allowed assistive access. (-25211)'))).toBe(true);
        expect(assistiveAccessRefusal(new Error('osascript is not allowed assistive access. (-25211)'))).toEqual({
            refused: true,
            reason : ASSISTIVE_ACCESS_REFUSAL_REASON
        });
        expect(assistiveAccessRefusal({stderr: 'execution error: Not authorized to send Apple events to System Events. (-1743)'})).toEqual({
            refused: true,
            reason : AUTOMATION_ACCESS_REFUSAL_REASON
        });
        expect(assistiveAccessRefusal({stderr: 'execution error: A privilege violation occurred. (-10004)'})).toEqual({
            refused: true,
            reason : PRIVILEGE_VIOLATION_REFUSAL_REASON
        });
        expect(windowRefusalRemedy(ASSISTIVE_ACCESS_REFUSAL_REASON)).toBe('grant Accessibility permission to Neo Harness.app in System Settings');
        expect(windowRefusalRemedy(AUTOMATION_ACCESS_REFUSAL_REASON)).toBe('grant Automation of System Events permission to Neo Harness.app in System Settings');
        expect(windowRefusalRemedy(PRIVILEGE_VIOLATION_REFUSAL_REASON)).toBeNull();
        expect(await readSeatWindowRect(4242, {execFileFn: refusing, platform: 'darwin'})).toEqual({
            refused: true,
            reason : ASSISTIVE_ACCESS_REFUSAL_REASON
        });
        expect(await placeSeatWindow(4242, RECT, {execFileFn: refusing, platform: 'darwin'})).toEqual({
            refused: true,
            reason : ASSISTIVE_ACCESS_REFUSAL_REASON
        });
        expect(isWindowRefusal({refused: true, reason: ASSISTIVE_ACCESS_REFUSAL_REASON})).toBe(true);
        expect(isWindowRefusal(RECT)).toBe(false);
        expect(await placeSeatWindow(4242, {x: 1, y: 1, width: 0, height: 0}, {execFileFn, platform: 'darwin'})).toBeNull();
    });

    test('waiting for the first window polls the reader until a rectangle or the bound, and short-circuits immediately on macOS Accessibility denial (#1301)', async () => {
        const answers = [null, null, RECT];
        let   clock   = 0;
        const sleeps  = [];

        const rect = await waitForSeatWindowRect(7, {readFn: async () => answers.shift() ?? null, timeoutMs: 1000, pollMs: 100, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms }});

        expect(rect).toEqual(RECT);
        expect(sleeps).toEqual([100, 100]);

        clock = 0;
        expect(await waitForSeatWindowRect(7, {readFn: async () => null, timeoutMs: 250, pollMs: 100, now: () => clock, sleep: async ms => { clock += ms }})).toBeNull();

        let   deniedCalls  = 0;
        const deniedSleeps = [];
        const deniedResult = await waitForSeatWindowRect(7, {
            readFn   : pid => readSeatWindowRect(pid, {
                execFileFn: async () => {
                    deniedCalls += 1;
                    throw new Error('System Events got an error: osascript is not allowed assistive access. (-25211)')
                },
                platform: 'darwin'
            }),
            timeoutMs: 20000,
            pollMs   : 250,
            now      : () => 0,
            sleep    : async ms => { deniedSleeps.push(ms) }
        });

        expect(deniedResult).toEqual({refused: true, reason: ASSISTIVE_ACCESS_REFUSAL_REASON});
        expect(deniedCalls).toBe(1);
        expect(deniedSleeps).toEqual([]);

        let   thrownCalls  = 0;
        const thrownResult = await waitForSeatWindowRect(7, {
            readFn   : async () => {
                thrownCalls += 1;
                throw new Error('osascript is not allowed assistive access (-25211)')
            },
            timeoutMs: 20000,
            pollMs   : 250,
            now      : () => 0,
            sleep    : async ms => { deniedSleeps.push(ms) }
        });

        expect(thrownResult).toEqual({refused: true, reason: ASSISTIVE_ACCESS_REFUSAL_REASON});
        expect(thrownCalls).toBe(1);
        expect(deniedSleeps).toEqual([]);
    });

    test('the record is written atomically beside the lease, mode 0600, and read back only when valid', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-window-rect-'));

        expect(writeSeatWindowRecord({instanceHome: home, agentId: 'seat', harnessType: 'antigravity', rect: {x: 1, y: 1, width: 0, height: 1}})).toMatch(/not usable/);
        expect(readSeatWindowRecord(home)).toBeNull();

        expect(writeSeatWindowRecord({instanceHome: home, agentId: 'seat', harnessType: 'antigravity', rect: {...RECT, x: 2056.4}, capturedAt: '2026-10-17T15:00:00.000Z'})).toBeNull();

        const file = path.join(home, SEAT_WINDOW_FILE);

        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({version: 1, agentId: 'seat', harnessType: 'antigravity', rect: RECT, capturedAt: '2026-10-17T15:00:00.000Z'});
        expect(readSeatWindowRecord(home)).toMatchObject({rect: RECT, harnessType: 'antigravity'});

        fs.writeFileSync(file, JSON.stringify({version: 1, rect: {x: 1, y: 2, width: -3, height: 4}}));
        expect(readSeatWindowRecord(home)).toBeNull();

        fs.writeFileSync(file, '{not json');
        expect(readSeatWindowRecord(home)).toBeNull();

        fs.writeFileSync(path.join(home, 'file-as-dir'), '');
        expect(writeSeatWindowRecord({instanceHome: path.join(home, 'file-as-dir', 'deeper'), agentId: 'seat', harnessType: 'antigravity', rect: RECT})).toMatch(/ENOTDIR|not a directory|EEXIST/i);
    });
});
