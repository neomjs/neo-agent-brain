import Base                           from 'neo.mjs/src/core/Base.mjs';
import GraphService                   from './GraphService.mjs';
import RequestContextService          from '../../mcp/server/shared/services/RequestContextService.mjs';
import WakeSubscriptionService        from './WakeSubscriptionService.mjs';
import logger                         from '../../mcp/server/memory-core/logger.mjs';
import {normalizeAgentIdentityNodeId} from '../../graph/normalizeAgentIdentityNodeId.mjs';

/**
 * @summary Service for managing cross-tenant permission edges in the Native Graph.
 *
 * Implements explicit permission checks for the strict-isolation mailbox and
 * memory-sharing model. The default policy is opt-in visibility: permissions
 * are granted via Graph edges representing the capability.
 *
 * Edge Structure:
 * - A permission capability flows from the grantee to the granter.
 * - E.g. Alice `CAN_READ_INBOX_OF` Bob means:
 *   Edge source = Alice (grantee)
 *   Edge target = Bob (granter/owner)
 *   Edge type = `CAN_READ_INBOX_OF`
 *
 * @class Neo.ai.services.memory-core.PermissionService
 * @extends Neo.core.Base
 * @singleton
 */
class PermissionService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.memory-core.PermissionService'
         * @protected
         */
        className: 'Neo.ai.services.memory-core.PermissionService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @member {String[]} validScopes
     * @protected
     * @summary Whitelist of semantic edge types for agent-to-agent permissions.
     * Includes BLOCKED_BY: a negative-intent primitive ensuring hard isolation overrides.
     */
    validScopes = ['CAN_READ_INBOX_OF', 'CAN_READ_MEMORIES_OF', 'CAN_READ_SESSIONS_OF', 'CAN_REPLY_TO', 'BLOCKED_BY']

    /**
     * Grants a permission. The caller is the owner of the resource granting access TO another identity.
     * This creates a graph edge where `source = to` and `target = caller`.
     *
     * @param {Object} opts
     * @param {String} opts.to The agent identity being granted the permission
     * @param {String} opts.scope The permission scope
     * @returns {Promise<Object>}
     */
    async grantPermission({ to, scope }) {
        const boundOwner = RequestContextService.getAgentIdentityNodeId();
        if (!boundOwner) throw RequestContextService.unboundIdentityError('grant permission');
        if (!to) throw new Error("Missing 'to' parameter.");
        if (!scope) throw new Error("Missing 'scope' parameter.");

        const owner = normalizeAgentIdentityNodeId(boundOwner),
            grantee = normalizeAgentIdentityNodeId(to);

        if (!this.validScopes.includes(scope)) {
            throw new Error(`Invalid scope. Must be one of: ${this.validScopes.join(', ')}`);
        }

        // Verify target exists in SQLite directly, not in the in-memory cache. Identity
        // creation is a privileged operation (seedAgentIdentities.mjs); it should NOT be an
        // implicit side-effect of a permission grant. Stubbing with type 'AGENT' + stripped
        // metadata destroys seed data and creates type-inconsistent nodes. Use the same
        // foreign-key style existence guard as graph-link writes.
        const db         = GraphService.requireDb('PermissionService.grantPermission');
        const verifyStmt = db.storage.db.prepare('SELECT count(*) as count FROM Nodes WHERE id = ?');
        if (verifyStmt.get(grantee).count === 0) {
            throw new Error(`Cannot grant ${scope} to ${grantee}: target does not exist. Identity nodes must be pre-seeded via ai/scripts/setup/seedAgentIdentities.mjs.`);
        }

        // The capability belongs to 'to', pointing at 'owner'
        // e.g. "Alice CAN_READ_INBOX_OF Bob" (source: Alice, target: Bob)
        GraphService.linkNodes(grantee, owner, scope, 1.0);
        WakeSubscriptionService.pump().catch(e => logger.error('[wake-pump]', e));
        return { success: true, message: `Granted ${scope} to ${grantee}` };
    }

    /**
     * Revokes a permission. The caller is the owner of the resource revoking access FROM another identity.
     * @param {Object} opts
     * @param {String} opts.to The agent identity losing the permission
     * @param {String} opts.scope The permission scope
     * @returns {Promise<Object>}
     */
    async revokePermission({ to, scope }) {
        const boundOwner = RequestContextService.getAgentIdentityNodeId();
        if (!boundOwner) throw RequestContextService.unboundIdentityError('revoke permission');

        const owner = normalizeAgentIdentityNodeId(boundOwner),
            grantee = normalizeAgentIdentityNodeId(to);

        const db            = GraphService.requireDb('PermissionService.revokePermission');
        const edgesToRemove = [];
        for (const edge of db.edges.items) {
            if (
                normalizeAgentIdentityNodeId(edge.source) === grantee &&
                normalizeAgentIdentityNodeId(edge.target) === owner &&
                edge.type === scope
            ) {
                edgesToRemove.push(edge);
            }
        }

        if (edgesToRemove.length > 0) {
            db.edges.remove(edgesToRemove);
            WakeSubscriptionService.pump().catch(e => logger.error('[wake-pump]', e));
        }

        return { success: true, message: `Revoked ${scope} from ${grantee}` };
    }

    /**
     * @summary Lists permissions for an identity. Defaults to the caller.
     * Ordinary cached reads retain the separately recorded delegated-inbox stale-grant window;
     * out of scope here (Memory Core defect-note MESSAGE:9cf6556e-5458-4e87-8b0c-3bdf4616950a).
     * @param {Object} opts
     * @param {String} [opts.forIdentity] The identity to list permissions for.
     * @returns {Promise<Object>}
     */
    async listPermissions(args = {}) {
        return this.readPermissions(args);
    }

    /**
     * @summary Applies the same own-identity permission projection synchronously within a caller's read snapshot.
     * @param {Object} [args] Existing permission-list arguments; only the bound caller is admissible.
     * @param {Object} [options] Internal service options, never exposed on the MCP request.
     * @param {Boolean} [options.fromStorage=false] Read persisted capabilities instead of the graph cache.
     * Observer admission uses this inside its SQLite transaction so another process's revoke cannot
     * survive in cached capabilities or split permission admission from the message population.
     * @returns {Object} The canonical permission-list projection.
     */
    readPermissions({forIdentity} = {}, {fromStorage = false} = {}) {
        const boundCaller = RequestContextService.getAgentIdentityNodeId();
        if (!boundCaller) throw RequestContextService.unboundIdentityError('list permissions');

        const caller = normalizeAgentIdentityNodeId(boundCaller),
            targetId = normalizeAgentIdentityNodeId(forIdentity || caller);

        // Prevent arbitrary enumeration of other agents' permissions unless the caller is the target
        if (targetId !== caller) {
            throw new Error(`Unauthorized: Cannot enumerate permissions for ${targetId}`);
        }

        const db              = GraphService.requireDb('PermissionService.listPermissions');
        const capabilities    = [];     // Things targetId can do to others
        const grantedToOthers = [];  // Things others can do to targetId

        const edges = fromStorage
            ? db.storage.db.prepare(`SELECT source, target, type, data FROM Edges
                WHERE type IN (SELECT value FROM json_each(?))`).all(JSON.stringify(this.validScopes))
                .map(row => ({...row, properties: JSON.parse(row.data).properties}))
            : db.edges.items;

        for (const edge of edges) {
            if (this.validScopes.includes(edge.type)) {
                if (normalizeAgentIdentityNodeId(edge.source) === targetId) {
                    capabilities.push({
                        target   : normalizeAgentIdentityNodeId(edge.target),
                        scope    : edge.type,
                        timestamp: edge.properties?.timestamp
                    });
                }
                if (normalizeAgentIdentityNodeId(edge.target) === targetId) {
                    grantedToOthers.push({
                        grantedTo: normalizeAgentIdentityNodeId(edge.source),
                        scope    : edge.type,
                        timestamp: edge.properties?.timestamp
                    });
                }
            }
        }

        return { identity: targetId, capabilities, grantedToOthers };
    }

    /**
     * Synchronous check if the caller has the specified permission against the target.
     * @param {String} caller The identity attempting the action
     * @param {String} target The identity that owns the resource
     * @param {String} scope The required scope
     * @returns {Boolean}
     */
    hasPermission(caller, target, scope) {
        caller = normalizeAgentIdentityNodeId(caller);
        target = normalizeAgentIdentityNodeId(target);

        // Broadcasts are pseudo-targets; checking permission against broadcast logic
        // is typically handled at the service layer, but structurally always allowed.
        if (target === 'AGENT:*') return true;

        // Identity always has permission to their own resources
        if (caller === target) return true;

        const db = GraphService.requireDb('PermissionService.hasPermission');
        for (const edge of db.edges.items) {
            if (
                normalizeAgentIdentityNodeId(edge.source) === caller &&
                normalizeAgentIdentityNodeId(edge.target) === target &&
                edge.type === scope
            ) {
                return true;
            }
        }

        return false;
    }
}

export default Neo.setupClass(PermissionService);
