import crypto                from 'crypto';
import fs                    from 'fs';
import path                  from 'path';
import aiConfig              from '../../config.mjs';
import Base                  from 'neo.mjs/src/core/Base.mjs';
import {writeFileAtomicSync} from '../shared/atomicFileWrite.mjs';

/**
 * @summary The forges an admission can resolve, as AuthService names them.
 * @type {ReadonlyArray<String>}
 */
export const FORGE_AUTH_PROVIDERS = Object.freeze(['github', 'gitlab']);

const
    LOCK_FILE    = 'forge-connections.lock',
    STORE_FILE   = 'forge-connections.json',
    STORE_SCHEMA = 1;

/**
 * @summary The v1 endpoint floor (RFC 3986 syntax-based normalization): scheme and host case, a
 * scheme-default port and trailing slashes are not identity. The scheme value, a non-default port and
 * the path are. A value carrying credentials, a query or a fragment is no endpoint, so it can neither
 * resolve nor bind.
 * @param {*} value A forge base URL.
 * @returns {String|null} The normalized endpoint, or null.
 */
export function normalizeEndpoint(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;

    let url;

    try {
        url = new URL(value.trim())
    } catch {
        return null
    }

    if (url.username || url.password || url.search || url.hash) return null;

    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * @summary What makes a parsed store unusable, or null when it is a v1 store whose references and
 * event log agree.
 * @param {*} data
 * @returns {String|null}
 */
function storeProblem(data) {
    const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);

    if (!isMap(data) || data.schema !== STORE_SCHEMA)            return `it is not a schema-${STORE_SCHEMA} store`;
    if (!Number.isInteger(data.version) || data.version < 1)    return 'its version is not a positive integer';
    if (![data.connections, data.bindings, data.tombstones].every(isMap) || !Array.isArray(data.events)) {
        return 'a connections, bindings, tombstones or events table is missing'
    }

    for (const connection of Object.values(data.connections)) {
        if (!FORGE_AUTH_PROVIDERS.includes(connection?.authProvider)) return 'a connection names no known forge';
    }

    for (const table of ['bindings', 'tombstones']) {
        for (const [endpoint, id] of Object.entries(data[table])) {
            if (normalizeEndpoint(endpoint) !== endpoint) return `a ${table} key is not a normalized endpoint`;

            // a string before any key lookup: Object.hasOwn would coerce ['id'] to 'id', and throw on an
            // object that cannot become a primitive
            if (typeof id !== 'string' || id === '' || !Object.hasOwn(data.connections, id)) {
                return `a ${table} entry names an unknown connection`
            }
        }
    }

    if (Object.keys(data.bindings).some(endpoint => Object.hasOwn(data.tombstones, endpoint))) {
        return 'an endpoint is both bound and tombstoned'
    }

    if (data.events.length !== data.version || data.events.some((event, index) => event?.seq !== index + 1)) {
        return 'its event log does not match its version'
    }

    return null
}

/**
 * @summary The Fleet's forge-connection registry: which forge endpoints this plane trusts, and the
 * opaque connection each binds to. An admission's owner principal is `owner:<connectionId>:<providerUserId>`,
 * resolved here and nowhere else.
 *
 * The store is `forge-connections.json` in the Fleet's own durable root. It holds connections
 * `{id → {authProvider}}`, endpoint bindings `{endpoint → id}`, tombstones `{endpoint → id}` and an
 * append-only event log; its `version` counts the events. Connection ids are random, so none is ever
 * recycled.
 *
 * Fail-closed in both directions:
 * - Resolving only reads. An absent store resolves `uninitialized` and a store that cannot be read or
 *   fails its integrity check resolves `unavailable`. Neither is created, repaired or minted from, and
 *   the next admission reads the file again.
 * - Mutating is the plane-local administrative path only: the `forgeConnections` CLI run on the plane
 *   host against this root. No wire verb, bridge method or grant reaches these methods. Each mutation
 *   holds an exclusive lock, re-reads the store, builds the next state, appends its event and replaces
 *   the file atomically. A refused mutation writes nothing.
 *
 * Detaching moves an endpoint's binding into the tombstones, and a tombstoned endpoint never binds
 * again. Tombstones are store data, so they survive a restart and a volume-continuous recreation.
 * @class Neo.ai.services.fleet.ForgeConnectionRegistryService
 * @extends Neo.core.Base
 * @singleton
 */
class ForgeConnectionRegistryService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.fleet.ForgeConnectionRegistryService'
         * @protected
         */
        className: 'Neo.ai.services.fleet.ForgeConnectionRegistryService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true,
        /**
         * @member {String|null} dataDir=null
         * @summary Instance-local Fleet data-root override, for isolation and tests. Production leaves it
         * null, so the store sits in the canonical `AiConfig.fleet.dataDir` plane member, read at the use site.
         */
        dataDir: null
    }

    /**
     * @summary Approves `endpoint` as another address of `connectionId`, the operator's alias proof.
     * Redirects, DNS, similarity and numeric ids never bind; only this approval does.
     * @param {Object}  options
     * @param {String}  options.actor        Who runs the command, recorded in the event.
     * @param {Boolean} [options.apply=false] False builds and reports the change without writing it.
     * @param {String}  options.connectionId
     * @param {String}  options.endpoint
     * @returns {Object} `{ok: true, connectionId, endpoint, applied, version}` or `{ok: false, refused, reason}`.
     */
    approveAlias({actor, apply=false, connectionId, endpoint}) {
        return this.mutate({actor, apply, op: 'approve-alias'}, store => {
            const target = normalizeEndpoint(endpoint);

            if (!Object.hasOwn(store.connections, connectionId)) {
                return refusal('no-such-connection', `no connection has the id ${connectionId}`)
            }

            const unbindable = this.unbindable(store, target, endpoint);

            if (unbindable) return unbindable;

            store.bindings[target] = connectionId;

            return {ok: true, connectionId, endpoint: target}
        })
    }

    /**
     * @summary Tombstones `endpoint`'s binding: it resolves nobody from now on and never binds again.
     * @param {Object}  options
     * @param {String}  options.actor
     * @param {Boolean} [options.apply=false]
     * @param {String}  options.endpoint
     * @returns {Object} `{ok: true, connectionId, endpoint, applied, version}` or `{ok: false, refused, reason}`.
     */
    detach({actor, apply=false, endpoint}) {
        return this.mutate({actor, apply, op: 'detach'}, store => {
            const target       = normalizeEndpoint(endpoint),
                  connectionId = target ? store.bindings[target] : undefined;

            if (!connectionId) return refusal('not-bound', `no connection binds ${target ?? endpoint}`);

            store.tombstones[target] = connectionId;
            delete store.bindings[target];

            return {ok: true, connectionId, endpoint: target}
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
     * @summary Creates the empty store: the explicit first initialization, before any owner principal
     * exists. It refuses a store that exists, and never replaces one that cannot be read. (Not `init()`,
     * which is core.Base's construction hook.)
     * @param {Object}  options
     * @param {String}  options.actor
     * @param {Boolean} [options.apply=false]
     * @returns {Object} `{ok: true, applied, version}` or `{ok: false, refused, reason}`.
     */
    initialize({actor, apply=false}) {
        return this.withLock(apply, () => {
            const {state, reason} = this.read();

            if (state === 'ok')      return refusal('already-initialized', 'the forge-connection registry exists');
            if (state === 'corrupt') return refusal('store-unavailable', `the store is never replaced: ${reason}`);

            const store = {schema: STORE_SCHEMA, version: 1, connections: {}, bindings: {}, tombstones: {}, events: [
                {seq: 1, at: new Date().toISOString(), op: 'init', actor}
            ]};

            apply && this.write(store);

            return {ok: true, applied: apply, version: store.version}
        })
    }

    /**
     * @summary Runs one mutation of an existing store: re-read under the lock, change a copy, append the
     * event, write atomically. A refusal from `change` writes nothing.
     * @param {Object}   options
     * @param {String}   options.actor
     * @param {Boolean}  options.apply
     * @param {String}   options.op     The event's operation name.
     * @param {Function} change         `store => result`, mutating the copy; `{ok: false}` refuses.
     * @returns {Object}
     * @protected
     */
    mutate({actor, apply, op}, change) {
        return this.withLock(apply, () => {
            const {state, store, reason} = this.read();

            if (state === 'absent')  return refusal('store-uninitialized', 'the forge-connection registry is not initialized');
            if (state === 'corrupt') return refusal('store-unavailable', `the store is never replaced: ${reason}`);

            const next   = structuredClone(store),
                  result = change(next);

            if (!result.ok) return result;

            const {ok, ...event} = result;

            next.version += 1;
            next.events.push({seq: next.version, at: new Date().toISOString(), op, actor, ...event});

            apply && this.write(next);

            return {...result, applied: apply, version: next.version}
        })
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
     * @summary Registers a forge connection for `authProvider` at `endpoint`, under a fresh random id.
     * @param {Object}  options
     * @param {String}  options.actor
     * @param {Boolean} [options.apply=false]
     * @param {String}  options.authProvider One of {@link FORGE_AUTH_PROVIDERS}.
     * @param {String}  options.endpoint     The forge's base URL, as admissions will present it.
     * @returns {Object} `{ok: true, connectionId, endpoint, authProvider, applied, version}` or `{ok: false, refused, reason}`.
     */
    register({actor, apply=false, authProvider, endpoint}) {
        return this.mutate({actor, apply, op: 'register'}, store => {
            const target = normalizeEndpoint(endpoint);

            if (!FORGE_AUTH_PROVIDERS.includes(authProvider)) {
                return refusal('unknown-forge', `the forge must be one of ${FORGE_AUTH_PROVIDERS.join(', ')}`)
            }

            const unbindable = this.unbindable(store, target, endpoint);

            if (unbindable) return unbindable;

            const connectionId = crypto.randomUUID();

            store.connections[connectionId] = {authProvider};
            store.bindings[target]          = connectionId;

            return {ok: true, connectionId, endpoint: target, authProvider}
        })
    }

    /**
     * @summary An admission's owner principal, from its provider-validated facts. The login never
     * participates; the endpoint must be bound, and to a connection of the same forge.
     * @param {Object} facts
     * @param {String} [facts.authProvider]
     * @param {String} [facts.providerBaseUrl]
     * @param {String} [facts.providerUserId]
     * @returns {{state: 'admitted', principal: String}|{state: 'uninitialized'|'unavailable'|'refused'|'unregistered', reason: String}}
     */
    resolveOwner({authProvider, providerBaseUrl, providerUserId} = {}) {
        const {state, store, reason} = this.read();

        if (state === 'absent') {
            return {state: 'uninitialized', reason: 'the forge-connection registry is not initialized: run `node ai/scripts/fleet/forgeConnections.mjs init --apply` on the plane host'}
        }

        if (state === 'corrupt') {
            return {state: 'unavailable', reason: `the forge-connection registry is unavailable: ${reason}`}
        }

        if (typeof providerUserId !== 'string' || providerUserId === '') {
            return {state: 'refused', reason: 'the forge answered no provider user id'}
        }

        const endpoint     = normalizeEndpoint(providerBaseUrl),
              connectionId = endpoint ? store.bindings[endpoint] : undefined;

        if (!connectionId || store.connections[connectionId].authProvider !== authProvider) {
            return {state: 'unregistered', reason: endpoint ? `no ${authProvider} connection binds ${endpoint}` : 'the forge base URL is not an endpoint'}
        }

        return {state: 'admitted', principal: `owner:${connectionId}:${providerUserId}`}
    }

    /**
     * @summary Why `endpoint` cannot bind, or null: it must be an endpoint, unbound and never tombstoned.
     * @param {Object}      store
     * @param {String|null} target The normalized endpoint.
     * @param {*}           endpoint The value as given, for the reason.
     * @returns {Object|null}
     * @protected
     */
    unbindable(store, target, endpoint) {
        if (!target)                                 return refusal('not-an-endpoint', `${endpoint} is not an endpoint`);
        if (Object.hasOwn(store.tombstones, target)) return refusal('endpoint-tombstoned', `${target} was detached and never binds again`);
        if (Object.hasOwn(store.bindings, target))   return refusal('endpoint-already-bound', `${target} is bound to ${store.bindings[target]}`);

        return null
    }

    /**
     * @summary Holds the exclusive mutation lock around `fn` when the mutation writes. A held lock
     * refuses instead of waiting; a lock left by a crashed run names the file to remove.
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
                return refusal('busy', `another forge-connection mutation holds ${lockPath}; remove it only if none is running`)
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
     * @summary Replaces the store file atomically, owner-only and flushed.
     * @param {Object} store
     * @protected
     */
    write(store) {
        writeFileAtomicSync(path.join(this.getDataDir(), STORE_FILE), `${JSON.stringify(store, null, 4)}\n`, {fsync: true, mode: 0o600})
    }
}

/**
 * @summary A refused mutation's result.
 * @param {String} refused A stable code.
 * @param {String} reason
 * @returns {{ok: false, refused: String, reason: String}}
 */
function refusal(refused, reason) {
    return {ok: false, refused, reason}
}

export default Neo.setupClass(ForgeConnectionRegistryService);
