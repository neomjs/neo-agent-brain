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
 * 8. On any post-promotion throw (`chroma` restart, readiness wait, or re-validation), retains the durable
 *    attempt state (`bundleSha` + `bundleRoot`), restarts `kb-server` before releasing the lease, and returns
 *    structured `failed` details so the next run reconciles the unverified canonical collection.
 * 9. On clean post-restart validation, restarts `kb-server` inside the lease to refresh cached collection
 *    handles, clears the durable attempt state, then releases the lease and returns `healed`.
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

export const UNVERIFIED_DEFRAG_ATTEMPT_PHASES = Object.freeze([
    'live-parked',
    'shadow-promoted',
    'canonical-validated',
    'parking-deleted',
    'chroma-restarting',
    'post-promotion-unverified',
    'kb-server-refresh-pending'
]);

const PRE_PROMOTION_ABORTED_PHASES = Object.freeze([
    'creating-shadow',
    'shadow-loading',
    'shadow-loaded',
    'live-rollback-complete',
    'shadow-parked-after-failure'
]);

/**
 * @summary Checks whether a persisted defrag attempt marker requires post-promotion reconciliation.
 * @param {Object|null|undefined} state Parsed defrag state JSON.
 * @returns {Boolean}
 */
export function isUnverifiedDefragAttemptState(state) {
    return Boolean(
        state &&
        typeof state === 'object' &&
        UNVERIFIED_DEFRAG_ATTEMPT_PHASES.includes(state.phase)
    );
}

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
    const checkMeta = candidateMeta => {
        const restorable = isBundleRestorable(candidateMeta?.integrity),
              kbCheck    = Array.isArray(candidateMeta?.integrity)
                  ? candidateMeta.integrity.find(entry => entry?.subsystem === 'kb') ?? null
                  : null,
              valid      = (
                  restorable === true &&
                  Boolean(kbCheck) &&
                  kbCheck.status === 'pass' &&
                  Number.isInteger(kbCheck.bundleCount) &&
                  kbCheck.bundleCount > 0 &&
                  kbCheck.bundleCount === kbCheck.sourceCount
              );

        return {valid, restorable, kbCheck};
    };

    if (meta !== undefined) {
        const {valid, restorable, kbCheck} = checkMeta(meta);
        if (!valid) {
            return {
                ok         : false,
                reason     : 'bundle-integrity-check-failed',
                restorable,
                kbIntegrity: kbCheck
            };
        }
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

    const resolvedMeta                 = meta !== undefined ? meta : await fsModule.readJson(metaPath),
          {valid, restorable, kbCheck} = checkMeta(resolvedMeta);

    if (!valid) {
        return {
            ok         : false,
            reason     : 'bundle-integrity-check-failed',
            restorable,
            kbIntegrity: kbCheck
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
 * All storage, lease, backup, lifecycle-restart, durable-state, and healthcheck collaborators are injected so the
 * state machine is deterministically unit-testable with zero live-service side effects. Once `promoteShadow`
 * mutates the canonical collection, every exit path refreshes `kb-server` inside the writer fence, preserves
 * `{bundleSha, bundleRoot, failedStep}` on failure, and keeps the durable attempt marker on disk until
 * post-restart validation (or bundle restore) and `kb-server` refresh both succeed.
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
 * @param {Function} [collaborators.readAttemptState=async()=>null] Reads persisted defrag attempt state when present.
 * @param {Function} [collaborators.writeAttemptState=async()=>{}] Persists durable post-promotion attempt state.
 * @param {Function} [collaborators.clearAttemptState=async()=>{}] Clears durable attempt state after verified completion.
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
    readAttemptState    = async () => null,
    writeAttemptState   = async () => {},
    clearAttemptState   = async () => {},
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
        readAttemptState,
        writeAttemptState,
        clearAttemptState,
        clock,
        sleep
    };

    for (const [name, value] of Object.entries(required)) {
        if (typeof value !== 'function') {
            throw new TypeError(`createDefragHealOperation: ${name} must be a function`);
        }
    }

    const refreshKbServerSafely = async () => {
        try {
            await restartService('kb-server');
            return {kbServerRestarted: true, kbRestartError: null};
        } catch (kbError) {
            return {
                kbServerRestarted: false,
                kbRestartError   : kbError?.message ?? String(kbError)
            };
        }
    };

    const readAttemptStateSafely = async () => {
        try {
            return await readAttemptState();
        } catch {
            return null;
        }
    };

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

        const completePostPromotionVerification = async ({
            bundleRoot,
            bundleInfo,
            expectedDimension,
            initialPhase,
            reconciledInterruptedAttempt = false,
            priorFailedStep              = null,
            observationBefore            = null,
            promotion                    = null
        }) => {
            const persistUnverifiedState = async (phase, failedStep, lastError = null) => {
                try {
                    await writeAttemptState({
                        targetName       : 'knowledge-base',
                        collectionName   : expectedCollection,
                        bundleRoot,
                        bundleSha        : bundleInfo.bundleSha,
                        expectedCount    : bundleInfo.expectedCount,
                        expectedDimension: expectedDimension ?? null,
                        shadowName       : promotion?.shadowName ?? null,
                        parkingName      : promotion?.parkingName ?? null,
                        parkingDeleted   : promotion?.parkingDeleted ?? null,
                        phase,
                        failedStep,
                        ...(lastError ? {lastError} : {})
                    });
                } catch {
                    // Best-effort durable state write; structured failed outcome still carries bundleSha/bundleRoot.
                }
            };

            const reconcileMeta = reconciledInterruptedAttempt
                ? {reconciledInterruptedAttempt: true, resumedFromPhase: initialPhase}
                : {};

            if (initialPhase !== 'kb-server-refresh-pending') {
                const needsChromaRestart = (
                    !reconciledInterruptedAttempt ||
                    ['shadow-promoted', 'canonical-validated', 'parking-deleted'].includes(initialPhase) ||
                    priorFailedStep === 'chroma-restart'
                );

                let currentStep = 'chroma-restart',
                    validation  = null;

                try {
                    if (needsChromaRestart) {
                        await persistUnverifiedState('chroma-restarting', null);
                        await restartService('chroma');
                    }

                    currentStep = 'chroma-readiness';
                    await waitForChromaReady();

                    currentStep = 'post-restart-revalidation';
                    validation = await revalidateCanonical({
                        collectionName: expectedCollection,
                        expectedIds   : bundleInfo.sourceIds,
                        sampleRow     : bundleInfo.sampleRow
                    });
                } catch (stepError) {
                    const errorMsg = stepError?.message ?? String(stepError);
                    await persistUnverifiedState('post-promotion-unverified', currentStep, errorMsg);
                    const {kbServerRestarted, kbRestartError} = await refreshKbServerSafely();

                    return {
                        status: 'failed',
                        detail: {
                            reason              : `${currentStep}-failed`,
                            failedStep          : currentStep,
                            error               : errorMsg,
                            collection          : expectedCollection,
                            expectedCount       : bundleInfo.expectedCount,
                            bundleSha           : bundleInfo.bundleSha,
                            bundleRoot,
                            postRestartValidated: false,
                            kbServerRestarted,
                            ...reconcileMeta,
                            ...(kbRestartError ? {kbRestartError} : {})
                        }
                    };
                }

                if (!validation?.valid) {
                    let restored     = false,
                        restoreError = null;

                    try {
                        await restoreFromBundle({
                            bundleRoot,
                            kbDir      : bundleInfo.kbDir,
                            expectedIds: bundleInfo.sourceIds,
                            extraIds   : validation?.extraIds ?? []
                        });
                        restored = true;
                    } catch (error) {
                        restoreError = error?.message ?? String(error);
                    }

                    const {kbServerRestarted, kbRestartError} = await refreshKbServerSafely(),
                          failedStep                          = !restored
                              ? 'bundle-restore'
                              : (!kbServerRestarted ? 'kb-server-restart' : 'post-restart-validation'),
                          combinedRestoreError                = [
                              restoreError,
                              kbRestartError ? `kb-server restart failed: ${kbRestartError}` : null
                          ].filter(Boolean).join('; ') || null;

                    if (restored && kbServerRestarted) {
                        await clearAttemptState();
                    } else {
                        await persistUnverifiedState(
                            restored ? 'kb-server-refresh-pending' : 'post-promotion-unverified',
                            failedStep,
                            combinedRestoreError
                        );
                    }

                    return {
                        status: 'failed',
                        detail: {
                            reason        : validation?.reason || 'post-restart-validation-mismatch',
                            failedStep,
                            collection    : expectedCollection,
                            expectedCount : validation?.expectedCount ?? bundleInfo.expectedCount,
                            observedCount : validation?.observedCount ?? null,
                            missingIdCount: validation?.missingIdCount ?? null,
                            extraIdCount  : validation?.extraIdCount ?? null,
                            sampleValid   : validation?.sampleValid ?? false,
                            bundleSha     : bundleInfo.bundleSha,
                            bundleRoot,
                            restored,
                            kbServerRestarted,
                            ...reconcileMeta,
                            ...(combinedRestoreError ? {restoreError: combinedRestoreError} : {})
                        }
                    };
                }
            }

            const {kbServerRestarted, kbRestartError} = await refreshKbServerSafely();

            if (!kbServerRestarted) {
                await persistUnverifiedState('kb-server-refresh-pending', 'kb-server-restart', kbRestartError);
                return {
                    status: 'failed',
                    detail: {
                        reason              : 'kb-server-restart-failed',
                        failedStep          : 'kb-server-restart',
                        error               : kbRestartError,
                        collection          : expectedCollection,
                        expectedCount       : bundleInfo.expectedCount,
                        observedCount       : bundleInfo.expectedCount,
                        bundleSha           : bundleInfo.bundleSha,
                        bundleRoot,
                        postRestartValidated: true,
                        kbServerRestarted   : false,
                        ...reconcileMeta
                    }
                };
            }

            await clearAttemptState();

            return {
                status: 'healed',
                detail: {
                    collection         : expectedCollection,
                    bundleSha          : bundleInfo.bundleSha,
                    bundleRoot,
                    expectedCount      : bundleInfo.expectedCount,
                    observedCount      : bundleInfo.expectedCount,
                    deadFractionBefore : observationBefore?.deadFraction ?? null,
                    hnswOccupancyBefore: observationBefore?.hnswOccupancy ?? null,
                    liveCountBefore    : observationBefore?.liveCount ?? null,
                    shadowName         : promotion?.shadowName ?? null,
                    parkingName        : promotion?.parkingName ?? null,
                    parkingDeleted     : promotion?.parkingDeleted ?? null,
                    ...reconcileMeta
                }
            };
        };

        const acquireAndDrainOrDefer = async lease => {
            const leaseId = typeof lease?.leaseId === 'string' && lease.leaseId.length > 0
                ? lease.leaseId
                : null;

            if (!leaseId) {
                return {
                    deferred: {
                        status: 'deferred',
                        detail: {reason: 'writer-fence-missing-lease-id'}
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
                    deferred: {
                        status: 'deferred',
                        detail: {
                            reason        : 'kb-write-drain-unacknowledged',
                            leaseId,
                            timeoutMs     : drainTimeoutMs,
                            lastWriteGate : drainAck.writeGate,
                            lastProbeError: drainAck.lastProbeError
                        }
                    }
                };
            }

            return {deferred: null};
        };

        const initialAttemptState = await readAttemptStateSafely();

        if (isUnverifiedDefragAttemptState(initialAttemptState)) {
            return withWriterFence(async ({lease} = {}) => {
                const {deferred} = await acquireAndDrainOrDefer(lease);
                if (deferred) {
                    return deferred;
                }

                const priorAttempt = await readAttemptStateSafely();
                if (!isUnverifiedDefragAttemptState(priorAttempt)) {
                    return {
                        status: 'deferred',
                        detail: {reason: 'prior-attempt-already-reconciled'}
                    };
                }

                const bundleInfo = await inspectBundle({
                    bundleRoot       : priorAttempt.bundleRoot,
                    expectedDimension: priorAttempt.expectedDimension ?? null
                });

                if (!bundleInfo?.ok || (priorAttempt.bundleSha && bundleInfo.bundleSha !== priorAttempt.bundleSha)) {
                    const {kbServerRestarted, kbRestartError} = await refreshKbServerSafely();
                    return {
                        status: 'failed',
                        detail: {
                            reason                      : bundleInfo?.ok ? 'reconcile-bundle-sha-mismatch' : (bundleInfo?.reason || 'reconcile-bundle-unavailable'),
                            failedStep                  : 'reconcile-bundle',
                            collection                  : expectedCollection,
                            bundleRoot                  : priorAttempt.bundleRoot ?? null,
                            bundleSha                   : priorAttempt.bundleSha ?? bundleInfo?.bundleSha ?? null,
                            observedBundleSha           : bundleInfo?.bundleSha ?? null,
                            postRestartValidated        : false,
                            kbServerRestarted,
                            reconciledInterruptedAttempt: true,
                            resumedFromPhase            : priorAttempt.phase,
                            ...(kbRestartError ? {kbRestartError} : {})
                        }
                    };
                }

                return completePostPromotionVerification({
                    bundleRoot                  : priorAttempt.bundleRoot,
                    bundleInfo,
                    expectedDimension           : priorAttempt.expectedDimension ?? null,
                    initialPhase                : priorAttempt.phase,
                    reconciledInterruptedAttempt: true,
                    priorFailedStep             : priorAttempt.failedStep ?? null,
                    promotion                   : {
                        shadowName    : priorAttempt.shadowName ?? null,
                        parkingName   : priorAttempt.parkingName ?? null,
                        parkingDeleted: priorAttempt.parkingDeleted ?? null
                    }
                });
            });
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
            const {deferred} = await acquireAndDrainOrDefer(lease);
            if (deferred) {
                return deferred;
            }

            const existingState = await readAttemptStateSafely();
            if (existingState && PRE_PROMOTION_ABORTED_PHASES.includes(existingState.phase)) {
                await clearAttemptState();
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
                        failedStep : 'bundle-integrity',
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

            let promotion;
            try {
                promotion = await promoteShadow({
                    collectionName   : expectedCollection,
                    bundleRoot       : backupResult.bundleRoot,
                    kbDir            : bundleInfo.kbDir,
                    sourceIds        : bundleInfo.sourceIds,
                    bundleSha        : bundleInfo.bundleSha,
                    expectedDimension: observation.dimension ?? null,
                    now              : Number.isFinite(now) ? now : clock()
                });
            } catch (promoError) {
                const errorMsg               = promoError?.message ?? String(promoError),
                      stateAfterPromoFailure = await readAttemptStateSafely();

                if (isUnverifiedDefragAttemptState(stateAfterPromoFailure)) {
                    try {
                        await writeAttemptState({
                            ...stateAfterPromoFailure,
                            targetName       : 'knowledge-base',
                            collectionName   : expectedCollection,
                            bundleRoot       : backupResult.bundleRoot,
                            bundleSha        : bundleInfo.bundleSha,
                            expectedCount    : bundleInfo.expectedCount,
                            expectedDimension: observation.dimension ?? null,
                            phase            : 'post-promotion-unverified',
                            failedStep       : 'shadow-promotion',
                            lastError        : errorMsg
                        });
                    } catch {
                        // Best-effort durable state write.
                    }
                    const {kbServerRestarted, kbRestartError} = await refreshKbServerSafely();
                    return {
                        status: 'failed',
                        detail: {
                            reason              : 'shadow-promotion-failed-after-rename',
                            failedStep          : 'shadow-promotion',
                            error               : errorMsg,
                            collection          : expectedCollection,
                            expectedCount       : bundleInfo.expectedCount,
                            bundleSha           : bundleInfo.bundleSha,
                            bundleRoot          : backupResult.bundleRoot,
                            postRestartValidated: false,
                            kbServerRestarted,
                            ...(kbRestartError ? {kbRestartError} : {})
                        }
                    };
                }

                await clearAttemptState();
                return {
                    status: 'failed',
                    detail: {
                        reason              : 'shadow-promotion-failed',
                        failedStep          : 'shadow-promotion',
                        error               : errorMsg,
                        collection          : expectedCollection,
                        expectedCount       : bundleInfo.expectedCount,
                        bundleSha           : bundleInfo.bundleSha,
                        bundleRoot          : backupResult.bundleRoot,
                        postRestartValidated: false,
                        kbServerRestarted   : false
                    }
                };
            }

            return completePostPromotionVerification({
                bundleRoot       : backupResult.bundleRoot,
                bundleInfo,
                expectedDimension: observation.dimension ?? null,
                initialPhase     : 'parking-deleted',
                observationBefore: observation,
                promotion
            });
        });
    };
}
