import crypto                                   from 'crypto';
import Base                                     from 'neo.mjs/src/core/Base.mjs';
import config                                   from '../../mcp/server/memory-core/config.mjs';
import GraphService                             from './GraphService.mjs';
import SourceRegistryService                    from './SourceRegistryService.mjs';
import CommunityBatchAdmissionService           from './CommunityBatchAdmissionService.mjs';
import RequestContextService, {normalizeUserId} from '../../mcp/server/shared/services/RequestContextService.mjs';
import {normalizeMailboxIdentityForComparison}  from './helpers/mailboxReadStateClassifier.mjs';
import {
    TASK_ASSIGNMENT_AUTHORITY,
    TASK_STATE_CHANGED_ENTITY_TYPE,
    TASK_STATE_CHANGED_SCHEMA_VERSION
} from './taskAssignmentContract.mjs';
import {resolveTemporalWindow}            from './helpers/temporalWindowResolver.mjs';
import {buildTemporalBirdViewEnvelope}    from './helpers/temporalBirdViewEnvelope.mjs';
import {SUPPORTED_GITHUB_COMMUNITY_KINDS} from '../github-workflow/community/communityContentKinds.mjs';

/** @summary The authenticated viewer key is distinct from tenant scope and never session-owned. */
function viewerId() {
    const agent   = RequestContextService.getAgentIdentityNodeId(),
          subject = RequestContextService.getUserId();

    return agent ? `agent:${agent}` : subject ? `subject:${subject}` : null
}

/** @summary Resolves the bound canonical `@<identity>` claimant for atomic Task creation, or null. */
function claimantId() {
    const raw       = RequestContextService.getAgentIdentityNodeId(),
          canonical = normalizeMailboxIdentityForComparison(raw);

    return typeof canonical === 'string' && canonical.startsWith('@') && canonical !== '@me' && canonical !== '@'
        ? canonical
        : null
}

/** @summary Parses durable JSON evidence without converting malformed evidence into completeness. */
function parseEvidence(value) {
    try { return JSON.parse(value) } catch { return null }
}

/** @summary Current source identity and grant binding must survive an asynchronous provider read. */
function grantIdentity(source) {
    return JSON.stringify([
        source.sourceInstanceId, source.provider, source.canonicalProviderHost, source.resourceKind,
        source.providerResourceId, source.registrationEpoch, source.lifecycleState, source.displayLocator,
        source.grantRef, source.updatedAt
    ])
}

/**
 * @summary Durable community metadata, explicit current-content reads, per-viewer presentation markers,
 * and atomic `sourceEventId -> taskId` canonical A2A Task claim binding.
 * Pagination freezes ledger membership, while seen and source lifecycle remain current projections.
 * Unclaimed community activity remains outside LifecycleFrontier and Golden Path ranking; only an
 * explicit atomic claim creates a tenant-private canonical Task and hands subsequent state transitions
 * to MailboxService.
 * @class Neo.ai.services.memory-core.CommunityActivityService
 * @extends Neo.core.Base
 * @singleton
 * @see learn/agentos/decisions/0036-durable-community-activity-authority.md
 */
class CommunityActivityService extends Base {
    static config = {
        /** @member {String} className='Neo.ai.services.memory-core.CommunityActivityService' */
        className: 'Neo.ai.services.memory-core.CommunityActivityService',
        /** @member {Boolean} singleton=true */
        singleton: true,
        /** @member {Object|null} db=null @summary Dedicated connection to the existing Memory Core ledger. */
        db: null,
        /** @member {Object|null} contentAdapter=null @summary Optional adapter injection; GitHub loads only on explicit reads. */
        contentAdapter: null
    }

    /** @summary Waits for ledger owners, opens the configured store and creates presentation and claim-binding state. */
    async initAsync() {
        await super.initAsync();
        await Promise.all([SourceRegistryService.ready(), CommunityBatchAdmissionService.ready()]);

        if (!this.db) {
            const dbPath = config.storagePaths.graph;

            if (!dbPath) return;

            if (GraphService.db?.storage?.db?.open && (dbPath === ':memory:' || GraphService.db.storage.dbPath === dbPath)) {
                this.db = GraphService.db.storage.db;
            } else {
                const Database = (await import('better-sqlite3')).default;

                this.db = new Database(dbPath);
            }
        }

        this.ensureSchema()
    }

    /** @summary Creates idempotent viewer markers, the unique claim-binding ledger, and co-located graph tables when absent. */
    ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mc_community_seen (
                tenant_id TEXT NOT NULL, viewer_id TEXT NOT NULL, occurrence_identity TEXT NOT NULL,
                source_instance_id TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
                PRIMARY KEY (tenant_id, viewer_id, occurrence_identity)
            );
            CREATE TABLE IF NOT EXISTS mc_community_task_binding (
                tenant_id TEXT NOT NULL,
                occurrence_identity TEXT NOT NULL,
                source_instance_id TEXT NOT NULL,
                task_id TEXT NOT NULL UNIQUE,
                claimed_by TEXT NOT NULL,
                claimed_at TEXT NOT NULL,
                PRIMARY KEY (tenant_id, occurrence_identity)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_mc_community_task_binding_scoped_event
                ON mc_community_task_binding(tenant_id, occurrence_identity);
            CREATE TABLE IF NOT EXISTS Nodes (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS Edges (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                type TEXT NOT NULL,
                data TEXT NOT NULL,
                FOREIGN KEY (source) REFERENCES Nodes(id) ON DELETE CASCADE,
                FOREIGN KEY (target) REFERENCES Nodes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_edges_source ON Edges(source);
            CREATE INDEX IF NOT EXISTS idx_edges_target ON Edges(target);
            CREATE TABLE IF NOT EXISTS GraphLog (
                log_id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                event_id TEXT,
                event_payload TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_log_event_id
                ON GraphLog(event_id)
                WHERE event_id IS NOT NULL;
            CREATE TRIGGER IF NOT EXISTS node_insert AFTER INSERT ON Nodes BEGIN INSERT INTO GraphLog(entity_id, entity_type) VALUES (NEW.id, 'nodes'); END;
            CREATE TRIGGER IF NOT EXISTS node_update AFTER UPDATE ON Nodes BEGIN INSERT INTO GraphLog(entity_id, entity_type) VALUES (NEW.id, 'nodes'); END;
            CREATE TRIGGER IF NOT EXISTS node_delete AFTER DELETE ON Nodes BEGIN INSERT INTO GraphLog(entity_id, entity_type) VALUES (OLD.id, 'nodes'); END;
            CREATE TRIGGER IF NOT EXISTS edge_insert AFTER INSERT ON Edges BEGIN INSERT INTO GraphLog(entity_id, entity_type) VALUES (NEW.id, 'edges'); END;
            CREATE TRIGGER IF NOT EXISTS edge_update AFTER UPDATE ON Edges BEGIN INSERT INTO GraphLog(entity_id, entity_type) VALUES (NEW.id, 'edges'); END;
            CREATE TRIGGER IF NOT EXISTS edge_delete AFTER DELETE ON Edges BEGIN INSERT INTO GraphLog(entity_id, entity_type) VALUES (OLD.id, 'edges'); END;
        `)
    }

    /** @summary Resolves the bound read scope, refusing absent storage or tenant context. */
    scope() {
        const tenantId = SourceRegistryService.resolveTenantId();

        if (!tenantId) throw new Error('COMMUNITY_TENANT_UNRESOLVED');
        if (!this.db) throw new Error('COMMUNITY_STORAGE_UNAVAILABLE');

        return tenantId
    }

    /**
     * @summary Queries a half-open occurrence-time window with a stable admitted-sequence/row continuation.
     * No title, body, excerpt, live provider call or synthesized narrative enters this default path.
     * @param {Object} options Explicit windowStart, windowEnd, positive safe-integer limit; optional sources/cursor.
     * @returns {Promise<Object>} Shared Bird View envelope plus page items and an opaque continuation.
     */
    async query({windowStart, windowEnd, limit, sourceInstanceIds = null, cursor = null} = {}) {
        await this.ready();

        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('COMMUNITY_LIMIT_REQUIRED');
        if (sourceInstanceIds !== null && (!Array.isArray(sourceInstanceIds) ||
            sourceInstanceIds.some(id => typeof id !== 'string' || !id))) {
            throw new Error('COMMUNITY_SOURCE_FILTER_INVALID')
        }

        const tenantId = this.scope(),
              window   = resolveTemporalWindow({partition: 'community', windowStart, windowEnd}),
              ids      = sourceInstanceIds === null ? null : [...new Set(sourceInstanceIds)].sort(),
              scope    = crypto.createHash('sha256').update(JSON.stringify([tenantId, window, ids])).digest('hex');

        return this.db.transaction(() => this.readPage({tenantId, window, limit, ids, scope, cursor}))()
    }

    /** @summary Reads one page and its census in the same SQLite read snapshot. */
    readPage({tenantId, window, limit, ids, scope, cursor}) {
        const db            = this.db,
              registrations = db.prepare('SELECT source_instance_id FROM mc_source_registration WHERE tenant_id = ?').all(tenantId),
              owned         = new Set(registrations.map(row => row.source_instance_id));

        if (ids?.some(id => !owned.has(id))) throw new Error('COMMUNITY_SOURCE_NOT_OWNED');

        const latest   = db.prepare('SELECT COALESCE(MAX(admitted_sequence), 0) AS value FROM mc_community_batch_receipt WHERE tenant_id = ?').get(tenantId).value;
        let   snapshot = latest, after = null;

        if (cursor !== null) {
            let parsed;

            try {
                if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
                parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
                if (!parsed || parsed.version !== 1 || !Number.isSafeInteger(parsed.snapshot) ||
                    parsed.snapshot < 0 || parsed.snapshot > latest || !Array.isArray(parsed.after) ||
                    parsed.after.length !== 2 || !Number.isSafeInteger(parsed.after[0]) ||
                    parsed.after[0] < 1 || parsed.after[0] > parsed.snapshot ||
                    typeof parsed.after[1] !== 'string' || !parsed.after[1]) throw new Error()
            } catch { throw new Error('COMMUNITY_CURSOR_INVALID') }

            if (parsed.scope !== scope) throw new Error('COMMUNITY_CURSOR_SCOPE_MISMATCH');

            snapshot = parsed.snapshot;
            after = parsed.after
        }

        const clauses = ['o.tenant_id = ?', 'o.admitted_sequence <= ?'], args = [tenantId, snapshot];

        if (ids) {
            clauses.push(ids.length ? `o.source_instance_id IN (${ids.map(() => '?').join(',')})` : '0');
            args.push(...ids)
        }

        const supported = `o.occurrence_kind IN (${SUPPORTED_GITHUB_COMMUNITY_KINDS.map(() => '?').join(',')})`;

        clauses.push("o.attention_disposition = 'eligible'", supported,
            "EXISTS (SELECT 1 FROM mc_source_registration s WHERE s.tenant_id = o.tenant_id AND s.source_instance_id = o.source_instance_id AND s.provider = 'github' AND s.canonical_provider_host = 'github.com' AND s.resource_kind = 'repository')");
        args.push(...SUPPORTED_GITHUB_COMMUNITY_KINDS);

        const eligibleWhere = clauses.join(' AND '), eligibleArgs = [...args];

        clauses.push('julianday(o.occurred_at) >= julianday(?)', 'julianday(o.occurred_at) < julianday(?)');
        args.push(window.windowStartIso, window.windowEndIso);

        const where         = clauses.join(' AND '),
              totalResolved = db.prepare(`SELECT count(*) AS count FROM mc_community_observation o WHERE ${where}`).get(...args).count,
              continuation  = after ? ' AND (o.admitted_sequence > ? OR (o.admitted_sequence = ? AND o.observation_row_id > ?))' : '',
              pageArgs      = after ? [...args, after[0], after[0], after[1]] : args,
              rows          = db.prepare(`SELECT o.* FROM mc_community_observation o WHERE ${where}${continuation} ORDER BY o.admitted_sequence, o.observation_row_id LIMIT ?`).all(...pageArgs, limit),
              last          = rows.at(-1),
              more          = last && db.prepare(`SELECT 1 FROM mc_community_observation o WHERE ${where} AND (o.admitted_sequence > ? OR (o.admitted_sequence = ? AND o.observation_row_id > ?)) LIMIT 1`).get(...args, last.admitted_sequence, last.admitted_sequence, last.observation_row_id),
              nextCursor    = more ? Buffer.from(JSON.stringify({version: 1, scope, snapshot, after: [last.admitted_sequence, last.observation_row_id]})).toString('base64url') : null,
              viewer        = viewerId(),
              sources       = rows.map(row => ({
                  id       : row.occurrence_identity, type: 'community-activity', revision: row.occurrence_digest,
                  drillDown: {operation: 'get_community_activity_content', arguments: {sourceEventId: row.occurrence_identity}}
              })),
              invalidTimes = db.prepare(`SELECT count(*) AS count FROM mc_community_observation o WHERE ${eligibleWhere} AND julianday(o.occurred_at) IS NULL`).get(...eligibleArgs).count,
              sourceCoverage = this.readCoverage({tenantId, ids, snapshot}),
              degradedReasons = [...new Set(sourceCoverage.flatMap(source => source.degradedReasons))];

        if (invalidTimes) degradedReasons.push('invalid-occurrence-time');
        if (nextCursor) degradedReasons.push('source-truncated');

        const envelope = buildTemporalBirdViewEnvelope({
            window, sources, generatedAt: Date.now(),
            coverage: {
                totalResolved, truncated: Boolean(nextCursor), degraded: degradedReasons.length > 0,
                degradedReason: degradedReasons.join(',') || null, degradedReasons, invalidTimes,
                sources       : sourceCoverage, basis: 'admitted-ledger', snapshot
            }
        });

        return {
            ...envelope, nextCursor, snapshot,
            items: rows.map((row, index) => ({
                sourceEventId   : row.occurrence_identity, sourceInstanceId: row.source_instance_id,
                providerEntityId: row.provider_entity_id, parentProviderEntityId: row.parent_provider_entity_id,
                occurrenceKind  : row.occurrence_kind, occurredAt: row.occurred_at,
                actorId         : row.actor_id, actorKind: row.actor_kind, sourceAssociation: row.source_association,
                citation        : envelope.citations[index], notAuthority: true,
                seen            : Boolean(viewer && db.prepare('SELECT 1 FROM mc_community_seen WHERE tenant_id = ? AND viewer_id = ? AND occurrence_identity = ?').get(tenantId, viewer, row.occurrence_identity))
            }))
        }
    }

    /** @summary Projects source lifecycle and receipt coverage without exposing provider state or arbitrary payloads. */
    readCoverage({tenantId, ids, snapshot}) {
        const rows = this.db.prepare('SELECT * FROM mc_source_registration WHERE tenant_id = ? ORDER BY source_instance_id').all(tenantId);

        return rows.filter(row => !ids || ids.includes(row.source_instance_id)).map(row => {
            const degradedReasons = [],
                  supported       = row.provider === 'github' && row.canonical_provider_host === 'github.com' && row.resource_kind === 'repository',
                  families        = supported ? ['issues', 'pulls', 'discussions'].map(resourceFamily => {
                      const receipt  = this.db.prepare(`SELECT receipt_id, coverage FROM mc_community_batch_receipt WHERE tenant_id = ? AND source_instance_id = ? AND resource_family = ? AND admitted_sequence <= ? ORDER BY admitted_sequence DESC LIMIT 1`).get(tenantId, row.source_instance_id, resourceFamily, snapshot),
                            evidence = parseEvidence(receipt?.coverage),
                            complete = evidence?.complete === true && (!evidence.gaps || Array.isArray(evidence.gaps) && evidence.gaps.length === 0);

                      if (!complete) degradedReasons.push(receipt ? 'source-coverage-incomplete' : 'source-coverage-unknown');

                      return {resourceFamily, receiptId: receipt?.receipt_id || null, complete,
                          gapCount: Array.isArray(evidence?.gaps) ? evidence.gaps.length : null}
                  }) : [];

            if (!supported) degradedReasons.push('source-unsupported');
            if (row.lifecycle_state !== 'ACTIVE') degradedReasons.push('source-inactive');

            return {sourceInstanceId: row.source_instance_id, lifecycleState: row.lifecycle_state,
                registrationEpoch: row.registration_epoch, families, degradedReasons: [...new Set(degradedReasons)]}
        })
    }

    /** @summary Resolves a supported, eligible occurrence under the bound tenant; popularity has no handles. */
    getEvent(tenantId, sourceEventId) {
        if (typeof sourceEventId !== 'string' || !sourceEventId) throw new Error('COMMUNITY_EVENT_REQUIRED');

        const row = this.db.prepare(`SELECT o.* FROM mc_community_observation o
            JOIN mc_source_registration s ON s.tenant_id = o.tenant_id AND s.source_instance_id = o.source_instance_id
            WHERE o.tenant_id = ? AND o.occurrence_identity = ? AND s.provider = 'github'
                AND s.canonical_provider_host = 'github.com' AND s.resource_kind = 'repository'`).get(tenantId, sourceEventId);

        return row?.attention_disposition === 'eligible' && SUPPORTED_GITHUB_COMMUNITY_KINDS.includes(row.occurrence_kind) ? row : null
    }

    /**
     * @summary Writes a viewer marker idempotently; it never changes membership or the source revision.
     * @param {Object} options Occurrence identity only; the viewer is authenticated request context.
     * @returns {Promise<Object>} A zero-authority result.
     */
    async markSeen({sourceEventId} = {}) {
        await this.ready();

        const tenantId = this.scope(), viewer = viewerId();

        if (!viewer) throw new Error('COMMUNITY_SEEN_CONTEXT_REQUIRED');

        const row = this.getEvent(tenantId, sourceEventId);

        if (!row) return {status: 'ineligible', sourceEventId, notAuthority: true};

        this.db.prepare('INSERT OR IGNORE INTO mc_community_seen (tenant_id, viewer_id, occurrence_identity, source_instance_id, first_seen_at) VALUES (?, ?, ?, ?, ?)').run(tenantId, viewer, sourceEventId, row.source_instance_id, Date.now());

        return {status: 'seen', sourceEventId, notAuthority: true}
    }

    /**
     * @summary Fetches transient current prose only while the current source grant survives the provider read.
     * Historical epoch changes do not permanently deny an event after a legitimate reprovision.
     * @param {Object} options Occurrence identity from a citation handle.
     * @returns {Promise<Object>} Typed current content or an honest metadata-only absence status.
     */
    async getContent({sourceEventId} = {}) {
        await this.ready();

        const tenantId = this.scope(), row = this.getEvent(tenantId, sourceEventId),
              result   = status => ({status, sourceEventId, notAuthority: true});

        if (!row) return result('unknown');

        const source = SourceRegistryService.getRegistrationForTenant(tenantId, row.source_instance_id);

        if (!source || source.lifecycleState !== 'ACTIVE') return result('inaccessible');
        if (source.provider !== 'github' || source.canonicalProviderHost !== 'github.com' || source.resourceKind !== 'repository') return result('unsupported');
        const tombstones = this.db.prepare(`SELECT deletion_evidence FROM mc_community_observation
            WHERE tenant_id = ? AND source_instance_id = ? AND provider_entity_id = ? AND absence = 'deleted'`)
            .all(tenantId, row.source_instance_id, row.provider_entity_id);

        if (tombstones.some(tombstone => parseEvidence(tombstone.deletion_evidence))) return result('deleted');

        const before  = grantIdentity(source),
              adapter = this.contentAdapter || (await import('../github-workflow/GitHubCommunityContentService.mjs')).default;
        let content;

        try {
            content = await adapter.read({source, observation: {
                providerEntityId: row.provider_entity_id, parentProviderEntityId: row.parent_provider_entity_id,
                occurrenceKind  : row.occurrence_kind, absence: row.absence
            }})
        } catch { return result('unknown') }

        const after = SourceRegistryService.getRegistrationForTenant(tenantId, row.source_instance_id);

        if (!after || grantIdentity(after) !== before) return result('inaccessible');

        return {...content, sourceEventId, notAuthority: true}
    }

    /**
     * @summary Reads an already-committed canonical Task binding and its graph MESSAGE node.
     * @param {String} tenantId Server-resolved tenant id.
     * @param {String} sourceEventId Scoped occurrence identity.
     * @returns {Object|null} Existing canonical claim response, or null when unbound.
     */
    readExistingClaimBinding(tenantId, sourceEventId) {
        const existing = this.db.prepare(`
            SELECT task_id, claimed_by, claimed_at, source_instance_id
            FROM mc_community_task_binding
            WHERE tenant_id = ? AND occurrence_identity = ?
        `).get(tenantId, sourceEventId);

        if (!existing) return null;

        const nodeRow = this.db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get(existing.task_id);
        if (!nodeRow) {
            throw new Error(`COMMUNITY_TASK_BINDING_CORRUPT:${existing.task_id}`)
        }

        const parsedNode = parseEvidence(nodeRow.data),
              storedTask = parsedNode?.properties?.task;

        if (!storedTask?.state) {
            throw new Error(`COMMUNITY_TASK_BINDING_CORRUPT:${existing.task_id}`)
        }

        return {
            status          : 'claimed',
            created         : false,
            sourceEventId,
            sourceInstanceId: existing.source_instance_id,
            taskId          : existing.task_id,
            claimedBy       : existing.claimed_by,
            claimedAt       : existing.claimed_at,
            notAuthority    : false,
            task            : storedTask
        }
    }

    /**
     * @summary Hydrates a committed claimed Task and its routing endpoints into GraphService RAM without re-writing SQLite.
     * @param {String} taskId Canonical MESSAGE:<uuid> id.
     * @param {String} claimedBy Canonical @<identity> claimant id.
     */
    syncClaimedTaskToGraphCache(taskId, claimedBy) {
        const graphDb = GraphService.db;
        if (!graphDb?.nodes || !graphDb?.edges || !this.db?.open) return;

        const claimantRow = claimedBy ? this.db.prepare('SELECT data FROM Nodes WHERE id = ?').get(claimedBy) : null,
              messageRow  = this.db.prepare('SELECT data FROM Nodes WHERE id = ?').get(taskId),
              edgeRows    = this.db.prepare('SELECT data FROM Edges WHERE source = ? ORDER BY id').all(taskId);

        if (!messageRow) return;

        const wasAutoSave = graphDb.autoSave;
        graphDb.autoSave  = false;

        try {
            if (claimantRow) {
                const parsedClaimant = parseEvidence(claimantRow.data);
                if (parsedClaimant) graphDb.addNode(parsedClaimant)
            }

            const parsedMessage = parseEvidence(messageRow.data);
            if (parsedMessage) graphDb.addNode(parsedMessage);

            for (const edgeRow of edgeRows) {
                const parsedEdge = parseEvidence(edgeRow.data);
                if (parsedEdge) graphDb.addEdge(parsedEdge)
            }

            graphDb.acknowledgeLocalMutations?.()
        } finally {
            graphDb.autoSave = wasAutoSave
        }
    }

    /**
     * @summary Atomically validates an eligible community event and binds it to one canonical A2A Task.
     *
     * Task creation (`Nodes`, `Edges`, `GraphLog`) and `(tenant_id, occurrence_identity) -> task_id`
     * binding commit in one `IMMEDIATE` SQLite transaction. Concurrent or retrying callers receive
     * the same server-owned canonical Task; seen state, count projections, and provider delivery ids
     * never authorize claim. Downstream assignment/RBAC/state transitions belong to `MailboxService.transitionTask`
     * only after commit.
     *
     * @param {Object} options
     * @param {String} options.sourceEventId Admitted occurrence identity.
     * @param {String|null} [options.crashPoint=null] Optional test fault-injection point inside the transaction.
     * @returns {Promise<Object>} Canonical claim outcome and Task envelope when eligible/active.
     */
    async claimTask({sourceEventId, crashPoint = null} = {}) {
        await this.ready();

        const tenantId = this.scope(),
              claimant = claimantId();

        if (!claimant) throw new Error('COMMUNITY_CLAIM_CONTEXT_REQUIRED');
        if (typeof sourceEventId !== 'string' || !sourceEventId.trim()) throw new Error('COMMUNITY_EVENT_REQUIRED');

        const denied = (status, sourceInstanceId = null) => ({
            status,
            created     : false,
            sourceEventId,
            sourceInstanceId,
            taskId      : null,
            claimedBy   : null,
            claimedAt   : null,
            notAuthority: true,
            task        : null
        });

        const executeClaim = this.db.transaction(() => {
            const row = this.db.prepare(`
                SELECT o.*, s.lifecycle_state, s.provider, s.canonical_provider_host, s.resource_kind
                FROM mc_community_observation o
                JOIN mc_source_registration s
                  ON s.tenant_id = o.tenant_id AND s.source_instance_id = o.source_instance_id
                WHERE o.tenant_id = ? AND o.occurrence_identity = ?
            `).get(tenantId, sourceEventId);

            if (!row) return denied('ineligible');
            if (row.provider !== 'github' || row.canonical_provider_host !== 'github.com' || row.resource_kind !== 'repository') {
                return denied('ineligible', row.source_instance_id)
            }
            if (row.lifecycle_state !== 'ACTIVE') {
                return denied('inaccessible', row.source_instance_id)
            }
            if (row.attention_disposition !== 'eligible' || !SUPPORTED_GITHUB_COMMUNITY_KINDS.includes(row.occurrence_kind)) {
                return denied('ineligible', row.source_instance_id)
            }

            const tombstones = this.db.prepare(`
                SELECT deletion_evidence FROM mc_community_observation
                WHERE tenant_id = ? AND source_instance_id = ? AND provider_entity_id = ? AND absence = 'deleted'
            `).all(tenantId, row.source_instance_id, row.provider_entity_id);

            if ((row.absence === 'deleted' && parseEvidence(row.deletion_evidence)) ||
                tombstones.some(tombstone => parseEvidence(tombstone.deletion_evidence))) {
                return denied('deleted', row.source_instance_id)
            }

            const existing = this.readExistingClaimBinding(tenantId, sourceEventId);
            if (existing) return existing;

            const taskId         = `MESSAGE:${crypto.randomUUID()}`,
                  claimedAt      = new Date().toISOString(),
                  normalizedUser = normalizeUserId(tenantId);

            const claimantRow    = this.db.prepare('SELECT id, user_id, data FROM Nodes WHERE id = ?').get(claimant),
                  parsedClaimant = claimantRow ? parseEvidence(claimantRow.data) : null;

            if (!parsedClaimant || parsedClaimant.label !== 'AgentIdentity' ||
                !['agent', 'human'].includes(parsedClaimant.properties?.accountType)) {
                const claimantNode = {
                    id        : claimant,
                    label     : 'AgentIdentity',
                    properties: {
                        ...(parsedClaimant?.properties || {}),
                        name       : parsedClaimant?.properties?.name || claimant.slice(1) || claimant,
                        description: parsedClaimant?.properties?.description || 'Claimant AgentIdentity node provisioned on atomic community task claim.',
                        accountType: parsedClaimant?.properties?.accountType === 'human' ? 'human' : 'agent',
                        userId     : null
                    }
                };
                this.db.prepare(`
                    INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)
                    ON CONFLICT(id) DO UPDATE SET user_id = NULL, data = excluded.data
                `).run(claimant, JSON.stringify(claimantNode))
            }

            const bindingInsert = this.db.prepare(`
                INSERT INTO mc_community_task_binding (
                    tenant_id, occurrence_identity, source_instance_id, task_id, claimed_by, claimed_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, occurrence_identity) DO NOTHING
            `).run(tenantId, sourceEventId, row.source_instance_id, taskId, claimant, claimedAt);

            if (bindingInsert.changes === 0) {
                return this.readExistingClaimBinding(tenantId, sourceEventId)
            }

            if (crashPoint === 'after-binding-insert') {
                throw new Error('COMMUNITY_CLAIM_CRASH_AFTER_BINDING')
            }

            const task = {
                id                    : taskId,
                state                 : 'Working',
                assignee              : claimant,
                sourceEventId,
                sourceInstanceId      : row.source_instance_id,
                providerEntityId      : row.provider_entity_id,
                parentProviderEntityId: row.parent_provider_entity_id ?? null,
                occurrenceKind        : row.occurrence_kind
            };

            const messageNode = {
                id        : taskId,
                label     : 'MESSAGE',
                properties: {
                    name                   : `[community-claim] ${row.occurrence_kind} ${row.provider_entity_id}`,
                    description            : '',
                    subject                : `[community-claim] ${row.occurrence_kind} ${row.provider_entity_id}`,
                    bodyText               : `Claimed community activity ${sourceEventId} from source ${row.source_instance_id}.`,
                    priority               : 'normal',
                    sentAt                 : claimedAt,
                    readAt                 : claimedAt,
                    from                   : claimant,
                    senderPrincipalClass   : 'agent',
                    to                     : claimant,
                    inReplyTo              : null,
                    partOfThread           : null,
                    taggedConcepts         : ['community-activity'],
                    wakeSuppressed         : true,
                    userId                 : normalizedUser,
                    tenantId,
                    sharedEntity           : false,
                    task,
                    taskAssignmentAuthority: TASK_ASSIGNMENT_AUTHORITY,
                    lastModifiedAt         : claimedAt
                }
            };

            this.db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)').run(
                taskId,
                normalizedUser,
                JSON.stringify(messageNode)
            );

            if (crashPoint === 'after-node-insert') {
                throw new Error('COMMUNITY_CLAIM_CRASH_AFTER_NODE')
            }

            const edgeProps = {
                weight      : 1.0,
                timestamp   : claimedAt,
                userId      : normalizedUser,
                tenantId,
                sharedEntity: false
            };
            const sentByEdge = {
                id        : crypto.randomUUID(),
                source    : taskId,
                target    : claimant,
                type      : 'SENT_BY',
                properties: edgeProps
            };
            const sentToEdge = {
                id        : crypto.randomUUID(),
                source    : taskId,
                target    : claimant,
                type      : 'SENT_TO',
                properties: edgeProps
            };

            const insertEdge = this.db.prepare(
                'INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)'
            );
            insertEdge.run(sentByEdge.id, normalizedUser, taskId, claimant, 'SENT_BY', JSON.stringify(sentByEdge));
            insertEdge.run(sentToEdge.id, normalizedUser, taskId, claimant, 'SENT_TO', JSON.stringify(sentToEdge));

            if (crashPoint === 'after-edges-insert') {
                throw new Error('COMMUNITY_CLAIM_CRASH_AFTER_EDGES')
            }

            this.db.prepare(`
                INSERT INTO GraphLog (entity_id, entity_type, event_id, event_payload)
                VALUES (?, ?, ?, ?)
            `).run(
                taskId,
                TASK_STATE_CHANGED_ENTITY_TYPE,
                crypto.randomUUID(),
                JSON.stringify({
                    schemaVersion      : TASK_STATE_CHANGED_SCHEMA_VERSION,
                    taskId,
                    previousState      : null,
                    newState           : 'Working',
                    originator         : claimant,
                    assignee           : claimant,
                    assignmentAuthority: TASK_ASSIGNMENT_AUTHORITY,
                    lastModifiedAt     : claimedAt,
                    sourceEventId,
                    sourceInstanceId   : row.source_instance_id
                })
            );

            if (crashPoint === 'before-commit' || crashPoint === 'after-graphlog-insert') {
                throw new Error('COMMUNITY_CLAIM_CRASH_BEFORE_COMMIT')
            }

            return {
                status          : 'claimed',
                created         : true,
                sourceEventId,
                sourceInstanceId: row.source_instance_id,
                taskId,
                claimedBy       : claimant,
                claimedAt,
                notAuthority    : false,
                task
            }
        });

        const result = executeClaim.immediate();

        if (result.taskId) {
            this.syncClaimedTaskToGraphCache(result.taskId, result.claimedBy)
        }

        return result
    }

    /**
     * @summary Reads only committed claimed Tasks under the bound tenant for LifecycleFrontier consumption.
     * Unclaimed community observations, seen markers, and count projections are structurally excluded.
     * @param {Object} [options]
     * @param {String|null} [options.agentId=null] Optional owner filter.
     * @param {String} [options.checkedAt=new Date().toISOString()] Timestamp for the lifecycle read.
     * @returns {Promise<Object[]>} Normalized Task records for `produceLifecycleFrontier` / `admitClaimedTask`.
     */
    async listClaimedTasks({agentId = null, checkedAt = new Date().toISOString()} = {}) {
        await this.ready();

        const tenantId        = this.scope(),
              normalizedOwner = agentId ? normalizeMailboxIdentityForComparison(agentId) : null,
              rows            = this.db.prepare(`
                  SELECT b.occurrence_identity, b.source_instance_id, b.task_id, b.claimed_at, n.data
                  FROM mc_community_task_binding b
                  JOIN Nodes n ON n.id = b.task_id
                  WHERE b.tenant_id = ?
                  ORDER BY b.claimed_at ASC, b.task_id ASC
              `).all(tenantId);

        const tasks = [];

        for (const row of rows) {
            const parsed = parseEvidence(row.data),
                  props  = parsed?.properties || {},
                  task   = props.task;

            if (!task?.state) continue;

            const ownerId = normalizeMailboxIdentityForComparison(task.assignee);
            if (normalizedOwner && ownerId !== normalizedOwner) continue;

            tasks.push({
                id              : task.id || row.task_id,
                messageId       : task.id || row.task_id,
                ownerId,
                state           : task.state,
                actionableSince : props.lastModifiedAt || row.claimed_at,
                clockBasis      : 'transition',
                checkedAt,
                sourceEventId   : row.occurrence_identity,
                sourceInstanceId: row.source_instance_id
            })
        }

        return tasks
    }
}

export default Neo.setupClass(CommunityActivityService);
