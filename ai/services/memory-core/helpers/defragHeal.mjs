import crypto               from 'node:crypto';
import path                 from 'node:path';
import fs                   from 'fs-extra';
import {isBundleRestorable} from './bundleIntegrity.mjs';
import {
    closeBundlePayload,
    isBundlePayload,
    openBundlePayload
} from '../../shared/bundlePayload.mjs';

/**
 * @module ai/services/memory-core/helpers/defragHeal
 * @summary Fenced Knowledge Base HNSW compaction heal operation (`healOperations.defrag`).
 *
 * Executes the autonomous `store-bloat -> defrag` actuator pipeline for the Knowledge Base collection
 * without touching a local mutable persist-directory copy:
 *
 * 1. Rejects any target other than the configured Knowledge Base collection (`unsafe-input`).
 * 2. Re-reads live dead-element ratio at operation start; defers with zero mutations when unavailable
 *    or at/below `gcDefragThreshold`.
 * 3. Acquires the `kbWriteExclusive` heavy-maintenance lease and waits for `kb-server`'s healthcheck
 *    drain acknowledgement (`gate === 'closed'`, matching `leaseId`, `inFlightWrites === 0`).
 * 4. Captures a JSONL backup bundle, gates strictly on `isBundleRestorable(meta.integrity) === true`
 *    plus passing `kb` parity, records a streaming SHA-256 digest (`bundleSha`), and extracts the
 *    canonical ID list plus one sampled vector without materializing the corpus in V8 memory.
 * 5. Runs a free-disk preflight before creating the shadow collection, then streams batches from the
 *    verified bundle into `rewriteCollectionViaShadowPromotion`.
 * 6. Restarts `chroma` through the lifecycle-write envelope inside the lease to reclaim resident HNSW
 *    anonymous memory, then re-validates canonical row count, full ID set, and sampled embedding.
 * 7. On any post-restart mismatch (including an empty post-restart store), restores from `<bundleRoot>/kb`,
 *    restarts `kb-server` inside the lease, and returns `failed` with expected and observed counts.
 * 8. On clean post-restart validation, restarts `kb-server` inside the lease to refresh cached collection
 *    handles, then releases the lease and returns `healed`.
 *
 * @see learn/agentos/decisions/0026-recovery-actuator.md
 * @see learn/agentos/decisions/0027-autonomous-data-recovery-actuator.md
 */

export const DEFAULT_DRAIN_ACK_TIMEOUT_MS       = 15_000;
export const DEFAULT_DRAIN_ACK_POLL_INTERVAL_MS = 250;
export const DEFAULT_CHROMA_READY_TIMEOUT_MS    = 30_000;
export const DEFAULT_CHROMA_READY_POLL_MS       = 500;
export const DEFAULT_SHADOW_BATCH_SIZE          = 500;
export const DEFAULT_SHADOW_DISK_SAFETY_FACTOR  = 1.25;

const PER_ROW_NON_VECTOR_OVERHEAD_BYTES = 2048;
const FLOAT32_EMBEDDING_TOLERANCE       = 1e-3;

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * @summary Validates a finite embedding vector (Array or TypedArray) of optional expected dimension.
 * @param {*} vector Candidate embedding vector.
 * @param {Number|null} [expectedDimension=null] Expected vector length when positive integer.
 * @returns {Boolean}
 */
function isValidVector(vector, expectedDimension = null) {
    const isSequence = Array.isArray(vector) || (ArrayBuffer.isView(vector) && !(vector instanceof DataView));

    if (!isSequence || vector.length === 0) {
        return false;
    }

    if (Number.isInteger(expectedDimension) && expectedDimension > 0 && vector.length !== expectedDimension) {
        return false;
    }

    for (let i = 0; i < vector.length; i++) {
        if (!Number.isFinite(vector[i])) {
            return false;
        }
    }

    return true;
}

/**
 * @summary Streams raw file bytes into an active `crypto.Hash` instance.
 * @param {crypto.Hash} hash Active hash accumulator.
 * @param {String} filePath File to hash.
 * @param {Object} [fsModule=fs] Filesystem seam.
 * @returns {Promise<void>}
 */
async function updateHashWithFile(hash, filePath, fsModule = fs) {
    if (typeof fsModule.createReadStream === 'function') {
        await new Promise((resolve, reject) => {
            const stream = fsModule.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('error', reject);
            stream.on('end', resolve);
        });
        return;
    }

    const bytes = await fsModule.readFile(filePath);
    hash.update(bytes);
}

/**
 * @summary Verifies bundle survivability, computes a SHA-256 digest over `bundle-meta.json` and `<bundleRoot>/kb`
 * payloads, and streams the KB JSONL payload once to collect expected IDs and one sampled embedding.
 *
 * @param {Object} options
 * @param {String} options.bundleRoot Published backup bundle root directory.
 * @param {Object} options.meta Parsed `bundle-meta.json` object returned by `runBackup()`.
 * @param {Number|null} [options.expectedDimension=null] Expected vector dimension when known.
 * @param {Object} [options.fsModule=fs] Filesystem seam.
 * @returns {Promise<Object>} `{ok: true, bundleSha, kbDir, payloadFiles, sourceIds, expectedCount, sampleRow}` or `{ok: false, reason, ...}`.
 */
export async function inspectAndHashKbBundle({
    bundleRoot,
    meta,
    expectedDimension = null,
    fsModule          = fs
} = {}) {
    const restorable = isBundleRestorable(meta?.integrity),
          kbCheck    = Array.isArray(meta?.integrity)
              ? meta.integrity.find(entry => entry?.subsystem === 'kb') ?? null
              : null;

    if (
        restorable !== true ||
        !kbCheck ||
        kbCheck.status !== 'pass' ||
        !Number.isInteger(kbCheck.bundleCount) ||
        kbCheck.bundleCount <= 0 ||
        kbCheck.bundleCount !== kbCheck.sourceCount
    ) {
        return {
            ok         : false,
            reason     : 'bundle-integrity-check-failed',
            restorable,
            kbIntegrity: kbCheck
        };
    }

    if (typeof bundleRoot !== 'string' || bundleRoot.length === 0) {
        return {
            ok    : false,
            reason: 'bundle-root-missing'
        };
    }

    const metaPath = path.join(bundleRoot, 'bundle-meta.json'),
          kbDir    = path.join(bundleRoot, 'kb');

    if (!await fsModule.pathExists(metaPath) || !await fsModule.pathExists(kbDir)) {
        return {
            ok    : false,
            reason: 'bundle-kb-files-missing'
        };
    }

    const entries      = await fsModule.readdir(kbDir),
          payloadNames = entries.filter(isBundlePayload).sort(),
          payloadFiles = payloadNames.map(name => path.join(kbDir, name));

    if (payloadFiles.length === 0) {
        return {
            ok    : false,
            reason: 'bundle-kb-payload-missing'
        };
    }

    const hash = crypto.createHash('sha256');
    hash.update('bundle-meta.json\0');
    await updateHashWithFile(hash, metaPath, fsModule);

    for (let i = 0; i < payloadFiles.length; i++) {
        hash.update(`kb/${payloadNames[i]}\0`);
        await updateHashWithFile(hash, payloadFiles[i], fsModule);
    }

    const bundleSha = hash.digest('hex'),
          sourceIds = [],
          seenIds   = new Set();
    let   sampleRow = null;

    for (const filePath of payloadFiles) {
        const reader = openBundlePayload(filePath);

        try {
            for await (const line of reader) {
                if (!line.trim()) {
                    continue;
                }

                const row = JSON.parse(line);

                if (typeof row?.id !== 'string' || row.id.length === 0) {
                    return {
                        ok    : false,
                        reason: 'bundle-row-missing-id',
                        bundleSha
                    };
                }

                if (seenIds.has(row.id)) {
                    return {
                        ok         : false,
                        reason     : 'bundle-duplicate-row-id',
                        duplicateId: row.id,
                        bundleSha
                    };
                }

                if (!isValidVector(row.embedding, expectedDimension)) {
                    return {
                        ok    : false,
                        reason: 'bundle-row-invalid-embedding',
                        rowId : row.id,
                        bundleSha
                    };
                }

                seenIds.add(row.id);
                sourceIds.push(row.id);

                if (!sampleRow) {
                    sampleRow = {
                        id       : row.id,
                        embedding: Array.from(row.embedding)
                    };
                }
            }
        } finally {
            closeBundlePayload(reader);
        }
    }

    if (sourceIds.length !== kbCheck.bundleCount) {
        return {
            ok           : false,
            reason       : 'bundle-row-count-mismatch',
            expectedCount: kbCheck.bundleCount,
            observedCount: sourceIds.length,
            bundleSha
        };
    }

    return {
        ok           : true,
        bundleSha,
        kbDir,
        payloadFiles,
        sourceIds,
        expectedCount: sourceIds.length,
        sampleRow
    };
}

/**
 * @summary Streams verified Knowledge Base JSONL bundle rows into a Chroma shadow collection in bounded batches.
 *
 * @param {Object} options
 * @param {String} options.kbDir `<bundleRoot>/kb` directory holding `.jsonl` / `.jsonl.br` / `.jsonl.gz` payloads.
 * @param {Object} options.collection Target Chroma shadow collection handle (`add()`).
 * @param {Number|null} [options.expectedDimension=null] Expected vector dimension when known.
 * @param {Number} [options.batchSize=DEFAULT_SHADOW_BATCH_SIZE] Maximum rows buffered in V8 memory per flush.
 * @param {Object} [options.fsModule=fs] Filesystem seam.
 * @returns {Promise<{loadedCount: Number}>}
 */
export async function streamKbBundleIntoCollection({
    kbDir,
    collection,
    expectedDimension = null,
    batchSize         = DEFAULT_SHADOW_BATCH_SIZE,
    fsModule          = fs
} = {}) {
    const entries      = await fsModule.readdir(kbDir),
          payloadFiles = entries.filter(isBundlePayload).sort().map(name => path.join(kbDir, name));

    let batch       = [],
        loadedCount = 0;

    const flushBatch = async () => {
        if (batch.length === 0) {
            return;
        }

        const current = batch;
        batch = [];

        const addPayload = {
            ids       : current.map(row => row.id),
            embeddings: current.map(row => row.embedding),
            metadatas : current.map(row => row.metadata ?? {})
        };

        if (current.some(row => row.document != null)) {
            addPayload.documents = current.map(row => {
                if (row.document == null) {
                    return '';
                }
                return typeof row.document === 'object' ? JSON.stringify(row.document) : String(row.document);
            });
        }

        await collection.add(addPayload);
        loadedCount += current.length;
    };

    for (const filePath of payloadFiles) {
        const reader = openBundlePayload(filePath);

        try {
            for await (const line of reader) {
                if (!line.trim()) {
                    continue;
                }

                const row = JSON.parse(line);

                if (typeof row?.id !== 'string' || row.id.length === 0 || !isValidVector(row.embedding, expectedDimension)) {
                    throw new Error(`streamKbBundleIntoCollection: invalid row '${row?.id ?? 'unknown'}' in ${filePath}`);
                }

                batch.push({
                    id       : row.id,
                    embedding: row.embedding,
                    metadata : row.metadata ?? {},
                    document : row.document ?? null
                });

                if (batch.length >= batchSize) {
                    await flushBatch();
                }
            }

            await flushBatch();
        } finally {
            closeBundlePayload(reader);
        }
    }

    return {loadedCount};
}

/**
 * @summary Estimates free bytes required on the Chroma volume to build a compacted shadow collection safely.
 *
 * @param {Object} options
 * @param {Number} options.liveCount Live record count to write into the shadow collection.
 * @param {Number} [options.dimension=4096] Embedding vector dimension.
 * @param {Number} [options.liveSegmentBytes=0] On-disk bytes of current KB vector segment directories when readable.
 * @param {Number} [options.hnswOccupancy=0] Current HNSW element occupancy corresponding to `liveSegmentBytes`.
 * @param {Number} [options.safetyFactor=DEFAULT_SHADOW_DISK_SAFETY_FACTOR] Headroom multiplier (>= 1).
 * @returns {Number} Required free bytes.
 */
export function estimateRequiredShadowBytes({
    liveCount,
    dimension        = 4096,
    liveSegmentBytes = 0,
    hnswOccupancy    = 0,
    safetyFactor     = DEFAULT_SHADOW_DISK_SAFETY_FACTOR
} = {}) {
    const safeCount      = Math.max(0, Number(liveCount) || 0),
          safeDim        = Math.max(1, Number(dimension) || 4096),
          safeMultiplier = Number.isFinite(safetyFactor) && safetyFactor >= 1 ? safetyFactor : DEFAULT_SHADOW_DISK_SAFETY_FACTOR,
          rowEstimate    = safeCount * (safeDim * 4 + PER_ROW_NON_VECTOR_OVERHEAD_BYTES),
          scaledSegments = liveSegmentBytes > 0 && hnswOccupancy > 0
              ? Math.ceil(liveSegmentBytes * Math.min(1, safeCount / hnswOccupancy))
              : 0;

    return Math.ceil(Math.max(rowEstimate, scaledSegments) * safeMultiplier);
}

/**
 * @summary Measures on-disk segment bytes and filesystem free space (`statfs`) on the Chroma data volume
 * to verify sufficient headroom for a compacted shadow collection before writing to Chroma.
 *
 * @param {Object} options
 * @param {String} options.dataDir Chroma persist directory mount path.
 * @param {Number} options.liveCount Live record count to write into the shadow collection.
 * @param {Number} [options.dimension=4096] Embedding vector dimension.
 * @param {Number} [options.hnswOccupancy=0] Current HNSW element occupancy.
 * @param {String[]} [options.vectorSegmentIds=[]] Live KB vector segment directory IDs.
 * @param {Object} [options.fsModule=fs.promises] Async filesystem seam exposing `statfs`, `readdir`, and `stat`.
 * @returns {Promise<{ok: Boolean, freeBytes: Number|null, requiredBytes: Number, reason?: String}>}
 */
export async function measureChromaDiskHeadroom({
    dataDir,
    liveCount,
    dimension        = 4096,
    hnswOccupancy    = 0,
    vectorSegmentIds = [],
    fsModule         = fs.promises
} = {}) {
    let liveSegmentBytes = 0;

    if (typeof dataDir === 'string' && dataDir.length > 0 && Array.isArray(vectorSegmentIds)) {
        for (const segmentId of vectorSegmentIds) {
            if (typeof segmentId !== 'string' || segmentId.length === 0) {
                continue;
            }
            const segmentDir = path.join(dataDir, segmentId);
            try {
                const entries = await fsModule.readdir(segmentDir, {withFileTypes: true});
                for (const entry of entries) {
                    if (entry.isFile()) {
                        const st = await fsModule.stat(path.join(segmentDir, entry.name));
                        liveSegmentBytes += st.size;
                    }
                }
            } catch {
                // Segment directory unreadable or absent; row-based floor still bounds the estimate.
            }
        }
    }

    const requiredBytes = estimateRequiredShadowBytes({
        liveCount,
        dimension,
        liveSegmentBytes,
        hnswOccupancy
    });

    if (typeof dataDir !== 'string' || dataDir.length === 0 || typeof fsModule?.statfs !== 'function') {
        return {
            ok       : false,
            freeBytes: null,
            requiredBytes,
            reason   : 'chroma-statfs-unavailable'
        };
    }

    let freeBytes;
    try {
        const stats = await fsModule.statfs(dataDir);
        freeBytes = Number(BigInt(stats.bavail) * BigInt(stats.bsize));
    } catch (error) {
        return {
            ok       : false,
            freeBytes: null,
            requiredBytes,
            reason   : `chroma-statfs-failed: ${error?.message ?? String(error)}`
        };
    }

    if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes) {
        return {
            ok       : false,
            freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
            requiredBytes,
            reason   : 'insufficient-free-disk-for-shadow'
        };
    }

    return {
        ok: true,
        freeBytes,
        requiredBytes
    };
}

/**
 * @summary Polls `heartbeatFn` at a fixed interval until Chroma answers after a container restart.
 *
 * @param {Object} options
 * @param {Function} options.heartbeatFn `async () => *` Chroma heartbeat call.
 * @param {Number} [options.timeoutMs=DEFAULT_CHROMA_READY_TIMEOUT_MS] Maximum wait window in milliseconds.
 * @param {Number} [options.pollIntervalMs=DEFAULT_CHROMA_READY_POLL_MS] Constant poll interval in milliseconds.
 * @param {Function} [options.clock=Date.now] Clock seam.
 * @param {Function} [options.sleep=defaultSleep] Sleep seam.
 * @returns {Promise<void>}
 */
export async function waitForChromaHeartbeat({
    heartbeatFn,
    timeoutMs      = DEFAULT_CHROMA_READY_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_CHROMA_READY_POLL_MS,
    clock          = Date.now,
    sleep          = defaultSleep
} = {}) {
    const startedAt = clock();
    let   lastError = null;

    while (true) {
        try {
            await heartbeatFn();
            return;
        } catch (error) {
            lastError = error;
        }

        if (clock() - startedAt >= timeoutMs) {
            throw new Error(
                `Chroma did not become ready within ${timeoutMs}ms after restart: ${lastError?.message ?? String(lastError)}`
            );
        }

        await sleep(pollIntervalMs);
    }
}

/**
 * @summary Re-validates the canonical Knowledge Base collection after a Chroma restart against the bundle's
 * expected row count, complete ID set, and sampled vector.
 *
 * @param {Object} options
 * @param {Object|null} options.collection Canonical Chroma collection handle (or `null` when missing after restart).
 * @param {String[]} options.expectedIds Full ID list recorded from the verified bundle.
 * @param {{id: String, embedding: Number[]}|null} options.sampleRow Sampled bundle record for vector verification.
 * @param {Function} options.listIdsFn `async ({collection}) => String[]` ID pager.
 * @returns {Promise<Object>} Validation verdict `{valid, reason, expectedCount, observedCount, extraIds, missingIdCount, extraIdCount, sampleValid}`.
 */
export async function validateCanonicalCollectionAgainstBundle({
    collection,
    expectedIds = [],
    sampleRow   = null,
    listIdsFn
} = {}) {
    const expectedCount = expectedIds.length;

    if (!collection) {
        return {
            valid         : false,
            reason        : 'post-restart-collection-missing',
            expectedCount,
            observedCount : 0,
            extraIds      : [],
            missingIdCount: expectedCount,
            extraIdCount  : 0,
            sampleValid   : false
        };
    }

    const observedCount = await collection.count(),
          observedIds   = observedCount > 0 ? await listIdsFn({collection}) : [],
          expectedSet   = new Set(expectedIds),
          observedSet   = new Set(observedIds),
          extraIds      = [];
    let missingCount = 0;

    for (const id of expectedSet) {
        if (!observedSet.has(id)) {
            missingCount++;
        }
    }

    for (const id of observedSet) {
        if (!expectedSet.has(id)) {
            extraIds.push(id);
        }
    }

    let sampleValid = expectedCount === 0 || sampleRow === null;

    if (!sampleValid && observedSet.has(sampleRow.id)) {
        const sample    = await collection.get({ids: [sampleRow.id], include: ['embeddings']}),
              sampleIdx = Array.isArray(sample?.ids) ? sample.ids.indexOf(sampleRow.id) : -1,
              observed  = sampleIdx >= 0 ? sample?.embeddings?.[sampleIdx] : null;

        if (isValidVector(observed, sampleRow.embedding.length)) {
            sampleValid = true;
            for (let i = 0; i < sampleRow.embedding.length; i++) {
                if (Math.abs(observed[i] - sampleRow.embedding[i]) > FLOAT32_EMBEDDING_TOLERANCE) {
                    sampleValid = false;
                    break;
                }
            }
        }
    }

    const valid =
        observedCount === expectedCount &&
        observedIds.length === expectedCount &&
        observedSet.size === expectedSet.size &&
        missingCount === 0 &&
        extraIds.length === 0 &&
        sampleValid;

    let reason = null;
    if (!valid) {
        if (observedCount !== expectedCount) {
            reason = 'post-restart-count-mismatch';
        } else if (missingCount > 0 || extraIds.length > 0 || observedSet.size !== expectedSet.size) {
            reason = 'post-restart-id-set-mismatch';
        } else {
            reason = 'post-restart-sample-embedding-mismatch';
        }
    }

    return {
        valid,
        reason,
        expectedCount,
        observedCount,
        extraIds,
        missingIdCount: missingCount,
        extraIdCount  : extraIds.length,
        sampleValid
    };
}

/**
 * @summary Polls `probeKbWriteGate` until `kb-server` acknowledges the active `leaseId` with zero in-flight writes.
 *
 * @param {Object} options
 * @param {String} options.leaseId Active heavy-maintenance `leaseId`.
 * @param {Function} options.probeKbWriteGate `async () => ({gate, leaseId, inFlightWrites})`.
 * @param {Number} [options.timeoutMs=DEFAULT_DRAIN_ACK_TIMEOUT_MS] Maximum wait window in milliseconds.
 * @param {Number} [options.pollIntervalMs=DEFAULT_DRAIN_ACK_POLL_INTERVAL_MS] Constant poll interval in milliseconds.
 * @param {Function} [options.clock=Date.now] Clock seam.
 * @param {Function} [options.sleep=defaultSleep] Delay seam.
 * @returns {Promise<{acknowledged: Boolean, writeGate: Object|null, lastProbeError: String|null}>}
 */
export async function waitForKbWriteDrainAck({
    leaseId,
    probeKbWriteGate,
    timeoutMs      = DEFAULT_DRAIN_ACK_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_DRAIN_ACK_POLL_INTERVAL_MS,
    clock          = Date.now,
    sleep          = defaultSleep
} = {}) {
    const startedAt = clock();
    let   lastGate  = null,
          lastErrorMsg = null;

    while (true) {
        try {
            const writeGate = await probeKbWriteGate();
            lastGate     = writeGate ?? null;
            lastErrorMsg = null;

            if (
                writeGate?.gate === 'closed' &&
                writeGate?.leaseId === leaseId &&
                writeGate?.inFlightWrites === 0
            ) {
                return {
                    acknowledged  : true,
                    writeGate,
                    lastProbeError: null
                };
            }
        } catch (error) {
            lastErrorMsg = error?.message ?? String(error);
        }

        if (clock() - startedAt >= timeoutMs) {
            return {
                acknowledged  : false,
                writeGate     : lastGate,
                lastProbeError: lastErrorMsg
            };
        }

        await sleep(pollIntervalMs);
    }
}

/**
 * @summary Creates the `healOperations.defrag` actuator operation consumed by `dispatchHeal`.
 *
 * All storage, lease, backup, lifecycle-restart, and healthcheck collaborators are injected so the
 * state machine is deterministically unit-testable with zero live-service side effects.
 *
 * @param {Object} collaborators
 * @param {Function} collaborators.getExpectedCollection Returns the canonical Knowledge Base collection name.
 * @param {Function} collaborators.readDeadElements Returns `{observation, gcDefragThreshold}` at operation start.
 * @param {Function} collaborators.withWriterFence Acquires the `kbWriteExclusive` heavy-maintenance lease around `task({lease})`.
 * @param {Function} collaborators.probeKbWriteGate Probes `kb-server` healthcheck `writeGate` block.
 * @param {Function} collaborators.writeBackupBundle Captures a fresh backup bundle (`{bundleRoot, meta}`).
 * @param {Function} [collaborators.inspectBundle=inspectAndHashKbBundle] Verifies survivability and extracts `{bundleSha, kbDir, sourceIds, sampleRow}`.
 * @param {Function} collaborators.checkFreeDisk Verifies guest disk headroom (`{ok, freeBytes, requiredBytes}`) before shadow creation.
 * @param {Function} collaborators.promoteShadow Streams bundle rows into a shadow collection and promotes it to canonical.
 * @param {Function} collaborators.restartService Restarts a compose service (`'chroma'` / `'kb-server'`) via `applyLifecycle`.
 * @param {Function} [collaborators.waitForChromaReady=async()=>{}] Awaits Chroma readiness after `chroma` restart.
 * @param {Function} collaborators.revalidateCanonical Validates post-restart count, ID set, and sampled vector against the bundle.
 * @param {Function} collaborators.restoreFromBundle Restores canonical KB collection from `<bundleRoot>/kb` on post-restart mismatch.
 * @param {Number} [collaborators.drainTimeoutMs=DEFAULT_DRAIN_ACK_TIMEOUT_MS] Maximum wait for `kb-server` drain acknowledgement.
 * @param {Number} [collaborators.drainPollIntervalMs=DEFAULT_DRAIN_ACK_POLL_INTERVAL_MS] Poll interval for `kb-server` drain check.
 * @param {Function} [collaborators.clock=Date.now] Clock seam.
 * @param {Function} [collaborators.sleep=defaultSleep] Sleep seam.
 * @returns {Function} `async ({collection, evidence, now}) => Promise<{status: String, detail: Object}>`
 */
export function createDefragHealOperation({
    getExpectedCollection,
    readDeadElements,
    withWriterFence,
    probeKbWriteGate,
    writeBackupBundle,
    inspectBundle       = inspectAndHashKbBundle,
    checkFreeDisk,
    promoteShadow,
    restartService,
    waitForChromaReady  = async () => {},
    revalidateCanonical,
    restoreFromBundle,
    drainTimeoutMs      = DEFAULT_DRAIN_ACK_TIMEOUT_MS,
    drainPollIntervalMs = DEFAULT_DRAIN_ACK_POLL_INTERVAL_MS,
    clock               = Date.now,
    sleep               = defaultSleep
} = {}) {
    const required = {
        getExpectedCollection,
        readDeadElements,
        withWriterFence,
        probeKbWriteGate,
        writeBackupBundle,
        inspectBundle,
        checkFreeDisk,
        promoteShadow,
        restartService,
        waitForChromaReady,
        revalidateCanonical,
        restoreFromBundle,
        clock,
        sleep
    };

    for (const [name, value] of Object.entries(required)) {
        if (typeof value !== 'function') {
            throw new TypeError(`createDefragHealOperation: ${name} must be a function`);
        }
    }

    return async function defragHealOperation({collection, now} = {}) {
        const expectedCollection = getExpectedCollection();

        if (
            typeof expectedCollection !== 'string' ||
            expectedCollection.length === 0 ||
            typeof collection !== 'string' ||
            collection !== expectedCollection
        ) {
            return {
                status: 'unsafe-input',
                detail: {
                    reason            : 'unsupported-defrag-target',
                    collection        : collection ?? null,
                    expectedCollection: expectedCollection ?? null
                }
            };
        }

        const {observation, gcDefragThreshold} = await readDeadElements();

        if (!Number.isFinite(gcDefragThreshold) || gcDefragThreshold <= 0 || gcDefragThreshold >= 1) {
            return {
                status: 'unsafe-input',
                detail: {
                    reason           : 'invalid-defrag-threshold',
                    gcDefragThreshold: gcDefragThreshold ?? null
                }
            };
        }

        if (!observation || observation.status !== 'ok') {
            return {
                status: 'deferred',
                detail: {
                    reason           : 'dead-element-observation-unavailable',
                    observationStatus: observation?.status ?? 'missing',
                    observationReason: observation?.reason ?? null
                }
            };
        }

        if (!Number.isSafeInteger(observation.liveCount) || observation.liveCount <= 0) {
            return {
                status: 'deferred',
                detail: {
                    reason   : 'empty-live-collection',
                    liveCount: observation.liveCount ?? null
                }
            };
        }

        if (!Number.isFinite(observation.deadFraction) || observation.deadFraction <= gcDefragThreshold) {
            return {
                status: 'deferred',
                detail: {
                    reason       : 'below-defrag-threshold',
                    deadFraction : observation.deadFraction ?? null,
                    gcDefragThreshold,
                    liveCount    : observation.liveCount,
                    hnswOccupancy: observation.hnswOccupancy ?? null
                }
            };
        }

        return withWriterFence(async ({lease} = {}) => {
            const leaseId = typeof lease?.leaseId === 'string' && lease.leaseId.length > 0
                ? lease.leaseId
                : null;

            if (!leaseId) {
                return {
                    status: 'deferred',
                    detail: {
                        reason: 'writer-fence-missing-lease-id'
                    }
                };
            }

            const drainAck = await waitForKbWriteDrainAck({
                leaseId,
                probeKbWriteGate,
                timeoutMs     : drainTimeoutMs,
                pollIntervalMs: drainPollIntervalMs,
                clock,
                sleep
            });

            if (!drainAck.acknowledged) {
                return {
                    status: 'deferred',
                    detail: {
                        reason        : 'kb-write-drain-unacknowledged',
                        leaseId,
                        timeoutMs     : drainTimeoutMs,
                        lastWriteGate : drainAck.writeGate,
                        lastProbeError: drainAck.lastProbeError
                    }
                };
            }

            const backupResult = await writeBackupBundle(),
                  bundleInfo   = await inspectBundle({
                      bundleRoot       : backupResult?.bundleRoot,
                      meta             : backupResult?.meta,
                      expectedDimension: observation.dimension ?? null
                  });

            if (!bundleInfo?.ok) {
                return {
                    status: 'failed',
                    detail: {
                        reason     : bundleInfo?.reason || 'bundle-integrity-check-failed',
                        bundleRoot : backupResult?.bundleRoot ?? null,
                        bundleSha  : bundleInfo?.bundleSha ?? null,
                        restorable : bundleInfo?.restorable ?? null,
                        kbIntegrity: bundleInfo?.kbIntegrity ?? null
                    }
                };
            }

            const diskPreflight = await checkFreeDisk({
                liveCount       : bundleInfo.expectedCount,
                dimension       : observation.dimension ?? 4096,
                hnswOccupancy   : observation.hnswOccupancy ?? 0,
                vectorSegmentIds: observation.vectorSegmentIds ?? []
            });

            if (!diskPreflight?.ok) {
                return {
                    status: 'deferred',
                    detail: {
                        reason       : diskPreflight?.reason || 'insufficient-free-disk-for-shadow',
                        freeBytes    : diskPreflight?.freeBytes ?? null,
                        requiredBytes: diskPreflight?.requiredBytes ?? null,
                        bundleSha    : bundleInfo.bundleSha,
                        bundleRoot   : backupResult.bundleRoot
                    }
                };
            }

            const promotion = await promoteShadow({
                collectionName: expectedCollection,
                bundleRoot    : backupResult.bundleRoot,
                kbDir         : bundleInfo.kbDir,
                sourceIds     : bundleInfo.sourceIds,
                bundleSha     : bundleInfo.bundleSha,
                now           : Number.isFinite(now) ? now : clock()
            });

            await restartService('chroma');
            await waitForChromaReady();

            const validation = await revalidateCanonical({
                collectionName: expectedCollection,
                expectedIds   : bundleInfo.sourceIds,
                sampleRow     : bundleInfo.sampleRow
            });

            if (!validation?.valid) {
                let restored     = false,
                    restoreError = null;

                try {
                    await restoreFromBundle({
                        bundleRoot : backupResult.bundleRoot,
                        kbDir      : bundleInfo.kbDir,
                        expectedIds: bundleInfo.sourceIds,
                        extraIds   : validation?.extraIds ?? []
                    });
                    restored = true;
                } catch (error) {
                    restoreError = error?.message ?? String(error);
                }

                try {
                    await restartService('kb-server');
                } catch (kbRestartError) {
                    restoreError = restoreError
                        ? `${restoreError}; kb-server restart failed: ${kbRestartError?.message ?? String(kbRestartError)}`
                        : `kb-server restart failed: ${kbRestartError?.message ?? String(kbRestartError)}`;
                }

                return {
                    status: 'failed',
                    detail: {
                        reason        : validation?.reason || 'post-restart-validation-mismatch',
                        collection    : expectedCollection,
                        expectedCount : validation?.expectedCount ?? bundleInfo.expectedCount,
                        observedCount : validation?.observedCount ?? null,
                        missingIdCount: validation?.missingIdCount ?? null,
                        extraIdCount  : validation?.extraIdCount ?? null,
                        sampleValid   : validation?.sampleValid ?? false,
                        bundleSha     : bundleInfo.bundleSha,
                        bundleRoot    : backupResult.bundleRoot,
                        restored,
                        ...(restoreError ? {restoreError} : {})
                    }
                };
            }

            await restartService('kb-server');

            return {
                status: 'healed',
                detail: {
                    collection         : expectedCollection,
                    bundleSha          : bundleInfo.bundleSha,
                    bundleRoot         : backupResult.bundleRoot,
                    expectedCount      : validation.expectedCount,
                    observedCount      : validation.observedCount,
                    deadFractionBefore : observation.deadFraction,
                    hnswOccupancyBefore: observation.hnswOccupancy,
                    liveCountBefore    : observation.liveCount,
                    shadowName         : promotion?.shadowName ?? null,
                    parkingName        : promotion?.parkingName ?? null,
                    parkingDeleted     : promotion?.parkingDeleted ?? null
                }
            };
        });
    };
}
