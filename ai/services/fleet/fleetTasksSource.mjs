/**
 * @module ai/services/fleet/fleetTasksSource
 * @summary Brain-side, viewer-bound source for the Fleet cockpit's Tasks pane — WHAT the
 * deployment is doing, as three sections of provenance-labeled rows: running, queued / next, and
 * recently completed. It reads the existing truth verbs only (the orchestrator's deployment-state
 * snapshot, the Memory Core REM pipeline state, and — where the process can reach it — the
 * Knowledge Base's own ingestion progress), reduces each to bounded rows SERVER-SIDE, and answers
 * one envelope whose `sources` block names every axis as itself. No scheduler is simulated, no
 * progress is invented: a source that did not answer renders as its own typed state, and a row's
 * `progress` exists only where the wire reported a fraction or a backlog.
 *
 * The snapshot verb returns ~100 KB per read; only its task-shaped facts leave this module
 * (tenant repo sync, the backup lane, recovery runs, self-heal freezes, and the heavy-maintenance
 * starvation receipt — every waiter starved behind the maintenance lease, with the lease itself as
 * the queue's summary). Tenant and repository NAMES never leave either — rows are labeled by the
 * snapshot's identity hashes, so the cockpit's own wire stays free of tenant identifiers by
 * construction; nor do paths, bundle names, durability prose or residue figures.
 */

import {redactReadFailure} from './redactReadFailure.mjs';

const
    CANONICAL_IDENTITY = /^@[A-Za-z0-9][A-Za-z0-9._-]*$/,
    /** @summary Rows per section; a section beyond it is a search problem, not a glance. */
    MAX_ROWS           = 12,
    /**
     * @summary The deployment reader's envelope statuses under which a retained snapshot is still a
     * measurement: `available` (ok) is wired; `stale` and `degraded` are `ok:false` envelopes that
     * KEEP the snapshot (the reader's own contract), so their rows render under their own word.
     */
    SNAPSHOT_STATES    = Object.freeze({available: 'wired', stale: 'stale', degraded: 'degraded'}),
    /** @summary Axis states that count as "the source answered" in the envelope fold. */
    ANSWERED_STATES    = new Set(['wired', 'stale', 'degraded']);

/**
 * @summary Coerce one supported time value to finite epoch milliseconds, or `null`.
 * @param {Date|String|Number|null|undefined} value
 * @returns {Number|null}
 * @private
 */
function toMsOrNull(value) {
    if (value === null || value === undefined || value === '') return null;

    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);

    return Number.isFinite(ms) ? ms : null
}

/**
 * @summary Render one epoch/ISO value as an ISO instant, or `null` when it is not a time.
 * @param {*} value
 * @returns {String|null}
 * @private
 */
function toIso(value) {
    const ms = toMsOrNull(value);

    return ms === null ? null : new Date(ms).toISOString()
}

/**
 * @summary A finite, non-negative integer or `null` — counts that are not counts do not render.
 * @param {*} value
 * @returns {Number|null}
 * @private
 */
function toCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * @summary A non-empty string as the wire sent it, or `null` — a word is never invented.
 * @param {*} value
 * @returns {String|null}
 * @private
 */
function toWord(value) {
    return typeof value === 'string' && value ? value : null
}

/**
 * @summary Build one row. Every row carries the same grammar so the pane renders one shape;
 * additive facts (a starved row's wait and cause fields) ride AFTER the eight grammar keys.
 * @param {Object} row
 * @param {String} row.id Stable, source-scoped identity (the Store key).
 * @param {'running'|'queued'|'recent'} row.section
 * @param {String} row.name One-line task name; never a tenant or repository name.
 * @param {'orchestrator'|'mc'|'kb'} row.source Provenance axis.
 * @param {String} row.state The state WORD the pane renders ("in progress" is first-class).
 * @param {String|null} [row.at] The row's governing instant, ISO.
 * @param {Object|null} [row.progress] `{kind:'determinate'|'backlog', done, total}` or null.
 * @param {String|null} [row.detail] One short qualifier line.
 * @returns {Object}
 * @private
 */
function makeRow({id, section, name, source, state, at = null, progress = null, detail = null, ...facts}) {
    return {id, section, name, source, state, at, progress, detail, ...facts}
}

/**
 * @summary A determinate-or-backlog progress fact — only when both numbers are real counts and
 * the total is non-zero; anything else is `null`, which the pane renders as the state word alone.
 * @param {'determinate'|'backlog'} kind
 * @param {*} done
 * @param {*} total
 * @returns {Object|null}
 * @private
 */
function makeProgress(kind, done, total) {
    const d = toCount(done),
          t = toCount(total);

    return d === null || t === null || t === 0 ? null : {kind, done: Math.min(d, t), total: t}
}

/**
 * @summary Reduce the deployment-state snapshot payload (the `get_deployment_state_snapshot`
 * result) to task rows. Pure: no clock reads, no I/O. Exported for the witness.
 *
 * Sources inside the snapshot, in the order the operator asks about them:
 * - `tenantRepoSync.task` — the pull-mode ingestion sweep: running now (running row) or its last
 *   completion (recent row);
 * - `tenantRepoSync.repos[]` — one queued row per repository carrying a `nextDueAt`, labeled by
 *   identity hash, with a backlog gauge where `corpusOutstanding` reports outstanding work;
 * - `maintenance` — the backup lane as ONE row under the writer's phase word: queued at its next
 *   attempt, else recent at its last bundle; the health verdict's reason codes are its words;
 * - `recoveryRuns.entries[]` — actuator runs: in flight → running, otherwise recent;
 * - `selfHeal.summary.currentlyFrozen[]` — a frozen collection is a task the deployment is
 *   holding open, so it renders as running under the word "frozen";
 * - `heavyMaintenanceStarvation.breaches[]` — one queued row per waiter starved past the
 *   watchdog's bound, its wait and its own cause riding the row as additive facts; the block's
 *   check-time facts (lease holder, posture, the bound, the unreadable count) are the `scheduler`
 *   summary beside the rows, never repeated per row. Absent or `disabled` → no rows, no summary.
 *
 * The reader (`ai/services/memory-core/helpers/deploymentStateBridgeStore.mjs`) answers four
 * envelopes: `{ok:true, status:'available', snapshot}`; `{ok:false, status:'stale', snapshot,
 * reason:'snapshot-stale'}` and `{ok:false, status:'degraded', snapshot, reason}` — both RETAIN the
 * snapshot, so their rows are still measurements and render under their own word; and
 * `{ok:false, status:'unavailable', snapshot:null, reason}` (missing / too large / unreadable).
 * An `ok:false` envelope carrying a snapshot under any other status fails closed as unavailable.
 *
 * @param {Object|null} payload The verb's parsed result.
 * @returns {{rows: Object[], state: String, reason: String|null, observedAt: String|null, scheduler: Object|null}}
 */
export function extractDeploymentRows(payload) {
    const
        snapshot = payload && typeof payload === 'object' && payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : null,
        state    = snapshot
            ? (payload.ok === true ? 'wired' : SNAPSHOT_STATES[payload.status] ?? null)
            : null;

    if (state === null || state === 'wired' && payload.ok !== true) {
        return {
            rows      : [],
            state     : 'unavailable',
            reason    : typeof payload?.reason === 'string' ? payload.reason : 'deployment-snapshot-unavailable',
            observedAt: null,
            scheduler : null
        }
    }

    const
        observedAt  = toIso(snapshot.generatedAt),
        sync        = snapshot.tenantRepoSync && typeof snapshot.tenantRepoSync === 'object' ? snapshot.tenantRepoSync : null,
        task        = sync?.task && typeof sync.task === 'object' ? sync.task : null,
        repos       = Array.isArray(sync?.repos) ? sync.repos : [],
        maintenance = snapshot.maintenance && typeof snapshot.maintenance === 'object' ? snapshot.maintenance : null,
        retry       = maintenance?.retry && typeof maintenance.retry === 'object' ? maintenance.retry : null,
        health      = maintenance?.health && typeof maintenance.health === 'object' ? maintenance.health : null,
        lastBackup  = maintenance?.lastBackup && typeof maintenance.lastBackup === 'object' ? maintenance.lastBackup : null,
        starvation  = snapshot.heavyMaintenanceStarvation && typeof snapshot.heavyMaintenanceStarvation === 'object' ? snapshot.heavyMaintenanceStarvation : null,
        recoveries  = Array.isArray(snapshot.recoveryRuns?.entries) ? snapshot.recoveryRuns.entries : [],
        frozen      = Array.isArray(snapshot.selfHeal?.summary?.currentlyFrozen) ? snapshot.selfHeal.summary.currentlyFrozen : [],
        rows        = [];

    if (task) {
        if (task.running === true) {
            rows.push(makeRow({
                id     : 'orchestrator:tenant-sync:run',
                section: 'running',
                name   : 'Tenant repo sync',
                source : 'orchestrator',
                state  : 'in progress',
                at     : toIso(task.lastRunAt),
                detail : typeof task.lastReason === 'string' ? task.lastReason : null
            }))
        } else if (task.lastCompletion && typeof task.lastCompletion === 'object') {
            const
                done   = task.lastCompletion,
                status = typeof done.status === 'string' && done.status ? done.status : 'completed',
                counts = [
                    toCount(done.completedCount) !== null ? `${done.completedCount} synced` : null,
                    toCount(done.notDueCount)    !== null ? `${done.notDueCount} not due`   : null,
                    toCount(done.failedCount)    !== null ? `${done.failedCount} failed`    : null
                ].filter(Boolean),
                // The completion's instant is the CURRENT attempt's: a completed run is stamped by
                // its success time, a failed run by its error time, a skipped sweep by the attempt
                // itself. The producer preserves `lastSuccessAt` across later failures, so it can
                // only stamp the run it belongs to.
                at     = status === 'completed'
                    ? toIso(task.lastSuccessAt ?? task.lastRunAt)
                    : status === 'failed'
                        ? toIso(task.lastErrorAt ?? task.lastRunAt)
                        : toIso(task.lastRunAt);

            rows.push(makeRow({
                id     : 'orchestrator:tenant-sync:last',
                section: 'recent',
                name   : 'Tenant repo sync',
                source : 'orchestrator',
                state  : status,
                at,
                detail : counts.length > 0 ? counts.join(' · ') : (typeof done.reason === 'string' ? done.reason : null)
            }))
        }
    }

    for (const repo of repos) {
        if (!repo || typeof repo !== 'object' || typeof repo.identityHash !== 'string' || repo.disabled === true) continue;

        const
            at          = toIso(repo.nextDueAt),
            outstanding = repo.corpusOutstanding && typeof repo.corpusOutstanding === 'object' ? repo.corpusOutstanding : null,
            settled     = toCount(outstanding?.settled),
            remaining   = toCount(outstanding?.remaining),
            failures    = toCount(repo.consecutiveFailures),
            detailBits  = [
                typeof repo.lastIngestedRev === 'string' && repo.lastIngestedRev ? `rev ${repo.lastIngestedRev.slice(0, 7)}` : null,
                failures > 0 ? `${failures} consecutive failures` : null
            ].filter(Boolean);

        if (!at) continue;

        rows.push(makeRow({
            id      : `orchestrator:tenant-sync:${repo.identityHash}`,
            section : 'queued',
            name    : `Repo sync · ${repo.identityHash.slice(0, 8)}`,
            source  : 'orchestrator',
            state   : repo.due === true ? 'due' : 'scheduled',
            at,
            progress: remaining > 0 && settled !== null ? makeProgress('backlog', settled, settled + remaining) : null,
            detail  : detailBits.length > 0 ? detailBits.join(' · ') : null
        }))
    }

    // the backup lane is ONE row whenever the plane observed it (a retry state, a health verdict
    // or a receipt): the writer's phase word, its instant the next attempt (queued) or, with
    // nothing scheduled, the last bundle (recent). A lane carrying neither instant — never
    // anchored, or a receipt the observer could not reach — stays visible under the queue with a
    // null instant: its state and its reason codes are the facts, no attempt or completion is
    // invented. The health verdict's reason codes are its words — never the durability prose,
    // the bundle name or the staging residue
    if (retry || health || lastBackup) {
        const
            nextAttempt      = toIso(retry?.nextAttemptAtMs),
            finishedAt       = toIso(lastBackup?.finishedAt),
            receipt          = toWord(lastBackup?.status) ?? toWord(lastBackup?.backup?.status),
            remainingRetries = toCount(retry?.retriesRemaining),
            codes            = Array.isArray(health?.reasonCodes) ? health.reasonCodes.filter(code => typeof code === 'string' && code) : [],
            detailBits       = [
                codes.length > 0 ? codes.map(code => code.replaceAll('-', ' ')).join(' · ') : null,
                remainingRetries !== null ? `${remainingRetries} retries remaining` : null
            ].filter(Boolean);

        rows.push(makeRow({
            id     : 'orchestrator:maintenance:backup',
            section: !nextAttempt && finishedAt ? 'recent' : 'queued',
            name   : 'Backup lane',
            source : 'orchestrator',
            state  : toWord(retry?.phase) ?? toWord(health?.status) ?? receipt ?? 'observed',
            at     : nextAttempt ?? finishedAt ?? null,
            detail : detailBits.length > 0 ? detailBits.join(' · ') : null
        }))
    }

    for (const entry of recoveries) {
        if (!entry || typeof entry !== 'object' || typeof entry.recoveryRunId !== 'string') continue;

        const
            target   = entry.targetIdentity && typeof entry.targetIdentity === 'object' ? entry.targetIdentity : null,
            label    = target && typeof target.id === 'string' ? `${typeof target.kind === 'string' ? target.kind + ' ' : ''}${target.id}` : 'unnamed target',
            finished = toIso(entry.completedAt),
            reason   = typeof entry.details?.reasonCode === 'string' ? entry.details.reasonCode : null;

        rows.push(makeRow({
            id     : `orchestrator:recovery:${entry.recoveryRunId}`,
            section: finished ? 'recent' : 'running',
            name   : `Recovery · ${label}`,
            source : 'orchestrator',
            state  : typeof entry.status === 'string' && entry.status ? entry.status : (finished ? 'completed' : 'in progress'),
            at     : finished ?? toIso(entry.updatedAt ?? entry.startedAt),
            detail : reason
        }))
    }

    for (const collection of frozen) {
        if (typeof collection !== 'string' || !collection) continue;

        rows.push(makeRow({
            id     : `orchestrator:self-heal:frozen:${collection}`,
            section: 'running',
            name   : `Self-heal freeze · ${collection}`,
            source : 'orchestrator',
            state  : 'frozen'
        }))
    }

    // the heavy-maintenance starvation receipt: one queued row per breach, the wait and the row's
    // own cause riding the row as additive facts, the lease as the section's summary — the
    // watchdog's verdict verbatim, its two clocks kept apart (`deferredSince` is the row's instant,
    // `checkedAt` the summary's). A cause is worded only from the row's own reason code; the
    // check-time lease holder cannot say why one waiter waits, so it never becomes a row's cause.
    let scheduler = null;

    if (starvation && starvation.posture !== 'disabled') {
        const
            breaches       = (Array.isArray(starvation.breaches) ? starvation.breaches : [])
                .filter(breach => breach && typeof breach === 'object' && typeof breach.taskName === 'string' && breach.taskName),
            checkedAt      = toIso(starvation.checkedAt),
            degradeAfterMs = toCount(starvation.degradeAfterMs);

        for (const breach of breaches) {
            const
                reasonCode       = toWord(breach.reasonCode),
                blockingTaskName = toWord(breach.blockingTaskName),
                leaseOwner       = toWord(breach.leaseOwner),
                cause            = reasonCode === null
                    ? null
                    : [reasonCode, leaseOwner ? `lease owner ${leaseOwner}` : null, blockingTaskName ? `behind ${blockingTaskName}` : null].filter(Boolean).join(' · '),
                detailBits       = [
                    cause,
                    breach.priorityZero === true ? 'priority zero' : null,
                    breach.bootstrapCritical === true ? 'bootstrap critical' : null
                ].filter(Boolean);

            rows.push(makeRow({
                id      : `orchestrator:starvation:${breach.taskName}`,
                section : 'queued',
                name    : breach.taskName,
                source  : 'orchestrator',
                state   : 'starved',
                at      : toIso(breach.deferredSince),
                progress: null,
                detail  : detailBits.length > 0 ? detailBits.join(' · ') : null,
                // additive facts: the wait is text in the pane, never a clamped progress track
                waitMs           : toCount(breach.starvedForMs),
                thresholdMs      : degradeAfterMs,
                checkedAt,
                reasonCode,
                blockingTaskName,
                leaseOwner,
                priorityZero     : breach.priorityZero === true,
                bootstrapCritical: breach.bootstrapCritical === true
            }))
        }

        scheduler = {
            leaseHolder    : toWord(starvation.leaseHolder),
            leaseStatus    : toWord(starvation.leaseStatus),
            checkedAt,
            degradeAfterMs,
            posture        : toWord(starvation.posture),
            starvedTotal   : breaches.length,
            unreadableCount: toCount(starvation.unreadableCount)
        }
    }

    return {rows, state, reason: null, observedAt, scheduler}
}

/**
 * @summary Reduce the REM pipeline state (`get_rem_pipeline_state`) to its one row: the digest
 * backlog, a QUEUE fact labeled "backlog" — a queue is not a task, and the producer
 * (`HealthService.buildRemPipelineState`) exposes no running fact at all: `recentCycles[]` are
 * completed-cycle summaries (`runId`, `wallClockMs` — a duration — overflow facts, `outcome`)
 * carrying no instant and no active flag, so this row never claims "in progress" and never
 * carries a time. The producer's `axisErrors` map is honored: a count whose read failed falls
 * back to 0 upstream, and a fallback zero must never become a wired measurement here. Pure;
 * exported for the witness.
 * @param {Object|null} state The verb's parsed result (`undigested`, `digested`, `recentCycles`,
 *     optional `axisErrors`).
 * @returns {{rows: Object[], state: String, reason: String|null}} plus a `detail` member only when
 *     a failed axis left a legible, redacted message.
 */
export function extractRemRows(state) {
    const
        undigested = toCount(state?.undigested),
        digested   = toCount(state?.digested),
        axisErrors = state?.axisErrors && typeof state.axisErrors === 'object' ? state.axisErrors : null,
        failedAxis = axisErrors ? ['undigested', 'digested'].find(axis => axisErrors[axis]) : null;

    if (failedAxis) {
        const detail = redactReadFailure(axisErrors[failedAxis]);

        return {rows: [], state: 'unavailable', reason: 'rem-axis-error', ...(detail ? {detail: `${failedAxis}: ${detail}`} : {})}
    }

    if (undigested === null || digested === null) {
        return {rows: [], state: 'unavailable', reason: 'rem-payload-unrecognized'}
    }

    const
        cycles  = Array.isArray(state.recentCycles) ? state.recentCycles : [],
        outcome = typeof cycles[0]?.outcome === 'string' && cycles[0].outcome ? cycles[0].outcome : null,
        bits    = [`${undigested} undigested · ${digested} digested`, outcome ? `last cycle ${outcome}` : null].filter(Boolean);

    return {
        rows: [makeRow({
            id      : 'mc:rem:digest',
            section : 'queued',
            name    : 'REM digest',
            source  : 'mc',
            state   : 'backlog',
            progress: makeProgress('backlog', digested, digested + undigested),
            detail  : bits.join(' · ')
        })],
        state : 'wired',
        reason: null
    }
}

/**
 * @summary Reduce the Knowledge Base's own ingestion progress (`get_ingestion_progress`) to rows:
 * an active run is a RUNNING row with a determinate fraction where chunks are counted (the
 * `stalled` flag earns the wedged word — text, never hue); an idle process contributes its last
 * run as a RECENT row. The verb is explicitly this-process-only, and the row's detail carries
 * that scope — the caveat is part of the truth. Tenant and repository identifiers in the payload
 * are deliberately NOT rendered. Pure; exported for the witness.
 * @param {Object|null} progress The verb's parsed result.
 * @returns {{rows: Object[], state: String, reason: String|null, scope: String|null}}
 */
export function extractIngestionRows(progress) {
    if (!progress || typeof progress !== 'object' || typeof progress.status !== 'string') {
        return {rows: [], state: 'unavailable', reason: 'ingestion-payload-unrecognized', scope: null}
    }

    const
        scope = typeof progress.observedScope === 'string' ? progress.observedScope : null,
        rows  = [];

    if (progress.active === true) {
        rows.push(makeRow({
            id      : 'kb:ingestion:run',
            section : 'running',
            name    : 'KB ingestion',
            source  : 'kb',
            state   : progress.stalled === true ? 'stalled' : (typeof progress.phase === 'string' && progress.phase ? progress.phase : 'in progress'),
            at      : toIso(progress.startedAt),
            progress: makeProgress('determinate', progress.embeddedChunks, progress.totalChunks),
            detail  : scope
        }))
    } else if (progress.lastRunSummary && typeof progress.lastRunSummary === 'object') {
        const
            last   = progress.lastRunSummary,
            chunks = toCount(last.embeddedChunks),
            errors = toCount(last.errorCount),
            bits   = [
                chunks !== null ? `${chunks} chunks` : null,
                errors !== null && errors > 0 ? `${errors} errors` : null,
                scope
            ].filter(Boolean);

        rows.push(makeRow({
            id     : 'kb:ingestion:last',
            section: 'recent',
            name   : 'KB ingestion',
            source : 'kb',
            state  : typeof last.status === 'string' && last.status ? last.status : 'completed',
            at     : toIso(last.completedAt ?? progress.completedAt),
            detail : bits.length > 0 ? bits.join(' · ') : null
        }))
    }

    return {rows, state: 'wired', reason: null, scope}
}

/**
 * @summary Order one section and cap it: running and recent newest-first, queued soonest-first;
 * rows without an instant sink to the end of their section, equal instants order by name. The
 * queue leads with operationally blocked work BEFORE any chronology: a starved row ranks first,
 * longest wait first (`waitMs`, then name), so the cap can never cut a waiter in favor of older
 * ordinary rows — display order, never the scheduler's own.
 * @param {Object[]} rows
 * @param {'running'|'queued'|'recent'} section
 * @returns {Object[]}
 * @private
 */
function orderSection(rows, section) {
    const direction = section === 'queued' ? 1 : -1;

    return rows
        .filter(row => row.section === section)
        .sort((a, b) => {
            const aBlocked = a.state === 'starved',
                  bBlocked = b.state === 'starved';

            if (aBlocked !== bBlocked) return aBlocked ? -1 : 1;
            if (aBlocked) return ((b.waitMs ?? -1) - (a.waitMs ?? -1)) || a.name.localeCompare(b.name);

            const am = toMsOrNull(a.at),
                  bm = toMsOrNull(b.at);

            if (am === null && bm === null) return a.name.localeCompare(b.name);
            if (am === null) return 1;
            if (bm === null) return -1;

            return (am - bm) * direction || a.name.localeCompare(b.name)
        })
        .slice(0, MAX_ROWS)
}

/**
 * @summary Create the process-lifetime Fleet tasks source.
 *
 * The transport-stamped viewer is resolved at EACH call (the trust-boundary discipline every
 * fleet source shares); the operations receive no viewer claim. `getIngestionProgress` is
 * OPTIONAL: the Knowledge Base's own ingestion verb is reachable only where this process holds a
 * Knowledge Base client (in-process mode), and an absent operation answers as the typed
 * `unwired` source state rather than a failure — the snapshot carries the deployment's real
 * ingestion lane in both modes.
 *
 * @param {Object} options
 * @param {Function} options.getDeploymentStateSnapshot Injected `get_deployment_state_snapshot`
 *     operation returning the parsed payload.
 * @param {Function} options.getRemPipelineState Injected `get_rem_pipeline_state` operation.
 * @param {Function} [options.getIngestionProgress] Injected `get_ingestion_progress` operation.
 * @param {Function} options.resolveViewerIdentity Returns the transport-stamped canonical @identity.
 * @param {Function} [options.now] Clock returning a Date/epoch/ISO value.
 * @returns {{readTasks: Function}}
 */
export function createFleetTasksSource({
    getDeploymentStateSnapshot,
    getRemPipelineState,
    getIngestionProgress = null,
    resolveViewerIdentity,
    now = () => new Date()
} = {}) {
    if (typeof getDeploymentStateSnapshot !== 'function' || typeof getRemPipelineState !== 'function' ||
        typeof resolveViewerIdentity !== 'function' || typeof now !== 'function') {
        throw new TypeError('createFleetTasksSource: getDeploymentStateSnapshot, getRemPipelineState, resolveViewerIdentity, and now are required')
    }

    if (getIngestionProgress !== null && typeof getIngestionProgress !== 'function') {
        throw new TypeError('createFleetTasksSource: getIngestionProgress must be a function when supplied')
    }

    const resolveViewer = async () => {
        const viewer = await resolveViewerIdentity();

        if (typeof viewer !== 'string' || !CANONICAL_IDENTITY.test(viewer)) {
            throw new Error('fleet tasks: authenticated ingress did not bind a canonical viewer identity')
        }

        return viewer
    };

    /**
     * @summary Run one operation and reduce its result; a throw becomes the typed `unavailable`
     * state carrying a sanitized detail, never a fabricated empty section.
     * @param {String} label
     * @param {Function} operation
     * @param {Function} reduce
     * @returns {Promise<Object>}
     */
    const readAxis = async (label, operation, reduce) => {
        try {
            return reduce(await operation({}))
        } catch (error) {
            const detail = redactReadFailure(error);

            console.warn(`[fleet] tasks ${label} read failed: ${detail ?? 'no legible error'}`);

            return {rows: [], state: 'unavailable', reason: `${label}-read-failed`, ...(detail ? {detail} : {})}
        }
    };

    return {
        /**
         * @summary Read the deployment's task picture: every wired axis is read, each reduces to
         * its rows and its own typed state, and the envelope's `capability` is the honest fold —
         * `wired` when every wired axis answered (`wired`, `stale` or `degraded` — the snapshot
         * reader's retained-snapshot statuses still measure), `partial` when some did,
         * `unavailable` when none. Sections are ordered and capped here so the wire carries a
         * glance, not a dump — `counts.queuedKnown` is the queue before the cap, every producer
         * counted, so the pane can say known · shown; `scheduler` is the deployment axis's
         * heavy-maintenance summary, present only when the snapshot carried the receipt.
         * @param {Object} [params] Reserved; the verb takes no caller input today.
         * @returns {Promise<Object>}
         */
        async readTasks(params = {}) {
            const
                viewer     = await resolveViewer(),
                nowMs      = toMsOrNull(now()),
                capturedAt = new Date(nowMs ?? Date.now()).toISOString();

            if (nowMs === null) {
                throw new TypeError('fleet tasks: now must be a finite timestamp')
            }

            const [deployment, rem, ingestion] = await Promise.all([
                readAxis('deployment', getDeploymentStateSnapshot, extractDeploymentRows),
                readAxis('rem',        getRemPipelineState,        extractRemRows),
                getIngestionProgress
                    ? readAxis('ingestion', getIngestionProgress, extractIngestionRows)
                    : {rows: [], state: 'unwired', reason: 'ingestion-verb-unreachable-from-this-process', scope: null}
            ]);

            const
                axes     = [deployment, rem, ingestion],
                answered = axes.filter(axis => ANSWERED_STATES.has(axis.state)).length,
                wiredAxes= axes.filter(axis => axis.state !== 'unwired').length,
                state    = answered === 0 ? 'unavailable' : answered === wiredAxes ? 'wired' : 'partial',
                rows        = [...deployment.rows, ...rem.rows, ...ingestion.rows],
                running     = orderSection(rows, 'running'),
                queued      = orderSection(rows, 'queued'),
                recent      = orderSection(rows, 'recent'),
                queuedKnown = rows.filter(row => row.section === 'queued').length;

            return {
                capability: {
                    state,
                    capturedAt,
                    ...(state === 'unavailable' ? {reason: 'no-task-source-answered'} : {})
                },
                viewer,
                sources: {
                    deployment: {state: deployment.state, reason: deployment.reason ?? null, ...(deployment.detail ? {detail: deployment.detail} : {}), observedAt: deployment.observedAt ?? null},
                    rem       : {state: rem.state,        reason: rem.reason        ?? null, ...(rem.detail        ? {detail: rem.detail}        : {})},
                    ingestion : {state: ingestion.state,  reason: ingestion.reason  ?? null, ...(ingestion.detail  ? {detail: ingestion.detail}  : {}), scope: ingestion.scope ?? null}
                },
                ...(deployment.scheduler ? {scheduler: deployment.scheduler} : {}),
                running,
                queued,
                recent,
                counts: {running: running.length, queued: queued.length, recent: recent.length, queuedKnown}
            }
        }
    }
}

export default createFleetTasksSource;
