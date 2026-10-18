import Base                      from 'neo.mjs/src/core/Base.mjs';
import aiConfig                  from '../../../mcp/server/memory-core/config.mjs';
import DestructiveOperationGuard from '../../../mcp/server/shared/services/DestructiveOperationGuard.mjs';
import {
    cloneConfigSubtree,
    validateConfigSnapshot
}                                from '../../shared/configSnapshot.mjs';

/**
 * @class Neo.ai.services.memory-core.managers.CollectionProxy
 * @extends Neo.core.Base
 */
class CollectionProxy extends Base {
    /**
     * Instance-local test configuration snapshot seam.
     * @type {Object|null}
     * @private
     */
    #configSnapshot = null;

    static config = {
        /**
         * @member {String} className='Neo.ai.services.memory-core.managers.CollectionProxy'
         * @protected
         */
        className: 'Neo.ai.services.memory-core.managers.CollectionProxy',
        /**
         * @member {String} collectionType='memory'
         */
        collectionType: 'memory'
    }

    /**
     * @returns {Object|null}
     */
    get configSnapshot() {
        return this.#configSnapshot;
    }

    /**
     * @param {Object|null} value
     */
    set configSnapshot(value) {
        this.#configSnapshot = this.beforeSetConfigSnapshot(value);
    }

    /**
     * Validates a service-local test snapshot before storing it.
     *
     * @param {Object|null} value
     * @returns {Object|null}
     * @protected
     */
    beforeSetConfigSnapshot(value) {
        return validateConfigSnapshot(value, {
            requiredSubtrees: ['engines'],
            serviceName     : 'CollectionProxy'
        });
    }

    /**
     * Clones the live `aiConfig` leaves read by `CollectionProxy` into a
     * plain object suitable for `proxy.configSnapshot` in unit tests.
     *
     * @param {Object} [overrides={}]
     * @returns {Object}
     */
    createConfigSnapshot(overrides = {}) {
        const snapshot = {
            engine : aiConfig.engine,
            engines: cloneConfigSubtree(aiConfig, ['engines'])
        };

        return {
            ...snapshot,
            ...overrides,
            engines: overrides.engines
                ? {...snapshot.engines, ...overrides.engines}
                : snapshot.engines
        };
    }

    /**
     * Resolves the active configuration source: the test `configSnapshot` when
     * installed, otherwise the live `aiConfig` singleton.
     *
     * @returns {Object}
     * @private
     */
    #getConfig() {
        return this.#configSnapshot || aiConfig;
    }

    async getManagers() {
        const architecture = this.#getConfig().engine;
        const managers     = [];

        // In Hybrid RAG, vectors exclusively live in ChromaDB
        if (architecture === 'chroma' || architecture === 'hybrid') {
            const { default: ChromaManager } = await import('./ChromaManager.mjs');
            await ChromaManager.ready();
            managers.push(ChromaManager);
        }

        return managers;
    }

    async getCollections() {
        const managers = await this.getManagers();
        return Promise.all(managers.map(m => {
            if (this.collectionType === 'graph')           return m.getGraphCollection();
            if (this.collectionType === 'temporalSummary') return m.getTemporalSummaryCollection();
            return this.collectionType === 'memory' ? m.getMemoryCollection() : m.getSummaryCollection();
        }));
    }

    /**
     * @summary The identity of the vector collection(s) this proxy fronts — never the proxy's own id.
     *
     * `CollectionProxy` extends `Neo.core.Base`, so `proxy.id` is a framework-assigned INSTANCE id
     * (`neo-base-86`) that moves with construction order. Backup receipts previously recorded it as
     * `collectionId`, so `deriveLineage` compared
     * process-instance counters rather than collections and could not detect a collection change in
     * either direction — `changed` for an ordinary restart, `same` for a genuine swap under a stable
     * process, which previously left the collapse guard KB-complete but MC-partial.
     *
     * **It identifies the PRIMARY, because the primary is what gets exported.** `get()` and `count()`
     * both read `collections[0]` and ignore the rest, so the rows in a receipt come from exactly one
     * collection. The identity beside them has to be that collection's.
     *
     * A composite over every manager was the first shape here, and it was wrong in a way worth
     * recording: it described a SET while the data came from a MEMBER. With a second manager present,
     * a change confined to a non-reading member would move the identity and derive `lineage: changed`
     * for a source whose exported rows never changed — a false refuse in the collapse guard, caused
     * by an identity that did not identify what it accompanied.
     *
     * So this deliberately does NOT generalise ahead of the read path. If Memory Core ever exports
     * more than the primary, the fix is per-manager export **and** per-manager receipts together; an
     * identity cannot get there first.
     *
     * @returns {Promise<String|null>} The primary collection's id, or `null` when none resolves — which
     * degrades the lineage axis to `unknown` rather than asserting a continuity it cannot observe.
     */
    async resolveCollectionId() {
        const [primary] = await this.getCollections();

        return primary?.id ?? null
    }

    async add(args) {
        const collections = await this.getCollections();
        await Promise.all(collections.map(c => c.add(args)));
    }

    async upsert(args) {
        const collections = await this.getCollections();
        await Promise.all(collections.map(c => c.upsert(args)));
    }

    async update(args) {
        const collections = await this.getCollections();
        await Promise.all(collections.map(c => c.update(args)));
    }

    async get(args) {
        const collections = await this.getCollections();
        if (!collections || collections.length === 0 || !collections[0]) {
            throw new Error(`[CollectionProxy] get() failed: No underlying collection available for type '${this.collectionType}'`);
        }
        return collections[0].get(args);
    }

    async query(args) {
        const collections = await this.getCollections();
        if (!collections || collections.length === 0 || !collections[0]) {
            throw new Error(`[CollectionProxy] query() failed: No underlying collection available for type '${this.collectionType}'`);
        }
        return collections[0].query(args);
    }

    async count() {
        const collections = await this.getCollections();
        if (!collections || collections.length === 0 || !collections[0]) {
            throw new Error(`[CollectionProxy] count() failed: No underlying collection available for type '${this.collectionType}'`);
        }
        return collections[0].count();
    }

    async delete(args) {
        const collections = await this.getCollections();
        await Promise.all(collections.map(c => c.delete(args)));
    }

    async drop({confirmation} = {}) {
        const managers = await this.getManagers();
        for (const manager of managers) {
            let coll;
            if (this.collectionType === 'graph') {
                coll = await manager.getGraphCollection();
            } else if (this.collectionType === 'temporalSummary') {
                coll = await manager.getTemporalSummaryCollection();
            } else {
                coll = this.collectionType === 'memory' ?
                    await manager.getMemoryCollection() :
                    await manager.getSummaryCollection();
            }

            const chromaCoordinates = this.#getConfig().engines.chroma;
            const chromaPath        = chromaCoordinates.path || chromaCoordinates.dataDir;

            await DestructiveOperationGuard.assertDestructiveTargetAllowed({
                operation: `memory-core.${this.collectionType}.drop`,
                subsystem: 'memory-core',
                mode     : 'drop',
                target   : {
                    collectionName: coll.name,
                    chroma        : {
                        host: chromaCoordinates.host,
                        port: chromaCoordinates.port,
                        path: chromaPath
                    },
                    path    : chromaPath,
                    repoRoot: process.cwd()
                },
                confirmation
            });

            // Route through the guarded `manager.deleteCollection({name, confirmation})`
            // wrapper. The path-target guard above already passed; the operator confirmation token
            // is threaded down so the uniform collection-name gate accepts the production-recovery
            // bypass. Fail closed if a manager lacks the wrapper because bare-client fallback would
            // bypass the destructive-operation guard.
            if (typeof manager.deleteCollection !== 'function') {
                throw new Error(
                    `[CollectionProxy] manager ${manager?.constructor?.config?.className || 'unknown'} ` +
                    `lacks the guarded deleteCollection wrapper; refusing bare client.deleteCollection ` +
                    `fallback per #11652 substrate-level invariant.`
                );
            }
            await manager.deleteCollection({name: coll.name, confirmation});
        }
    }
}

export default Neo.setupClass(CollectionProxy);
