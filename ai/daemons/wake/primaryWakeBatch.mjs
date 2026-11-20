/**
 * @module ai/daemons/wake/primaryWakeBatch
 * @summary Selects and renders bounded catch-up digests from receiver-approved ordinary wakes.
 * The receiver owns eligibility and the native slot owns the frozen membership and receipt.
 */

import {formatLocalWakeDigest} from './localWakeAdapters.mjs';

/** @summary An admitted batch has at most this many source events. Every member owns at least one. */
export const MAX_PRIMARY_WAKE_BATCH_EVENTS = 48;
const MAX_DIGEST_BYTES  = 16 * 1024;
const BUCKETS           = ['sent_to_me', 'task_state_changed', 'permission_granted', 'heartbeat_pulse'];
const PRIORITIES       = ['low', 'normal', 'high'];
const RECORD_KEY       = /^[a-f0-9]{64}$/;

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
 * @summary Renders one digest using the existing wake summaries, in the order records were accepted.
 * Counts accumulate across all members. Each category keeps the last summarized payload and the
 * message category keeps the highest priority seen across the batch.
 * @param {Object[]} records Ordered accepted receiver records from one subscription.
 * @returns {String} The wake text before the native receipt marker is appended.
 */
export function formatPrimaryWakeBatch(records) {
    const breakdown = {};
    let   totalEvents = 0;
    for (const {envelope, sourceEventIds} of records) {
        totalEvents += sourceEventIds.length;
        for (const key of BUCKETS) {
            const bucket = envelope.payload?.breakdown?.[key];
            if (!Number.isSafeInteger(bucket?.count) || bucket.count < 1) continue;
            const aggregate = breakdown[key] ??= {count: 0};
            aggregate.count += bucket.count;
            if (bucket.latest) aggregate.latest = bucket.latest;
            if (key === 'sent_to_me') {
                const priority = bucket.highestPriority || bucket.latest?.priority,
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
