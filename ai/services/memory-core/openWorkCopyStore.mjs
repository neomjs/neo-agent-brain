import {openWorkFreshness} from '../fleet/openWorkFreshness.mjs';

/**
 * @module ai/services/memory-core/openWorkCopyStore
 * @summary The plane's copy of the Fleet's open-work projection: each seat's open pull requests and the reviews
 * requested of it, as the host producer last published them. A seat's wake digest reads its own entry here, so no
 * seat reads GitHub for it.
 *
 * The copy lives in this process. A plane restart empties it and the next pulse fills it again, so a read answers
 * `unavailable` in between, never "no open work". Every entry belongs to the publisher that wrote it: a publication
 * replaces that publisher's entries whole and leaves every other publisher's untouched, and an entry ages by the
 * observation that wrote it. Plain data, no I/O: the intake verifies the publisher before a write reaches here.
 */

const
    /** @summary The coverage words the producer stamps on a pulse that answered. */
    COVERAGES = new Set(['complete', 'partial', 'stale']),
    /** @summary The most seats one publication tracks. */
    MAX_SEATS = 100,
    /** @summary The most rows one seat's list carries. */
    MAX_ROWS = 100,
    /** @summary The most bytes one publication's seats may hold. */
    MAX_BYTES = 256 * 1024,
    /** @summary The longest title or reason a publication keeps. */
    MAX_TEXT = 300,
    SEAT_ID = /^@[\w.-]{1,100}$/,
    REPO    = /^[\w.-]{1,100}\/[\w.-]{1,100}$/,
    /** @summary Each publisher's last publication, keyed by the publisher's verified identity. */
    publications = new Map();

/**
 * @summary A bounded string, or null.
 * @param {*} value
 * @param {Number} [max=MAX_TEXT]
 * @returns {String|null}
 * @private
 */
function text(value, max = MAX_TEXT) {
    return typeof value === 'string' ? value.slice(0, max) : null
}

/**
 * @summary The part of a projection row a digest names, or null when the row has no repository and number.
 * @param {Object} row One row of a seat's `authored` or `reviewing` list.
 * @returns {Object|null} `{repo, number, title, ci, verdict, stale, holder: {role, kind}}`.
 * @private
 */
function rowOf(row) {
    if (!REPO.test(row?.repo ?? '') || !Number.isInteger(row.number) || row.number < 1) return null;

    return {
        repo   : row.repo,
        number : row.number,
        title  : text(row.title),
        ci     : text(row.ci, 20),
        verdict: text(row.verdict, 40),
        stale  : row.stale === true,
        holder : {role: text(row.holder?.role, 20), kind: text(row.holder?.kind, 40)}
    }
}

/**
 * @summary One seat's lists, or the reason they are refused.
 * @param {Object} work `{authored, reviewing}`.
 * @returns {{work?: Object, error?: String}}
 * @private
 */
function workOf(work) {
    const lists = {authored: work?.authored ?? [], reviewing: work?.reviewing ?? []};

    for (const [name, rows] of Object.entries(lists)) {
        if (!Array.isArray(rows) || rows.length > MAX_ROWS) return {error: `${name} must be at most ${MAX_ROWS} rows`};

        lists[name] = rows.map(rowOf);

        if (lists[name].includes(null)) return {error: `${name} holds a row without a repository and number`}
    }

    return {work: lists}
}

/**
 * @summary Replaces one publisher's entries with a publication, whole. A malformed publication writes nothing, so
 * the previous copy stays and keeps aging by its own observation. A tracked identity the plane does not know as an
 * agent is refused and named, and the rest is written.
 * @param {String} publisher The verified identity that publishes; it keys the entries, and nothing in `args` can.
 * @param {Object} args
 * @param {String}      args.observedAt The producer's last pulse, an ISO time.
 * @param {String}      args.coverage   `complete`, `partial` or `stale`.
 * @param {String|null} [args.reason]   The producer's reason for a partial or stale pulse.
 * @param {String[]}    args.tracked    Every seat the publication covers; one without rows reads empty.
 * @param {Object}      [args.seats]    `{[seat]: {authored, reviewing}}` for tracked seats.
 * @param {Object}   options
 * @param {Function} options.isAgent `seat → Boolean`: whether the plane knows the seat as an agent identity.
 * @param {Number}   [options.now=Date.now()]
 * @returns {{publishedAt: String, tracked: Number, refused: Array<{seat: String, reason: String}>}}
 */
export function writeOpenWorkCopy(publisher, {observedAt, coverage, reason = null, tracked, seats = {}} = {}, {isAgent, now = Date.now()}) {
    const refuse = message => {
        throw new Error(`Refused open-work copy: ${message}.`)
    };

    Number.isFinite(Date.parse(observedAt))                       || refuse('observedAt must be an ISO time');
    COVERAGES.has(coverage)                                       || refuse(`coverage must be one of ${[...COVERAGES].join(', ')}`);
    Array.isArray(tracked) && tracked.length <= MAX_SEATS         || refuse(`tracked must list at most ${MAX_SEATS} seats`);
    tracked.every(seat => SEAT_ID.test(seat))                     || refuse('tracked must list @identities');
    seats && typeof seats === 'object' && !Array.isArray(seats)   || refuse('seats must map seats to their open work');
    Object.keys(seats).every(seat => tracked.includes(seat))      || refuse('seats names a seat the publication does not track');
    JSON.stringify(seats).length <= MAX_BYTES                     || refuse(`seats must hold at most ${MAX_BYTES} bytes`);

    const entries = new Map(), refused = [];

    for (const seat of new Set(tracked)) {
        const {work, error} = workOf(seats[seat]);

        error && refuse(`${seat}: ${error}`);

        isAgent(seat) ? entries.set(seat, work) : refused.push({seat, reason: 'not a registered agent identity'})
    }

    const publishedAt = new Date(now).toISOString();

    publications.set(publisher, {coverage, entries, observedAt, publishedAt, reason: text(reason)});

    return {publishedAt, tracked: entries.size, refused}
}

/**
 * @summary One identity's open work from the copy, with its freshness. When two publishers track the identity, the
 * entry with the newer observation answers. Past the unavailable bound, the rows are withheld rather than shown as
 * current work.
 * @param {String} identity A canonical `@identity`.
 * @param {Object} [options]
 * @param {Number} [options.now=Date.now()]
 * @returns {Object} `{state: 'ok'|'stale', observedAt, publishedAt, coverage, reason, authored, reviewing}`, or
 *     `{state: 'unavailable'|'untracked', observedAt, reason}`.
 */
export function ownOpenWorkOf(identity, {now = Date.now()} = {}) {
    if (publications.size === 0) {
        return {state: 'unavailable', observedAt: null, reason: 'no open-work copy has reached this plane yet'}
    }

    let newest = null;

    for (const publication of publications.values()) {
        const work = publication.entries.get(identity);

        if (work && (!newest || Date.parse(publication.observedAt) > Date.parse(newest.publication.observedAt))) {
            newest = {publication, work}
        }
    }

    if (!newest) {
        return {state: 'untracked', observedAt: null, reason: `the open-work copy does not track ${identity}`}
    }

    const
        {publication, work} = newest,
        freshness           = openWorkFreshness(publication.observedAt, {now});

    if (freshness === 'unavailable') {
        return {state: 'unavailable', observedAt: publication.observedAt, reason: 'the last open-work copy is too old to show'}
    }

    return {
        state      : freshness === 'stale' || publication.coverage === 'stale' ? 'stale' : 'ok',
        observedAt : publication.observedAt,
        publishedAt: publication.publishedAt,
        coverage   : publication.coverage,
        reason     : publication.reason,
        ...structuredClone(work)
    }
}

/**
 * @summary Empties the copy, as a plane restart does.
 */
export function resetOpenWorkCopy() {
    publications.clear()
}
