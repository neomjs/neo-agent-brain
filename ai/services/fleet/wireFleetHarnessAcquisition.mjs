import {acquireAntigravityUpdate}  from './antigravityUpdate.mjs';
import {acquireCodexDesktopUpdate} from './codexDesktopUpdate.mjs';
import {
    HARNESS_GENERATION_FAMILIES,
    selectHarnessGeneration
} from './harnessGeneration.mjs';

/**
 * @module ai/services/fleet/wireFleetHarnessAcquisition
 * @summary The Fleet's own harness updates. The operator runs the vendor apps only as Fleet seats and every
 * seat's own updater is off, so nothing else ever brings a new build. For each GUI family whose seats start
 * from admitted generations, this job runs the family's acquisition (fetch from the vendor feed, verify,
 * admit) shortly after the Fleet server starts and then on an interval. A seat moves to the new build at its
 * next Start; the job never touches a running seat and never delays a Start.
 */

/** Each family's acquisition, and the candidate version its result names. A family without one has no source yet. */
export const HARNESS_ACQUIRERS = Object.freeze({
    'antigravity'  : Object.freeze({
        acquire: ({root, installedBundle}) => acquireAntigravityUpdate({root, ...(installedBundle && {appBundle: installedBundle})}),
        version: result => result?.check?.candidate?.version ?? null
    }),
    'codex-desktop': Object.freeze({
        acquire: ({root, installedBundle}) => acquireCodexDesktopUpdate({root, ...(installedBundle && {appBundle: installedBundle})}),
        version: result => result?.candidate?.shortVersion ?? null
    })
});

// Starts that run at boot finish first; a run copies, signs-checks and probes several hundred MB.
const BOOT_DELAY_MS = 2 * 60 * 1000;

// Node runs a timer longer than this after 1 ms instead, which would poll the vendor feeds in a tight loop.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * @summary Wire the acquisition job: one run per family soon after boot, then one every `intervalMs`.
 * Runs for one family never overlap, and a run that throws is recorded for its family without stopping
 * the others. A family that is not opted in, or has no acquisition, is never fetched.
 * @param {Object} options
 * @param {Function} options.context `(family) => {optedIn, root, installedBundle}`, normally
 * `FleetLifecycleService#harnessAcquisitionContext`, so the job and a Start read one opt-in.
 * @param {Number} options.intervalMs Milliseconds between runs.
 * @param {Number} [options.bootDelayMs=BOOT_DELAY_MS] Delay before the first run.
 * @param {Object} [options.acquirers=HARNESS_ACQUIRERS] `{[family]: {acquire, version}}`.
 * @param {Function} [options.select=selectHarnessGeneration] Reads the family's selected generation.
 * @param {Function} [options.now] Clock seam.
 * @param {Object} [options.log=console]
 * @returns {{pulse: Function, status: Function, stop: Function}|null} `null` without a context, a positive finite
 * interval or a finite boot delay. A delay longer than a Node timer holds (about 24.8 days) runs at that length.
 */
export function wireFleetHarnessAcquisition({
    context,
    intervalMs,
    bootDelayMs = BOOT_DELAY_MS,
    acquirers   = HARNESS_ACQUIRERS,
    select      = selectHarnessGeneration,
    now         = () => new Date(),
    log         = console
} = {}) {
    if (typeof context !== 'function' || !(Number.isFinite(intervalMs) && intervalMs > 0) ||
        !(Number.isFinite(bootDelayMs) && bootDelayMs >= 0)) return null;

    const
        families = Object.keys(HARNESS_GENERATION_FAMILIES),
        status   = new Map(families.map(family => [family, {family, state: 'pending'}])),
        running  = new Map();

    let stopped = false;

    const runFamily = family => {
        if (stopped || running.has(family)) return running.get(family) ?? Promise.resolve(status.get(family));

        const run = (async () => {
            const {optedIn, root, installedBundle} = context(family), acquirer = acquirers[family];

            if (!optedIn)  return {family, state: 'not-opted-in'};
            if (!acquirer) return {family, state: 'no-source'};

            const lastCheckAt = now().toISOString();

            let result;

            try {
                result = await acquirer.acquire({root, installedBundle})
            } catch (error) {
                return {family, state: 'failed', lastCheckAt, outcome: null, reason: error?.code ?? error?.message ?? String(error)}
            }

            let selectedVersion = null;

            // an unreadable ledger leaves the selection unknown, never the check
            try { selectedVersion = select({root, family})?.shortVersion ?? null } catch {}

            return {family, state: 'checked', lastCheckAt, outcome: result?.status ?? null,
                candidateVersion: acquirer.version(result), selectedVersion, reason: result?.reason ?? null}
        })().catch(error => ({family, state: 'failed', outcome: null, reason: error?.message ?? String(error)}))
            .then(entry => {
                status.set(family, entry);
                if (entry.state === 'checked' || entry.state === 'failed') {
                    log.log(`[fleet] harness acquisition ${family}: ${entry.state} ${entry.outcome ?? ''} ` +
                        `(candidate ${entry.candidateVersion ?? '-'}, selected ${entry.selectedVersion ?? '-'})${entry.reason ? `: ${entry.reason}` : ''}`)
                }
                return entry
            })
            .finally(() => running.delete(family));

        running.set(family, run);
        return run
    };

    const
        pulse     = () => Promise.all(families.map(runFamily)),
        bootTimer = setTimeout(pulse, Math.min(bootDelayMs, MAX_TIMER_MS)),
        timer     = setInterval(pulse, Math.min(intervalMs, MAX_TIMER_MS));

    bootTimer.unref?.();
    timer.unref?.();

    return {
        pulse,
        /** @summary One entry per family: `pending`, `not-opted-in`, `no-source`, `checked` or `failed`. */
        status: () => families.map(family => ({...status.get(family)})),
        /**
         * @summary Stops further runs. A run in flight is not awaited: it can be a download of several hundred
         * MB, and a shutdown must not wait for it. Its staging is swept by the family's next run.
         */
        stop() {
            stopped = true;
            clearTimeout(bootTimer);
            clearInterval(timer)
        }
    }
}

export default wireFleetHarnessAcquisition;
