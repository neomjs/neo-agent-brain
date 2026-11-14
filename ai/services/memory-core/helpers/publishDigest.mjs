import crypto from 'node:crypto';

/**
 * @module ai/services/memory-core/helpers/publishDigest
 * @summary Pure deterministic RFC 8785 canonicalization, `revisionDigest` SHA-256 computation,
 * `Europe/Berlin` dated-publication schedule parsing (`D-1 18:00` lock cutoff + earliest release),
 * and link-shortener-tolerant read-back text matching shared by `MailboxService` and `publishExecutor`.
 * Contains no Neo or service imports so both processes can evaluate it without instantiating singletons.
 */

/**
 * Canonical IANA timezone governing the `D-1 18:00` content-lock window (`CET`/`CEST`).
 * @type {String}
 */
export const PUBLISH_LOCK_TIMEZONE = 'Europe/Berlin';

const
    DATE_ONLY_SCHEDULE_PATTERN  = /^(\d{4})-(\d{2})-(\d{2})$/,
    ISO_OFFSET_SCHEDULE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/,
    zonedFormatterCache         = new Map();

/**
 * @summary Verifies that `(year, month, day)` is a real calendar date without V8 rollover.
 * @param {Number} year
 * @param {Number} month 1-indexed month (`1..12`).
 * @param {Number} day   1-indexed day (`1..31`).
 * @returns {Boolean}
 * @private
 */
function isRealCalendarDate(year, month, day) {
    if (!Number.isInteger(year) || year < 1970 || year > 9999) return false;
    if (!Number.isInteger(month) || month < 1 || month > 12) return false;
    if (!Number.isInteger(day) || day < 1 || day > 31) return false;

    const probe = new Date(Date.UTC(year, month - 1, day));
    return (
        probe.getUTCFullYear() === year &&
        probe.getUTCMonth() === month - 1 &&
        probe.getUTCDate() === day
    );
}

/**
 * @summary Extracts numeric wall-clock `{year, month, day, hour, minute, second}` in `timeZone`.
 * @param {Number} utcMs
 * @param {String} timeZone
 * @returns {{year: Number, month: Number, day: Number, hour: Number, minute: Number, second: Number}}
 * @private
 */
function getZonedDateTimeParts(utcMs, timeZone) {
    let formatter = zonedFormatterCache.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            hourCycle: 'h23',
            year     : 'numeric',
            month    : '2-digit',
            day      : '2-digit',
            hour     : '2-digit',
            minute   : '2-digit',
            second   : '2-digit'
        });
        zonedFormatterCache.set(timeZone, formatter);
    }

    const raw = {};
    for (const part of formatter.formatToParts(new Date(utcMs))) {
        if (part.type !== 'literal') {
            raw[part.type] = Number(part.value);
        }
    }

    return {
        year  : raw.year,
        month : raw.month,
        day   : raw.day,
        hour  : raw.hour % 24,
        minute: raw.minute,
        second: raw.second
    };
}

/**
 * @summary Computes the millisecond offset `(localWallAsUtc - utcMs)` for `timeZone` at `utcMs`.
 * @param {Number} utcMs
 * @param {String} timeZone
 * @returns {Number}
 * @private
 */
function getTimeZoneOffsetMs(utcMs, timeZone) {
    const parts            = getZonedDateTimeParts(utcMs, timeZone),
          zonedAsUtcMs     = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
          wholeSecondUtcMs = Math.floor(utcMs / 1000) * 1000;

    return zonedAsUtcMs - wholeSecondUtcMs;
}

/**
 * @summary Converts a wall-clock timestamp in `timeZone` into exact UTC milliseconds using a
 * two-pass offset solver so `CET`/`CEST` transitions resolve deterministically on every host OS.
 * @param {Object} parts
 * @param {Number} parts.year
 * @param {Number} parts.month
 * @param {Number} parts.day
 * @param {Number} [parts.hour=0]
 * @param {Number} [parts.minute=0]
 * @param {Number} [parts.second=0]
 * @param {Number} [parts.millisecond=0]
 * @param {String} [timeZone=PUBLISH_LOCK_TIMEZONE]
 * @returns {Number}
 */
export function zonedWallTimeToUtcMs({
    year,
    month,
    day,
    hour        = 0,
    minute      = 0,
    second      = 0,
    millisecond = 0
}, timeZone = PUBLISH_LOCK_TIMEZONE) {
    const wallAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond),
          pass1       = wallAsUtcMs - getTimeZoneOffsetMs(wallAsUtcMs, timeZone);

    return wallAsUtcMs - getTimeZoneOffsetMs(pass1, timeZone);
}

/**
 * @summary Parses an optional `scheduledFor` string (`'YYYY-MM-DD'` or explicit-offset ISO-8601)
 * and computes both the `D-1 18:00:00.000 Europe/Berlin` lock cutoff (`lockCutoffMs`) and the
 * earliest release instant (`earliestReleaseMs`). Returns `null` when `scheduledFor` is `undefined`
 * or `null`, or `{ok: false, code: 'refused: scheduledFor', reason}` when malformed.
 * @param {*}      scheduledFor
 * @param {String} [timeZone=PUBLISH_LOCK_TIMEZONE]
 * @returns {null|{ok: true, scheduledFor: String, timeZone: String, targetDate: String, lockDate: String, lockCutoffMs: Number, lockCutoffIso: String, earliestReleaseMs: Number, earliestReleaseIso: String}|{ok: false, code: String, reason: String}}
 */
export function parsePublishSchedule(scheduledFor, timeZone = PUBLISH_LOCK_TIMEZONE) {
    if (scheduledFor === undefined || scheduledFor === null) {
        return null;
    }

    if (typeof scheduledFor !== 'string' || !scheduledFor.trim()) {
        return {
            ok    : false,
            code  : 'refused: scheduledFor',
            reason: "scheduledFor must be a non-empty 'YYYY-MM-DD' date or explicit-offset ISO-8601 timestamp when provided."
        };
    }

    const trimmed       = scheduledFor.trim(),
          dateOnlyMatch = DATE_ONLY_SCHEDULE_PATTERN.exec(trimmed);

    let targetYear,
        targetMonth,
        targetDay,
        earliestReleaseMs;

    if (dateOnlyMatch) {
        targetYear  = Number(dateOnlyMatch[1]);
        targetMonth = Number(dateOnlyMatch[2]);
        targetDay   = Number(dateOnlyMatch[3]);

        if (!isRealCalendarDate(targetYear, targetMonth, targetDay)) {
            return {
                ok    : false,
                code  : 'refused: scheduledFor',
                reason: `Invalid calendar date in scheduledFor '${trimmed}'.`
            };
        }

        earliestReleaseMs = zonedWallTimeToUtcMs({
            year       : targetYear,
            month      : targetMonth,
            day        : targetDay,
            hour       : 0,
            minute     : 0,
            second     : 0,
            millisecond: 0
        }, timeZone);
    } else {
        const isoMatch = ISO_OFFSET_SCHEDULE_PATTERN.exec(trimmed);
        if (!isoMatch) {
            return {
                ok    : false,
                code  : 'refused: scheduledFor',
                reason: `Invalid scheduledFor '${trimmed}'. Expected 'YYYY-MM-DD' or ISO-8601 with explicit 'Z' / '±HH:MM' offset.`
            };
        }

        const isoYear   = Number(isoMatch[1]),
              isoMonth  = Number(isoMatch[2]),
              isoDay    = Number(isoMatch[3]),
              isoHour   = Number(isoMatch[4]),
              isoMinute = Number(isoMatch[5]),
              isoSecond = isoMatch[6] !== undefined ? Number(isoMatch[6]) : 0,
              offHour   = isoMatch[10] !== undefined ? Number(isoMatch[10]) : 0,
              offMinute = isoMatch[11] !== undefined ? Number(isoMatch[11]) : 0;

        if (
            !isRealCalendarDate(isoYear, isoMonth, isoDay) ||
            isoHour > 23 ||
            isoMinute > 59 ||
            isoSecond > 59 ||
            offHour > 23 ||
            offMinute > 59
        ) {
            return {
                ok    : false,
                code  : 'refused: scheduledFor',
                reason: `Out-of-range date/time component in scheduledFor '${trimmed}'.`
            };
        }

        earliestReleaseMs = Date.parse(trimmed);
        if (!Number.isFinite(earliestReleaseMs)) {
            return {
                ok    : false,
                code  : 'refused: scheduledFor',
                reason: `Unparseable scheduledFor timestamp '${trimmed}'.`
            };
        }

        const zonedTarget = getZonedDateTimeParts(earliestReleaseMs, timeZone);
        targetYear        = zonedTarget.year;
        targetMonth       = zonedTarget.month;
        targetDay         = zonedTarget.day;
    }

    const prevUtc      = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay - 1)),
          prevYear     = prevUtc.getUTCFullYear(),
          prevMonth    = prevUtc.getUTCMonth() + 1,
          prevDay      = prevUtc.getUTCDate(),
          targetDate   = `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`,
          lockDate     = `${String(prevYear).padStart(4, '0')}-${String(prevMonth).padStart(2, '0')}-${String(prevDay).padStart(2, '0')}`,
          lockCutoffMs = zonedWallTimeToUtcMs({
              year       : prevYear,
              month      : prevMonth,
              day        : prevDay,
              hour       : 18,
              minute     : 0,
              second     : 0,
              millisecond: 0
          }, timeZone);

    return {
        ok                : true,
        scheduledFor      : trimmed,
        timeZone,
        targetDate,
        lockDate,
        lockCutoffMs,
        lockCutoffIso     : new Date(lockCutoffMs).toISOString(),
        earliestReleaseMs,
        earliestReleaseIso: new Date(earliestReleaseMs).toISOString()
    };
}

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
