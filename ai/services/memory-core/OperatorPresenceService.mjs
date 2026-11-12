import Base                      from 'neo.mjs/src/core/Base.mjs';
import GraphService              from './GraphService.mjs';
import {isHumanOperatorIdentity} from './MailboxService.mjs';
import RequestContextService     from '../../mcp/server/shared/services/RequestContextService.mjs';

/**
 * @summary The plane-wide record of whether the operator is present or away.
 *
 * Peers drive in both modes. The mode answers one question: will an operator-only ask (org admin,
 * credentials, merges) get a quick answer? Only the Fleet's registered human operator writes it, judged by
 * the same {@link isHumanOperatorIdentity} the open-work intake uses. `who_is_online` carries the read, so a
 * seat that boots after a change still learns it.
 *
 * @class Neo.ai.services.memory-core.OperatorPresenceService
 * @extends Neo.core.Base
 * @singleton
 */
class OperatorPresenceService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.memory-core.OperatorPresenceService'
         * @protected
         */
        className: 'Neo.ai.services.memory-core.OperatorPresenceService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @member {String[]} modes=['present','away']
     * @protected
     */
    modes = ['present', 'away']
    /**
     * @member {String} nodeId='OPERATOR_PRESENCE'
     * @protected
     */
    nodeId = 'OPERATOR_PRESENCE'

    /**
     * @summary The operator's mode now.
     * No record reads `present` with `since: null`, the fleet's standing assumption. An `away` whose
     * `until` has passed reads `present` with `expired: true`, so a forgotten toggle cannot hold the fleet away.
     * @param {Date|String|Number} [now=new Date()] Clock source.
     * @returns {{mode: String, since: String|null, until: String|null, setBy: String|null, expired?: Boolean}}
     */
    getOperatorPresence(now = new Date()) {
        const nowMs = this._toMs(now),
              props = this._readNode(this.nodeId)?.properties;

        if (!this.modes.includes(props?.mode)) {
            return {mode: 'present', since: null, until: null, setBy: null}
        }

        if (props.mode === 'away' && props.until && Date.parse(props.until) <= nowMs) {
            return {mode: 'present', since: props.until, until: null, setBy: props.setBy ?? null, expired: true}
        }

        return {mode: props.mode, since: props.since ?? null, until: props.until ?? null, setBy: props.setBy ?? null}
    }

    /**
     * @summary Sets the operator's mode, refused unless the request-bound identity is the human operator.
     * `since` moves only when the mode does. `changed` says whether readers now see a different state, so a
     * caller broadcasts once per change without reading first.
     * @param {Object} options
     * @param {'present'|'away'} options.mode
     * @param {String} [options.until] ISO time an `away` ends by itself. `away` only, and in the future.
     * @param {Date|String|Number} [options.now=new Date()] Clock source; a test seam the contract never declares.
     * @returns {{operatorPresence: Object, changed: Boolean}}
     */
    setOperatorPresence({mode, until, now = new Date()} = {}) {
        GraphService.requireDb('OperatorPresenceService.setOperatorPresence');

        const setBy = RequestContextService.getAgentIdentityNodeId();

        if (!setBy) {
            throw RequestContextService.unboundIdentityError('set operator presence')
        }

        if (!isHumanOperatorIdentity(GraphService.db, setBy)) {
            throw new Error(`Refused: only the operator sets operator presence, and '${setBy}' is not the human operator.`)
        }

        if (!this.modes.includes(mode)) {
            throw new Error(`Invalid mode '${mode}'. Must be one of: ${this.modes.join(', ')}.`)
        }

        const nowMs  = this._toMs(now),
              nowIso = new Date(nowMs).toISOString();

        let untilIso = null;

        if (until != null) {
            const untilMs = Date.parse(until);

            if (mode !== 'away')       throw new Error('until applies to away only.');
            if (Number.isNaN(untilMs)) throw new Error(`Invalid until '${until}'. Must be an ISO date-time.`);
            if (untilMs <= nowMs)      throw new Error(`until '${until}' has already passed.`);

            untilIso = new Date(untilMs).toISOString()
        }

        const current  = this.getOperatorPresence(nowMs),
              sameMode = current.mode === mode,
              record   = {mode, since: (sameMode && current.since) || nowIso, until: untilIso, setBy};

        GraphService.upsertNode({
            id         : this.nodeId,
            type       : 'OPERATOR_PRESENCE',
            name       : 'Operator presence',
            description: 'Whether the operator is present or away, for the whole plane.',
            properties : {...record, updatedAt: nowIso, sharedEntity: true}
        });

        return {operatorPresence: record, changed: !sameMode || current.until !== untilIso}
    }

    /**
     * @summary Reads a node's durable row rather than this process's cache, which another process's write bypasses.
     * @param {String} id
     * @returns {Object|null}
     * @protected
     */
    _readNode(id) {
        const row = GraphService.db?.storage?.db?.prepare('SELECT data FROM Nodes WHERE id = ?').get(id);

        try {
            return row?.data ? JSON.parse(row.data) : null
        } catch {
            return null
        }
    }

    /**
     * @param {Date|String|Number} value
     * @returns {Number}
     * @protected
     */
    _toMs(value) {
        const ms = new Date(value).getTime();

        if (Number.isNaN(ms)) {
            throw new Error(`Invalid operator presence timestamp: ${value}`)
        }

        return ms
    }
}

export default Neo.setupClass(OperatorPresenceService);
