import fs                    from 'fs';
import path                  from 'path';
import aiConfig              from '../../config.mjs';
import Base                  from 'neo.mjs/src/core/Base.mjs';
import {writeFileAtomicSync} from '../shared/atomicFileWrite.mjs';

const
    LOCK_FILE    = 'seat-operators.lock',
    STORE_FILE   = 'seat-operators.json',
    STORE_SCHEMA = 1,
    // an admitted owner principal (`ForgeConnectionRegistryService#resolveOwner`): owner:<connectionId>:<providerUserId>
    PRINCIPAL    = /^owner:[^:\s]+:[^:\s]+$/;

/**
 * @summary Whether a value has the owner-principal shape, `owner:<connectionId>:<providerUserId>`.
 * @param {*} value
 * @returns {Boolean}
 */
export function isOwnerPrincipal(value) {
    return typeof value === 'string' && PRINCIPAL.test(value)
}

/**
 * @summary What makes a parsed store unusable, or null when it is a v1 store.
 * @param {*} data
 * @returns {String|null}
 */
function storeProblem(data) {
    const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);

    if (!isMap(data) || data.schema !== STORE_SCHEMA)         return `it is not a schema-${STORE_SCHEMA} store`;
    if (!Number.isInteger(data.version) || data.version < 0) return 'its version is not a non-negative integer';
    if (!isMap(data.operators) || !Array.isArray(data.events)) return 'an operators or events table is missing';
    if (data.events.length !== data.version)                  return 'its version does not count its events';
    if (data.events.some((event, index) => event?.seq !== index + 1)) return 'its event log is out of sequence';

    for (const record of Object.values(data.operators)) {
        if (!isOwnerPrincipal(record?.principal)) return 'an operator record names no owner principal'
    }

    return null
}

/**
 * @summary The refusal shape every mutation returns; it writes nothing.
 * @param {String} refused
 * @param {String} reason
 * @returns {{ok: false, refused: String, reason: String}}
 */
function refusal(refused, reason) {
    return {ok: false, refused, reason}
}

/**
 * @summary Which owner principal operates each Fleet seat: the server-held relation behind
 * {@link Neo.ai.services.fleet.FleetRegistryService#operatesSeat}. One principal per seat.
 *
 * The store is `seat-operators.json` in the Fleet's own durable root, beside the seat registry. It holds
 * `{seatId → {principal, since, actor}}` and an append-only event log; its `version` counts the events.
 * Two writers share it, so both hold an exclusive lock, re-read the store, build the next state, append
 * an event and replace the file atomically:
 * - the seat registry: {@link claim} before `defineAgent` writes a seat, so a new seat holds its admitted
 *   principal or none and never a predecessor's, and {@link release} when `removeAgent` removes one;
 * - the plane-local administrative path, the `seatOperators` CLI run on the plane host, for
 *   {@link assign} (legacy seats) and {@link transfer}. No wire verb, bridge method or grant reaches them:
 *   host access to the Fleet data root is their authority.
 *
 * Reads never repair: an absent store has no operators, and a store that cannot be read or fails its
 * integrity check reads `unavailable`, never "no operator". A refused mutation writes nothing.
 * @class Neo.ai.services.fleet.SeatOperatorRegistryService
 * @extends Neo.core.Base
 * @singleton
 */
class SeatOperatorRegistryService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.fleet.SeatOperatorRegistryService'
         * @protected
         */
        className: 'Neo.ai.services.fleet.SeatOperatorRegistryService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true,
        /**
         * @summary Instance-local Fleet data-root override, for isolation and tests. Production leaves it
         * null, so the store sits in the canonical `AiConfig.fleet.dataDir` plane member, read at the use site.
         * @member {String|null} dataDir=null
         */
        dataDir: null
    }

    /**
     * @summary Assigns unowned seats to one principal: the bounded migration for seats defined before the
     * relation existed. All or nothing: a seat another principal operates refuses the whole call, and a seat
     * this principal already operates is left as it is, with no new event.
     * @param {Object}   options
     * @param {String}   options.actor
     * @param {Boolean}  [options.apply=false]
     * @param {String}   options.principal
     * @param {String[]} options.seats
     * @param {Function} options.seatExists `seatId => Boolean`, the seat registry's answer.
     * @returns {Object} `{ok: true, assigned, unchanged, applied, version}` or `{ok: false, refused, reason}`.
     */
    assign({actor, apply=false, principal, seats, seatExists}) {
        if (!isOwnerPrincipal(principal))          return refusal('no-principal', 'the principal must be owner:<connectionId>:<providerUserId>');
        if (!Array.isArray(seats) || !seats.length) return refusal('no-seats', 'name at least one seat');

        return this.mutate({actor, apply, op: 'assign', idle: result => result.assigned.length === 0}, store => {
            const assigned = [], unchanged = [];

            for (const seatId of new Set(seats)) {
                if (!seatExists(seatId)) return refusal('unknown-seat', `no seat '${seatId}' is defined`);

                const current = store.operators[seatId]?.principal;

                if (current === principal) {
                    unchanged.push(seatId);
                    continue
                }

                if (current) return refusal('other-operator', `seat '${seatId}' is operated by another principal; transfer it instead`);

                assigned.push(seatId)
            }

            const since = new Date().toISOString();

            assigned.forEach(seatId => {store.operators[seatId] = {actor, principal, since}});

            return {ok: true, assigned, principal, unchanged}
        })
    }

    /**
     * @summary Records who operates a seat `defineAgent` is about to write: the admitted principal, or no one
     * without admission. It runs before the definition exists, so a record an earlier seat of the same id
     * left is replaced or cleared, and a new seat never inherits its predecessor's operator. A refusal
     * refuses the create. A claim whose definition then fails to publish names a seat that does not exist:
     * no lookup reads it as operated, and the next create of that id claims again.
     * @param {Object}      options
     * @param {String|null} options.principal The admission's owner principal, or null without admission.
     * @param {String}      options.seatId
     * @returns {Object} `{ok: true, applied, version}` or `{ok: false, refused, reason}`.
     */
    claim({principal, seatId}) {
        if (principal !== null && !isOwnerPrincipal(principal)) return refusal('no-principal', 'an admission must carry an owner principal');

        return this.mutate({actor: principal, apply: true, op: 'define', idle: result => !result.principal && !result.replaced}, store => {
            const replaced = store.operators[seatId]?.principal ?? null;

            if (principal) {
                store.operators[seatId] = {actor: principal, principal, since: new Date().toISOString()}
            } else {
                delete store.operators[seatId]
            }

            return {ok: true, principal, replaced, seatId}
        })
    }

    /**
     * @summary The Fleet data root the store lives in.
     * @returns {String}
     */
    getDataDir() {
        return this.dataDir || aiConfig.fleet.dataDir
    }

    /**
     * @summary Runs one mutation: re-read under the lock, change a copy, append the event, write atomically.
     * An absent store starts empty; a store that cannot be trusted is never replaced. A refusal from
     * `change`, or a change `idle` calls a no-op, writes nothing.
     * @param {Object}      options
     * @param {String|null} options.actor The admitted principal or the host actor; null when the registry
     *     acts for no admitted caller (a define without admission, a remove).
     * @param {Boolean}     options.apply
     * @param {String}      options.op    The event's operation name.
     * @param {Function}    [options.idle] `result => Boolean`: true when the change moved nothing.
     * @param {Function}    change        `store => result`, mutating the copy; `{ok: false}` refuses.
     * @returns {Object}
     * @protected
     */
    mutate({actor, apply, op, idle = () => false}, change) {
        return this.withLock(apply, () => {
            const {state, store, reason} = this.read();

            if (state === 'corrupt') return refusal('store-unavailable', `the store is never replaced: ${reason}`);

            const next   = structuredClone(store ?? {schema: STORE_SCHEMA, version: 0, operators: {}, events: []}),
                  result = change(next);

            if (!result.ok)   return result;
            if (idle(result)) return {...result, applied: false, version: next.version};

            const {ok, ...event} = result;

            next.version += 1;
            next.events.push({seq: next.version, at: new Date().toISOString(), op, actor, ...event});

            apply && this.write(next);

            return {...result, applied: apply, version: next.version}
        })
    }

    /**
     * @summary The one seat's operator, read fresh. Never throws.
     * @param {String} seatId
     * @returns {{state: 'ok', principal: String|null}|{state: 'unavailable', reason: String}}
     */
    operatorOf(seatId) {
        const {state, store, reason} = this.read();

        if (state === 'corrupt') return {state: 'unavailable', reason};

        return {principal: store?.operators[seatId]?.principal ?? null, state: 'ok'}
    }

    /**
     * @summary One read of the store, never thrown and never written.
     * @returns {{state: 'absent'|'ok'|'corrupt', store: Object|null, reason: String|null}}
     */
    read() {
        let data;

        try {
            data = JSON.parse(fs.readFileSync(path.join(this.getDataDir(), STORE_FILE), 'utf8'))
        } catch (error) {
            return error.code === 'ENOENT'
                ? {state: 'absent', store: null, reason: null}
                : {state: 'corrupt', store: null, reason: error instanceof SyntaxError ? 'it is not valid JSON' : `it cannot be read (${error.code ?? error.message})`}
        }

        let problem;

        try {
            problem = storeProblem(data)
        } catch {
            problem = 'its structure cannot be read'
        }

        return problem ? {state: 'corrupt', store: null, reason: problem} : {state: 'ok', store: data, reason: null}
    }

    /**
     * @summary Drops a seat's record when `removeAgent` removes the seat. Tidiness, not the guarantee: a
     * refused release leaves a record for a seat that no longer exists, which no lookup reads as operated,
     * and the next create of that id replaces or clears it ({@link claim}).
     * @param {Object} options
     * @param {String} options.seatId
     * @returns {Object} `{ok: true, applied, version}` or `{ok: false, refused, reason}`.
     */
    release({seatId}) {
        return this.mutate({actor: null, apply: true, op: 'remove', idle: result => !result.released}, store => {
            const released = store.operators[seatId]?.principal ?? null;

            delete store.operators[seatId];

            return {ok: true, released, seatId}
        })
    }

    /**
     * @summary The seats one principal operates, read fresh. Never throws.
     * @param {String} principal
     * @returns {{state: 'ok', seats: String[]}|{state: 'unavailable', reason: String}}
     */
    seatsOf(principal) {
        const {state, store, reason} = this.read();

        if (state === 'corrupt') return {state: 'unavailable', reason};

        return {
            seats: Object.entries(store?.operators ?? {}).filter(([, record]) => record.principal === principal).map(([seatId]) => seatId),
            state: 'ok'
        }
    }

    /**
     * @summary Moves a seat from one principal to another, compare-and-set: the seat's current operator
     * must be `from`. This is how a replaced forge connection, a new principal, gets its seats back.
     * @param {Object}  options
     * @param {String}  options.actor
     * @param {Boolean} [options.apply=false]
     * @param {String}  options.from
     * @param {String}  options.seat
     * @param {String}  options.to
     * @returns {Object} `{ok: true, seat, from, to, applied, version}` or `{ok: false, refused, reason}`.
     */
    transfer({actor, apply=false, from, seat, to}) {
        if (!isOwnerPrincipal(from) || !isOwnerPrincipal(to)) return refusal('no-principal', 'both principals must be owner:<connectionId>:<providerUserId>');
        if (from === to)                                       return refusal('same-principal', 'a transfer needs two different principals');

        return this.mutate({actor, apply, op: 'transfer'}, store => {
            const current = store.operators[seat]?.principal;

            if (!current)         return refusal('unowned', `seat '${seat}' has no operator; assign it instead`);
            if (current !== from) return refusal('not-current', `seat '${seat}' is not operated by the --from principal`);

            store.operators[seat] = {actor, principal: to, since: new Date().toISOString()};

            return {ok: true, from, seat, to}
        })
    }

    /**
     * @summary Runs `fn` under the store's exclusive lock; a dry run takes no lock. A held lock refuses
     * rather than waits.
     * @param {Boolean}  apply
     * @param {Function} fn
     * @returns {Object}
     * @protected
     */
    withLock(apply, fn) {
        if (!apply) return fn();

        const dataDir  = this.getDataDir(),
              lockPath = path.join(dataDir, LOCK_FILE);

        fs.mkdirSync(dataDir, {recursive: true, mode: 0o700});

        let handle;

        try {
            handle = fs.openSync(lockPath, 'wx', 0o600)
        } catch (error) {
            if (error.code === 'EEXIST') {
                return refusal('busy', `another seat-operator mutation holds ${lockPath}; remove it only if none is running`)
            }

            throw error
        }

        try {
            return fn()
        } finally {
            fs.closeSync(handle);
            fs.rmSync(lockPath, {force: true})
        }
    }

    /**
     * @summary Replaces the store atomically.
     * @param {Object} store
     * @protected
     */
    write(store) {
        writeFileAtomicSync(path.join(this.getDataDir(), STORE_FILE), `${JSON.stringify(store, null, 4)}\n`, {fsync: true, mode: 0o600})
    }
}

export default Neo.setupClass(SeatOperatorRegistryService);
