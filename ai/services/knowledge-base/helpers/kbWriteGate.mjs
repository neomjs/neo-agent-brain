import fs       from 'fs-extra';
import AiConfig from '../../../config.mjs';
import {
    inspectHeavyMaintenanceLease,
    isKbWriteExclusiveLease,
    resolveHeavyMaintenanceLeasePath
} from '../../../daemons/orchestrator/services/heavyMaintenanceLeasePrimitives.mjs';

export const KB_MAINTENANCE_IN_PROGRESS = 'KB_MAINTENANCE_IN_PROGRESS';

const DEFAULT_TRANSIENT_MALFORMED_RETRY_MS = 10;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * @summary Builds a retryable Knowledge Base maintenance refusal error naming the active window.
 * @param {Object} [options]
 * @param {String|null} [options.leaseId=null] Public lease identifier.
 * @param {String|null} [options.owner=null] Lease owner label.
 * @param {String|null} [options.expiresAt=null] Declared lease expiry ISO timestamp.
 * @param {String} [options.operation='write'] Refused KB write operation label.
 * @returns {Error}
 */
export function createKbMaintenanceInProgressError({
    leaseId   = null,
    owner     = null,
    expiresAt = null,
    operation = 'write'
} = {}) {
    const windowParts = [
        owner     ? `owner '${owner}'`     : null,
        leaseId   ? `leaseId '${leaseId}'` : null,
        expiresAt ? `until ${expiresAt}`   : null
    ].filter(Boolean);

    const windowSummary = windowParts.length > 0 ? ` (${windowParts.join(', ')})` : '';
    const error         = new Error(
        `Knowledge Base write '${operation}' refused: a KB maintenance window is in progress${windowSummary}. ` +
        'Retry after the maintenance window closes.'
    );

    error.name      = 'KbMaintenanceInProgressError';
    error.code      = KB_MAINTENANCE_IN_PROGRESS;
    error.retryable = true;
    error.leaseId   = leaseId;
    error.owner     = owner;
    error.expiresAt = expiresAt;
    error.operation = operation;

    return error;
}

/**
 * @summary Returns true when an error is a `KB_MAINTENANCE_IN_PROGRESS` write-gate refusal.
 * @param {*} error Candidate error.
 * @returns {Boolean}
 */
export function isKbMaintenanceInProgressError(error) {
    return Boolean(error && error.code === KB_MAINTENANCE_IN_PROGRESS);
}

/**
 * @summary Converts a `KB_MAINTENANCE_IN_PROGRESS` refusal into the structured MCP error payload.
 * @param {Error} error Refusal error thrown by `kbWriteGate`.
 * @returns {{error: String, message: String, code: String, retryable: Boolean, leaseId: String|null, owner: String|null, expiresAt: String|null}}
 */
export function toKbMaintenanceErrorPayload(error) {
    return {
        error    : 'Knowledge Base maintenance window in progress',
        message  : error?.message || 'Knowledge Base writes are temporarily fenced during an active maintenance window. Retry after maintenance completes.',
        code     : KB_MAINTENANCE_IN_PROGRESS,
        retryable: true,
        leaseId  : error?.leaseId   ?? null,
        owner    : error?.owner     ?? null,
        expiresAt: error?.expiresAt ?? null
    };
}

function createReadOnlyFsAdapter(fsModule) {
    return {
        readFile: (...args) => fsModule.readFile(...args)
    };
}

/**
 * @summary Creates a read-only KB Chroma write gate backed by the shared heavy-maintenance lease.
 *
 * `runWrite` enforces store-before-load ordering (`inFlightWrites++` before `inspectGate()`): once
 * a coordinator persists a `kbWriteExclusive` lease and observes `{gate: 'closed', inFlightWrites: 0}`
 * on `getHealthStatus()`, no concurrent `kb-server` Chroma write can slip into the window uncounted.
 * The lease file is inspected strictly read-only across container namespaces (`crossNamespace: true`).
 *
 * @see learn/agentos/decisions/0026-recovery-actuator.md
 * @param {Object} [options]
 * @param {String|null} [options.leasePath=null] Explicit lease-path override for isolated tests.
 * @param {Object} [options.fsModule=fs] Filesystem module seam (wrapped to expose `readFile` only).
 * @param {Function} [options.now=() => new Date()] Clock seam.
 * @param {Number} [options.malformedRetryDelayMs=10] Single-retry delay for transient mid-create empty reads.
 * @returns {{inspectGate: Function, getHealthStatus: Function, assertOpen: Function, runWrite: Function, getInFlightWrites: Function}}
 */
export function createKbWriteGate({
    leasePath             = null,
    fsModule              = fs,
    now                   = () => new Date(),
    malformedRetryDelayMs = DEFAULT_TRANSIENT_MALFORMED_RETRY_MS
} = {}) {
    const readOnlyFs     = createReadOnlyFsAdapter(fsModule);
    let   inFlightWrites = 0;

    const resolveLeasePath = () => resolveHeavyMaintenanceLeasePath({
        leasePath,
        dataDir: AiConfig.orchestrator.dataDir
    });

    const inspectGate = async () => {
        const targetPath = resolveLeasePath();
        let   current    = await inspectHeavyMaintenanceLease({
            leasePath     : targetPath,
            fsModule      : readOnlyFs,
            now           : now(),
            crossNamespace: true
        });

        if (current.status === 'malformed' && malformedRetryDelayMs > 0) {
            await sleep(malformedRetryDelayMs);
            current = await inspectHeavyMaintenanceLease({
                leasePath     : targetPath,
                fsModule      : readOnlyFs,
                now           : now(),
                crossNamespace: true
            });
        }

        if (current.active && isKbWriteExclusiveLease(current.lease)) {
            const observedLeaseId = typeof current.lease.leaseId === 'string' && current.lease.leaseId.length > 0
                ? current.lease.leaseId
                : null;

            return {
                gate     : 'closed',
                leaseId  : observedLeaseId,
                owner    : current.lease.owner     ?? null,
                expiresAt: current.lease.expiresAt ?? null
            };
        }

        return {
            gate     : 'open',
            leaseId  : null,
            owner    : null,
            expiresAt: null
        };
    };

    const getHealthStatus = async () => {
        const state = await inspectGate();

        return {
            gate   : state.gate,
            leaseId: state.leaseId,
            inFlightWrites
        };
    };

    const assertOpen = async (operation = 'write') => {
        const state = await inspectGate();

        if (state.gate === 'closed') {
            throw createKbMaintenanceInProgressError({
                leaseId  : state.leaseId,
                owner    : state.owner,
                expiresAt: state.expiresAt,
                operation
            });
        }
    };

    const runWrite = async (operation, writeFn) => {
        inFlightWrites += 1;

        try {
            const state = await inspectGate();

            if (state.gate === 'closed') {
                throw createKbMaintenanceInProgressError({
                    leaseId  : state.leaseId,
                    owner    : state.owner,
                    expiresAt: state.expiresAt,
                    operation
                });
            }

            return await writeFn();
        } finally {
            inFlightWrites -= 1;
        }
    };

    return {
        inspectGate,
        getHealthStatus,
        assertOpen,
        runWrite,
        getInFlightWrites: () => inFlightWrites
    };
}

export const kbWriteGate = createKbWriteGate();

export default kbWriteGate;
