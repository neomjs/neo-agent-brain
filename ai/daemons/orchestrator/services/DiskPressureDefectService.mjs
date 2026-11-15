import fs       from 'node:fs';
import path     from 'node:path';
import Base     from 'neo.mjs/src/core/Base.mjs';
import AiConfig from '../../../config.mjs';

/**
 * @module ai/daemons/orchestrator/services/DiskPressureDefectService
 * @summary Episode-scoped defect-note reconciler for unrelieved plane Docker / data-mount disk pressure.
 *
 * Consumes the `engineDisk` observation from a written deployment-state snapshot together with the
 * controller's outcomes for that snapshot. When disk pressure cannot be relieved by build-cache
 * pruning — either because diagnosis routed directly to `record` (warm-floor / dead-band / non-cache
 * pressure) or because `prune-build-cache` ran and returned `alarmOnly` / `prune-freed-nothing` — it
 * emits at most one `defect-note:` per active episode and persists the episode marker atomically under
 * the orchestrator's state directory. Once a fresh, non-degraded `statfs` sample drops below
 * `AiConfig.orchestrator.diskPressure.percent`, it emits a matching `defect-note: [recovered]` carrying
 * the identical observation fingerprint and closes the episode so any later incident re-opens cleanly.
 */

/**
 * @summary State filename persisted inside the orchestrator's runtime data directory.
 * @type {String}
 */
export const DISK_PRESSURE_EPISODE_STATE_FILE = 'disk-pressure-defect-episode.json';

/**
 * @summary Canonical concept tags attached to disk-pressure defect and recovery broadcasts.
 * @type {ReadonlyArray<String>}
 */
export const DISK_PRESSURE_DEFECT_TAGGED_CONCEPTS = Object.freeze([
    'defect-note',
    'disk-pressure',
    'docker-engine'
]);

/**
 * @summary Coerces a numeric metric into a non-negative integer byte count.
 * @param {*} value Candidate numeric metric.
 * @returns {Number}
 */
function toNonNegativeInt(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

/**
 * @summary Formats a disk usage percentage to at most two decimal places.
 * @param {*} value Candidate percentage reading.
 * @returns {String}
 */
function formatDiskPercent(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '0';
    return (Math.round(parsed * 100) / 100).toString();
}

/**
 * @summary Reconciles unrelieved engine disk-pressure episodes into stable-fingerprint mailbox defect notes.
 *
 * Keeps volatile readings (`usedPercent`, `availableBytes`, per-class reclaimable bytes) strictly in the
 * note `body` while anchoring the `subject` to surface + mount + invariant symptom so open, recovery, and
 * subsequent episodes with different byte/percentage readings fold onto one deterministic fingerprint.
 *
 * @class Neo.ai.daemons.orchestrator.services.DiskPressureDefectService
 * @extends Neo.core.Base
 * @see ai/daemons/orchestrator/services/ContainerHealthControllerService.mjs
 * @see ai/services/memory-core/helpers/defectObservationFold.mjs
 */
export class DiskPressureDefectService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.daemons.orchestrator.services.DiskPressureDefectService'
         * @protected
         */
        className: 'Neo.ai.daemons.orchestrator.services.DiskPressureDefectService'
    }

    /**
     * Runtime state directory owning `disk-pressure-defect-episode.json`.
     * @member {String|null} stateDir=null
     */
    stateDir = null
    /**
     * Live authority-lease predicate (`() => Boolean`), checked before publication, before temp-file
     * creation, and immediately before atomic state rename.
     * @member {Function|null} hasObservationWriteAuthority=null
     */
    hasObservationWriteAuthority = null
    /**
     * Mailbox publisher (`(note) => Promise<Object>`) injected by the composition root.
     * @member {Function|null} publishDefectNote=null
     */
    publishDefectNote = null
    /**
     * Clock seam (`() => Number`) for deterministic unit specs; defaults to `Date.now()`.
     * @member {Function|null} nowFn=null
     */
    nowFn = null

    /**
     * @summary Returns the current epoch timestamp in milliseconds.
     * @returns {Number}
     */
    now() {
        return typeof this.nowFn === 'function' ? this.nowFn() : Date.now();
    }

    /**
     * @summary Evaluates whether observation-write authority is currently held.
     * @param {Function|null} [authorityCheck=this.hasObservationWriteAuthority] Live authority oracle.
     * @returns {Boolean}
     */
    isAuthorityHeld(authorityCheck = this.hasObservationWriteAuthority) {
        return typeof authorityCheck === 'function' ? authorityCheck() === true : true;
    }

    /**
     * @summary Resolves the persisted state file path for the active disk-pressure defect episode.
     * @param {String|null} [stateDir=this.stateDir] Owning runtime state directory.
     * @returns {String}
     */
    getEpisodeStatePath(stateDir = this.stateDir) {
        if (typeof stateDir !== 'string' || !stateDir.trim()) {
            throw new TypeError('DiskPressureDefectService: a non-empty stateDir is required');
        }

        return path.join(stateDir, DISK_PRESSURE_EPISODE_STATE_FILE);
    }

    /**
     * @summary Reads the persisted disk-pressure episode state, defaulting to inactive when absent or malformed.
     * @param {Object} [options={}]
     * @param {String|null} [options.stateDir=this.stateDir] Owning runtime state directory.
     * @returns {Object}
     */
    readEpisodeState({stateDir = this.stateDir} = {}) {
        const statePath = this.getEpisodeStatePath(stateDir);

        try {
            const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (parsed && typeof parsed === 'object' && typeof parsed.active === 'boolean') {
                if (parsed.active && (typeof parsed.noteCore !== 'string' || !parsed.noteCore.trim())) {
                    return {active: false};
                }

                return parsed;
            }
        } catch {
            return {active: false};
        }

        return {active: false};
    }

    /**
     * @summary Atomically persists the episode state file, re-fencing authority before temp write and before rename.
     * @param {Object} state Episode state payload.
     * @param {Object} [options={}]
     * @param {String|null} [options.stateDir=this.stateDir] Owning runtime state directory.
     * @param {Function|null} [options.hasObservationWriteAuthority=this.hasObservationWriteAuthority] Authority oracle.
     * @returns {Boolean} True when persisted; false when fenced by authority loss.
     */
    writeEpisodeState(state, {
        stateDir = this.stateDir,
        hasObservationWriteAuthority = this.hasObservationWriteAuthority
    } = {}) {
        if (!this.isAuthorityHeld(hasObservationWriteAuthority)) {
            return false;
        }

        const statePath = this.getEpisodeStatePath(stateDir),
              tempPath  = `${statePath}.${process.pid}.${this.now()}.tmp`;

        fs.mkdirSync(path.dirname(statePath), {recursive: true});
        fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

        if (!this.isAuthorityHeld(hasObservationWriteAuthority)) {
            fs.rmSync(tempPath, {force: true});
            return false;
        }

        fs.renameSync(tempPath, statePath);
        return true;
    }

    /**
     * @summary Composes the canonical stable-subject `defect-note:` payload for an unrelieved disk-pressure episode.
     * @param {Object} options
     * @param {String} options.mountPath Mounted filesystem path under pressure.
     * @param {String} options.trigger Unrelieved routing reason (`record` or `prune-freed-nothing`).
     * @param {Number} options.usedPercent Sampled filesystem used percentage.
     * @param {Number} options.availableBytes Sampled available bytes on the mount.
     * @param {Number} options.imagesReclaimableBytes Reclaimable image bytes reported by Docker.
     * @param {Number} options.volumesReclaimableBytes Reclaimable volume bytes reported by Docker.
     * @param {Number} options.buildCacheReclaimableBytes Reclaimable build-cache bytes reported by Docker.
     * @param {Number} options.reclaimableAboveWarmFloorBytes Reclaimable build-cache bytes above the warm floor.
     * @returns {{noteCore: String, note: {subject: String, body: String, taggedConcepts: String[]}}}
     */
    composeDefectNote({
        mountPath,
        trigger,
        usedPercent,
        availableBytes,
        imagesReclaimableBytes,
        volumesReclaimableBytes,
        buildCacheReclaimableBytes,
        reclaimableAboveWarmFloorBytes
    }) {
        const noteCore = `docker-engine disk-pressure broke ${mountPath}: the build-cache prune cannot relieve it`,
              subject  = `defect-note: ${noteCore}`,
              body     = [
                  `Unrelieved Docker / data-mount disk pressure (${trigger}).`,
                  `- mountPath: ${mountPath}`,
                  `- usedPercent: ${formatDiskPercent(usedPercent)}%`,
                  `- availableBytes: ${availableBytes}`,
                  `- images.reclaimableBytes: ${imagesReclaimableBytes}`,
                  `- volumes.reclaimableBytes: ${volumesReclaimableBytes}`,
                  `- buildCache.reclaimableBytes: ${buildCacheReclaimableBytes}`,
                  `- reclaimableAboveWarmFloorBytes: ${reclaimableAboveWarmFloorBytes}`
              ].join('\n');

        return {
            noteCore,
            note: {
                subject,
                body,
                taggedConcepts: [...DISK_PRESSURE_DEFECT_TAGGED_CONCEPTS]
            }
        };
    }

    /**
     * @summary Composes the matching `[recovered]` defect-note payload when disk usage drops below ceiling.
     * @param {Object} options
     * @param {String} options.noteCore Stable observation core captured when the episode opened.
     * @param {String} options.mountPath Mounted filesystem path.
     * @param {Number} options.pressureCeilingPercent Configured disk-pressure ceiling percentage.
     * @param {Number} options.usedPercent Fresh healthy filesystem used percentage.
     * @param {Number} options.availableBytes Fresh available bytes on the mount.
     * @param {Number} options.imagesReclaimableBytes Reclaimable image bytes on recovery sample.
     * @param {Number} options.volumesReclaimableBytes Reclaimable volume bytes on recovery sample.
     * @param {Number} options.buildCacheReclaimableBytes Reclaimable build-cache bytes on recovery sample.
     * @returns {{subject: String, body: String, taggedConcepts: String[]}}
     */
    composeRecoveryNote({
        noteCore,
        mountPath,
        pressureCeilingPercent,
        usedPercent,
        availableBytes,
        imagesReclaimableBytes,
        volumesReclaimableBytes,
        buildCacheReclaimableBytes
    }) {
        return {
            subject: `defect-note: [recovered] ${noteCore}`,
            body   : [
                `Docker / data-mount disk usage dropped below ${pressureCeilingPercent}%.`,
                `- mountPath: ${mountPath}`,
                `- usedPercent: ${formatDiskPercent(usedPercent)}%`,
                `- availableBytes: ${availableBytes}`,
                `- images.reclaimableBytes: ${imagesReclaimableBytes}`,
                `- volumes.reclaimableBytes: ${volumesReclaimableBytes}`,
                `- buildCache.reclaimableBytes: ${buildCacheReclaimableBytes}`
            ].join('\n'),
            taggedConcepts: [...DISK_PRESSURE_DEFECT_TAGGED_CONCEPTS]
        };
    }

    /**
     * @summary Advances the disk-pressure defect episode state machine for one snapshot + controller outcome batch.
     * @param {Object} [options={}]
     * @param {Object|null} [options.engineDisk=null] Snapshot `engineDisk` observation and diagnosis.
     * @param {Object[]} [options.outcomes=[]] Controller outcomes produced for the snapshot.
     * @param {String|null} [options.stateDir=this.stateDir] Owning runtime state directory.
     * @param {Function|null} [options.hasObservationWriteAuthority=this.hasObservationWriteAuthority] Authority oracle.
     * @param {Function|null} [options.publishDefectNote=this.publishDefectNote] Defect-note mailbox publisher.
     * @param {Number} [options.now=this.now()] Observation epoch milliseconds.
     * @returns {Promise<Object>} Reconciliation disposition (`noop`, `opened`, `recovered`, or `fenced`).
     */
    async reconcile({
        engineDisk = null,
        outcomes = [],
        stateDir = this.stateDir,
        hasObservationWriteAuthority = this.hasObservationWriteAuthority,
        publishDefectNote = this.publishDefectNote,
        now = this.now()
    } = {}) {
        if (!engineDisk || typeof engineDisk !== 'object' || !this.isAuthorityHeld(hasObservationWriteAuthority)) {
            return {action: 'noop'};
        }

        if (typeof publishDefectNote !== 'function') {
            throw new TypeError('DiskPressureDefectService: publishDefectNote callback is required');
        }

        const episode = this.readEpisodeState({stateDir});

        if (episode.active === true) {
            const hasFreshStatfs = engineDisk.status !== 'unavailable' &&
                engineDisk.status !== 'degraded' &&
                !(Array.isArray(engineDisk.errors) && engineDisk.errors.length > 0) &&
                Boolean(engineDisk.statfs && typeof engineDisk.statfs === 'object'),
                  currentUsedPercent     = hasFreshStatfs ? Number(engineDisk.statfs.usedPercent) : NaN,
                  pressureCeilingPercent = AiConfig.orchestrator.diskPressure.percent;

            if (Number.isFinite(currentUsedPercent) && currentUsedPercent < pressureCeilingPercent) {
                const df                         = engineDisk.df && typeof engineDisk.df === 'object' ? engineDisk.df : null,
                      mountPath                  = engineDisk.statfs.path || engineDisk.statfs.mountPath || episode.mountPath || AiConfig.plane.dataRoot,
                      availableBytes             = toNonNegativeInt(engineDisk.statfs.availableBytes),
                      imagesReclaimableBytes     = toNonNegativeInt(df?.images?.reclaimableBytes),
                      volumesReclaimableBytes    = toNonNegativeInt(df?.volumes?.reclaimableBytes),
                      buildCacheReclaimableBytes = toNonNegativeInt(df?.buildCache?.reclaimableBytes),
                      recoveryNote               = this.composeRecoveryNote({
                          noteCore   : episode.noteCore,
                          mountPath,
                          pressureCeilingPercent,
                          usedPercent: currentUsedPercent,
                          availableBytes,
                          imagesReclaimableBytes,
                          volumesReclaimableBytes,
                          buildCacheReclaimableBytes
                      });

                if (!this.isAuthorityHeld(hasObservationWriteAuthority)) {
                    return {action: 'noop'};
                }

                await publishDefectNote(recoveryNote);
                const persisted = this.writeEpisodeState({
                    active      : false,
                    recoveredAt : new Date(now).toISOString(),
                    lastNoteCore: episode.noteCore
                }, {stateDir, hasObservationWriteAuthority});

                return {action: persisted ? 'recovered' : 'fenced', subject: recoveryNote.subject};
            }

            return {action: 'noop'};
        }

        const decision    = engineDisk.diagnosis,
              targetId    = engineDisk.targetIdentity?.id || decision?.serviceKey || 'docker-engine',
              diskOutcome = Array.isArray(outcomes)
                  ? outcomes.find(entry => entry?.serviceKey === targetId) || null
                  : null;

        if (!decision || decision.status !== 'diagnosed' || diskOutcome?.status === 'declined') {
            return {action: 'noop'};
        }

        const details         = decision.diagnosis?.details || decision.details || {},
              actuatorOutcome = diskOutcome?.actuatorOutcome || null,
              routedToRecord  = decision.actionClass === 'record' ||
                  details.actionClass === 'record' ||
                  diskOutcome?.status === 'recorded',
              trigger         = actuatorOutcome?.reasonCode === 'prune-freed-nothing'
                  ? 'prune-freed-nothing'
                  : actuatorOutcome?.alarmOnly === true
                      ? (actuatorOutcome.reasonCode || 'alarm-only')
                      : routedToRecord
                          ? 'record'
                          : null;

        if (!trigger) {
            return {action: 'noop'};
        }

        const statfs                         = engineDisk.statfs || details.statfs || null,
              df                             = engineDisk.df || null,
              images                         = df?.images || details.images || null,
              volumes                        = df?.volumes || details.volumes || null,
              buildCache                     = df?.buildCache || details.buildCache || null,
              mountPath                      = statfs?.path || statfs?.mountPath || AiConfig.plane.dataRoot,
              usedPercent                    = Number(statfs?.usedPercent),
              availableBytes                 = toNonNegativeInt(statfs?.availableBytes),
              imagesReclaimableBytes         = toNonNegativeInt(images?.reclaimableBytes),
              volumesReclaimableBytes        = toNonNegativeInt(volumes?.reclaimableBytes),
              buildCacheReclaimableBytes     = toNonNegativeInt(buildCache?.reclaimableBytes ?? details.reclaimableBuildCacheBytes),
              reclaimableAboveWarmFloorBytes = toNonNegativeInt(details.reclaimableAboveWarmFloorBytes),
              {noteCore, note}               = this.composeDefectNote({
                  mountPath,
                  trigger,
                  usedPercent,
                  availableBytes,
                  imagesReclaimableBytes,
                  volumesReclaimableBytes,
                  buildCacheReclaimableBytes,
                  reclaimableAboveWarmFloorBytes
              });

        if (!this.isAuthorityHeld(hasObservationWriteAuthority)) {
            return {action: 'noop'};
        }

        await publishDefectNote(note);
        const persisted = this.writeEpisodeState({
            active          : true,
            noteCore,
            openedAt        : new Date(now).toISOString(),
            trigger,
            mountPath,
            usedPercent     : Number.isFinite(usedPercent) ? usedPercent : 0,
            availableBytes,
            reclaimableBytes: {
                images    : imagesReclaimableBytes,
                volumes   : volumesReclaimableBytes,
                buildCache: buildCacheReclaimableBytes
            }
        }, {stateDir, hasObservationWriteAuthority});

        return {action: persisted ? 'opened' : 'fenced', subject: note.subject, trigger};
    }
}

export default Neo.setupClass(DiskPressureDefectService);
