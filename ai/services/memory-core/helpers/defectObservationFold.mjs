import {createHash} from 'node:crypto';

/**
 * @module ai/services/memory-core/helpers/defectObservationFold
 * @summary The zero-ceremony defect channel's read model: a deterministic fingerprint for
 * `defect-note:` lines, and a pure fold that projects mailbox notes into standing observation
 * records.
 *
 * Design notes (the "explicitly non-memory operational incident ledger" clause): the mailbox is
 * the canonical writer AND store — append-only, already durable, already every seat's channel.
 * This module never writes anything; the ledger IS the fold. That gives the graduated contract
 * for free: deterministic identity (the fingerprint computes from the note alone), idempotent
 * RED↔RECOVERED (state is recomputed from the full note set, so a duplicate transition changes
 * nothing), operator override (an operator note is just another row), and aging (a fold
 * parameter, so no daemon mutates anything to mark a record quiet). Append-only trail + pure
 * projection — never a second memory authority.
 *
 * The note format (ticket-create's defect-channel exemption):
 *
 *     defect-note: <surface> broke <observed symptom>
 *     defect-note: <surface> is wrong <observed symptom>
 *     defect-note: [recovered] <surface> broke <observed symptom>   ← same fingerprint, recovery arm
 *
 * The `[recovered]` marker flips the observation to `recovered`; a later plain note re-opens it
 * to `red`. Notes that do not parse still fold — their fingerprint derives from the normalized
 * raw line, so even malformed captures aggregate instead of vanishing.
 */

/**
 * Filename-free, store-free: nothing to address. The fold consumes message-like rows.
 */

/**
 * Volatility is context-keyed, because identity is: a status code or a count IS the defect
 * (`broke 404` differs from `broke 500`; `returning 0 results` differs from `returning 500
 * results`), while an id, port, epoch, or hash is noise (`repo 12345` is `repo 678`). A digit
 * run therefore collapses only when it is long enough to be an epoch or big id, or when it
 * trails an id-noun; short runs stay verbatim. Long hex runs (hashes) always collapse.
 * @type {RegExp}
 */
const ID_NOUN_DIGIT_PATTERN = /\b(repo|id|pid|port|issue|pr|ticket|message|session|run|job|worker|shard|row|line|epoch)(s?\s*[:#-]?\s*)\d+/gi;
const LONG_HEX_PATTERN      = /[0-9a-f]{8,}/gi;
const LONG_DIGIT_PATTERN    = /\d{6,}/g;
const DEFECT_NOTE_SUBJECT_PATTERN = /^\s*defect-note:\s*/i;
const DEFECT_NOTE_MENTION_PATTERN = /^\s*defect-note\b|\bdefect-note\s*(?=:|[×x]\s*\d|\[)|\[\s*defect-note\b/i;

/**
 * @summary Whether a subject is a canonical defect-note capture subject.
 * @param {*} subject Message subject to classify.
 * @returns {Boolean} True only for the anchored `defect-note:` form.
 */
export function isDefectNoteSubject(subject) {
    return DEFECT_NOTE_SUBJECT_PATTERN.test(String(subject ?? ''));
}

/**
 * @summary Detects an explicit defect-note concept tag.
 * @param {*} taggedConcepts Candidate concept tags.
 * @returns {Boolean} Whether a canonical defect-note tag is present.
 */
function hasDefectNoteTag(taggedConcepts) {
    return Array.isArray(taggedConcepts) && taggedConcepts.some(tag => {
        const concept = String(tag ?? '').trim().replace(/^concept:/i, '');

        return concept.toLowerCase() === 'defect-note';
    });
}

/**
 * @summary Finds the first structural defect delimiter outside quoted literals.
 * @param {String} body Prefix-free defect-note text.
 * @returns {{index: Number, length: Number}|null} Delimiter coordinates, if parseable.
 */
function findDefectNoteDelimiter(body) {
    let quote = null,
        escaped = false;

    for (let index = 0; index < body.length; index++) {
        const character = body[index];

        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === quote) {
                quote = null;
            }
            continue;
        }

        const previous = body[index - 1],
              apostropheStartsQuote = character === "'" && (!previous || !/[\p{L}\p{N}_]/u.test(previous));

        if (character === '"' || character === '`' || apostropheStartsQuote) {
            quote = character;
            continue;
        }

        if (/\s/.test(character)) {
            const match = body.slice(index).match(/^\s+(?:broke|is\s+wrong)\s+/i);

            if (match) return {index, length: match[0].length};
        }
    }

    return null;
}

/**
 * @summary The deterministic observation identity for one defect-note line.
 *
 * Normalization is deliberately shallow: lowercase, whitespace collapse, context-keyed volatile
 * collapse. Deeper "similarity" is ranking, and ranking is a second authority — two notes merge
 * exactly when they normalize identically, which a filer can reason about at capture time.
 *
 * @param {String} line The note text (with or without the `defect-note:` prefix).
 * @returns {String} 16 hex chars — stable for the same normalized line.
 */
export function defectNoteFingerprint(line) {
    const normalized = String(line ?? '')
        .replace(DEFECT_NOTE_SUBJECT_PATTERN, '')
        .replace(/^\s*\[recovered\]\s*/i, '')
        .toLowerCase()
        .replace(ID_NOUN_DIGIT_PATTERN, '$1$2#')
        .replace(LONG_HEX_PATTERN, '#')
        .replace(LONG_DIGIT_PATTERN, '#')
        .replace(/\s+/g, ' ')
        .trim();

    return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * @summary Parses one note line into its surface/symptom arms, ignoring quoted delimiter literals.
 * @param {String} line
 * @returns {{surface: String, symptom: String, recovered: Boolean, parseable: Boolean}}
 */
export function parseDefectNote(line) {
    const text       = String(line ?? '').replace(DEFECT_NOTE_SUBJECT_PATTERN, '').trim(),
          recovered  = /^\[recovered\]\s*/i.test(text),
          body       = text.replace(/^\[recovered\]\s*/i, ''),
          delimiter  = findDefectNoteDelimiter(body);

    if (!delimiter) {
        return {parseable: false, recovered, surface: body, symptom: ''};
    }

    const surface = body.slice(0, delimiter.index).trim(),
          symptom = body.slice(delimiter.index + delimiter.length).trim();

    if (!surface || !symptom) {
        return {parseable: false, recovered, surface: body, symptom: ''};
    }

    return {
        parseable: true,
        recovered,
        surface,
        symptom
    };
}

/**
 * @summary Classifies a proposed defect-note capture without reading its body or mutating its identity.
 * @param {Object} args Subject-only mailbox write properties.
 * @returns {Object|undefined} Admission metadata for defect-note candidates, otherwise undefined.
 */
export function inspectDefectNoteCapture({subject, to, taggedConcepts = []} = {}) {
    const text      = String(subject ?? ''),
          candidate = DEFECT_NOTE_MENTION_PATTERN.test(text) || hasDefectNoteTag(taggedConcepts);

    if (!candidate) return undefined;

    if (!isDefectNoteSubject(text)) {
        return {
            admitted: false,
            reason  : /defect-note\s*[×x]\s*\d+/i.test(text)
                ? 'Body-only batches are not captured; send one defect-note subject per observation.'
                : 'Use `defect-note:` as the complete subject prefix, with one observation in the subject.'
        };
    }

    if (to !== 'AGENT:*') {
        return {admitted: false, reason: 'Send defect notes to `AGENT:*`.'};
    }

    const parsed = parseDefectNote(text);

    return {
        admitted   : true,
        parseable  : parsed.parseable,
        fingerprint: defectNoteFingerprint(text),
        ...(parsed.parseable ? {} : {reason: 'No unambiguous surface/symptom split; raw note retained.'})
    };
}

/**
 * @summary Counts capture and parsing outcomes over a supplied message window.
 * @param {Object[]} rows Message rows; an omitted recipient denotes a broadcast-summary input.
 * @returns {Object} Row, candidate, admitted, dropped, parseable and raw counts.
 */
export function censusDefectNoteCaptures(rows) {
    const result = {rows: 0, candidates: 0, admitted: 0, dropped: 0, parseable: 0, raw: 0};

    for (const row of rows) {
        result.rows++;
        const capture = inspectDefectNoteCapture({subject: row?.subject, taggedConcepts: row?.taggedConcepts, to: row?.to ?? 'AGENT:*'});
        if (!capture) continue;

        result.candidates++;
        if (!capture.admitted) result.dropped++;
        else {
            result.admitted++;
            result[capture.parseable ? 'parseable' : 'raw']++;
        }
    }

    return result;
}

/**
 * @summary Folds `defect-note:` rows into one standing observation record per fingerprint.
 *
 * Input rows need only `{subject, from, sentAt}` — the note text IS the subject, deliberately:
 * production callers use the shared anchored subject predicate, and `listMessages`
 * returns a summary projection that carries no `body` at all. Reading `body` would couple the
 * fold to a field no caller produces — and if the projection ever grew one, every standing
 * fingerprint would silently re-identify. Pure: no I/O, no clock — `now` is passed in so aging
 * is decidable in a spec.
 *
 * State machine per fingerprint: `red` (open sightings) → `recovered` (a recovery note is the
 * latest transition) → `red` again if a fresh sighting lands after recovery. `quiet` is the
 * aging overlay: no note of any kind within `quietAfterMs` of `now`, regardless of state.
 *
 * `threads` are the distinct `partOfThread` values the sightings arrived under. A machine
 * producer files every note as one identity, so the thread — one per CI run and job — is the
 * coordinate that tells two independent observations from one re-read; the digest's promotion
 * trigger reads it beside `reporters`. A hand-filed note carries no thread and records none.
 *
 * @param {Object[]} rows Message-like rows (`{subject, from, sentAt, partOfThread?}`).
 * @param {Object}     [options]
 * @param {Number}     [options.now=Date.now()]            Fold instant (epoch ms).
 * @param {Number}     [options.quietAfterMs=604800000]    Aging window — default 7 days.
 * @returns {Array<Object>} Standing records, most-recently-active first.
 */
export function foldDefectObservations(rows, {now = Date.now(), quietAfterMs = 7 * 24 * 60 * 60 * 1000} = {}) {
    if (!Number.isFinite(now) || !Number.isFinite(quietAfterMs) || quietAfterMs <= 0) {
        throw new Error('foldDefectObservations: now and a positive finite quietAfterMs are required');
    }

    const records = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
        const text = String(row?.subject || ''),
              at   = Date.parse(row?.sentAt);

        if (!text.trim() || !Number.isFinite(at)) continue;

        const fingerprint = defectNoteFingerprint(text),
              parsed      = parseDefectNote(text),
              existing    = records.get(fingerprint),
              thread      = typeof row.partOfThread === 'string' && row.partOfThread.trim() ? row.partOfThread : null;

        if (!existing) {
            records.set(fingerprint, {
                fingerprint,
                surface    : parsed.surface,
                symptom    : parsed.symptom,
                parseable  : parsed.parseable,
                count      : 1,
                reporters  : [...new Set([row.from].filter(Boolean))],
                threads    : thread ? [thread] : [],
                firstSeenAt: new Date(at).toISOString(),
                lastSeenAt : new Date(at).toISOString(),
                state      : parsed.recovered ? 'recovered' : 'red'
            });
            continue;
        }

        existing.count++;
        if (row.from && !existing.reporters.includes(row.from)) existing.reporters.push(row.from);
        if (thread && !existing.threads.includes(thread)) existing.threads.push(thread);
        if (at < Date.parse(existing.firstSeenAt)) existing.firstSeenAt = new Date(at).toISOString();
        if (at > Date.parse(existing.lastSeenAt)) {
            existing.lastSeenAt = new Date(at).toISOString();
            // The newest transition wins: a recovery note closes, a fresh sighting re-opens.
            existing.state      = parsed.recovered ? 'recovered' : 'red';
        }
    }

    return [...records.values()]
        .map(record => ({
            ...record,
            state: now - Date.parse(record.lastSeenAt) > quietAfterMs ? 'quiet' : record.state
        }))
        .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}
