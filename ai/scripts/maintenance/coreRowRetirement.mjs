import {
    coreRowProtectionReason,
    fingerprint,
    metadataFingerprint
} from './coreRowRetirementPlan.mjs';

/** @summary Refuses a retirement with a stable code, without exposing stored content. */
function refuse(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

/** @summary Captures finite JSON values before borrowed input crosses an asynchronous boundary. */
function frozenSnapshot(value) {
    fingerprint(value);
    const freeze = item => {
        if (item && typeof item === 'object') {
            Object.values(item).forEach(freeze);
            Object.freeze(item);
        }
        return item;
    };
    return freeze(structuredClone(value));
}

/** @summary Returns one sorted, duplicate-free ID population or refuses malformed observations. */
function orderedIds(ids) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
        throw refuse('KB_CORE_RETIRE_INVALID_IDS');
    }
    return [...ids].sort();
}

/** @summary Compares exact ID populations independently of API result ordering. */
function sameIds(left, right) {
    return fingerprint(orderedIds(left)) === fingerprint(orderedIds(right));
}

/** @summary Rejects an invalid batch size before a paginated read can start. */
function assertPageSize(pageSize) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw refuse('KB_CORE_RETIRE_PAGE_SIZE_INVALID');
}

/**
 * @summary Reads a stable complete collection ID population without fetching foreign content.
 * @param {Object} collection Existing Chroma collection; this function never creates one.
 * @param {Number} pageSize
 * @returns {Promise<String[]>}
 */
export async function readCollectionIds(collection, pageSize) {
    assertPageSize(pageSize);
    const before = await collection.count();
    if (!Number.isSafeInteger(before) || before < 0) throw refuse('KB_CORE_RETIRE_COUNT_UNREADABLE');
    const ids = [];
    for (let offset = 0; offset <= before; offset += pageSize) {
        const page = await collection.get({include: [], limit: pageSize, offset});
        if (!Array.isArray(page.ids) || page.ids.length > pageSize) throw refuse('KB_CORE_RETIRE_PAGE_INVALID');
        ids.push(...page.ids);
        if (page.ids.length < pageSize) break;
    }
    if (await collection.count() !== before || ids.length !== before) throw refuse('KB_CORE_RETIRE_POPULATION_MOVED');
    return orderedIds(ids);
}

/**
 * @summary Reads only requested IDs and their metadata, preserving absence as an observation.
 * @param {Object} collection Existing Chroma collection.
 * @param {String[]} ids
 * @param {Number} pageSize
 * @returns {Promise<Map>}
 */
export async function readRetirementRows(collection, ids, pageSize) {
    assertPageSize(pageSize);
    const wanted = new Set(orderedIds(ids)), rows = new Map();
    for (let offset = 0; offset < ids.length; offset += pageSize) {
        const page = await collection.get({ids: ids.slice(offset, offset + pageSize), include: ['metadatas'], limit: pageSize});
        if (!Array.isArray(page.ids) || !Array.isArray(page.metadatas) || page.ids.length !== page.metadatas.length) {
            throw refuse('KB_CORE_RETIRE_METADATA_UNREADABLE');
        }
        page.ids.forEach((id, index) => {
            const metadata = page.metadatas[index];
            if (!wanted.has(id) || rows.has(id) || !metadata || typeof metadata !== 'object') {
                throw refuse('KB_CORE_RETIRE_METADATA_INVALID');
            }
            rows.set(id, metadata);
        });
    }
    return rows;
}

/**
 * @summary Checks the frozen plan's set relationships and family boundary before store access.
 * @param {Object} plan
 * @returns {Object} Bound original population and candidate snapshots.
 */
export function validateCoreRetirementPlan(plan) {
    if (!plan || typeof plan !== 'object') throw refuse('KB_CORE_RETIRE_PLAN_INVALID');
    const {planDigest, ...body} = plan;
    if (fingerprint(body) !== planDigest || plan.executable !== true || plan.refusals?.length !== 0) {
        throw refuse('KB_CORE_RETIRE_PLAN_UNCERTIFIED');
    }
    const {binding, candidates, census, preservation, retirementIds} = plan;
    if (!binding?.collectionId || !binding.scope || !Array.isArray(candidates) || !Array.isArray(census)) {
        throw refuse('KB_CORE_RETIRE_PLAN_INVALID');
    }
    const snapshots = new Map();
    for (const row of census) {
        if (snapshots.has(row.id) || metadataFingerprint(row.metadata) !== row.metadataDigest) {
            throw refuse('KB_CORE_RETIRE_CENSUS_INVALID');
        }
        snapshots.set(row.id, row);
    }
    const originalIds = orderedIds([...new Set([...snapshots.keys(), ...(binding.protectedIds || [])])]);
    const retired     = orderedIds(retirementIds);
    const retiredSet  = new Set(retired), protectedSet = new Set(binding.protectedIds || []);
    if (fingerprint(originalIds) !== binding.populationIdDigest || !sameIds(candidates.map(row => row.id), retired)) {
        throw refuse('KB_CORE_RETIRE_PLAN_POPULATION_INVALID');
    }
    if (retired.some(id => protectedSet.has(id))) throw refuse('KB_CORE_RETIRE_PROTECTED_CANDIDATE');
    const expectedPreserved = originalIds.filter(id => !retiredSet.has(id));
    if (!sameIds(preservation.ids, expectedPreserved) || preservation.count !== expectedPreserved.length
        || preservation.digest !== fingerprint(expectedPreserved)) {
        throw refuse('KB_CORE_RETIRE_PRESERVATION_INVALID');
    }
    const preservedSet = new Set(preservation.ids);
    for (const candidate of candidates) {
        const snapshot = snapshots.get(candidate.id);
        if (!snapshot || snapshot.metadataDigest !== candidate.metadataDigest
            || coreRowProtectionReason(snapshot.metadata, binding.scope)) {
            throw refuse('KB_CORE_RETIRE_PROTECTED_CANDIDATE');
        }
        if (!Array.isArray(candidate.replacements) || !candidate.replacements.length) {
            throw refuse('KB_CORE_RETIRE_REPLACEMENT_INVALID');
        }
        for (const replacement of candidate.replacements) {
            if (!Array.isArray(replacement.rows) || !replacement.rows.length
                || !sameIds(replacement.ids, replacement.rows.map(row => row.id))
                || replacement.rows.some(row => retiredSet.has(row.id) || !preservedSet.has(row.id)
                    || snapshots.get(row.id)?.metadataDigest !== row.metadataDigest)) {
                throw refuse('KB_CORE_RETIRE_REPLACEMENT_INVALID');
            }
        }
    }
    return {originalIds, snapshots};
}

/** @summary Validates resumable progress; only one persisted pending batch may be uncertain. */
function validateProgress(progress, plan) {
    if (!progress || progress.schemaVersion !== 'neo.legacy-core-retirement-progress/v1' || progress.planDigest !== plan.planDigest) {
        throw refuse('KB_CORE_RETIRE_PROGRESS_INVALID');
    }
    const confirmed  = orderedIds(progress.confirmed), pending = orderedIds(progress.pending);
    const plannedSet = new Set(plan.retirementIds), confirmedSet = new Set(confirmed);
    if ([...confirmed, ...pending].some(id => !plannedSet.has(id)) || pending.some(id => confirmedSet.has(id))
        || !Number.isSafeInteger(progress.batches) || progress.batches < 0) {
        throw refuse('KB_CORE_RETIRE_PROGRESS_INVALID');
    }
    if (progress.complete && (pending.length || !sameIds(confirmed, plan.retirementIds))) {
        throw refuse('KB_CORE_RETIRE_PROGRESS_INVALID');
    }
    return {...progress, confirmed, pending};
}

/**
 * @summary Applies one frozen retirement under an externally held heavy-maintenance lease.
 *
 * The entrypoint owns lease acquisition and exact input reloading. Before any delete, revalidate
 * rebuilds the redundancy proof against current artifact/map bytes and actual replacement rows.
 * The executor independently checks live old metadata, protected IDs and replacement fingerprints.
 * Persisting pending BEFORE dispatch allows a lost acknowledgement to be reconciled by reads on the
 * next explicit invocation; a confirmed ID reappearing is a refusal, not authority to delete again.
 * Chroma has no transaction: post-dispatch failures retain the journal and require reconciliation.
 *
 * @param {Object} options
 * @param {Object} options.collection Existing selected collection.
 * @param {Object} options.plan Frozen planner output.
 * @param {String} options.confirmation Exact plan digest approved for this application.
 * @param {Number} options.pageSize
 * @param {Function} options.revalidate Rebuilds current redundancy proof; returns its plan digest.
 * @param {Function} options.readProgress Reads persisted progress or null for a first invocation.
 * @param {Function} options.writeProgress Durably persists progress before resolving.
 * @returns {Promise<Object>} Counts and preservation receipt; never stored content.
 */
export async function applyCoreRowRetirement({
    collection, plan, confirmation, pageSize, revalidate, readProgress, writeProgress
}) {
    assertPageSize(pageSize);
    plan = frozenSnapshot(plan);
    const {originalIds} = validateCoreRetirementPlan(plan);
    if (confirmation !== plan.planDigest) throw refuse('KB_CORE_RETIRE_UNCONFIRMED');
    if (collection.id !== plan.binding.collectionId) throw refuse('KB_CORE_RETIRE_COLLECTION_CHANGED');
    if (typeof revalidate !== 'function' || typeof readProgress !== 'function' || typeof writeProgress !== 'function') {
        throw refuse('KB_CORE_RETIRE_DURABILITY_REQUIRED');
    }
    let progress = await readProgress();
    progress = progress ? validateProgress(progress, plan) : {
        schemaVersion: 'neo.legacy-core-retirement-progress/v1',
        planDigest   : plan.planDigest, confirmed: [], pending: [], batches: 0, complete: false
    };
    const alreadyComplete = progress.complete;
    let   stage           = 'revalidate';
    const receipt         = () => ({
        planDigest      : plan.planDigest,
        candidateCount  : plan.retirementIds.length,
        retiredConfirmed: progress.confirmed.length,
        pendingCount    : progress.pending.length,
        batches         : progress.batches,
        complete        : progress.complete
    });
    try {
        if (await revalidate(plan) !== plan.planDigest) throw refuse('KB_CORE_RETIRE_PROOF_CHANGED');
        stage = 'observe';
        const present     = await readCollectionIds(collection, pageSize), presentSet = new Set(present);
        const originalSet = new Set(originalIds), uncertain = new Set([...progress.confirmed, ...progress.pending]);
        if (present.some(id => !originalSet.has(id))
            || originalIds.some(id => !presentSet.has(id) && !uncertain.has(id))
            || progress.confirmed.some(id => presentSet.has(id))) {
            throw refuse('KB_CORE_RETIRE_POPULATION_CHANGED');
        }
        const oldIds  = plan.retirementIds.filter(id => presentSet.has(id));
        const oldRows = await readRetirementRows(collection, oldIds, pageSize);
        for (const candidate of plan.candidates) {
            if (!presentSet.has(candidate.id)) continue;
            const metadata = oldRows.get(candidate.id);
            if (!metadata || coreRowProtectionReason(metadata, plan.binding.scope)
                || metadataFingerprint(metadata) !== candidate.metadataDigest) {
                throw refuse('KB_CORE_RETIRE_OLD_ROW_CHANGED');
            }
        }
        const replacements = new Map();
        for (const candidate of plan.candidates) for (const replacement of candidate.replacements) {
            for (const row of replacement.rows) {
                if (replacements.has(row.id) && replacements.get(row.id) !== row.metadataDigest) {
                    throw refuse('KB_CORE_RETIRE_REPLACEMENT_INVALID');
                }
                replacements.set(row.id, row.metadataDigest);
            }
        }
        const targetRows = await readRetirementRows(collection, [...replacements.keys()], pageSize);
        for (const [id, digest] of replacements) {
            if (!targetRows.has(id) || metadataFingerprint(targetRows.get(id)) !== digest) {
                throw refuse('KB_CORE_RETIRE_REPLACEMENT_CHANGED');
            }
        }
        const confirmed = new Set(progress.confirmed);
        progress.pending.filter(id => !presentSet.has(id)).forEach(id => confirmed.add(id));
        progress = {...progress, confirmed: [...confirmed].sort(), pending: [], complete: false};
        await writeProgress(frozenSnapshot(progress));
        const remaining = plan.retirementIds.filter(id => !confirmed.has(id));
        for (let offset = 0; offset < remaining.length; offset += pageSize) {
            const batch = remaining.slice(offset, offset + pageSize);
            progress = {...progress, pending: batch, batches: progress.batches + 1};
            stage = 'persist-pending';
            await writeProgress(frozenSnapshot(progress));
            stage = 'delete';
            await collection.delete({ids: batch});
            stage = 'confirm-delete';
            if ((await readRetirementRows(collection, batch, pageSize)).size !== 0) {
                throw refuse('KB_CORE_RETIRE_DELETE_INCOMPLETE');
            }
            batch.forEach(id => confirmed.add(id));
            progress = {...progress, confirmed: [...confirmed].sort(), pending: []};
            stage = 'persist-confirmed';
            await writeProgress(frozenSnapshot(progress));
        }
        stage = 'preservation';
        const after = await readCollectionIds(collection, pageSize);
        if (!sameIds(after, plan.preservation.ids)) throw refuse('KB_CORE_RETIRE_PRESERVATION_CHANGED');
        progress = {...progress, complete: true};
        await writeProgress(frozenSnapshot(progress));
        return {...receipt(), alreadyComplete, preservation: {count: after.length, digest: fingerprint(after)}};
    } catch (cause) {
        const error = cause.code?.startsWith('KB_CORE_RETIRE_') ? cause : refuse('KB_CORE_RETIRE_INTERRUPTED');
        error.receipt = {...receipt(), stage, complete: false};
        throw error;
    }
}
