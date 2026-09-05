/**
 * @module ai/services/fleet/projectDeploymentStateForFleet
 * @summary The bounded, redacted client projection of the orchestrator's deployment-state snapshot — the
 * only shape `fleetDeploymentState` ever puts on the fleet wire. The snapshot
 * (`DeploymentStateBridgeService#collectSnapshot`) is written for the KB/MC tools inside the plane's
 * trust boundary and carries per-service `resolvedConfig` (host paths, env values), `inspect` (container
 * detail), `logs`, `stats`, `proofs` and evidence facts; through the MCP tool it measures ~82 K characters.
 * None of that is a wire payload. This projection keeps exactly what a plane card renders, under the
 * snapshot's own field names — nothing is renamed and nothing is invented: a field the snapshot lacks
 * projects as `null`, never as a guessed value. Pure and synchronous, so the redaction is unit-provable
 * in isolation (the red-first arm feeds a leaking fixture and asserts nothing survives).
 *
 * The plane-log surface is deliberately absent — neomjs/neo-agent-brain#27 owns bounded, redacted log
 * reads as its own verb. Observe-only: no actuator, no restart command, rides this shape.
 */

/**
 * The projection's finite states. `ok` and `stale` carry the last known picture (a stale one says how old);
 * `unavailable` carries a named reason and an empty roster of services — never a fabricated plane.
 * @type {Object}
 */
export const DEPLOYMENT_STATE_PROJECTION_STATES = Object.freeze({
    ok         : 'ok',
    stale      : 'stale',
    unavailable: 'unavailable'
});

const
    isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value),
    fieldOf  = (record, key) => (isObject(record) && Object.hasOwn(record, key)) ? record[key] : null,
    nestedOf = (record, key) => { const value = fieldOf(record, key); return isObject(value) ? value : null };

/**
 * @summary Project one per-service record (`recordType: 'deployment-service-state'`) to its card fields.
 * The shape authority is the WRITER, not a guess (#323): `DeploymentStateBridgeService#collectSnapshot`
 * folds errors and memory pressure into ONE status word (`foldMemoryPressureIntoStatus`: `available` |
 * `degraded`), `classification` carries the class word beside its declared flag, and `diagnosis` is a
 * `container-health-diagnosis-decision` record — `{status, actionClass, diagnosis: {recoveryClass,
 * confidence} | null}` (`ContainerHealthDiagnosisService#createDecision`), the inner block absent on a
 * healthy service.
 * @param {Object} row The snapshot's service record.
 * @returns {Object} `{serviceKey, observedAt, status, memoryPressure, restartChurn, classification, diagnosis}`
 *     — each nested block bounded to its named fields, `null` when the record lacks it.
 */
export function projectDeploymentServiceForFleet(row) {
    const
        status         = fieldOf(row, 'status'),
        memoryPressure = nestedOf(row, 'memoryPressure'),
        restartChurn   = nestedOf(row, 'restartChurn'),
        classification = nestedOf(row, 'classification'),
        decision       = nestedOf(row, 'diagnosis'),
        diagnosis      = nestedOf(decision, 'diagnosis');

    return {
        serviceKey    : typeof row?.serviceKey === 'string' ? row.serviceKey : null,
        observedAt    : fieldOf(row, 'observedAt'),
        status        : typeof status === 'string' ? status : null,
        memoryPressure: memoryPressure && {
            disposition: fieldOf(memoryPressure, 'disposition'),
            reason     : fieldOf(memoryPressure, 'reason')
        },
        restartChurn  : restartChurn && {
            baseline : fieldOf(restartChurn, 'baseline'),
            detecting: fieldOf(restartChurn, 'detecting')
        },
        classification: classification && {
            serviceClass          : fieldOf(classification, 'serviceClass'),
            serviceClassDeclared  : fieldOf(classification, 'serviceClassDeclared'),
            appliedMemoryThreshold: fieldOf(classification, 'appliedMemoryThreshold'),
            sampleCount           : fieldOf(classification, 'sampleCount')
        },
        diagnosis     : decision && {
            status       : fieldOf(decision, 'status'),
            actionClass  : fieldOf(decision, 'actionClass'),
            recoveryClass: fieldOf(diagnosis, 'recoveryClass'),
            confidence   : fieldOf(diagnosis, 'confidence')
        }
    };
}

/**
 * @summary Project the snapshot's maintenance blocks: the backup lane's retry phase, health verdict and
 * last receipt (`DeploymentStateBridgeService#collectMaintenanceSnapshot` — `retry`, `health`,
 * `lastBackup`), and the heavy-maintenance starvation posture with its breach count — the receipts
 * themselves (waiters, lease holders, staging residue, durability paths) stay inside the plane.
 * @param {Object} snapshot
 * @returns {{backup: Object|null, starvation: Object|null}}
 */
export function projectDeploymentMaintenanceForFleet(snapshot) {
    const
        maintenance = nestedOf(snapshot, 'maintenance'),
        retry       = nestedOf(maintenance, 'retry'),
        health      = nestedOf(maintenance, 'health'),
        lastBackup  = nestedOf(maintenance, 'lastBackup'),
        reasonCodes = health && Array.isArray(health.reasonCodes) ? health.reasonCodes.filter(code => typeof code === 'string') : [],
        starvation  = nestedOf(snapshot, 'heavyMaintenanceStarvation'),
        breaches    = starvation && Array.isArray(starvation.breaches) ? starvation.breaches : null;

    return {
        backup    : maintenance && {
            // the lane's retry phase (`healthy` | `unanchored` | `retrying` | `exhausted`) and its
            // success anchor ride `maintenance.retry` (`describeBackupRetryState`), present once the
            // lane has task state; the health verdict and its reason codes ride `maintenance.health`
            phase           : fieldOf(retry, 'phase'),
            lastSuccessAt   : fieldOf(retry, 'lastSuccessAt'),
            lastSuccessAgeMs: fieldOf(retry, 'lastSuccessAgeMs'),
            health          : health && {
                status: fieldOf(health, 'status'),
                reasonCodes
            },
            // the receipt: its finish instant, the bundle's own status, the off-host sync's status —
            // an unreadable or unreachable receipt carries `status` at its root instead
            lastBackup      : lastBackup && {
                finishedAt : fieldOf(lastBackup, 'finishedAt'),
                status     : fieldOf(nestedOf(lastBackup, 'backup'), 'status') ?? fieldOf(lastBackup, 'status'),
                offHostSync: fieldOf(nestedOf(lastBackup, 'offHostSync'), 'status')
            }
        },
        starvation: starvation && {
            posture    : fieldOf(starvation, 'posture'),
            breachCount: breaches ? breaches.length : null
        }
    };
}

/**
 * @summary Project a whole snapshot to the wire shape, aged against the staleness horizon.
 * @param {Object|null} snapshot             The parsed snapshot file, or `null` when there is none to project.
 * @param {Object}      [options={}]
 * @param {Number}      [options.ageMs]      How old the file is on the reader's clock; `>` `staleAfterMs` reads `stale`.
 * @param {Number}      [options.staleAfterMs] The staleness horizon (the resolved `staleAfterMs` leaf).
 * @param {String}      [options.reason]     The reader's named reason when `snapshot` is absent.
 * @returns {Object} `{state, reason, generatedAt, ageMs, services, maintenance}` — always a fresh object.
 */
export function projectDeploymentStateForFleet(snapshot, {ageMs = null, staleAfterMs = null, reason = null} = {}) {
    if (!isObject(snapshot)) {
        return {
            state      : DEPLOYMENT_STATE_PROJECTION_STATES.unavailable,
            reason     : typeof reason === 'string' && reason.length > 0 ? reason : 'snapshot-unreadable',
            generatedAt: null,
            ageMs      : null,
            services   : [],
            maintenance: {backup: null, starvation: null}
        };
    }

    const
        stale    = Number.isFinite(ageMs) && Number.isFinite(staleAfterMs) && ageMs > staleAfterMs,
        services = Array.isArray(snapshot.services) ? snapshot.services : [];

    return {
        state      : stale ? DEPLOYMENT_STATE_PROJECTION_STATES.stale : DEPLOYMENT_STATE_PROJECTION_STATES.ok,
        reason     : null,
        generatedAt: fieldOf(snapshot, 'generatedAt'),
        ageMs      : Number.isFinite(ageMs) ? ageMs : null,
        services   : services.filter(isObject).map(projectDeploymentServiceForFleet),
        maintenance: projectDeploymentMaintenanceForFleet(snapshot)
    };
}
