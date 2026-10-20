import {expect, test}                                from '@playwright/test';
import fs                                            from 'node:fs';
import {FLEET_BOOT_PHASES, formatFleetBootPhaseLine} from '../../../../../../ai/services/fleet/devFleetServer.mjs';

const source = fs.readFileSync(new URL('../../../../../../ai/services/fleet/devFleetServer.mjs', import.meta.url), 'utf8');

/** @summary Execute the actual post-admission boot statements with isolated transport/observer seams. */
function bootSlice({enabled = true, plane = true, start}) {
    const begin = source.indexOf('        // Claim the transport before starting an observer'),
        end     = source.indexOf('        // AWAITED plane teardown', begin);
    if (begin < 0 || end < 0) throw new Error('Fleet boot statement anchors changed');
    let wakeOptions;
    const events = [], round = () => {},
        seams    = {
            startFleetBridgeServer               : async options => { events.push('listen'); return start?.(options) ?? {close() {}} },
            settleFleetBridge                    : async () => ({state: 'ready', port: 1, action: 'verified', publicKeySha256: '0123456789abcdef'}),
            superviseFleetBridge                 : () => ({stop() {}}),
            FLEET_BRIDGE_STATES                  : {READY: 'ready'},
            neuralLinkConfig                     : {port: 1},
            FleetManager                         : {},
            AiConfig                             : {fleet: {openWorkWakes: enabled, bearerHandshake: false}},
            planeClient                          : plane ? {addMessage() { events.push('send') }} : null,
            FleetRegistryService                 : {}, RequestContextService: {run() {}},
            wireFleetOpenWorkWakes               : options => { wakeOptions = options; events.push('wake'); return round },
            wireFleetOpenWorkSource              : options => { events.push(['observe', options.onPulse]); return {} },
            readGithubToken                      : () => null, readPresence: async () => ({}),
            assertFleetViewerMcAuthorizationClass: () => null,
            console                              : {log() {}, warn() {}}, port: 1, bearerToken: 'fixture', viewer: {}, origins: []
        },
        run = new Function(...Object.keys(seams), `return (async () => { let server, wakeRound, openWork; ${source.slice(begin, end)} })()`);
    return {events, round, config: seams.AiConfig, wakeOptions: () => wakeOptions, run: () => run(...Object.values(seams))}
}

/** @summary Read the actual cleanup function so a refactor cannot leave one exit undrained. */
function cleanup(seams) {
    const begin = source.indexOf('    async function closeObservedWorkAndPlane() {'),
        end     = source.indexOf('\n    }', begin);
    if (begin < 0 || end < 0) throw new Error('Fleet cleanup function anchor changed');
    return new Function(...Object.keys(seams), `${source.slice(begin, end + 6)}; return closeObservedWorkAndPlane;`)(...Object.values(seams))
}

/** @summary Execute the actual `cleanShutdown` function so drain and handoff share one deadline. */
function shutdownSlice(seams) {
    const begin = source.indexOf('        let shutdown;'),
        end     = source.indexOf("\n        process.on('SIGTERM'", begin);
    if (begin < 0 || end < 0) throw new Error('Fleet cleanShutdown function anchor changed');
    return new Function(...Object.keys(seams), `${source.slice(begin, end)}; return cleanShutdown;`)(...Object.values(seams))
}

test.describe('Fleet open-work boot custody (#761)', () => {
    test('an occupied transport rejects before any observer or wake path starts', async () => {
        let release;
        const pending = new Promise((resolve, reject) => { release = () => reject(Object.assign(new Error('occupied'), {code: 'EADDRINUSE'})) }),
            h         = bootSlice({start: () => pending}), running = h.run();
        expect(h.events).toEqual(['listen']);
        release();
        await expect(running).rejects.toMatchObject({code: 'EADDRINUSE'});
        expect(h.events).toEqual(['listen'])
    });

    test('only an enabled plane-mode owner connects the one observer to a wake round', async () => {
        for (const [enabled, plane, wakes] of [[false, true, false], [true, false, false], [true, true, true]]) {
            const h = bootSlice({enabled, plane});
            await h.run();
            expect(h.events).toEqual(wakes ? ['listen', 'wake', ['observe', h.round]] : ['listen', ['observe', null]]);
            if (wakes) {
                expect(h.wakeOptions().isEnabled()).toBe(true);
                h.config.fleet.openWorkWakes = false;
                expect(h.wakeOptions().isEnabled()).toBe(false)
            }
        }
    });

    test('cleanup waits for an active callback before closing the plane, even when another stop rejects', async () => {
        const events = [];
        let release;
        const active = new Promise(resolve => { release = resolve }),
            stop     = cleanup({
                fleetWakeStreamConsumer: {stop() { events.push('stream') }},
                openWork               : {stop: () => { events.push('observer'); return active }},
                wakeRound              : {stop: async () => { events.push('wake'); throw new Error('stop failure') }},
                planeClient            : {close: async () => { events.push('plane') }}
            }),
            running = stop();
        await Promise.resolve();
        expect(events).toEqual(['stream', 'observer', 'wake']);
        release();
        await expect(running).rejects.toThrow('stop failure');
        expect(events.at(-1)).toBe('plane');
        expect(source.slice(source.indexOf('    } catch (error) {', source.indexOf('// Each seat')))).toContain('await closeObservedWorkAndPlane()')
    });

    test('boot logs elapsed milliseconds for runtime bind, viewer claim, plane init, recovery, and transport (#1142)', () => {
        expect(FLEET_BOOT_PHASES).toEqual(['runtime bind', 'viewer claim', 'plane init', 'recovery', 'transport']);
        expect(formatFleetBootPhaseLine('runtime bind', 5720.4, 'gen=abcd1234')).toBe(
            '[fleet] boot phase runtime bind: 5720 ms (gen=abcd1234)'
        );
        expect(formatFleetBootPhaseLine('recovery', 0.2)).toBe('[fleet] boot phase recovery: 0 ms');

        for (const phase of FLEET_BOOT_PHASES) {
            expect(source).toContain(`formatFleetBootPhaseLine('${phase}',`);
        }
    });

    test('under a 300 ms shutdownBudgetMs with a drain + handoff that would take longer, cleanShutdown passes remaining deadlineMs and logs Fleet continuity refused: deadline at survivor-validation (#1081)', async () => {
        const logs    = [],
            errors    = [],
            events    = [],
            drains    = [],
            deadlines = [],
            shutdown  = shutdownSlice({
                AiConfig        : {fleet: {shutdownBudgetMs: 300}},
                bridgeSupervisor: {stop() { events.push('bridge-stop') }},
                runtime         : {generation: 'gen-1081'},
                lifecycle       : {
                    listRunning       : () => [{id: 'seat-1'}],
                    getLaunchAdmission: () => ({
                        proofTimeoutMs: 5000,
                        closeUnclean  : async () => { events.push('close-unclean') }
                    }),
                    handoffRuntimeCustody: ({deadlineMs, onStage}) => new Promise((resolve, reject) => {
                        deadlines.push(deadlineMs);
                        onStage?.('survivor-validation');
                        setTimeout(() => {
                            onStage?.('refused at survivor-validation: deadline');
                            reject(new Error('Fleet continuity refused: deadline at survivor-validation.'));
                        }, deadlineMs);
                    })
                },
                server                  : {
                    drainFleetRequests: ms => {
                        drains.push(ms);
                        return new Promise(resolve => setTimeout(resolve, 100));
                    }
                },
                FleetManager             : {getTenantService: async () => ({})},
                closeObservedWorkAndPlane: async () => { events.push('close-plane') },
                console                  : {
                    log  : message => logs.push(message),
                    error: message => errors.push(message)
                },
                process                 : {exit: code => events.push(['exit', code])}
            });

        await shutdown('SIGTERM');

        expect(drains).toHaveLength(1);
        expect(drains[0]).toBeGreaterThan(0);
        expect(drains[0]).toBeLessThanOrEqual(300);
        expect(deadlines).toHaveLength(1);
        expect(deadlines[0]).toBeGreaterThan(0);
        expect(deadlines[0]).toBeLessThanOrEqual(210);
        expect(logs.some(line => line.includes('continuity handoff starting: 1 running seat(s); shutdown budget 300 ms; drain and proofs bounded by 5000 ms each'))).toBe(true);
        expect(logs.some(line => line.includes('continuity handoff: survivor-validation ('))).toBe(true);
        expect(logs.some(line => line.includes('continuity handoff: refused at survivor-validation: deadline ('))).toBe(true);
        expect(errors).toHaveLength(1);
        const match = errors[0].match(/continuity handoff was not completed after (\d+) ms: Fleet continuity refused: deadline at survivor-validation\. \(budget 300 ms\)/);
        expect(match).not.toBeNull();
        expect(Number(match[1])).toBeGreaterThanOrEqual(250);
        expect(Number(match[1])).toBeLessThan(480);
        expect(events).toEqual(['bridge-stop', 'close-unclean', 'close-plane', ['exit', 0]]);

        const fastLogs   = [],
            fastErrors   = [],
            fastEvents   = [],
            fastShutdown = shutdownSlice({
                AiConfig        : {fleet: {shutdownBudgetMs: 300}},
                bridgeSupervisor: {stop() {}},
                runtime         : {generation: 'gen-1081-fast'},
                lifecycle       : {
                    listRunning       : () => [{id: 'seat-1'}],
                    getLaunchAdmission: () => ({
                        proofTimeoutMs: 5000,
                        closeUnclean  : async () => { fastEvents.push('close-unclean') }
                    }),
                    handoffRuntimeCustody: async ({onStage}) => {
                        onStage?.('durable-handoff');
                    }
                },
                server                   : {drainFleetRequests: async () => {}},
                FleetManager             : {getTenantService: async () => ({})},
                closeObservedWorkAndPlane: async () => { fastEvents.push('close-plane') },
                console                  : {
                    log  : message => fastLogs.push(message),
                    error: message => fastErrors.push(message)
                },
                process                 : {exit: code => fastEvents.push(['exit', code])}
            });

        await fastShutdown('SIGTERM');
        expect(fastErrors).toEqual([]);
        expect(fastLogs.some(line => /continuity handoff sealed after \d+ ms \(budget 300 ms\); a successor rebinds the released origin/.test(line))).toBe(true);
        expect(fastEvents).toEqual(['close-unclean', 'close-plane', ['exit', 0]]);
    });

    test('transport listens before runtime payload inventory or recovery runs, and Starts stay fenced until recovery settles (#1198 AC-4)', async () => {
        const preBegin  = source.indexOf('    if (runtime.generation) {'),
              preEnd    = source.indexOf('    // Wire the cross-process boot-identity reader', preBegin),
              postBegin = source.indexOf('        const transportStartedAt = Date.now();'),
              postEnd   = source.indexOf('        // Seat-conflation honesty at boot:', postBegin);
        expect(preBegin).toBeGreaterThan(0);
        expect(postBegin).toBeGreaterThan(preEnd);
        expect(postEnd).toBeGreaterThan(postBegin);

        let releaseVerify, releaseRecover;
        const events    = [],
              logs      = [],
              admission = {continuityPhase: 'ready', proofTimeoutMs: 5000, closeUnclean: async () => {}, continuityRecord: {handoffProved: true}},
              runtime   = {
                  generation: {id: 'a'.repeat(64)},
                  verify    : () => new Promise(resolve => {
                      events.push(['verify-start', admission.continuityPhase]);
                      releaseVerify = () => {
                          runtime.verified = runtime.generation;
                          events.push('verify-done');
                          resolve(runtime.generation);
                      };
                  })
              },
              lifecycle = {
                  openRuntimeCustody   : () => events.push('open-custody'),
                  getRegistry          : () => ({admissionDirectory: () => '/tmp/custody'}),
                  getLaunchAdmission   : () => admission,
                  recoverRuntimeCustody: () => new Promise(resolve => {
                      events.push(['recover-start', Boolean(runtime.verified), admission.continuityPhase]);
                      releaseRecover = () => {
                          admission.continuityPhase = 'ready';
                          events.push('recover-done');
                          resolve([{agentId: 'seat', state: 'active', detail: null}]);
                      };
                  })
              },
              seams = {
                  runtime,
                  lifecycle,
                  startFleetBridgeServer: async () => {
                      events.push(['listen', Boolean(runtime.verified), admission.continuityPhase]);
                      return {address: () => ({port: 8083}), drainFleetRequests: async () => {}};
                  },
                  settleFleetBridge                    : async () => ({state: 'ready', port: 1, action: 'verified', publicKeySha256: '0123456789abcdef'}),
                  superviseFleetBridge                 : () => ({stop() {}}),
                  FLEET_BRIDGE_STATES                  : {READY: 'ready'},
                  neuralLinkConfig                     : {port: 1},
                  FleetManager                         : {getTenantService: async () => ({})},
                  AiConfig                             : {fleet: {openWorkWakes: false, bearerHandshake: false, bearer: 'supplied'}},
                  planeClient                          : null,
                  FleetRegistryService                 : {},
                  RequestContextService                : {run() {}},
                  wireFleetOpenWorkWakes               : () => null,
                  wireFleetOpenWorkSource              : () => ({}),
                  readGithubToken                      : () => null,
                  readPresence                         : async () => ({}),
                  assertFleetViewerMcAuthorizationClass: () => null,
                  formatFleetBootPhaseLine,
                  process                              : {on() {}},
                  console                              : {log: line => logs.push(line), warn() {}, error() {}},
                  port                                 : 8083,
                  bearerToken                          : 'fixture',
                  viewer                               : {agentIdentityNodeId: 'AGENT:tobiu'},
                  origins                              : []
              },
              run = new Function(...Object.keys(seams), `return (async () => { let server, wakeRound, openWork; ${source.slice(preBegin, preEnd)}\n${source.slice(postBegin, postEnd)} })()`);

        const running = run(...Object.values(seams));
        await Promise.resolve();
        await Promise.resolve();

        expect(events).toEqual([
            'open-custody',
            ['listen', false, 'recovering'],
            ['verify-start', 'recovering']
        ]);
        expect(logs.some(line => line.includes('[fleet] boot phase transport:'))).toBe(true);
        expect(logs.some(line => line.includes('[fleet] boot phase recovery:'))).toBe(false);

        releaseVerify();
        await Promise.resolve();
        await Promise.resolve();

        expect(events).toEqual([
            'open-custody',
            ['listen', false, 'recovering'],
            ['verify-start', 'recovering'],
            'verify-done',
            ['recover-start', true, 'recovering']
        ]);

        releaseRecover();
        await running;

        expect(admission.continuityPhase).toBe('ready');
        expect(logs.some(line => line.includes('[fleet] boot phase recovery:'))).toBe(true);
    });
});


