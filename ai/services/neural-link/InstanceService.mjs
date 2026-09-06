import Base              from 'neo.mjs/src/core/Base.mjs';
import ConnectionService from './ConnectionService.mjs';
import RecorderService   from './RecorderService.mjs';

/**
 * @summary Manages generic instance inspection and manipulation for the Neural Link MCP Server.
 *
 * This service provides tools for reading and writing properties of any registered Neo instance
 * (e.g. Components, Stores, Managers, Controllers).
 *
 * @class Neo.ai.services.neural-link.InstanceService
 * @extends Neo.core.Base
 * @singleton
 */
class InstanceService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.neural-link.InstanceService'
         * @protected
         */
        className: 'Neo.ai.services.neural-link.InstanceService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @returns {Promise<void>}
     */
    async initAsync() {
        await super.initAsync();
        await ConnectionService.ready();
    }

    /**
     * Finds instances matching a selector.
     * @param {Object} opts
     * @param {String} opts.sessionId
     * @param {Object} opts.selector
     * @param {String[]} [opts.returnProperties]
     * @returns {Promise<Object>}
     */
    async findInstances({sessionId, selector, returnProperties}) {
        return await ConnectionService.call(sessionId, 'find_instances', {
            selector,
            returnProperties
        })
    }

    /**
     * @summary Creates any JSON-addressable Neo instance through the Neural Link write surface.
     *
     * This is the general creation primitive beneath component-only creation: callers provide a `className`
     * or `ntype` plus a JSON config, optionally with `parentId` to attach the created component to a container.
     * Server-side validation keeps the MCP boundary data-only before dispatching to the App Worker.
     * @param {Object} opts
     * @param {String} [opts.className] The fully-qualified Neo class name.
     * @param {Object} [opts.config={}] JSON-safe instance config.
     * @param {String} [opts.ntype] The Neo ntype shortcut.
     * @param {String} [opts.parentId] Optional target container id.
     * @param {String} [opts.sessionId] The target session ID.
     * @returns {Promise<Object>}
     */
    async createInstance({className, config={}, ntype, parentId, sessionId}) {
        const payload = this.buildCreateInstancePayload({className, config, ntype, parentId});

        return await ConnectionService.call(sessionId, 'create_instance', payload)
    }

    /**
     * @summary Builds the data-only App Worker payload for `create_instance`.
     * @param {Object} params
     * @param {String} [params.className]
     * @param {Object} [params.config={}]
     * @param {String} [params.ntype]
     * @param {String} [params.parentId]
     * @returns {Object}
     * @protected
     */
    buildCreateInstancePayload({className, config={}, ntype, parentId}) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error('create_instance: `config` must be an instance configuration object.')
        }

        this.rejectFunctionBearingConfig(config);

        this.rejectModuleBearingConfig(config);

        const
            resolvedClassName = className ?? config.className,
            resolvedNtype     = ntype     ?? config.ntype;

        if (className !== undefined && typeof className !== 'string') {
            throw new Error('create_instance: `className` must be a string.')
        }

        if (ntype !== undefined && typeof ntype !== 'string') {
            throw new Error('create_instance: `ntype` must be a string.')
        }

        if (className && config.className && className !== config.className) {
            throw new Error('create_instance: top-level `className` conflicts with `config.className`.')
        }

        if (ntype && config.ntype && ntype !== config.ntype) {
            throw new Error('create_instance: top-level `ntype` conflicts with `config.ntype`.')
        }

        if (resolvedClassName && resolvedNtype) {
            throw new Error('create_instance: provide exactly one of `className` or `ntype`.')
        }

        if (!resolvedClassName && !resolvedNtype) {
            throw new Error('create_instance: provide `className` or `ntype` to instantiate.')
        }

        return {
            className: resolvedClassName,
            config,
            ntype    : resolvedNtype,
            parentId
        }
    }

    /**
     * @summary Rejects function-bearing config values at the MCP boundary.
     * @param {*} value
     * @param {String} [path='config']
     * @protected
     */
    rejectFunctionBearingConfig(value, path='config') {
        if (typeof value === 'function') {
            throw new Error(`create_instance: function-bearing config is not supported at ${path}; pass a registered handler id string instead.`)
        }

        if (!value || typeof value !== 'object') {
            return
        }

        if (Array.isArray(value)) {
            value.forEach((item, index) => this.rejectFunctionBearingConfig(item, `${path}[${index}]`));
            return
        }

        Object.entries(value).forEach(([key, item]) => {
            this.rejectFunctionBearingConfig(item, `${path}.${key}`)
        })
    }

    /**
     * @summary Recursively rejects `module` class-reference keys at any depth in the config.
     *
     * `module` is a live class reference that cannot cross the Neural Link wire; a nested
     * `{items: [{module: 'Neo.button.Base'}]}` must be rejected at the boundary, not reach
     * an internal `Container.createItem` TypeError. Mirrors {@link rejectFunctionBearingConfig}'s
     * recursive shape.
     * @param {*} value
     * @param {String} [path='config']
     * @protected
     */
    rejectModuleBearingConfig(value, path='config') {
        if (!value || typeof value !== 'object') {
            return
        }

        if (Array.isArray(value)) {
            value.forEach((item, index) => this.rejectModuleBearingConfig(item, `${path}[${index}]`));
            return
        }

        if (Object.hasOwn(value, 'module')) {
            throw new Error(`create_instance: \`module\` is a class reference and cannot cross the Neural Link wire; declare \`ntype\` or \`className\` instead (found at ${path}.module).`)
        }

        Object.entries(value).forEach(([key, item]) => {
            this.rejectModuleBearingConfig(item, `${path}.${key}`)
        })
    }

    /**
     * Retrieves properties from a specific instance by its ID.
     * @param {Object} opts
     * @param {String} opts.sessionId
     * @param {String} opts.id
     * @param {String[]} opts.properties
     * @returns {Promise<Object>}
     */
    async getInstanceProperties({sessionId, id, properties}) {
        return await ConnectionService.call(sessionId, 'get_instance_properties', {
            id,
            properties
        })
    }

    /**
     * Sets properties on a specific instance by its ID.
     * @param {Object} opts
     * @param {String} opts.sessionId
     * @param {String} opts.id
     * @param {Object} opts.properties
     * @returns {Promise<Object>}
     */
    async setInstanceProperties({sessionId, id, properties}) {
        return await ConnectionService.call(sessionId, 'set_instance_properties', {
            id,
            properties
        })
    }

    /**
     * @summary Reverts the explicit dock Group cursor, or the requester's non-dock stack.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @param {String} [opts.groupId] Explicit dock Group; omission selects the non-dock path.
     * @returns {Promise<Object>}
     */
    async undo({sessionId, groupId}) {
        return this.forwardTransaction('undo', {sessionId, groupId})
    }

    /**
     * @summary Reapplies the explicit dock Group cursor, or the requester's non-dock stack.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @param {String} [opts.groupId] Explicit dock Group; omission selects the non-dock path.
     * @returns {Promise<Object>}
     */
    async redo({sessionId, groupId}) {
        return this.forwardTransaction('redo', {sessionId, groupId})
    }

    /**
     * @summary Archives a committed Group snapshot or non-dock transaction without changing the live cursor.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @param {String} [opts.groupId] Explicit dock Group; omission selects the non-dock path.
     * @param {String} [opts.txId]
     * @param {String} [opts.name]
     * @returns {Promise<Object>}
     */
    async saveTransaction({sessionId, groupId, txId, name}) {
        const appSessionId = sessionId ?? ConnectionService.getDefaultSessionId();
        const snapshot     = await this.forwardTransaction('save_transaction', {sessionId, groupId, txId});

        if (!snapshot?.saved) {
            return snapshot
        }

        return await RecorderService.saveTransactionArchive({
            appSessionId,
            name,
            transaction : snapshot.transaction
        })
    }

    /**
     * @summary Replays an archive into the explicit Group or legacy non-dock command path under current-caller enforcement.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @param {String} [opts.groupId] Explicit dock Group; omission selects the non-dock path.
     * @param {String} [opts.archiveId]
     * @returns {Promise<Object>}
     */
    async replayTransaction({sessionId, groupId, archiveId}) {
        const archive = await RecorderService.getTransactionArchive({archiveId});

        // UNREACHABLE IS NOT ABSENT. Both used to answer `archive-not-found`, which told the caller a
        // durable archive was gone whenever the store was merely out of reach — and "gone" is the one
        // answer that invites them to stop looking for it.
        if (archive?.status === 'unavailable') {
            return {replayed: false, reason: archive.reason}
        }

        if (archive?.status !== 'found') {
            return {replayed: false, reason: 'archive-not-found'}
        }

        const result = await this.forwardTransaction('replay_transaction', {
            sessionId, groupId,
            archiveId,
            ops               : archive.ops,
            sourceCommittedAt : archive.committedAt,
            sourceOriginWriter: archive.originWriter,
            sourceTxId        : archive.sourceTxId
        });

        if (!result?.replayed) {
            return result
        }

        // THE MARK IS REPORTED, NOT ASSUMED. `replayed` stays true because the ops really were replayed —
        // inverting it would deny work the App Worker actually did. What was missing is that the
        // BOOKKEEPING could fail silently, leaving a replay that happened and a count that never moved,
        // with nothing in the answer to say so.
        const mark = await RecorderService.recordTransactionReplay({archiveId});

        return mark?.updated === true
            ? {...result, replayMarked: true, replayCount: mark.replayCount}
            : {...result, replayMarked: false, replayMarkReason: mark?.reason ?? `archive-mark-${mark?.status ?? 'failed'}`}
    }

    /**
     * @summary Reads the explicit Group's shared history, or the requester's non-dock history.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @param {String} [opts.groupId] Explicit dock Group; omission selects the non-dock path.
     * @returns {Promise<Object>}
     */
    async listTransactions({sessionId, groupId}) {
        return this.forwardTransaction('list_transactions', {sessionId, groupId})
    }

    /**
     * @summary Discards pending Group inputs, or aborts the requester's non-dock record.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @param {String} [opts.groupId] Explicit dock Group; omission selects the non-dock path.
     * @returns {Promise<Object>}
     */
    async abortTransaction({sessionId, groupId}) {
        return this.forwardTransaction('abort_transaction', {sessionId, groupId})
    }

    /**
     * @summary Opens a bounded Group preparation batch, or a legacy non-dock batch.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @param {String} [opts.groupId] Explicit dock Group; omission selects the non-dock path.
     * @param {String} [opts.name]
     * @returns {Promise<Object>}
     */
    async beginTransaction({sessionId, groupId, name}) {
        return this.forwardTransaction('begin_transaction', {sessionId, groupId, name})
    }

    /**
     * @summary Commits pending Group inputs atomically, or commits the requester's non-dock record.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @param {String} [opts.groupId] Explicit dock Group; omission selects the non-dock path.
     * @returns {Promise<Object>}
     */
    async commitTransaction({sessionId, groupId}) {
        return this.forwardTransaction('commit_transaction', {sessionId, groupId})
    }

    /**
     * @summary Refuses an old worker that ignores Group selection before forwarding a mutating command.
     * @param {String} method
     * @param {Object} opts App Worker session, optional Group and command payload.
     * @returns {Promise<Object>}
     */
    async forwardTransaction(method, {sessionId, groupId, ...payload}) {
        if (groupId !== undefined) {
            sessionId ??= ConnectionService.getDefaultSessionId();
            payload.groupId = groupId;
            const selected = await ConnectionService.call(sessionId, 'list_transactions', {groupId});
            if (selected?.groupId !== groupId) throw new Error('The target App Worker does not support explicit Group transactions.');
            if (method === 'list_transactions') return selected
        }
        return ConnectionService.call(sessionId, method, payload)
    }

    /**
     * Calls a method on a specific instance.
     * @param {Object} opts
     * @param {String} opts.sessionId
     * @param {String} opts.id
     * @param {String} opts.method
     * @param {Array}  [opts.args]
     * @returns {Promise<Object>}
     */
    async callMethod({sessionId, id, method, args}) {
        return await ConnectionService.call(sessionId, 'call_method', {
            id,
            method,
            args
        })
    }
}

export default Neo.setupClass(InstanceService);
