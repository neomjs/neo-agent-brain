/**
 * @module ai/daemons/wake/primaryWakeBatch
 * @summary Selects and renders bounded catch-up digests from receiver-approved ordinary and urgent wakes.
 * The receiver owns eligibility and the native slot owns the frozen membership and receipt.
 */

import {formatLocalWakeDigest} from './localWakeAdapters.mjs';

/** @summary An admitted batch has at most this many source events. Every member owns at least one. */
export const MAX_PRIMARY_WAKE_BATCH_EVENTS = 48;
/** @summary Upper bound on staged urgent candidate keys kept in the urgent spool pointer under overflow. */
export const MAX_URGENT_SPOOL_CANDIDATES   = 512;
/** @summary Primary-session harness families that coalesce eligible wakes at idle boundaries. */
export const PRIMARY_WAKE_BATCH_FAMILIES   = Object.freeze(new Set(['codex-desktop', 'antigravity']));
const MAX_DIGEST_BYTES = 16 * 1024;
const BUCKETS          = ['sent_to_me', 'task_state_changed', 'permission_granted', 'heartbeat_pulse'];
const PRIORITIES       = ['low', 'normal', 'high'];
const RECORD_KEY       = /^[a-f0-9]{64}$/;

/** @summary Returns whether a primary-session family coalesces ordinary wakes at idle boundaries. */
export function isBatchCapablePrimaryFamily(family) {
    return PRIMARY_WAKE_BATCH_FAMILIES.has(family)
}

/** @summary Checks that one original record has a nonempty set of unambiguous source identities. */
function validSources(sourceEventIds) {
    return Array.isArray(sourceEventIds) && sourceEventIds.length > 0 &&
        sourceEventIds.every(id => typeof id === 'string' && id.trim().length > 0) &&
        new Set(sourceEventIds).size === sourceEventIds.length
}

/**
 * @summary Checks that this accepted record still matches the exact frozen member.
 * @param {Object} record Accepted receiver record.
 * @param {Object} member Frozen record key and ordered source event identities.
 * @returns {Boolean}
 */
export function matchesPrimaryWakeMember(record, member) {
    const ids = record?.sourceEventIds, frozen = member?.sourceEventIds;
    return typeof record?.recordKey === 'string' && RECORD_KEY.test(record.recordKey) &&
        record.recordKey === member?.recordKey && validSources(ids) && Array.isArray(frozen) &&
        ids.length === frozen.length && ids.every((id, index) => id === frozen[index])
}

/**
 * @summary Resolves the wire-contract recency timestamp for one digest bucket, matching
 * `CoalescingEngineService._buildDigestEnvelope` (`latestTs`, then `sentAt` / `grantedAt` /
 * `lastModifiedAt`, then `envelope.emittedAt`). Returns `null` when no timestamp is present so
 * timestamp-less records retain acceptance-order last-write-wins.
 * @param {Object} bucket
 * @param {Object} envelope
 * @returns {Number|null}
 */
function resolveBucketTimestamp(bucket, envelope) {
    if (typeof bucket?.latestTs === 'number' && Number.isFinite(bucket.latestTs)) {
        return bucket.latestTs
    }
    const latest = bucket?.latest;
    for (const field of ['sentAt', 'grantedAt', 'lastModifiedAt']) {
        const value = latest?.[field];
        if (typeof value === 'string') {
            const ts = Date.parse(value);
            if (Number.isFinite(ts)) return ts
        }
    }
    const emitted = envelope?.emittedAt;
    if (typeof emitted === 'number' && Number.isFinite(emitted)) return emitted;
    if (typeof emitted === 'string') {
        const ts = Date.parse(emitted);
        if (Number.isFinite(ts)) return ts
    }
    return null
}

/**
 * @summary Renders one digest using the existing wake summaries across the selected batch.
 * Counts accumulate across all members. Each category resolves `latest` by true wire-contract
 * event recency (falling back to acceptance order only when timestamps are absent), and the
 * message category keeps the highest priority seen across the batch.
 * @param {Object[]} records Ordered accepted receiver records from one subscription.
 * @returns {String} The wake text before the native receipt marker is appended.
 */
export function formatPrimaryWakeBatch(records) {
    const breakdown        = {},
          latestTsByBucket = {};
    let totalEvents = 0;
    for (const {envelope, sourceEventIds} of records) {
        totalEvents += sourceEventIds.length;
        for (const key of BUCKETS) {
            const bucket = envelope.payload?.breakdown?.[key];
            if (!Number.isSafeInteger(bucket?.count) || bucket.count < 1) continue;
            const aggregate = breakdown[key] ??= {count: 0};
            aggregate.count += bucket.count;
            if (bucket.latest) {
                const ts     = resolveBucketTimestamp(bucket, envelope),
                      prevTs = latestTsByBucket[key] ?? null;
                if (!aggregate.latest || (ts !== null ? (prevTs === null || ts >= prevTs) : prevTs === null)) {
                    aggregate.latest      = bucket.latest;
                    latestTsByBucket[key] = ts ?? prevTs
                }
            }
            if (key === 'sent_to_me') {
                const priority   = bucket.highestPriority || bucket.latest?.priority,
                      normalized = PRIORITIES.includes(priority) ? priority : 'normal';
                if (PRIORITIES.indexOf(normalized) > PRIORITIES.indexOf(aggregate.highestPriority)) {
                    aggregate.highestPriority = normalized
                }
            }
        }
    }
    return formatLocalWakeDigest({agentIdentity: records[0]?.envelope?.agentIdentity, payload: {totalEvents, breakdown}})
}

/**
 * @summary Selects a bounded prefix with at least two indivisible receiver records.
 * The caller supplies a vetted, ordered snapshot from one subscription, with its spool anchor first.
 * The caller stops its content prefix at waiting records and leaves idle-only nudges on their own path.
 * This selector then stops at the first source-identity or size boundary.
 * @param {Object[]} records Ordered, eligible ordinary receiver records.
 * @returns {Object[]|undefined} Ordered record keys and source event identities, or undefined for singleton delivery.
 */
export function selectPrimaryWakeBatch(records) {
    const selected = [], members = [], sourceIds = new Set(), recordKeys = new Set();
    for (const record of records) {
        const {recordKey, sourceEventIds, envelope} = record;
        if (!RECORD_KEY.test(recordKey) || !validSources(sourceEventIds) ||
            sourceEventIds.length !== envelope?.payload?.totalEvents || recordKeys.has(recordKey) ||
            sourceIds.size + sourceEventIds.length > MAX_PRIMARY_WAKE_BATCH_EVENTS ||
            sourceEventIds.some(id => sourceIds.has(id))) break;
        selected.push(record);
        if (Buffer.byteLength(formatPrimaryWakeBatch(selected), 'utf8') > MAX_DIGEST_BYTES) break;
        members.push({recordKey, sourceEventIds: sourceEventIds.slice()});
        recordKeys.add(recordKey);
        for (const id of sourceEventIds) sourceIds.add(id)
    }
    return members.length > 1 ? members : undefined
}

/** @summary Checks whether an ordered record subset stays within event, uniqueness, and UTF-8 byte bounds. */
function batchSubsetFits(records) {
    const sourceIds = new Set();
    let   events    = 0;
    for (const {sourceEventIds} of records) {
        events += sourceEventIds.length;
        if (events > MAX_PRIMARY_WAKE_BATCH_EVENTS) return false;
        for (const id of sourceEventIds) {
            if (sourceIds.has(id)) return false;
            sourceIds.add(id)
        }
    }
    return Buffer.byteLength(formatPrimaryWakeBatch(records), 'utf8') <= MAX_DIGEST_BYTES
}

/** @summary Vets an ordered urgent record sequence up to the first malformed or duplicate entry. */
function vetUrgentRecords(records) {
    const vetted = [], seenKeys = new Set();
    for (const record of records ?? []) {
        const {recordKey, sourceEventIds, envelope} = record ?? {};
        if (!RECORD_KEY.test(recordKey ?? '') || !validSources(sourceEventIds) ||
            sourceEventIds.length !== envelope?.payload?.totalEvents || seenKeys.has(recordKey)) break;
        vetted.push(record);
        seenKeys.add(recordKey)
    }
    return vetted
}

/** @summary Maps selected receiver records to frozen attempt membership entries. */
function toBatchMembers(records) {
    return records.map(({recordKey, sourceEventIds}) => ({recordKey, sourceEventIds: sourceEventIds.slice()}))
}

/**
 * @summary Pairs an oldest prefix anchored at `vetted[0]` with compatible newest tail records ending at `vetted.at(-1)`,
 * skipping oversize middle records on the tail side so earlier small fresh arrivals are not stranded.
 */
function selectHeadTailUrgentRecords(vetted) {
    const head = [vetted[0]], tail = [vetted.at(-1)];
    let   left = 1, right = vetted.length - 2, headOpen = true;
    while (left <= right) {
        if (headOpen) {
            const candidate = [...head, vetted[left], ...tail];
            if (batchSubsetFits(candidate)) { head.push(vetted[left]); left++ }
            else headOpen = false
        }
        if (left <= right) {
            const candidate = [...head, vetted[right], ...tail];
            if (batchSubsetFits(candidate)) tail.unshift(vetted[right]);
            right--
        }
    }
    return [...head, ...tail]
}

/**
 * @summary Selects `vetted.at(-1)` plus earlier compatible urgent records in chronological order, skipping oversize
 * records that cannot share the batch so overtaken small fresh arrivals surface on the same fresh-tail turn.
 */
function selectNewestUrgentTail(vetted) {
    const last = vetted.at(-1);
    if (!batchSubsetFits([last])) return [last];
    const tail = [last];
    for (let index = vetted.length - 2; index >= 0; index--) {
        const candidate = [vetted[index], ...tail];
        if (batchSubsetFits(candidate)) tail.unshift(vetted[index])
    }
    return tail
}

/**
 * @summary Selects a bounded urgent catch-up batch keeping fresh tail arrivals visible alongside oldest progress.
 * When all vetted records fit within the event and byte budgets, returns the full sequence. Under overflow, pairs
 * a contiguous oldest prefix (anchored at `records[0]` so every turn retires older backlog without starvation)
 * with compatible newest tail records so recent urgent work surfaces on the first idle turn. If `records[0]` and the
 * newest record cannot fit together, falls back to {@link selectPrimaryWakeBatch} for that anchor; cross-turn
 * bounded freshness across consecutive incompatible full records is enforced by {@link selectUrgentPrimaryWakeTurn}.
 * @param {Object[]} records Ordered, eligible urgent receiver records with the attempt anchor first.
 * @returns {Object[]|undefined} Ordered record keys and source event identities, or undefined for singleton delivery.
 */
export function selectUrgentPrimaryWakeBatch(records) {
    const vetted = vetUrgentRecords(records);
    if (vetted.length < 2) return undefined;
    const full = selectPrimaryWakeBatch(vetted);
    if (full?.length === vetted.length) return full;

    const first = vetted[0], last = vetted.at(-1);
    if (!batchSubsetFits([first, last])) return full;

    return toBatchMembers(selectHeadTailUrgentRecords(vetted))
}

/**
 * @summary Plans one idle urgent turn with 1:1 oldest/fresh-tail alternation and non-blocking tail packing.
 * - When all eligible urgent records fit (`<= 48` events, `<= 16 KiB`), or when `[oldest, newest]` fits under
 *   overflow, the newest urgent record and any earlier compatible tail records surface on **Turn 1** alongside
 *   oldest-prefix retirement (`nextPreferFreshTail = false`).
 * - When oversize records prevent `oldest` and `newest` from sharing one batch (e.g. consecutive 48-event full
 *   records), turns alternate 1:1 between retiring the oldest prefix/singleton (`preferFreshTail === false` →
 *   `nextPreferFreshTail = true`) and promoting the newest record plus any earlier compatible records that fit
 *   alongside it (`preferFreshTail === true` → `nextPreferFreshTail = false`, skipping incompatible oversize
 *   records rather than stopping at them). At each fresh-tail turn (at most 2 idle turns), the newest record
 *   and every compatible fresh record fit within remaining capacity surface immediately, while at least one
 *   oldest record retires per 2-turn cycle; an oversize arrival that cannot share a batch with a newer record
 *   waits for its oldest-or-tail slot (`<= 2` turns per ahead incompatible batch).
 * @param {Object[]} records Chronologically ordered eligible urgent receiver records.
 * @param {Object} [options={}]
 * @param {Boolean} [options.preferFreshTail=false] Whether the previous urgent turn excluded newer work due to an incompatible head.
 * @returns {{anchorRecord:Object,members:(Object[]|undefined),nextPreferFreshTail:Boolean}|null}
 */
export function selectUrgentPrimaryWakeTurn(records, {preferFreshTail = false} = {}) {
    const vetted = vetUrgentRecords(records);
    if (vetted.length === 0) return null;
    if (vetted.length === 1) return {anchorRecord: vetted[0], members: undefined, nextPreferFreshTail: false};

    const full = selectPrimaryWakeBatch(records);
    if (full?.length === vetted.length) {
        return {anchorRecord: vetted[0], members: full, nextPreferFreshTail: false}
    }

    const first = vetted[0], last = vetted.at(-1);
    if (batchSubsetFits([first, last])) {
        return {
            anchorRecord       : first,
            members            : toBatchMembers(selectHeadTailUrgentRecords(vetted)),
            nextPreferFreshTail: false
        }
    }

    if (preferFreshTail) {
        const tail = selectNewestUrgentTail(vetted);
        return {
            anchorRecord       : tail[0],
            members            : tail.length > 1 ? toBatchMembers(tail) : undefined,
            nextPreferFreshTail: false
        }
    }

    return {
        anchorRecord       : first,
        members            : full,
        nextPreferFreshTail: true
    }
}
