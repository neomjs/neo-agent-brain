import crypto                             from 'crypto';
import Base                               from 'neo.mjs/src/core/Base.mjs';
import config                             from '../../mcp/server/memory-core/config.mjs';
import SourceRegistryService              from './SourceRegistryService.mjs';
import CommunityBatchAdmissionService     from './CommunityBatchAdmissionService.mjs';
import RequestContextService              from '../../mcp/server/shared/services/RequestContextService.mjs';
import {resolveTemporalWindow}            from './helpers/temporalWindowResolver.mjs';
import {buildTemporalBirdViewEnvelope}    from './helpers/temporalBirdViewEnvelope.mjs';
import {SUPPORTED_GITHUB_COMMUNITY_KINDS} from '../github-workflow/community/communityContentKinds.mjs';

/** @summary The authenticated viewer key is distinct from tenant scope and never session-owned. */
function viewerId() {
    const agent   = RequestContextService.getAgentIdentityNodeId(),
          subject = RequestContextService.getUserId();

    return agent ? `agent:${agent}` : subject ? `subject:${subject}` : null
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
 * @summary Durable community metadata, explicit current-content reads and per-viewer presentation markers.
 * Pagination freezes ledger membership, while seen and source lifecycle remain current projections.
 * The only table this reader writes is its own seen table; admission, Tasks and ranking retain their owners.
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

    /** @summary Waits for ledger owners, opens the configured store and creates only presentation state. */
    async initAsync() {
        await super.initAsync();
        await Promise.all([SourceRegistryService.ready(), CommunityBatchAdmissionService.ready()]);

        if (!this.db) {
            const dbPath = config.storagePaths.graph;

            if (!dbPath) return;

            const Database = (await import('better-sqlite3')).default;

            this.db = new Database(dbPath);
        }

        this.ensureSchema()
    }

    /** @summary Creates idempotent viewer markers without altering source ledger schema. */
    ensureSchema() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS mc_community_seen (
            tenant_id TEXT NOT NULL, viewer_id TEXT NOT NULL, occurrence_identity TEXT NOT NULL,
            source_instance_id TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, viewer_id, occurrence_identity)
        )`)
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
}

export default Neo.setupClass(CommunityActivityService);
