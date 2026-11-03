import {normalizeMailboxIdentityForComparison} from './mailboxReadStateClassifier.mjs';

/**
 * @module ai/services/memory-core/helpers/messageAdmission
 * @summary The message-level admission rule, as a predicate and as its Chroma `where` set form.
 *
 * `MailboxService.getMessage` decides with {@link canReadMessage} whether a caller may open a
 * message. `query_messages` pre-filters the message index with {@link admissionWhere} and re-checks
 * each hit with the same predicate. A property spec holds the two forms equal, so recall never
 * returns a message `get_message` would refuse. The explicit observer read (`mailboxObservation.mjs`)
 * is a separate admission family. No I/O, graph access or configuration lookup happens here.
 */

const BROADCAST = 'AGENT:*';

/**
 * @summary Decides whether `me` may open one message, from its routing facts.
 *
 * The sender and every direct recipient may read it. A broadcast admits the recipients snapshotted
 * at send time, and one without delivery edges (legacy or known-zero) admits everyone. An inbox
 * grant admits a direct message to that inbox, never a broadcast.
 *
 * @param {String} me Caller identity.
 * @param {Object} facts
 * @param {String|null} facts.sentBy The `SENT_BY` target.
 * @param {String[]} facts.sentTo The `SENT_TO` targets in edge order; the last one is the route.
 * @param {Boolean} facts.deliveredToMe A `DELIVERED_TO` edge names `me`.
 * @param {Boolean} facts.hasDeliveries Any `DELIVERED_TO` edge exists.
 * @param {Function} facts.canReadInboxOf `target => Boolean`: the caller holds `CAN_READ_INBOX_OF`
 * on `target`. Called at most once, and only for a direct message to someone else.
 * @returns {Boolean}
 */
export function canReadMessage(me, {sentBy, sentTo, deliveredToMe, hasDeliveries, canReadInboxOf}) {
    const self  = normalizeMailboxIdentityForComparison(me),
          isMe  = identity => normalizeMailboxIdentityForComparison(identity) === self,
          route = sentTo.at(-1) ?? null;

    if (isMe(sentBy) || sentTo.some(isMe)) return true;
    if (route === BROADCAST) return deliveredToMe || !hasDeliveries;

    return Boolean(route) && canReadInboxOf(route)
}

/**
 * @summary Compiles {@link canReadMessage} into a Chroma `where` clause over the message index.
 *
 * It reads the metadata `toMessageEmbedRecord` writes: canonical `from` and `to`, `kind`, and on
 * broadcasts `cohort`, `recipientCount` and `recipients`. Chroma applies `where` before ranking, so
 * the top-k is drawn from admitted rows only.
 *
 * @param {String} me Caller identity.
 * @param {String[]} [grants=[]] Inboxes the caller holds `CAN_READ_INBOX_OF` on.
 * @returns {Object} A Chroma `where` clause.
 */
export function admissionWhere(me, grants = []) {
    const self    = normalizeMailboxIdentityForComparison(me),
          inboxes = [...new Set(grants.map(normalizeMailboxIdentityForComparison))]
              .filter(inbox => inbox !== self && inbox !== BROADCAST),
          clauses = [
              {from: self},
              {to: self},
              {recipients: {$contains: self}},
              {$and: [{kind: 'broadcast'}, {cohort: 'legacy-unknown'}]},
              {$and: [{kind: 'broadcast'}, {recipientCount: 0}]}
          ];

    if (inboxes.length > 0) {
        clauses.push({$and: [{kind: 'direct'}, {to: {$in: inboxes}}]})
    }

    return {$or: clauses}
}
