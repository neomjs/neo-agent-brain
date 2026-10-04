import {DEFAULT_FLEET_ACTIVITY_EVENT_LIMIT} from './fleetPrLaneActivityAdapter.mjs';
import {redactCredentials}                  from './redactCredentials.mjs';
import {FLEET_COCKPIT_SOURCES}              from '../../../src/fleet/contract/cockpit.mjs';

/**
 * @module ai/services/fleet/fleetActivityComposer
 * @summary The producer for `FleetControlBridge.activitySource` — one bounded `{capability, events}`
 * snapshot composed from the landed A2A and PR/lane adapters.
 *
 * The bridge has consumed `readActivitySnapshot(params)` since it was written, and nothing ever
 * produced it: the capability's own name (`fleet:activity-adapters`) promised a composition that did
 * not exist, so `fleetActivity` answered `not-wired` permanently, by construction.
 *
 * **Composing two truths means composing two capabilities, and that is the whole design.** Events
 * merge trivially; sight does not. A composite may only claim `wired` when EVERY contributing adapter
 * is wired — because a caller reading `wired` concludes it is seeing the fleet's activity, and one
 * blind adapter makes that false while leaving the event list looking perfectly healthy. A degraded
 * adapter's missing events are indistinguishable from quiet ones, so the capability is the only place
 * that difference can survive.
 *
 * The adapters are INJECTED readers, never imported singletons: the mailbox / PR read paths own
 * identity binding and read permissions, so composing must not smuggle a second path to them.
 */

/**
 * @summary The contributing slots, named by the COMPOSER rather than by the adapters.
 *
 * A slot is what this module asked; `capability.source` is what the adapter says it is. Attributing a
 * failure by the adapter's self-report lets a broken contributor blame a healthy one — the reason
 * line an operator debugs from must come from the party that knows which slot it called.
 * @type {Object}
 */
export const FLEET_ACTIVITY_SLOTS = Object.freeze({
    a2a   : 'a2a',
    prLane: 'pr-lane'
});

/**
 * @summary The cap on a failure reason reaching the cockpit.
 * @type {Number}
 */
export const FLEET_ACTIVITY_REASON_MAX = 200;

/**
 * @summary The hard ceiling on events a caller may request — a MAXIMUM, not a default.
 *
 * `DEFAULT_FLEET_ACTIVITY_EVENT_LIMIT` is what a caller gets when it asks for nothing; this is what
 * it gets when it asks for everything. Without the distinction, refusing `-1` and `NaN` while
 * obeying `1e9` guards the malformed case and leaves the one that matters: `params` arrives over the
 * wire from the App Worker, so the ceiling was caller-chosen against a producer that fans out to
 * every adapter.
 *
 * 4× the default: generous enough that no honest caller meets it, bounded enough that a dishonest
 * one cannot turn one request into an unbounded read of the mailbox and GitHub at once.
 * @type {Number}
 */
export const FLEET_ACTIVITY_BOUND_MAX = 200;

/**
 * @summary Resolves the event bound, refusing values that would silently unbound the read.
 *
 * `params.limit ?? limit` accepted `-1`, `NaN`, `0` and `'50'` — a caller-supplied bound reaches the
 * adapters verbatim, so a bad one is a caller-controlled unbounded read rather than a display quirk.
 * An unusable bound falls back to the configured default instead of being obeyed.
 *
 * @param {*} requested The caller's `limit`.
 * @param {Number} fallback The configured default.
 * @returns {Number}
 * @private
 */
function normalizeBound(requested, fallback) {
    const value = Number(requested);

    // Two different refusals, and the first cut only had one. An unusable bound falls back to the
    // default; a USABLE but unbounded one is clamped. `Number.isInteger(1e9) && 1e9 > 0` is true, so
    // checking only well-formedness let the exact read this guard exists to stop walk through the
    // front door — the reason string was already capped in this same file, and the count was not.
    //
    // `fallback` is validated at construction rather than clamped here: `Math.min(-1, MAX)` is `-1`
    // and `Math.min(NaN, MAX)` is `NaN`, so clamping a configured bound obeys a misconfiguration as
    // readily as it obeyed a hostile one. A bad config is a defect to surface, not a value to repair.
    return Number.isInteger(value) && value > 0 ? Math.min(value, FLEET_ACTIVITY_BOUND_MAX) : fallback
}

/**
 * @summary Resolves the page offset. Like `limit` it arrives over the wire, so anything but a
 * positive integer reads the first page rather than reaching the mailbox.
 *
 * Only the A2A lane pages: the PR/lane adapter slices by `limit` alone and answers its newest rows
 * at any offset, so a history read names `slots: ['a2a']` as well.
 * @param {*} requested The caller's `offset`.
 * @returns {Number}
 * @private
 */
function normalizeOffset(requested) {
    return Number.isInteger(requested) && requested > 0 ? requested : 0
}

/**
 * @summary Resolves the slots a read asks. A caller that wants one lane names it, as a history read
 * of the mailbox does, and the composite capability then speaks for the slots asked. A selection with
 * no known slot asks every slot, as a live read does.
 * @param {*} requested The caller's `slots`: names from {@link FLEET_ACTIVITY_SLOTS}.
 * @param {Object[]} slots Every `{read, slot}` this source composes.
 * @returns {Object[]}
 * @private
 */
function selectSlots(requested, slots) {
    const
        names  = new Set(Array.isArray(requested) ? requested : []),
        chosen = slots.filter(({slot}) => names.has(slot));

    return chosen.length ? chosen : slots
}

/**
 * @summary Caps operator-facing text at `max`, marking the elision.
 *
 * @param {String} raw
 * @param {Number} max
 * @returns {String}
 * @private
 */
function capText(raw, max) {
    return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
}

/**
 * @summary Renders a failure into a reason safe to hand a cockpit.
 *
 * Adapter errors carry filesystem paths, tokens and query fragments. A capability reason is rendered
 * verbatim to an operator and travels through the projection, so it is a leak surface and an unbounded
 * one: an error's `message` has no length contract. Capped and stripped of newlines so one failure
 * cannot flood or restructure the pane it lands in.
 *
 * Redaction is delegated to `redactCredentials`, the single Fleet redaction authority — a private
 * table here would be the sixth copy of a contract that already drifted across five adapters, which
 * is the exact defect that module exists to end. Redaction still runs BEFORE the cap: capping first
 * is not merely insufficient — it is dangerous, severing a token and leaving the prefix that still
 * authenticates while reporting the string as handled.
 *
 * @param {*} failure Error or string.
 * @returns {String}
 * @private
 */
function redactReason(failure) {
    const raw = `${failure?.message ?? failure ?? 'unknown failure'}`.replace(/\s+/g, ' ').trim();

    return capText(redactCredentials(raw), FLEET_ACTIVITY_REASON_MAX)
}

/**
 * @summary Reads one slot, containing every failure mode as that slot's degraded capability.
 *
 * `Promise.resolve(read(params))` does NOT contain a synchronous throw — the call is evaluated before
 * the wrapper exists, so the error escapes the `.catch` and takes the whole snapshot down. An async
 * stub cannot surface that; a real adapter validating its arguments throws exactly that way. `await`
 * inside `try` contains both shapes.
 *
 * A malformed return is contained too: a contributor that answers `undefined`, or without a
 * capability, has not reported sight, and inventing one for it is the failure this module exists to
 * prevent.
 *
 * @param {Function} read The slot's reader.
 * @param {String} slot The composer-owned slot name.
 * @param {Object} params Bounds forwarded to the adapter.
 * @param {String} capturedAt ISO capture stamp.
 * @returns {Promise<{capability: Object, events: Object[]}>}
 * @private
 */
async function readSlot(read, slot, params, capturedAt) {
    // `slot` is carried as a FIELD, not baked into the reason text. The first cut prefixed the reason
    // with `${slot}: ` and omitted the field the healthy return below sets — so `composeCapability`
    // read `capability.slot` as undefined and attributed a named failure to `unknown slot`, on top of
    // the prefix it adds itself. The two return paths of one function disagreed about the contract.
    const degraded = reason => ({
        capability: {source: FLEET_COCKPIT_SOURCES.activity, state: 'degraded', confidence: 'none', capturedAt, slot, reason: redactReason(reason)},
        counts    : [],
        events    : []
    });

    let snapshot;

    try {
        snapshot = await read(params)
    } catch (error) {
        return degraded(error)
    }

    if (!snapshot?.capability) {
        return degraded('returned no capability')
    }

    return {
        // The slot owns the attribution: an adapter's own `source` is its claim about itself, and a
        // composite reason built from it lets a broken contributor name a healthy slot.
        capability: {...snapshot.capability, slot},
        scanned   : Number.isInteger(snapshot.scanned) && snapshot.scanned >= 0 ? snapshot.scanned : null,
        counts    : Array.isArray(snapshot.counts) ? snapshot.counts : [],
        events    : Array.isArray(snapshot.events) ? snapshot.events : []
    }
}

/**
 * @summary Merges two adapter snapshots into one, newest-first and bounded.
 *
 * @param {Object[]} events Every contributing adapter's events.
 * @param {Number} limit Maximum rows to return.
 * @returns {Object[]}
 * @private
 */
function boundEvents(events, limit) {
    const seen = new Set();

    return events
        // Stable identity is an ingress contract, not something the view may synthesize. Missing
        // ids are omitted; repeated ids name one producer fact and collapse newest-first.
        .filter(event => typeof event?.eventId === 'string' && event.eventId.trim())
        .sort((left, right) => String(right?.occurredAt ?? '').localeCompare(String(left?.occurredAt ?? '')))
        .filter(event => {
            if (seen.has(event.eventId)) {
                return false
            }

            seen.add(event.eventId);
            return true
        })
        .slice(0, limit)
}

/**
 * @summary Keeps only source-qualified count rows whose producer proves completeness.
 *
 * The composer does not aggregate across slots: a complete mailbox total beside an uncounted
 * PR/lane corpus is a complete mailbox total, never a fleet total. Duplicate source/scope rows
 * collapse to the newest capture.
 * @param {Object[]} contributions Slot snapshots.
 * @returns {Object[]}
 * @private
 */
function composeCounts(contributions) {
    const rows = new Map();

    contributions.flatMap(contribution => contribution.counts || []).forEach(row => {
        const valid = typeof row?.source === 'string' && row.source
            && (row.scope === 'last24h' || row.scope === 'total')
            && row.complete === true
            && Number.isInteger(row.value) && row.value >= 0
            && !Number.isNaN(Date.parse(row.capturedAt));

        if (!valid) {
            return
        }

        const key      = `${row.source}:${row.scope}`,
              previous = rows.get(key);

        if (!previous || Date.parse(row.capturedAt) >= Date.parse(previous.capturedAt)) {
            rows.set(key, {...row})
        }
    });

    return [...rows.values()].sort((left, right) => {
        const sourceOrder = left.source.localeCompare(right.source);

        return sourceOrder || (left.scope === 'last24h' ? -1 : 1)
    })
}

/**
 * @summary Composes the contributing capabilities into the one the caller may trust.
 *
 * Fail-honest and deliberately pessimistic: `wired` requires unanimity. Any contributor that is
 * not wired downgrades the composite and names itself in the reason, because "we saw everything"
 * and "we saw what we could" are different claims and only one of them is true here. Confidence
 * follows the same rule — the composite is never more confident than its weakest contributor.
 *
 * @param {Object[]} capabilities Contributing adapter capabilities.
 * @param {String} capturedAt ISO capture stamp.
 * @returns {Object} `{source, state, confidence, capturedAt, reason}`
 * @private
 */
function composeCapability(capabilities, capturedAt) {
    const
        blind = capabilities.filter(capability => capability?.state !== 'wired'),
        // each contributor's own capability, by the slot this composer asked: what a contributor
        // observed (a producer's high-water time, its coverage, its retained window) survives the
        // composition instead of being replaced by this read's clock
        slots = Object.fromEntries(capabilities.filter(capability => capability?.slot).map(capability => [capability.slot, capability]));

    if (blind.length === 0) {
        return {
            source    : FLEET_COCKPIT_SOURCES.activity,
            state     : 'wired',
            confidence: 'observed',
            capturedAt,
            reason    : null,
            slots
        }
    }

    // Name every blind contributor, not just the first: an operator debugging a partial feed needs to
    // know which half is missing, and a single-source reason invites fixing the wrong adapter.
    //
    // Attribution is by SLOT — what this composer asked — not by `capability.source`, which is the
    // adapter's claim about itself. A contributor that mislabels its source would otherwise send the
    // operator to a healthy adapter, and the one surface that exists to be trusted when things break
    // must not be forgeable by the thing that broke.
    //
    // The COMPOSITE is what an operator reads, so the composite is what must be capped. Capping each
    // part and then joining them bounds nothing: two blind slots at 200 each, plus prefixes and the
    // separator, reached ~430 through a guard whose whole purpose was that one failure cannot flood
    // the pane. A bound on the inputs is not a bound on the result.
    const reason = capText(
        blind
            .map(capability => `${capability?.slot ?? 'unknown slot'}: ${redactReason(capability?.reason ?? capability?.state ?? 'unavailable')}`)
            .join('; '),
        FLEET_ACTIVITY_REASON_MAX
    );

    return {
        source    : FLEET_COCKPIT_SOURCES.activity,
        // `not-wired` only when NOTHING could be read — otherwise the feed genuinely carries partial
        // truth and `degraded` is the honest word for it. Collapsing both into one state would tell a
        // caller with half a feed the same thing it tells one with none.
        state     : blind.length === capabilities.length ? 'not-wired' : 'degraded',
        confidence: 'none',
        capturedAt,
        reason,
        slots
    }
}

/**
 * @summary A seat's lane outlives the page it was read from: each seat's newest claim or release
 * (`claim-corrected`), folded forward from every admitted first page for one viewer. A claim leaves
 * only when its seat sends a newer claim or a release, never because newer mail pushed it off the
 * page. With a `{load, save}` store it survives a restart, for the mailbox source and viewer it was
 * read from: a record from another plane or another viewer is not shown, and the first change
 * replaces it. A saved record this process cannot read (a throwing load, or a parsed value that is
 * not `{source, viewerIdentity, seats}`) stays out of this process and is never overwritten.
 * @param {Object|null} store
 * @param {String|null} source The admitted mailbox's identity, saved with the record.
 * @returns {{fold: Function, claimsFor: Function}}
 * @private
 */
function createLaneRecord(store, source) {
    let viewer   = null,
        seats    = new Map(),
        writable = Boolean(store);

    try {
        const saved = store?.load() ?? null;

        if (saved !== null) {
            if (typeof saved.source !== 'string' || typeof saved.viewerIdentity !== 'string' || !Array.isArray(saved.seats)) {
                throw new TypeError('not a {source, viewerIdentity, seats} record')
            }

            if (saved.source === source) {
                viewer = saved.viewerIdentity;
                seats  = new Map(saved.seats)
            }
        }
    } catch (error) {
        writable = false;
        console.warn('[fleetActivityComposer] the saved lane record is unreadable; lanes stay in memory:', error?.message ?? error)
    }

    return {
        fold(viewerIdentity, {capability, events} = {}) {
            if (capability?.state !== 'wired') return;

            let changed = viewer !== viewerIdentity;

            if (changed) {
                viewer = viewerIdentity;
                seats  = new Map()
            }

            for (const {agentId, occurredAt, payload} of (Array.isArray(events) ? events : []).filter(Boolean)) {
                const collisionTag = payload?.collisionTag,
                      at           = Date.parse(occurredAt),
                      previous     = seats.get(agentId);

                if ((collisionTag !== 'lane-claim' && collisionTag !== 'claim-corrected') ||
                    typeof agentId !== 'string' || !agentId || !Number.isFinite(at)) {
                    continue
                }

                // an older claim or release displaces nothing
                if (previous && at <= Date.parse(previous.occurredAt)) {
                    continue
                }

                seats.set(agentId, {collisionTag, occurredAt, messageId: payload.messageId ?? null, subject: payload.subject ?? null});
                changed = true
            }

            if (changed && writable) {
                try {
                    store.save({source, viewerIdentity: viewer, seats: [...seats]})
                } catch (error) {
                    console.warn('[fleetActivityComposer] the lane record was not saved:', error?.message ?? error)
                }
            }
        },

        claimsFor(viewerIdentity) {
            return viewerIdentity !== viewer ? [] : [...seats]
                .filter(([, seat]) => seat?.collisionTag === 'lane-claim')
                .map(([agentId, {messageId, occurredAt, subject}]) => ({
                    type: 'lane-claim', source: FLEET_COCKPIT_SOURCES.a2a, agentId, occurredAt, payload: {messageId, subject}
                }))
        }
    }
}

/**
 * @summary Builds the injectable activity read-source the bridge consumes.
 *
 * @param {Object}   options={}
 * @param {Function} options.readA2ASnapshot `params => Promise<{capability, events}>` — the A2A
 *   adapter's read path, already bound to its own injected `listMessages`.
 * @param {Function} options.readPrLaneSnapshot `params => Promise<{capability, events}>` — the
 *   PR/lane adapter's read path. The adapter itself is a pure builder over already-read facts, so
 *   the caller owns the reading and this composer never reaches for GitHub or the graph directly.
 * @param {Number}   [options.limit=DEFAULT_FLEET_ACTIVITY_EVENT_LIMIT] Default event bound.
 * @param {Function} [options.resolveViewerIdentity] Server-bound mailbox viewer at each call; absent disables retention.
 * @param {Object}   [options.laneClaimStore] `{load, save}` for the per-seat lane record; absent keeps it in memory.
 * @param {String}   [options.laneClaimSource] The admitted mailbox's identity, required with a store:
 *   a saved record is only read back against the source it was read from.
 * @returns {{readActivitySnapshot: Function, readHeldA2ASnapshot: Function}} The activity read and its viewer-bound first-page observation.
 * @throws {TypeError} When a reader is missing — an unreadable half must be an explicit degraded
 *   capability from a real adapter, never a composer quietly composing one contributor and calling
 *   the result the fleet's activity — or when a lane store arrives without its source.
 */
export function createFleetActivityReadSource({readA2ASnapshot, readPrLaneSnapshot, resolveViewerIdentity = () => null, limit = DEFAULT_FLEET_ACTIVITY_EVENT_LIMIT, laneClaimStore = null, laneClaimSource = null} = {}) {
    if (typeof readA2ASnapshot !== 'function' || typeof readPrLaneSnapshot !== 'function') {
        throw new TypeError('[fleetActivityComposer] readA2ASnapshot and readPrLaneSnapshot must be injected')
    }

    if (laneClaimStore && (typeof laneClaimSource !== 'string' || !laneClaimSource)) {
        throw new TypeError('[fleetActivityComposer] a laneClaimStore needs the laneClaimSource its record belongs to')
    }

    // The configured bound is validated where the readers are, and for the same reason: a wrong one is
    // a defect to surface, not a value to repair. `normalizeBound` guarded the CALLER's limit and then
    // handed a misconfigured `-1` straight to the adapters as the fallback for every refused request —
    // the guard against an unbounded read, unbounding the read itself. Failing at construction refuses
    // it once, loudly, instead of silently on every subsequent call.
    if (!Number.isInteger(limit) || limit < 1 || limit > FLEET_ACTIVITY_BOUND_MAX) {
        throw new TypeError(`[fleetActivityComposer] limit must be an integer between 1 and ${FLEET_ACTIVITY_BOUND_MAX}; received ${limit}`)
    }

    const slots = [
        {read: readA2ASnapshot,    slot: FLEET_ACTIVITY_SLOTS.a2a},
        {read: readPrLaneSnapshot, slot: FLEET_ACTIVITY_SLOTS.prLane}
    ];

    const lanes = createLaneRecord(laneClaimStore, laneClaimSource);

    let heldA2A       = null,
        newestA2ARead = 0;

    return {
        /**
         * @summary Read the admitted first mailbox page without I/O, only within its bound viewer.
         * @returns {Object|null} An independent snapshot carrying the viewer's per-seat `laneClaims`,
         * or null before a matching viewer's read.
         */
        readHeldA2ASnapshot() {
            const viewerIdentity = resolveViewerIdentity();

            return viewerIdentity && viewerIdentity === heldA2A?.viewerIdentity
                ? {...structuredClone(heldA2A.snapshot), laneClaims: lanes.claimsFor(viewerIdentity)}
                : null
        },

        /**
         * @summary Read the requested slots, retaining only the newest viewer-bound first mailbox page.
         * @param {Object} params Activity selection and paging.
         * @returns {Promise<Object>} The bounded composite activity snapshot.
         */
        async readActivitySnapshot(params = {}) {
            const
                capturedAt     = new Date().toISOString(),
                bound          = normalizeBound(params.limit, limit),
                offset         = normalizeOffset(params.offset),
                selected       = selectSlots(params.slots, slots),
                holdsA2A       = offset === 0 && selected.some(({slot}) => slot === FLEET_ACTIVITY_SLOTS.a2a),
                generation     = holdsA2A ? ++newestA2ARead : null,
                viewerIdentity = holdsA2A ? resolveViewerIdentity() : null,
                // Every asked slot is read even when one is expected to fail: a contributor that cannot
                // read must return its OWN degraded capability, and short-circuiting would replace
                // that adapter's stated reason with the composer's guess about it. A caller's
                // `slots` is a question about lanes, not a skip of a failing one.
                contributions = await Promise.all(selected.map(({read, slot}) =>
                    readSlot(read, slot, {...params, limit: bound, offset}, capturedAt)));

            // History and late completions cannot replace the newest admitted mailbox window.
            if (holdsA2A && generation === newestA2ARead) {
                const a2a = contributions.find(({capability}) => capability.slot === FLEET_ACTIVITY_SLOTS.a2a);

                heldA2A = viewerIdentity ? {viewerIdentity, snapshot: structuredClone(a2a)} : null;
                viewerIdentity && lanes.fold(viewerIdentity, a2a)
            }

            return {
                capability: composeCapability(contributions.map(contribution => contribution.capability), capturedAt),
                counts    : composeCounts(contributions),
                events    : boundEvents(contributions.flatMap(contribution => contribution.events), bound)
            }
        }
    }
}
