/**
 * @module ai/services/fleet/publishExecutor
 * @summary Fleet-side outbound social publish executor operating under Fleet credential custody.
 *
 * Exposes three primary verbs to the Fleet Manager's operator-facing bridge (never to agent seats):
 * - {@link publish} — executes an approved `requestPublish` revision at most once under custody:
 *   reads the `(peer, channel)` switch at publish time, verifies the revision digest against the
 *   approval/attestation and immutable media byte digests, reserves `publishing` in `MailboxService`
 *   (`transitionPublishState`) before any platform HTTP call, uploads the verified media bytes under
 *   the account's own credential from Fleet custody, and records `published` with the provider id
 *   and read-back (storing `textAsPublished` beside `textAsRequested`). On crash or lost
 *   acknowledgement after `publishing` is reserved, the next run reconciles against the account's
 *   recent posts created at or after `reservedAt` before any retry — adopting a single positive
 *   match as `published` or recording `unresolved` when zero or multiple candidates match.
 * - {@link readMetrics} — reads owned-object metrics (`public_metrics` + `non_public_metrics` on X
 *   or organization-page statistics on LinkedIn) tagged with `{source, window, claimClass}`,
 *   reporting any unavailable metric as `'unknown'`, never `0`.
 * - {@link reply} — present in the module contract and disabled until X's reply automation
 *   classification is settled against the primary rules or written approval from X.
 *
 * Every publication-state read and write binds directly to `MailboxService`'s single-writer verbs
 * (`getMessage`, `transitionPublishState`, `approvePublishRevision`, `attestPublishRevision`) and
 * shares `computePublishRevisionDigest` with `MailboxService`.
 */

import crypto     from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path       from 'node:path';
import {
    computePublishRevisionDigest,
    matchesRequestedPublishText
} from '../memory-core/MailboxService.mjs';

export {computePublishRevisionDigest, matchesRequestedPublishText};

/**
 * Closed v1 outbound publishing channels.
 * @type {Readonly<{x: 'x', linkedin: 'linkedin'}>}
 */
export const PUBLISH_CHANNELS = Object.freeze({
    x       : 'x',
    linkedin: 'linkedin'
});

/**
 * Closed v1 outbound post formats.
 * @type {Readonly<{post: 'post', linkReply: 'link-reply', reply: 'reply'}>}
 */
export const PUBLISH_FORMATS = Object.freeze({
    post     : 'post',
    linkReply: 'link-reply',
    reply    : 'reply'
});

/**
 * Closed five-state publication sub-state machine stored under the request id in `MailboxService`.
 * @type {Readonly<{queued: 'queued', publishing: 'publishing', published: 'published', refused: 'refused', unresolved: 'unresolved'}>}
 */
export const PUBLICATION_STATES = Object.freeze({
    queued    : 'queued',
    publishing: 'publishing',
    published : 'published',
    refused   : 'refused',
    unresolved: 'unresolved'
});

/**
 * Four legal switch states per `(peer, channel)` pair, ordered from strictest (`0`) to most permissive (`3`).
 * @type {Readonly<{approveEach: 'approve each', approveBatch: 'approve the batch', autoApproveAttested: 'auto-approve after a cross-family review attestation', autoApprove: 'auto-approve'}>}
 */
export const SWITCH_STATES = Object.freeze({
    approveEach        : 'approve each',
    approveBatch       : 'approve the batch',
    autoApproveAttested: 'auto-approve after a cross-family review attestation',
    autoApprove        : 'auto-approve'
});

const SWITCH_STATE_RANK = Object.freeze({
    [SWITCH_STATES.approveEach]        : 0,
    [SWITCH_STATES.approveBatch]       : 1,
    [SWITCH_STATES.autoApproveAttested]: 2,
    [SWITCH_STATES.autoApprove]        : 3
});

/**
 * Primary policy source named by every reply-classification refusal.
 * @type {String}
 */
export const REPLY_CLASSIFICATION_PRIMARY_SOURCE = 'https://help.x.com/en/rules-and-policies/x-automation';

/**
 * Named refusal codes emitted by the Fleet publish executor.
 * @type {Readonly<Record<String, String>>}
 */
export const REFUSAL_CODES = Object.freeze({
    credential                   : 'refused: credential',
    switch                       : 'refused: switch',
    digest                       : 'refused: digest',
    attestation                  : 'refused: attestation',
    replyClassificationUnresolved: 'refused: reply-classification-unresolved',
    alreadyPublished             : 'refused: already-published',
    unresolved                   : 'refused: unresolved',
    publishingInFlight           : 'refused: publishing-in-flight',
    channel                      : 'refused: channel',
    notFound                     : 'refused: not-found'
});

/**
 * Canonical metric keys returned by {@link readMetrics} per channel. Any metric absent, `null`,
 * `undefined`, or non-finite in the platform response is reported as `'unknown'`, never `0`.
 * @type {Readonly<Record<String, ReadonlyArray<String>>>}
 */
export const CHANNEL_METRIC_KEYS = Object.freeze({
    x: Object.freeze([
        'impressions',
        'likes',
        'reposts',
        'replies',
        'quotes',
        'bookmarks',
        'url_link_clicks',
        'user_profile_clicks',
        'engagements'
    ]),
    linkedin: Object.freeze([
        'impressions',
        'uniqueImpressions',
        'clicks',
        'likes',
        'comments',
        'shares',
        'engagement'
    ])
});

const X_METRIC_FIELD_ALIASES = Object.freeze({
    impressions: ['impressions', 'impression_count'],
    likes      : ['likes', 'like_count'],
    reposts    : ['reposts', 'retweet_count', 'repost_count'],
    replies    : ['replies', 'reply_count'],
    quotes     : ['quotes', 'quote_count'],
    bookmarks  : ['bookmarks', 'bookmark_count']
});

const X_RAW_COUNT_ALIAS_KEYS = new Set([
    'impression_count',
    'like_count',
    'retweet_count',
    'repost_count',
    'reply_count',
    'quote_count',
    'bookmark_count'
]);

/**
 * LinkedIn page-admin token maximum lifetime in milliseconds (60 days).
 * @type {Number}
 */
export const LINKEDIN_TOKEN_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Default number of recent account posts inspected during post-crash reconciliation.
 * @type {Number}
 */
export const RECONCILE_RECENT_POSTS_LIMIT = 20;

const SECRET_KEY_PATTERN = /(token|secret|password|credential|authorization|api[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token)/i;

/**
 * @summary Scrubs known secret values and Bearer tokens from strings, errors, and objects so no
 * verb, log line, or refusal reason ever leaks a platform credential.
 * @param {*}        value
 * @param {String[]} [secrets=[]]
 * @returns {*}
 */
export function scrubSecrets(value, secrets = []) {
    const activeSecrets = secrets.filter(item => typeof item === 'string' && item.length > 0);

    const scrubString = text => {
        let output = String(text).replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
        for (const secret of activeSecrets) {
            output = output.split(secret).join('[REDACTED]');
        }
        return output;
    };

    if (typeof value === 'string') {
        return scrubString(value);
    }

    if (value instanceof Error) {
        return scrubString(value.message || String(value));
    }

    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(item => scrubSecrets(item, activeSecrets));
    }

    if (value && typeof value === 'object') {
        const clone = {};
        for (const [key, entry] of Object.entries(value)) {
            if (SECRET_KEY_PATTERN.test(key)) {
                continue;
            }
            clone[key] = scrubSecrets(entry, activeSecrets);
        }
        return clone;
    }

    return value;
}

/**
 * @summary Creates a Fleet custody credential reader over `<userData>/brain/fleet` (or an injected
 * credentials map/directory). Tokens are read by `{channel, account}`, checked for presence,
 * revocation, and expiry (including LinkedIn's 60-day token window), and never logged or returned
 * by any public executor verb.
 * @param {Object}   [options={}]
 * @param {String}   [options.custodyDir] Directory under `<userData>/brain/fleet`.
 * @param {Object}   [options.credentials] Optional in-memory map keyed by `${channel}:${account}` or `account`.
 * @param {Object}   [options.fsModule=fsPromises]
 * @param {Function} [options.now=Date.now]
 * @returns {{readCredential: Function}}
 */
export function createFleetCustodyStore({
    custodyDir  = null,
    credentials = null,
    fsModule    = fsPromises,
    now         = () => Date.now()
} = {}) {
    async function loadRawRecord(channel, account) {
        if (credentials && typeof credentials === 'object') {
            const compositeKey = `${channel}:${account}`;
            if (Object.hasOwn(credentials, compositeKey)) {
                return credentials[compositeKey];
            }
            if (credentials[channel] && typeof credentials[channel] === 'object' && Object.hasOwn(credentials[channel], account)) {
                return credentials[channel][account];
            }
            if (Object.hasOwn(credentials, account)) {
                return credentials[account];
            }
        }

        if (!custodyDir) {
            return null;
        }

        const safeAccount = String(account).replace(/[^a-zA-Z0-9._@-]/g, '_'),
              perAccount  = path.join(custodyDir, 'social-credentials', channel, `${safeAccount}.json`),
              bundlePath  = path.join(custodyDir, 'social-credentials.json');

        try {
            const raw = await fsModule.readFile(perAccount, 'utf8');
            return JSON.parse(raw);
        } catch {
            // Fall through to aggregate custody file if present.
        }

        try {
            const raw    = await fsModule.readFile(bundlePath, 'utf8'),
                  parsed = JSON.parse(raw);
            return parsed?.[`${channel}:${account}`] ?? parsed?.[channel]?.[account] ?? null;
        } catch {
            return null;
        }
    }

    return {
        /**
         * @summary Reads and validates the custody credential for `{channel, account}` at `now()`.
         * @param {Object} params
         * @param {String} params.channel
         * @param {String} params.account
         * @param {Number} [params.nowMs]
         * @returns {Promise<{ok: Boolean, token?: String, record?: Object, code?: String, reason?: String}>}
         */
        async readCredential({channel, account, nowMs = now()}) {
            if (!channel || !account) {
                return {
                    ok    : false,
                    code  : REFUSAL_CODES.credential,
                    reason: `${REFUSAL_CODES.credential} — channel and account are required to resolve Fleet custody`
                };
            }

            const record = await loadRawRecord(channel, account);

            if (!record || typeof record !== 'object') {
                return {
                    ok    : false,
                    code  : REFUSAL_CODES.credential,
                    reason: `${REFUSAL_CODES.credential} — no Fleet custody token registered for ${channel}:${account}`
                };
            }

            if (record.revoked === true) {
                return {
                    ok    : false,
                    code  : REFUSAL_CODES.credential,
                    reason: `${REFUSAL_CODES.credential} — Fleet custody token for ${channel}:${account} is marked revoked`
                };
            }

            const token = typeof record.accessToken === 'string'
                ? record.accessToken.trim()
                : (typeof record.token === 'string' ? record.token.trim() : '');

            if (!token) {
                return {
                    ok    : false,
                    code  : REFUSAL_CODES.credential,
                    reason: `${REFUSAL_CODES.credential} — Fleet custody record for ${channel}:${account} holds no access token`
                };
            }

            if (record.expiresAt != null) {
                const expiresMs = typeof record.expiresAt === 'number'
                    ? record.expiresAt
                    : Date.parse(String(record.expiresAt));

                if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
                    return {
                        ok    : false,
                        code  : REFUSAL_CODES.credential,
                        reason: `${REFUSAL_CODES.credential} — Fleet custody token for ${channel}:${account} is expired`
                    };
                }
            }

            if (channel === PUBLISH_CHANNELS.linkedin && record.issuedAt != null) {
                const issuedMs = typeof record.issuedAt === 'number'
                    ? record.issuedAt
                    : Date.parse(String(record.issuedAt));

                if (!Number.isFinite(issuedMs) || (nowMs - issuedMs) >= LINKEDIN_TOKEN_MAX_AGE_MS) {
                    return {
                        ok    : false,
                        code  : REFUSAL_CODES.credential,
                        reason: `${REFUSAL_CODES.credential} — LinkedIn page-admin token for ${account} exceeded the 60-day custody lifetime`
                    };
                }
            }

            return {
                ok    : true,
                token,
                record: {
                    channel,
                    account,
                    scopes   : Array.isArray(record.scopes) ? [...record.scopes] : [],
                    expiresAt: record.expiresAt ?? null,
                    issuedAt : record.issuedAt ?? null
                }
            };
        }
    };
}

/**
 * @summary Reads a message record from `MailboxService#getMessage({messageId})`, returning `null`
 * when the verb is absent or the message does not exist.
 * @param {Object} mailbox
 * @param {String} messageId
 * @returns {Promise<Object|null>}
 */
async function readMailboxMessage(mailbox, messageId) {
    if (typeof mailbox?.getMessage !== 'function' || typeof messageId !== 'string' || !messageId) {
        return null;
    }

    try {
        const record = await mailbox.getMessage({messageId});
        return record && typeof record === 'object' ? record : null;
    } catch {
        return null;
    }
}

/**
 * @summary Invokes `MailboxService#transitionPublishState` and verifies that the transition was
 * durably accepted into the requested target state. Fails closed when the write verb is missing,
 * returns `false`/`undefined`, or throws.
 * @param {Object} mailbox
 * @param {Object} transition
 * @returns {Promise<{ok: Boolean, publication?: Object, state?: String, refused?: String, reason?: String}>}
 */
async function transitionMailboxPublishState(mailbox, transition) {
    if (typeof mailbox?.transitionPublishState !== 'function') {
        return {
            ok     : false,
            refused: REFUSAL_CODES.publishingInFlight,
            reason : 'mailbox.transitionPublishState verb is required to mutate publication state'
        };
    }

    let result;
    try {
        result = await mailbox.transitionPublishState({
            taskId         : transition.requestId,
            messageId      : transition.requestId,
            newState       : transition.state,
            revisionDigest : transition.revisionDigest,
            attemptId      : transition.attemptId,
            reservedAt     : transition.reservedAt,
            providerId     : transition.providerId,
            textAsPublished: transition.textAsPublished,
            readback       : transition.readback,
            readbackAt     : transition.readbackAt,
            refusalReason  : transition.refusalReason
        });
    } catch (error) {
        return {
            ok     : false,
            state  : error?.publicationState ?? undefined,
            refused: error?.code ?? REFUSAL_CODES.publishingInFlight,
            reason : error?.message || String(error)
        };
    }

    if (
        !result ||
        typeof result !== 'object' ||
        result.success === false ||
        result.ok === false ||
        result.publication?.state !== transition.state
    ) {
        return {
            ok     : false,
            state  : result?.publication?.state ?? result?.state ?? undefined,
            refused: result?.refused ?? result?.code ?? REFUSAL_CODES.publishingInFlight,
            reason : result?.reason ?? `mailbox.transitionPublishState did not confirm state '${transition.state}'`
        };
    }

    return {
        ok         : true,
        publication: result.publication
    };
}

/**
 * @summary Normalizes a `requestPublish` message returned by `MailboxService#getMessage` into
 * `{requestId, requester, revisions, currentRevision, publication}`.
 * @param {Object} raw
 * @returns {Object|null}
 */
function normalizeRequestRecord(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const requestId = raw.messageId ?? raw.requestId ?? raw.id ?? null,
          requester = raw.from ?? raw.requester ?? raw.createdBy ?? null,
          task      = raw.task ?? raw,
          revisions = Array.isArray(raw.revisions)
              ? raw.revisions
              : (Array.isArray(task.revisions)
                  ? task.revisions
                  : (raw.revision ? [raw.revision] : (task.revision ? [task.revision] : [])));

    const latestFromList  = revisions.length > 0 ? revisions[revisions.length - 1] : null,
          rawCurrent      = raw.revision ?? latestFromList ?? raw.currentRevision ?? task.currentRevision ?? task.revision ?? null,
          payload         = rawCurrent?.payload ?? latestFromList?.payload ?? raw.requestPublish ?? task.requestPublish ?? raw.payload ?? null,
          rawPub          = raw.publication ?? task.publication ?? task.publicationState ?? raw.publicationState ?? {},
          textAsRequested = rawPub.textAsRequested ?? payload?.text ?? '';

    return {
        requestId,
        requester,
        revisions,
        currentRevision: rawCurrent
            ? {
                ...rawCurrent,
                revisionNumber: rawCurrent.revisionNumber ?? revisions.length ?? 1,
                revisionDigest: rawCurrent.revisionDigest ?? (payload ? computePublishRevisionDigest(payload) : null),
                payload       : payload ?? {},
                approval      : rawCurrent.approval ?? task.revision?.approval ?? raw.approval ?? null,
                attestation   : rawCurrent.attestation ?? task.revision?.attestation ?? raw.attestation ?? payload?.attestation ?? null,
                releaseState  : rawCurrent.releaseState ?? raw.releaseState ?? null
            }
            : null,
        publication: {
            state          : rawPub.state ?? PUBLICATION_STATES.queued,
            attemptId      : rawPub.attemptId ?? rawPub.reservation?.attemptId ?? null,
            reservedAt     : rawPub.reservation?.reservedAt ?? rawPub.reservedAt ?? null,
            revisionNumber : rawPub.currentRevisionNumber ?? rawPub.revisionNumber ?? rawCurrent?.revisionNumber ?? 1,
            revisionDigest : rawPub.currentRevisionDigest ?? rawPub.revisionDigest ?? rawPub.reservation?.revisionDigest ?? rawCurrent?.revisionDigest ?? null,
            reservation    : rawPub.reservation ?? null,
            providerId     : rawPub.providerId ?? null,
            readback       : rawPub.readback ?? null,
            readbackAt     : rawPub.readbackAt ?? null,
            textAsRequested,
            textAsPublished: rawPub.textAsPublished ?? null,
            refusalReason  : rawPub.refusalReason ?? rawPub.reason ?? null
        }
    };
}

/**
 * @summary Verifies that a `requestPublish` revision satisfies the publish-time switch state for
 * `(peer, channel)` and that any attached approval or cross-family attestation matches `revisionDigest`.
 * @param {Object}   params
 * @param {String}   params.switchState
 * @param {Object}   params.currentRevision
 * @param {String}   params.revisionDigest
 * @param {String}   params.requester
 * @param {Object}   params.mailbox
 * @param {Function} params.resolveIdentityFamily
 * @returns {Promise<{ok: Boolean, code?: String, reason?: String}>}
 */
async function evaluateSwitchAndApproval({
    switchState,
    currentRevision,
    revisionDigest,
    requester,
    mailbox,
    resolveIdentityFamily
}) {
    if (!Object.hasOwn(SWITCH_STATE_RANK, switchState)) {
        return {
            ok    : false,
            code  : REFUSAL_CODES.switch,
            reason: `${REFUSAL_CODES.switch} — unknown or disabled publish switch state '${String(switchState)}'`
        };
    }

    const approval     = currentRevision.approval ?? null,
          attestation  = currentRevision.attestation ?? currentRevision.payload?.attestation ?? null,
          releaseState = currentRevision.releaseState ?? null;

    // 1. If an explicit approval record is present on the revision, both its revisionDigest and
    //    its revisionNumber MUST match the current revision.
    if (approval !== null && approval !== undefined) {
        const approvedDigest = approval.revisionDigest ?? null,
              approvedNumber = approval.revisionNumber ?? null;

        if (approvedDigest !== revisionDigest || approvedNumber !== currentRevision.revisionNumber) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.digest,
                reason: `${REFUSAL_CODES.digest} — approval {revisionNumber: ${String(approvedNumber)}, revisionDigest: '${String(approvedDigest)}'} does not match requested revision ${currentRevision.revisionNumber} digest '${revisionDigest}'`
            };
        }
    }

    // 2. If the queued request recorded a required releaseState and the switch read at publish
    //    time was downgraded below that releaseState without an explicit operator approval for this
    //    digest, refuse with `refused: switch`.
    if (releaseState && Object.hasOwn(SWITCH_STATE_RANK, releaseState)) {
        if (SWITCH_STATE_RANK[switchState] < SWITCH_STATE_RANK[releaseState] && !approval) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.switch,
                reason: `${REFUSAL_CODES.switch} — switch for ${requester ?? 'peer'} × ${currentRevision.payload?.channel ?? 'channel'} is '${switchState}' at publish time, below queued release state '${releaseState}'`
            };
        }
    }

    // 3. Evaluate per-switch-state release requirements at publish time:
    if (switchState === SWITCH_STATES.approveEach || switchState === SWITCH_STATES.approveBatch) {
        if (!approval) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.switch,
                reason: `${REFUSAL_CODES.switch} — switch state '${switchState}' at publish time requires explicit operator approval bound to revision digest '${revisionDigest}'`
            };
        }
        return {ok: true};
    }

    if (switchState === SWITCH_STATES.autoApproveAttested) {
        if (approval) {
            return {ok: true};
        }

        if (!attestation || typeof attestation !== 'object') {
            return {
                ok    : false,
                code  : REFUSAL_CODES.switch,
                reason: `${REFUSAL_CODES.switch} — switch state '${switchState}' at publish time requires operator approval or a verified cross-family review attestation`
            };
        }

        const reviewerMessageId = attestation.reviewerMessageId ?? attestation.messageId ?? null,
              attestedDigest    = attestation.revisionDigest ?? null,
              attestedNumber    = attestation.revisionNumber ?? currentRevision.revisionNumber;

        if (attestedDigest !== revisionDigest || attestedNumber !== currentRevision.revisionNumber) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.digest,
                reason: `${REFUSAL_CODES.digest} — attestation digest '${String(attestedDigest)}' does not match revision digest '${revisionDigest}'`
            };
        }

        if (!reviewerMessageId || typeof mailbox?.getMessage !== 'function') {
            return {
                ok    : false,
                code  : REFUSAL_CODES.attestation,
                reason: `${REFUSAL_CODES.attestation} — reviewerMessageId '${String(reviewerMessageId)}' could not be verified from the mailbox store`
            };
        }

        const reviewMsg = await readMailboxMessage(mailbox, reviewerMessageId);
        if (!reviewMsg || typeof reviewMsg !== 'object') {
            return {
                ok    : false,
                code  : REFUSAL_CODES.attestation,
                reason: `${REFUSAL_CODES.attestation} — cited review message '${reviewerMessageId}' does not exist in the mailbox store`
            };
        }

        const reviewerFrom = reviewMsg.from ?? null;
        if (!reviewerFrom || reviewerFrom === requester) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.attestation,
                reason: `${REFUSAL_CODES.attestation} — reviewer identity '${String(reviewerFrom)}' must be a distinct peer seat from '${String(requester)}'`
            };
        }

        const requesterFamily = await resolveIdentityFamily(requester),
              reviewerFamily  = await resolveIdentityFamily(reviewerFrom);

        if (!requesterFamily || !reviewerFamily || requesterFamily === reviewerFamily) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.attestation,
                reason: `${REFUSAL_CODES.attestation} — reviewer family '${String(reviewerFamily)}' is not a distinct model family from '${String(requesterFamily)}'`
            };
        }

        // RA-3: Accept attestation ONLY through the review message's structured `revisionDigest`
        // (as bound by `MailboxService#attestPublishRevision`), never via substring matching on body text.
        const msgDigest = reviewMsg.revisionDigest ?? reviewMsg.attestedRevisionDigest ?? null;

        if (msgDigest !== revisionDigest) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.attestation,
                reason: `${REFUSAL_CODES.attestation} — review message '${reviewerMessageId}' does not carry a structured revisionDigest matching '${revisionDigest}'`
            };
        }

        return {ok: true};
    }

    // switchState === SWITCH_STATES.autoApprove
    return {ok: true};
}

/**
 * @summary Verifies that every media attachment descriptor `{uri, sha256, mimeType}` resolves via
 * `mediaReader` to bytes whose recomputed SHA-256 hex digest equals `descriptor.sha256`, returning
 * the verified byte buffers (`{bytes, sha256, mimeType}`) rather than the URIs so the platform
 * upload consumes the exact bytes that were hashed.
 * @param {Array<Object>} media
 * @param {Function|null} mediaReader `(uri) => Promise<Buffer|Uint8Array|String>`
 * @returns {Promise<{ok: Boolean, verifiedMedia?: Array<{bytes: Buffer, sha256: String, mimeType: String}>, code?: String, reason?: String}>}
 */
async function verifyMediaAttachments(media = [], mediaReader = null) {
    if (!Array.isArray(media) || media.length === 0) {
        return {ok: true, verifiedMedia: []};
    }

    if (typeof mediaReader !== 'function') {
        return {
            ok    : false,
            code  : REFUSAL_CODES.digest,
            reason: `${REFUSAL_CODES.digest} — mediaReader is required to verify media byte digests before upload`
        };
    }

    const verifiedMedia = [];

    for (const descriptor of media) {
        const uri            = descriptor?.uri,
              expectedSha256 = typeof descriptor?.sha256 === 'string' ? descriptor.sha256.toLowerCase() : '',
              mimeType       = descriptor?.mimeType;

        if (!uri || !/^[0-9a-f]{64}$/.test(expectedSha256) || !mimeType) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.digest,
                reason: `${REFUSAL_CODES.digest} — media descriptor requires {uri, sha256, mimeType}`
            };
        }

        let bytes;
        try {
            bytes = await mediaReader(uri);
        } catch {
            return {
                ok    : false,
                code  : REFUSAL_CODES.digest,
                reason: `${REFUSAL_CODES.digest} — media bytes at '${uri}' could not be read for digest verification`
            };
        }

        if (bytes === null || bytes === undefined) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.digest,
                reason: `${REFUSAL_CODES.digest} — mediaReader returned no bytes for '${uri}'`
            };
        }

        const buffer       = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes),
              actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');

        if (actualSha256 !== expectedSha256) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.digest,
                reason: `${REFUSAL_CODES.digest} — media byte digest '${actualSha256}' for '${uri}' does not match approved sha256 '${expectedSha256}'`
            };
        }

        verifiedMedia.push({
            bytes   : buffer,
            sha256  : expectedSha256,
            mimeType
        });
    }

    return {ok: true, verifiedMedia};
}

/**
 * @summary Normalizes platform metric numbers (including X API v2 `*_count` field names) so that
 * any absent, `null`, `undefined`, or non-finite metric is reported as `'unknown'`, never `0`.
 * @param {Object} rawMetrics
 * @param {String} channel
 * @returns {Object}
 */
export function normalizeOwnedMetrics(rawMetrics = {}, channel = PUBLISH_CHANNELS.x) {
    const keys   = CHANNEL_METRIC_KEYS[channel] ?? CHANNEL_METRIC_KEYS.x,
          merged = {
              ...(rawMetrics?.public_metrics ?? {}),
              ...(rawMetrics?.non_public_metrics ?? {}),
              ...(rawMetrics?.statistics ?? {}),
              ...(rawMetrics?.metrics ?? {}),
              ...(rawMetrics ?? {})
          },
          normalized = {};

    for (const key of keys) {
        const candidates = (channel === PUBLISH_CHANNELS.x && X_METRIC_FIELD_ALIASES[key])
            ? X_METRIC_FIELD_ALIASES[key]
            : [key];
        let resolvedValue;
        for (const candidateKey of candidates) {
            if (merged[candidateKey] !== undefined) {
                resolvedValue = merged[candidateKey];
                break;
            }
        }
        normalized[key] = (typeof resolvedValue === 'number' && Number.isFinite(resolvedValue)) ? resolvedValue : 'unknown';
    }

    for (const [key, value] of Object.entries(merged)) {
        if (['public_metrics', 'non_public_metrics', 'statistics', 'metrics', 'source', 'window', 'claimClass', 'providerId', 'channel', 'account'].includes(key)) {
            continue;
        }
        if (X_RAW_COUNT_ALIAS_KEYS.has(key) || SECRET_KEY_PATTERN.test(key)) {
            continue;
        }
        if (!Object.hasOwn(normalized, key)) {
            normalized[key] = (typeof value === 'number' && Number.isFinite(value)) ? value : 'unknown';
        }
    }

    return normalized;
}

/**
 * @summary Creates a Fleet publish executor instance with injected seams (`mailbox`, `custody`,
 * `switchStore`, `platform`, `mediaReader`, `resolveIdentityFamily`, `logger`, `now`, `mintAttemptId`).
 * @param {Object}   [config={}]
 * @param {Object}   [config.mailbox]
 * @param {Object}   [config.custody]
 * @param {Object}   [config.switchStore]
 * @param {Object}   [config.platform]
 * @param {Function} [config.mediaReader]
 * @param {Function} [config.resolveIdentityFamily]
 * @param {Object}   [config.logger]
 * @param {Function} [config.now]
 * @param {Function} [config.mintAttemptId]
 * @returns {{publish: Function, readMetrics: Function, reply: Function, approveRevision: Function, attestRevision: Function}}
 */
export function createPublishExecutor(config = {}) {
    const now                   = config.now ?? (() => Date.now()),
          mintAttemptId         = config.mintAttemptId ?? (() => `attempt-${crypto.randomUUID()}`),
          custody               = config.custody ?? createFleetCustodyStore({
              custodyDir : config.custodyDir ?? null,
              credentials: config.credentials ?? null,
              now
          }),
          logger                = config.logger ?? null,
          publishedByProviderId = new Map();

    function safeLog(level, event, details = {}, secrets = []) {
        if (!logger || typeof logger[level] !== 'function') {
            return;
        }
        const sanitized = scrubSecrets({event, ...details}, secrets);
        logger[level](sanitized);
    }

    /**
     * @summary Resolves the publish-time switch state for `(peer, channel)`. Defaults to `'approve each'`.
     * Never falls back to a channel-only key so one channel entry cannot govern every peer.
     * @param {Object} SwitchStoreSeam
     * @param {String} peer
     * @param {String} channel
     * @returns {Promise<String>}
     */
    async function readSwitchAtPublishTime(SwitchStoreSeam, peer, channel) {
        if (!SwitchStoreSeam || !peer || !channel) {
            return SWITCH_STATES.approveEach;
        }
        if (typeof SwitchStoreSeam === 'function') {
            return (await SwitchStoreSeam({peer, channel})) ?? SWITCH_STATES.approveEach;
        }
        if (typeof SwitchStoreSeam.getSwitchState === 'function') {
            return (await SwitchStoreSeam.getSwitchState({peer, channel})) ?? SWITCH_STATES.approveEach;
        }
        if (typeof SwitchStoreSeam.read === 'function') {
            return (await SwitchStoreSeam.read({peer, channel})) ?? SWITCH_STATES.approveEach;
        }
        const compositeKey = `${peer}:${channel}`;
        if (Object.hasOwn(SwitchStoreSeam, compositeKey)) {
            return SwitchStoreSeam[compositeKey];
        }
        if (SwitchStoreSeam[peer] && typeof SwitchStoreSeam[peer] === 'object' && Object.hasOwn(SwitchStoreSeam[peer], channel)) {
            return SwitchStoreSeam[peer][channel];
        }
        return SWITCH_STATES.approveEach;
    }

    /**
     * @summary Reconciles an interrupted `publishing` attempt against the target account's recent
     * posts created at or after the reservation's `reservedAt`. Adopts the post as `published` on a
     * single positive match without issuing a second write; transitions to `unresolved` when zero
     * or multiple candidates match.
     */
    async function reconcilePublishingAttempt({
        request,
        requestedDigest,
        mailbox,
        custodySeam,
        platform,
        nowMs
    }) {
        const {requestId, currentRevision, publication} = request,
              reservedDigest                            = publication.revisionDigest ?? currentRevision?.revisionDigest,
              attemptId                                 = publication.attemptId ?? publication.reservation?.attemptId ?? 'attempt-reconcile',
              reservedAtIso                             = publication.reservedAt ?? publication.reservation?.reservedAt ?? null,
              reservedAtMs                              = reservedAtIso ? Date.parse(String(reservedAtIso)) : NaN,
              targetRevision                            = request.revisions.find(rev => rev.revisionDigest === reservedDigest) ?? currentRevision,
              payload                                   = targetRevision?.payload ?? {},
              channel                                   = payload.channel,
              account                                   = payload.account;

        if (requestedDigest && reservedDigest && requestedDigest !== reservedDigest) {
            return {
                ok            : false,
                state         : PUBLICATION_STATES.publishing,
                refused       : REFUSAL_CODES.publishingInFlight,
                requestId,
                attemptId,
                revisionDigest: reservedDigest,
                reason        : `${REFUSAL_CODES.publishingInFlight} — attempt '${attemptId}' for digest '${reservedDigest}' is in flight and must be reconciled before '${requestedDigest}'`
            };
        }

        const cred    = await custodySeam.readCredential({channel, account, nowMs});
        const secrets = cred.token ? [cred.token] : [];

        const markUnresolved = async reason => {
            const safeReason = scrubSecrets(reason, secrets);
            await transitionMailboxPublishState(mailbox, {
                requestId,
                state          : PUBLICATION_STATES.unresolved,
                attemptId,
                revisionNumber : targetRevision?.revisionNumber ?? 1,
                revisionDigest : reservedDigest,
                textAsRequested: publication.textAsRequested,
                textAsPublished: null,
                refusalReason  : safeReason
            });
            safeLog('warn', 'publish.reconcile.unresolved', {requestId, attemptId, revisionDigest: reservedDigest, reason: safeReason}, secrets);
            return {
                ok            : false,
                state         : PUBLICATION_STATES.unresolved,
                refused       : REFUSAL_CODES.unresolved,
                reconciled    : false,
                requestId,
                attemptId,
                revisionDigest: reservedDigest,
                reason        : safeReason
            };
        };

        if (!Number.isFinite(reservedAtMs)) {
            return markUnresolved(`${REFUSAL_CODES.unresolved} — publishing reservation for '${requestId}' carries no valid reservedAt timestamp to bound reconciliation`);
        }

        if (!cred.ok) {
            return markUnresolved(`${REFUSAL_CODES.unresolved} — post-crash reconciliation could not read custody credential (${cred.reason})`);
        }

        if (typeof platform?.listRecentPosts !== 'function') {
            return markUnresolved(`${REFUSAL_CODES.unresolved} — platform recent-posts reader is unavailable; cannot prove whether attempt '${attemptId}' landed`);
        }

        let recentResult;
        try {
            recentResult = await platform.listRecentPosts({
                channel,
                account,
                token: cred.token,
                limit: RECONCILE_RECENT_POSTS_LIMIT
            });
        } catch (error) {
            return markUnresolved(`${REFUSAL_CODES.unresolved} — recent-posts reconciliation read failed: ${scrubSecrets(error, secrets)}`);
        }

        const posts = Array.isArray(recentResult)
            ? recentResult
            : (Array.isArray(recentResult?.posts) ? recentResult.posts : (Array.isArray(recentResult?.data) ? recentResult.data : null));

        if (!posts) {
            return markUnresolved(`${REFUSAL_CODES.unresolved} — recent-posts reconciliation returned no list`);
        }

        // RA-6: Adopt only a post created at or after the reservation's `reservedAt`, and treat
        // zero or several candidates as `unresolved`.
        const candidates = posts.filter(post => {
            const createdRaw = post?.createdAt ?? post?.created_at ?? post?.publishedAt ?? null,
                  createdMs  = typeof createdRaw === 'number'
                      ? createdRaw
                      : (createdRaw ? Date.parse(String(createdRaw)) : NaN);

            if (!Number.isFinite(createdMs) || createdMs < reservedAtMs) {
                return false;
            }

            if (post?.attemptId && post.attemptId === attemptId) {
                return true;
            }
            if (post?.revisionDigest && post.revisionDigest === reservedDigest) {
                return true;
            }
            return typeof post?.text === 'string' && matchesRequestedPublishText(post.text, payload.text);
        });

        if (candidates.length === 0) {
            return markUnresolved(`${REFUSAL_CODES.unresolved} — attempt '${attemptId}' not found in recent posts created at or after ${reservedAtIso} (${posts.length} inspected); negative search does not prove absence`);
        }

        if (candidates.length > 1) {
            return markUnresolved(`${REFUSAL_CODES.unresolved} — ambiguous reconciliation: ${candidates.length} candidate posts created at or after ${reservedAtIso} matched attempt '${attemptId}'`);
        }

        const [match]         = candidates,
              providerId      = String(match.providerId ?? match.id),
              readbackAt      = new Date(nowMs).toISOString(),
              textAsPublished = typeof match.text === 'string' ? match.text : payload.text;

        const transitioned = await transitionMailboxPublishState(mailbox, {
            requestId,
            state          : PUBLICATION_STATES.published,
            attemptId,
            revisionNumber : targetRevision?.revisionNumber ?? 1,
            revisionDigest : reservedDigest,
            providerId,
            readback       : {providerId, text: textAsPublished, readbackAt, reconciled: true},
            readbackAt,
            textAsRequested: publication.textAsRequested,
            textAsPublished
        });

        if (!transitioned.ok) {
            return markUnresolved(`${REFUSAL_CODES.unresolved} — reconciliation could not record published state: ${transitioned.reason}`);
        }

        publishedByProviderId.set(providerId, {channel, account, requestId});
        safeLog('info', 'publish.reconcile.adopted', {requestId, attemptId, revisionDigest: reservedDigest, providerId}, secrets);

        return {
            ok             : true,
            state          : PUBLICATION_STATES.published,
            noop           : false,
            reconciled     : true,
            requestId,
            attemptId,
            revisionNumber : targetRevision?.revisionNumber ?? 1,
            revisionDigest : reservedDigest,
            providerId,
            readbackAt,
            textAsRequested: publication.textAsRequested,
            textAsPublished
        };
    }

    return {
        /**
         * @summary Delegates operator approval of a `requestPublish` revision to `MailboxService#approvePublishRevision`.
         * @param {String} requestId
         * @param {String} revisionDigest
         * @param {Object} [options={}]
         * @returns {Promise<Object>}
         */
        async approveRevision(requestId, revisionDigest, options = {}) {
            const mailbox = options.mailbox ?? config.mailbox;
            if (typeof mailbox?.approvePublishRevision !== 'function') {
                throw new Error('mailbox.approvePublishRevision is required');
            }
            return mailbox.approvePublishRevision({
                taskId        : requestId,
                messageId     : requestId,
                revisionDigest,
                revisionNumber: options.revisionNumber
            });
        },

        /**
         * @summary Delegates cross-family review attestation of a `requestPublish` revision to `MailboxService#attestPublishRevision`.
         * @param {String} requestId
         * @param {Object} attestation
         * @param {Object} [options={}]
         * @returns {Promise<Object>}
         */
        async attestRevision(requestId, attestation = {}, options = {}) {
            const mailbox = options.mailbox ?? config.mailbox;
            if (typeof mailbox?.attestPublishRevision !== 'function') {
                throw new Error('mailbox.attestPublishRevision is required');
            }
            return mailbox.attestPublishRevision({
                taskId           : requestId,
                messageId        : requestId,
                reviewerMessageId: attestation.reviewerMessageId,
                revisionDigest   : attestation.revisionDigest,
                attestation
            });
        },

        /**
         * @summary Publishes an approved `requestPublish` revision at most once under Fleet custody.
         * @param {String} requestId      Canonical mailbox `MESSAGE:<uuid>` request id.
         * @param {String} revisionDigest Expected lowercase hex SHA-256 revision digest.
         * @param {Object} [callOptions={}]
         * @returns {Promise<Object>}
         */
        async publish(requestId, revisionDigest, callOptions = {}) {
            const mailbox               = callOptions.mailbox ?? config.mailbox,
                  custodySeam           = callOptions.custody ?? custody,
                  switchStore           = callOptions.switchStore ?? config.switchStore,
                  platform              = callOptions.platform ?? config.platform,
                  mediaReader           = callOptions.mediaReader ?? config.mediaReader,
                  resolveIdentityFamily = callOptions.resolveIdentityFamily ?? config.resolveIdentityFamily ?? (async () => null),
                  nowMs                 = (callOptions.now ?? now)();

            if (typeof requestId !== 'string' || !requestId.startsWith('MESSAGE:')) {
                return {
                    ok     : false,
                    state  : PUBLICATION_STATES.refused,
                    refused: REFUSAL_CODES.notFound,
                    reason : `${REFUSAL_CODES.notFound} — requestId must be a canonical 'MESSAGE:<uuid>' identifier`
                };
            }

            const rawRequest = await readMailboxMessage(mailbox, requestId);
            const request    = normalizeRequestRecord(rawRequest);

            if (!request || !request.currentRevision) {
                return {
                    ok     : false,
                    state  : PUBLICATION_STATES.refused,
                    refused: REFUSAL_CODES.notFound,
                    requestId,
                    reason : `${REFUSAL_CODES.notFound} — publish request '${requestId}' was not found`
                };
            }

            const {currentRevision, publication, requester} = request,
                  currentState                              = publication.state;

            // Per-state dispatch table — explicit handling for every publication state:
            // 1. `published`: idempotent no-op for the same revisionDigest; refuse a different digest.
            if (currentState === PUBLICATION_STATES.published) {
                if (publication.providerId && currentRevision?.payload?.channel && currentRevision?.payload?.account) {
                    publishedByProviderId.set(String(publication.providerId), {
                        channel  : currentRevision.payload.channel,
                        account  : currentRevision.payload.account,
                        requestId
                    });
                }

                if (publication.revisionDigest === revisionDigest) {
                    return {
                        ok             : true,
                        state          : PUBLICATION_STATES.published,
                        noop           : true,
                        requestId,
                        attemptId      : publication.attemptId,
                        revisionNumber : publication.revisionNumber,
                        revisionDigest : publication.revisionDigest,
                        providerId     : publication.providerId,
                        readbackAt     : publication.readbackAt,
                        textAsRequested: publication.textAsRequested,
                        textAsPublished: publication.textAsPublished
                    };
                }

                return {
                    ok            : false,
                    state         : PUBLICATION_STATES.published,
                    refused       : REFUSAL_CODES.alreadyPublished,
                    requestId,
                    providerId    : publication.providerId,
                    revisionDigest: publication.revisionDigest,
                    reason        : `${REFUSAL_CODES.alreadyPublished} — request '${requestId}' is already published at digest '${publication.revisionDigest}' (providerId '${publication.providerId}')`
                };
            }

            // 2. `unresolved`: terminal ambiguity until explicit operator resolution; never bypassed.
            if (currentState === PUBLICATION_STATES.unresolved) {
                return {
                    ok            : false,
                    state         : PUBLICATION_STATES.unresolved,
                    refused       : REFUSAL_CODES.unresolved,
                    requestId,
                    attemptId     : publication.attemptId,
                    revisionDigest: publication.revisionDigest,
                    reason        : publication.refusalReason || `${REFUSAL_CODES.unresolved} — request '${requestId}' holds an unresolved attempt '${publication.attemptId}' and requires operator reconciliation`
                };
            }

            // 3. `publishing`: an earlier attempt reserved `publishing` and did not settle; reconcile against recent posts.
            if (currentState === PUBLICATION_STATES.publishing) {
                return reconcilePublishingAttempt({
                    request,
                    requestedDigest: revisionDigest,
                    mailbox,
                    custodySeam,
                    platform,
                    nowMs
                });
            }

            // 4. `refused`: remains refused unless re-queued or revised.
            if (currentState === PUBLICATION_STATES.refused) {
                return {
                    ok            : false,
                    state         : PUBLICATION_STATES.refused,
                    refused       : publication.refusalReason ?? REFUSAL_CODES.digest,
                    requestId,
                    revisionDigest: publication.revisionDigest,
                    reason        : publication.refusalReason ?? 'request is in refused state'
                };
            }

            // 5. `queued`: run pre-dispatch gates before reserving `publishing`.
            const payload        = currentRevision.payload ?? {},
                  computedDigest = computePublishRevisionDigest(payload);

            // Gate 5a (RA-5): If the caller's revisionDigest argument does not match the current
            // revision's digest (e.g. a duplicate click from a pre-Edit card), refuse the call
            // WITHOUT writing `refused` to the valid stored request.
            if (!revisionDigest || revisionDigest !== currentRevision.revisionDigest) {
                const reason = `${REFUSAL_CODES.digest} — requested digest '${String(revisionDigest)}' does not match current revision digest '${currentRevision.revisionDigest}'`;
                return {
                    ok              : false,
                    state           : PUBLICATION_STATES.refused,
                    publicationState: currentState,
                    refused         : REFUSAL_CODES.digest,
                    requestId,
                    revisionDigest  : currentRevision.revisionDigest,
                    reason
                };
            }

            if (currentRevision.revisionDigest !== computedDigest) {
                const reason = `${REFUSAL_CODES.digest} — stored revision digest '${currentRevision.revisionDigest}' does not match canonical payload digest '${computedDigest}'`;
                await transitionMailboxPublishState(mailbox, {
                    requestId,
                    state          : PUBLICATION_STATES.refused,
                    revisionNumber : currentRevision.revisionNumber,
                    revisionDigest : currentRevision.revisionDigest,
                    textAsRequested: publication.textAsRequested,
                    textAsPublished: null,
                    refusalReason  : reason
                });
                return {
                    ok            : false,
                    state         : PUBLICATION_STATES.refused,
                    refused       : REFUSAL_CODES.digest,
                    requestId,
                    revisionDigest: currentRevision.revisionDigest,
                    reason
                };
            }

            // Gate 5b: Closed channel check.
            if (!Object.values(PUBLISH_CHANNELS).includes(payload.channel)) {
                const reason = `${REFUSAL_CODES.channel} — unsupported publish channel '${String(payload.channel)}'`;
                await transitionMailboxPublishState(mailbox, {
                    requestId,
                    state          : PUBLICATION_STATES.refused,
                    revisionNumber : currentRevision.revisionNumber,
                    revisionDigest,
                    textAsRequested: publication.textAsRequested,
                    textAsPublished: null,
                    refusalReason  : reason
                });
                return {
                    ok     : false,
                    state  : PUBLICATION_STATES.refused,
                    refused: REFUSAL_CODES.channel,
                    requestId,
                    reason
                };
            }

            // Gate 5c: Dispatch-time reply-classification check.
            if (payload.format === PUBLISH_FORMATS.reply || (payload.format === PUBLISH_FORMATS.post && payload.inReplyTo != null)) {
                const reason = `${REFUSAL_CODES.replyClassificationUnresolved} — third-party API replies are disabled until verified against ${REPLY_CLASSIFICATION_PRIMARY_SOURCE}`;
                await transitionMailboxPublishState(mailbox, {
                    requestId,
                    state          : PUBLICATION_STATES.refused,
                    revisionNumber : currentRevision.revisionNumber,
                    revisionDigest,
                    textAsRequested: publication.textAsRequested,
                    textAsPublished: null,
                    refusalReason  : reason
                });
                return {
                    ok           : false,
                    state        : PUBLICATION_STATES.refused,
                    refused      : REFUSAL_CODES.replyClassificationUnresolved,
                    primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE,
                    requestId,
                    reason
                };
            }

            let resolvedInReplyToProviderId = null;
            if (payload.format === PUBLISH_FORMATS.linkReply) {
                const targetRef           = payload.inReplyTo;
                let   sameAccountVerified = false;

                if (typeof targetRef === 'string' && targetRef.startsWith('MESSAGE:')) {
                    const parentRaw = await readMailboxMessage(mailbox, targetRef),
                          parent    = normalizeRequestRecord(parentRaw);

                    if (
                        parent &&
                        parent.publication.state === PUBLICATION_STATES.published &&
                        parent.publication.providerId &&
                        parent.currentRevision?.payload?.account === payload.account &&
                        parent.currentRevision?.payload?.channel === payload.channel
                    ) {
                        sameAccountVerified         = true;
                        resolvedInReplyToProviderId = parent.publication.providerId;
                    }
                } else if (typeof targetRef === 'string' && targetRef.length > 0 && typeof platform?.verifyOwnedPost === 'function') {
                    const verified = await platform.verifyOwnedPost({
                        channel   : payload.channel,
                        account   : payload.account,
                        providerId: targetRef
                    });
                    if (verified === true) {
                        sameAccountVerified         = true;
                        resolvedInReplyToProviderId = targetRef;
                    }
                }

                if (!sameAccountVerified) {
                    const reason = `${REFUSAL_CODES.replyClassificationUnresolved} — link-reply target '${String(targetRef)}' is not proven to belong to publishing account '${payload.account}'; third-party replies are disabled pending ${REPLY_CLASSIFICATION_PRIMARY_SOURCE}`;
                    await transitionMailboxPublishState(mailbox, {
                        requestId,
                        state          : PUBLICATION_STATES.refused,
                        revisionNumber : currentRevision.revisionNumber,
                        revisionDigest,
                        textAsRequested: publication.textAsRequested,
                        textAsPublished: null,
                        refusalReason  : reason
                    });
                    return {
                        ok           : false,
                        state        : PUBLICATION_STATES.refused,
                        refused      : REFUSAL_CODES.replyClassificationUnresolved,
                        primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE,
                        requestId,
                        reason
                    };
                }
            }

            // Gate 5d: Read the `(peer, channel)` switch at publish time and verify approval/attestation.
            const switchState = await readSwitchAtPublishTime(switchStore, requester, payload.channel);
            const switchCheck = await evaluateSwitchAndApproval({
                switchState,
                currentRevision,
                revisionDigest,
                requester,
                mailbox,
                resolveIdentityFamily
            });

            if (!switchCheck.ok) {
                await transitionMailboxPublishState(mailbox, {
                    requestId,
                    state          : PUBLICATION_STATES.refused,
                    revisionNumber : currentRevision.revisionNumber,
                    revisionDigest,
                    textAsRequested: publication.textAsRequested,
                    textAsPublished: null,
                    refusalReason  : switchCheck.reason
                });
                return {
                    ok     : false,
                    state  : PUBLICATION_STATES.refused,
                    refused: switchCheck.code,
                    requestId,
                    reason : switchCheck.reason
                };
            }

            // Gate 5e (RA-4): Verify immutable media byte digests before upload and pass verified bytes.
            const mediaCheck = await verifyMediaAttachments(payload.media, mediaReader);
            if (!mediaCheck.ok) {
                await transitionMailboxPublishState(mailbox, {
                    requestId,
                    state          : PUBLICATION_STATES.refused,
                    revisionNumber : currentRevision.revisionNumber,
                    revisionDigest,
                    textAsRequested: publication.textAsRequested,
                    textAsPublished: null,
                    refusalReason  : mediaCheck.reason
                });
                return {
                    ok     : false,
                    state  : PUBLICATION_STATES.refused,
                    refused: mediaCheck.code,
                    requestId,
                    reason : mediaCheck.reason
                };
            }

            // Gate 5f: Load and validate the target account's token from Fleet custody.
            const cred = await custodySeam.readCredential({
                channel: payload.channel,
                account: payload.account,
                nowMs
            });

            if (!cred.ok) {
                const safeReason = scrubSecrets(cred.reason);
                await transitionMailboxPublishState(mailbox, {
                    requestId,
                    state          : PUBLICATION_STATES.refused,
                    revisionNumber : currentRevision.revisionNumber,
                    revisionDigest,
                    textAsRequested: publication.textAsRequested,
                    textAsPublished: null,
                    refusalReason  : safeReason
                });
                safeLog('warn', 'publish.refused.credential', {requestId, channel: payload.channel, account: payload.account, reason: safeReason});
                return {
                    ok     : false,
                    state  : PUBLICATION_STATES.refused,
                    refused: REFUSAL_CODES.credential,
                    requestId,
                    reason : safeReason
                };
            }

            const secrets    = [cred.token],
                  attemptId  = mintAttemptId(),
                  reservedAt = new Date(nowMs).toISOString();

            // Gate 5g (RA-1): Record `publishing` in MailboxService BEFORE dispatching the platform call.
            // Fails closed when the write verb is absent, returns false/undefined, or loses a race.
            const reserved = await transitionMailboxPublishState(mailbox, {
                requestId,
                state          : PUBLICATION_STATES.publishing,
                attemptId,
                reservedAt,
                revisionNumber : currentRevision.revisionNumber,
                revisionDigest,
                textAsRequested: publication.textAsRequested,
                textAsPublished: null
            });

            if (!reserved.ok) {
                return {
                    ok     : false,
                    state  : reserved.state ?? PUBLICATION_STATES.refused,
                    refused: reserved.refused ?? REFUSAL_CODES.publishingInFlight,
                    requestId,
                    reason : scrubSecrets(reserved.reason ?? 'concurrent publish reservation conflict', secrets)
                };
            }

            safeLog('info', 'publish.publishing.reserved', {
                requestId,
                attemptId,
                revisionNumber: currentRevision.revisionNumber,
                revisionDigest,
                channel       : payload.channel,
                account       : payload.account
            }, secrets);

            // Step 6: Dispatch the platform call under the account's custody credential with verified media bytes.
            let platformResponse;
            try {
                platformResponse = await platform.publishPost({
                    channel  : payload.channel,
                    account  : payload.account,
                    token    : cred.token,
                    text     : payload.text,
                    format   : payload.format,
                    inReplyTo: resolvedInReplyToProviderId,
                    media    : mediaCheck.verifiedMedia,
                    attemptId,
                    revisionDigest
                });
            } catch (error) {
                const safeReason = scrubSecrets(error, secrets);

                if (error?.refused === true) {
                    const refusalText = `${error.code || 'refused: platform'} — ${safeReason}`;
                    await transitionMailboxPublishState(mailbox, {
                        requestId,
                        state          : PUBLICATION_STATES.refused,
                        attemptId,
                        revisionNumber : currentRevision.revisionNumber,
                        revisionDigest,
                        textAsRequested: publication.textAsRequested,
                        textAsPublished: null,
                        refusalReason  : refusalText
                    });
                    safeLog('warn', 'publish.refused.platform', {requestId, attemptId, reason: refusalText}, secrets);
                    return {
                        ok     : false,
                        state  : PUBLICATION_STATES.refused,
                        refused: error.code || 'refused: platform',
                        requestId,
                        attemptId,
                        reason : refusalText
                    };
                }

                // Ambiguous failure / crash between the platform call and the `published` record:
                // leave `publishing` durable in the mailbox so the next run reconciles against
                // recent posts before any retry.
                safeLog('error', 'publish.dispatch.interrupted', {requestId, attemptId, reason: safeReason}, secrets);
                throw new Error(`publish dispatch interrupted after recording publishing for ${requestId} (${attemptId}): ${safeReason}`);
            }

            const providerId = platformResponse?.providerId ?? platformResponse?.id ?? null;
            if (!providerId) {
                safeLog('error', 'publish.dispatch.missing_provider_id', {requestId, attemptId}, secrets);
                throw new Error(`publish dispatch returned no providerId after recording publishing for ${requestId} (${attemptId})`);
            }

            const textAsPublished = typeof platformResponse?.readback?.text === 'string'
                ? platformResponse.readback.text
                : (typeof platformResponse?.text === 'string' ? platformResponse.text : payload.text);
            const readbackAt = platformResponse?.readbackAt ?? new Date(nowMs).toISOString();
            const readback   = platformResponse?.readback ?? {
                providerId: String(providerId),
                text      : textAsPublished,
                readbackAt
            };

            // Step 7: Record `published` with the provider id and read-back in MailboxService.
            const publishedTransition = await transitionMailboxPublishState(mailbox, {
                requestId,
                state          : PUBLICATION_STATES.published,
                attemptId,
                revisionNumber : currentRevision.revisionNumber,
                revisionDigest,
                providerId     : String(providerId),
                readback,
                readbackAt,
                textAsRequested: publication.textAsRequested,
                textAsPublished
            });

            if (!publishedTransition.ok) {
                const unresolvedReason = `${REFUSAL_CODES.unresolved} — read-back could not transition to published (${publishedTransition.reason})`;
                await transitionMailboxPublishState(mailbox, {
                    requestId,
                    state          : PUBLICATION_STATES.unresolved,
                    attemptId,
                    revisionNumber : currentRevision.revisionNumber,
                    revisionDigest,
                    providerId     : String(providerId),
                    readbackAt,
                    textAsRequested: publication.textAsRequested,
                    textAsPublished,
                    refusalReason  : unresolvedReason
                });
                return scrubSecrets({
                    ok             : false,
                    state          : PUBLICATION_STATES.unresolved,
                    refused        : REFUSAL_CODES.unresolved,
                    requestId,
                    attemptId,
                    revisionNumber : currentRevision.revisionNumber,
                    revisionDigest,
                    providerId     : String(providerId),
                    readbackAt,
                    textAsRequested: publication.textAsRequested,
                    textAsPublished,
                    reason         : unresolvedReason
                }, secrets);
            }

            publishedByProviderId.set(String(providerId), {
                channel  : payload.channel,
                account  : payload.account,
                requestId
            });

            safeLog('info', 'publish.published', {
                requestId,
                attemptId,
                revisionNumber: currentRevision.revisionNumber,
                revisionDigest,
                providerId    : String(providerId),
                readbackAt
            }, secrets);

            return scrubSecrets({
                ok             : true,
                state          : PUBLICATION_STATES.published,
                noop           : false,
                reconciled     : false,
                requestId,
                attemptId,
                revisionNumber : currentRevision.revisionNumber,
                revisionDigest,
                providerId     : String(providerId),
                readback,
                readbackAt,
                textAsRequested: publication.textAsRequested,
                textAsPublished
            }, secrets);
        },

        /**
         * @summary Reads owned-object metrics (`public_metrics` + `non_public_metrics` on X or page
         * statistics on LinkedIn) with `{source, window, claimClass}`. Any unavailable metric is
         * reported as `'unknown'`, never `0`. Derives `channel` and `account` from the published
         * record when omitted by the caller.
         * @param {String} providerId
         * @param {Object} [options={}]
         * @returns {Promise<Object>}
         */
        async readMetrics(providerId, options = {}) {
            const mailbox     = options.mailbox ?? config.mailbox,
                  custodySeam = options.custody ?? custody,
                  platform    = options.platform ?? config.platform,
                  nowMs       = (options.now ?? now)();

            if (!providerId || typeof providerId !== 'string') {
                return {
                    ok     : false,
                    refused: REFUSAL_CODES.notFound,
                    reason : `${REFUSAL_CODES.notFound} — providerId is required to read owned-object metrics`
                };
            }

            let derivedRecord = publishedByProviderId.get(providerId) ?? null;
            if ((!derivedRecord?.channel || !derivedRecord?.account) && options.requestId) {
                const rawReq = await readMailboxMessage(mailbox, options.requestId),
                      norm   = normalizeRequestRecord(rawReq);
                if (norm?.currentRevision?.payload) {
                    derivedRecord = {
                        channel  : norm.currentRevision.payload.channel,
                        account  : norm.currentRevision.payload.account,
                        requestId: options.requestId
                    };
                }
            }

            const channel = options.channel ?? derivedRecord?.channel ?? PUBLISH_CHANNELS.x,
                  account = options.account ?? derivedRecord?.account ?? null;

            const cred = await custodySeam.readCredential({channel, account, nowMs});
            if (!cred.ok) {
                const safeReason = scrubSecrets(cred.reason);
                safeLog('warn', 'readMetrics.refused.credential', {providerId, channel, account, reason: safeReason});
                return {
                    ok     : false,
                    refused: REFUSAL_CODES.credential,
                    reason : safeReason
                };
            }

            const secrets = [cred.token];
            let raw;
            try {
                raw = await platform.readMetrics({
                    providerId,
                    channel,
                    account,
                    token: cred.token
                });
            } catch (error) {
                const safeReason = scrubSecrets(error, secrets);
                safeLog('error', 'readMetrics.failed', {providerId, channel, account, reason: safeReason}, secrets);
                return {
                    ok     : false,
                    refused: 'refused: metrics-unavailable',
                    reason : safeReason
                };
            }

            const metrics    = normalizeOwnedMetrics(raw, channel),
                  source     = raw?.source ?? (channel === PUBLISH_CHANNELS.linkedin ? 'linkedin-community-management-api' : 'x-v2-owned-object-metrics'),
                  window     = raw?.window ?? (channel === PUBLISH_CHANNELS.linkedin ? 'lifetime' : '30d'),
                  claimClass = raw?.claimClass ?? 'owned-object-telemetry';

            safeLog('info', 'readMetrics.ok', {providerId, channel, account, source, window, claimClass}, secrets);

            return scrubSecrets({
                ok        : true,
                providerId: String(providerId),
                channel,
                account,
                source,
                window,
                claimClass,
                metrics
            }, secrets);
        },

        /**
         * @summary Present in the executor contract and disabled until X's automation classification
         * for human-approved API replies is settled against the primary rules or written approval.
         * @param {Object} [options={}]
         * @returns {Promise<Object>}
         */
        async reply(options = {}) {
            const reason = `${REFUSAL_CODES.replyClassificationUnresolved} — the reply verb is disabled until verified against the primary source (${REPLY_CLASSIFICATION_PRIMARY_SOURCE}) or written approval from X`;
            safeLog('warn', 'reply.refused.disabled', {
                primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE,
                target       : options?.inReplyTo ?? null
            });
            return {
                ok           : false,
                refused      : REFUSAL_CODES.replyClassificationUnresolved,
                primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE,
                reason
            };
        }
    };
}

/**
 * @summary Convenience module-level `publish(requestId, revisionDigest, options)` verb.
 * @param {String} requestId
 * @param {String} revisionDigest
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function publish(requestId, revisionDigest, options = {}) {
    return createPublishExecutor(options).publish(requestId, revisionDigest, options);
}

/**
 * @summary Convenience module-level `readMetrics(providerId, options)` verb.
 * @param {String} providerId
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function readMetrics(providerId, options = {}) {
    return createPublishExecutor(options).readMetrics(providerId, options);
}

/**
 * @summary Convenience module-level `reply(options)` verb (disabled; refuses with primary source).
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function reply(options = {}) {
    return createPublishExecutor(options).reply(options);
}
