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
});
