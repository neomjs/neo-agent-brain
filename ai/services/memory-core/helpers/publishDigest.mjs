import crypto from 'node:crypto';

/**
 * @module ai/services/memory-core/helpers/publishDigest
 * @summary Pure deterministic RFC 8785 canonicalization, `revisionDigest` SHA-256 computation, and
 * link-shortener-tolerant read-back text matching shared by `MailboxService` and `publishExecutor`.
 * Contains no Neo or service imports so both processes can evaluate it without instantiating singletons.
 */

/**
 * @summary Produces an RFC 8785 deterministic JSON-ready value with lexicographically sorted object keys.
 * @param {*} value Value to canonicalize.
 * @returns {*}
 */
export function canonicalizeDeterministicJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalizeDeterministicJsonValue);
    }

    if (value && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] !== undefined) {
                sorted[key] = canonicalizeDeterministicJsonValue(value[key]);
            }
        }
        return sorted;
    }

    return value;
}

/**
 * @summary Computes the deterministic lowercase hex SHA-256 revision digest over a publication
 * request's content-bearing fields (`{account, channel, format, inReplyTo, media, text}`).
 * @param {Object} revisionFields
 * @param {String} revisionFields.account Logical account key.
 * @param {String} revisionFields.channel Target channel (`'x' | 'linkedin'`).
 * @param {String} revisionFields.format Publication format (`'post' | 'link-reply' | 'reply'`).
 * @param {String} revisionFields.text Exact text body to publish.
 * @param {Object[]} [revisionFields.media=[]] Ordered media descriptors (`{uri, sha256, mimeType}`).
 * @param {String|null} [revisionFields.inReplyTo=null] Upstream post/thread identifier or `null`.
 * @returns {String} 64-character lowercase hexadecimal SHA-256 digest.
 */
export function computePublishRevisionDigest({account, channel, format, text, media = [], inReplyTo = null} = {}) {
    const canonicalProjection = canonicalizeDeterministicJsonValue({
        account  : String(account ?? ''),
        channel  : String(channel ?? ''),
        format   : String(format ?? ''),
        inReplyTo: inReplyTo === undefined || inReplyTo === null ? null : String(inReplyTo),
        media    : Array.isArray(media)
            ? media.map(item => ({
                mimeType: String(item?.mimeType ?? ''),
                sha256  : String(item?.sha256 ?? '').toLowerCase(),
                uri     : String(item?.uri ?? '')
            }))
            : [],
        text     : String(text ?? '')
    });

    return crypto.createHash('sha256')
        .update(JSON.stringify(canonicalProjection))
        .digest('hex');
}

/**
 * @summary Compares platform read-back text (`textAsPublished`) against the requested revision text
 * (`textAsRequested`), tolerating platform link-shortener URL rewrites (such as X wrapping `https://...`
 * links in `https://t.co/...`) when the URL count and all non-URL text match identically.
 * @param {String} textAsPublished
 * @param {String} textAsRequested
 * @returns {Boolean}
 */
export function matchesRequestedPublishText(textAsPublished, textAsRequested) {
    if (typeof textAsPublished !== 'string' || typeof textAsRequested !== 'string') {
        return false;
    }

    if (textAsPublished === textAsRequested) {
        return true;
    }

    const urlPattern    = /https?:\/\/\S+/g,
          publishedUrls = textAsPublished.match(urlPattern) || [],
          requestedUrls = textAsRequested.match(urlPattern) || [];

    if (publishedUrls.length === 0 || publishedUrls.length !== requestedUrls.length) {
        return false;
    }

    return textAsPublished.replace(urlPattern, '<URL>') === textAsRequested.replace(urlPattern, '<URL>');
}
