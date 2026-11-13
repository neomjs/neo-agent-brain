import {test, expect} from '@playwright/test';
import {
    HARNESS_ACQUIRERS,
    wireFleetHarnessAcquisition
} from '../../../../../../ai/services/fleet/wireFleetHarnessAcquisition.mjs';

const
    ROOT  = '/nonexistent/fleet-spec-harness-generations',
    NOW   = new Date('2026-11-11T00:00:00.000Z'),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @summary A context that opts the given families in, as `FleetLifecycleService#harnessAcquisitionContext` would. */
const contextFor = optedIn => family => ({optedIn: optedIn.includes(family), root: ROOT, installedBundle: `/Applications/${family}.app`});

/** @summary An acquirer double that records each call and answers with `answer()`. */
const acquirer = (family, calls, answer) => ({
    acquire: async args => { calls.push([family, args]); return answer() },
    version: result => result?.version ?? null
});

/** @summary Wires the job with hour-long timers (unref'd), so a test drives it through `pulse()`. */
const wire = options => wireFleetHarnessAcquisition({
    intervalMs : 3_600_000,
    bootDelayMs: 3_600_000,
    select     : () => ({shortVersion: '1.0'}),
    now        : () => NOW,
    log        : {log() {}},
    ...options
});

test.describe('wireFleetHarnessAcquisition', () => {
    const handles = [];

    test.afterEach(() => {
        for (const handle of handles.splice(0)) handle?.stop()
    });

    test('runs every opted-in family that has a source, and says why each other family did not run', async () => {
        const calls = [], handle = wire({
            context  : contextFor(['claude-desktop', 'codex-desktop']),
            acquirers: {
                'antigravity'  : acquirer('antigravity', calls, () => ({status: 'up-to-date'})),
                'codex-desktop': acquirer('codex-desktop', calls, () => ({status: 'admitted', version: '26.1110.1'}))
            }
        });

        handles.push(handle);
        await handle.pulse();

        expect(calls).toEqual([['codex-desktop', {root: ROOT, installedBundle: '/Applications/codex-desktop.app'}]]);
        expect(handle.status()).toEqual([
            {family: 'antigravity', state: 'not-opted-in'},
            {family: 'claude-desktop', state: 'no-source'},
            {family: 'codex-desktop', state: 'checked', lastCheckAt: NOW.toISOString(), outcome: 'admitted',
                candidateVersion: '26.1110.1', selectedVersion: '1.0', reason: null}
        ])
    });

    test('a run that throws is recorded for its family, and the other families still run', async () => {
        const calls = [], handle = wire({
            context  : contextFor(['antigravity', 'codex-desktop']),
            acquirers: {
                'antigravity'  : acquirer('antigravity', calls, () => ({status: 'up-to-date', version: '2.31.0'})),
                'codex-desktop': acquirer('codex-desktop', calls, () => { throw Object.assign(new Error('HTTP 503'), {code: 'archive-download-failed'}) })
            }
        });

        handles.push(handle);
        await handle.pulse();

        expect(calls.map(([family]) => family)).toEqual(['antigravity', 'codex-desktop']);
        expect(handle.status()[0]).toMatchObject({family: 'antigravity', state: 'checked', outcome: 'up-to-date'});
        expect(handle.status()[2]).toEqual({family: 'codex-desktop', state: 'failed', lastCheckAt: NOW.toISOString(),
            outcome: null, reason: 'archive-download-failed'})
    });

    test('an unreadable selection leaves the check in place and only the selected version unknown', async () => {
        const handle = wire({
            context  : contextFor(['codex-desktop']),
            acquirers: {'codex-desktop': acquirer('codex-desktop', [], () => ({status: 'up-to-date', version: '26.1103.60933'}))},
            select   : () => { throw new Error('ledger-invalid') }
        });

        handles.push(handle);
        await handle.pulse();

        expect(handle.status()[2]).toMatchObject({state: 'checked', outcome: 'up-to-date', selectedVersion: null})
    });

    test('two runs never overlap for one family', async () => {
        let release;
        const
            calls  = [],
            gate   = new Promise(resolve => { release = resolve }),
            handle = wire({
                context  : contextFor(['codex-desktop']),
                acquirers: {'codex-desktop': acquirer('codex-desktop', calls, () => gate.then(() => ({status: 'up-to-date'})))}
            });

        handles.push(handle);

        const first = handle.pulse(), second = handle.pulse();

        await sleep(10);
        expect(calls, 'the second pulse joins the run in flight').toHaveLength(1);

        release();
        await Promise.all([first, second]);
        await handle.pulse();

        expect(calls, 'a later pulse starts a new run').toHaveLength(2)
    });

    test('runs once after the boot delay, then on every interval, and stop ends both', async () => {
        const calls = [], handle = wire({
            context    : contextFor(['codex-desktop']),
            acquirers  : {'codex-desktop': acquirer('codex-desktop', calls, () => ({status: 'up-to-date'}))},
            bootDelayMs: 10,
            intervalMs : 60
        });

        handles.push(handle);

        await sleep(40);
        expect(calls, 'the boot run, before the first interval').toHaveLength(1);

        await sleep(160);
        expect(calls.length, 'interval runs follow').toBeGreaterThanOrEqual(3);

        handle.stop();
        const stoppedAt = calls.length;

        await sleep(150);
        expect(calls, 'nothing runs after stop').toHaveLength(stoppedAt)
    });

    test('an interval longer than a Node timer holds waits the longest delay Node keeps, never 1 ms', async () => {
        const calls = [], handle = wire({
            context    : contextFor(['codex-desktop']),
            acquirers  : {'codex-desktop': acquirer('codex-desktop', calls, () => ({status: 'up-to-date'}))},
            bootDelayMs: 10,
            intervalMs : 720 * 3_600_000 // 30 days, past the 2^31 - 1 ms a timer holds
        });

        handles.push(handle);

        await sleep(120);
        expect(calls, 'the boot run only').toHaveLength(1)
    });

    test('wires nothing without a context, a positive finite interval or a finite boot delay', () => {
        const context = contextFor([]);

        expect(wireFleetHarnessAcquisition({intervalMs: 1000})).toBe(null);
        expect(wireFleetHarnessAcquisition({context, intervalMs: 0})).toBe(null);
        expect(wireFleetHarnessAcquisition({context, intervalMs: Infinity})).toBe(null);
        expect(wireFleetHarnessAcquisition({context, intervalMs: NaN})).toBe(null);
        expect(wireFleetHarnessAcquisition({context, intervalMs: 1000, bootDelayMs: Infinity})).toBe(null)
    });

    test('every GUI family has an acquisition, and each names its candidate\'s version', () => {
        expect(Object.keys(HARNESS_ACQUIRERS)).toEqual(['antigravity', 'claude-desktop', 'codex-desktop']);
        expect(HARNESS_ACQUIRERS['codex-desktop'].version({candidate: {shortVersion: '26.1103.60933'}})).toBe('26.1103.60933');
        expect(HARNESS_ACQUIRERS.antigravity.version({check: {candidate: {version: '2.31.0'}}})).toBe('2.31.0');
        expect(HARNESS_ACQUIRERS['claude-desktop'].version({check: {candidate: {version: '5.11492.0'}}})).toBe('5.11492.0')
    });

    test('a family its host leaves to the vendor\'s updater is skipped with the host\'s reason, and never fetched', async () => {
        const calls = [], handle = wire({
            context  : family => ({optedIn: false, reason: family === 'claude-desktop' ? 'Claude\'s updater policy is not in force' : null, root: ROOT, installedBundle: null}),
            acquirers: {'claude-desktop': acquirer('claude-desktop', calls, () => ({status: 'admitted'}))}
        });

        handles.push(handle);
        await handle.pulse();

        expect(calls).toEqual([]);
        expect(handle.status()).toEqual([
            {family: 'antigravity', state: 'not-opted-in'},
            {family: 'claude-desktop', state: 'not-opted-in', reason: 'Claude\'s updater policy is not in force'},
            {family: 'codex-desktop', state: 'not-opted-in'}
        ])
    });

    test('each opted-in family retires after its acquisition, a failed one included; a retirement that keeps everything or throws is recorded beside the check', async () => {
        const order = [], handle = wire({
            context  : contextFor(['antigravity', 'claude-desktop', 'codex-desktop']),
            acquirers: {
                'antigravity'   : acquirer('antigravity', order, () => ({status: 'admitted', version: '2.31.2'})),
                'claude-desktop': acquirer('claude-desktop', order, () => { throw Object.assign(new Error('HTTP 503'), {code: 'record-fetch-failed'}) }),
                'codex-desktop' : acquirer('codex-desktop', order, () => ({status: 'up-to-date', version: '26.1106.51428'}))
            },
            retire   : async family => {
                order.push([`retire:${family}`]);
                if (family === 'codex-desktop') throw new Error('ledger-invalid');
                return family === 'antigravity'
                    ? {retired: ['g'.repeat(64)], kept: []}
                    : {retired: [], kept: [], reason: 'the lease of seat \'seat\' could not be read'}
            }
        });

        handles.push(handle);
        await handle.pulse();

        for (const family of ['antigravity', 'claude-desktop', 'codex-desktop']) {
            const acquired = order.findIndex(([step]) => step === family), retired = order.findIndex(([step]) => step === `retire:${family}`);

            expect(acquired, family).toBeGreaterThanOrEqual(0);
            expect(retired, `${family} retires after its own acquisition`).toBeGreaterThan(acquired)
        }

        const [antigravity, claude, codex] = handle.status();

        expect(antigravity).toMatchObject({state: 'checked', outcome: 'admitted', retired: ['g'.repeat(64)]});
        expect(antigravity.retireReason).toBeUndefined();
        expect(claude).toMatchObject({state: 'failed', reason: 'record-fetch-failed', retired: [], retireReason: 'the lease of seat \'seat\' could not be read'});
        expect(codex).toMatchObject({state: 'checked', outcome: 'up-to-date', retired: [], retireReason: 'ledger-invalid'})
    })
});
