import crypto                                                                       from 'crypto';
import fs                                                                           from 'fs';
import path                                                                         from 'path';
import Base                                                                         from 'neo.mjs/src/core/Base.mjs';
import {Memory_GraphService as GraphService, Memory_StorageRouter as StorageRouter} from '../../services.mjs';
import logger                                                                       from '../../mcp/server/memory-core/logger.mjs';
import {canonicalizeConceptId}                                                      from '../graph/conceptSpineCanonicalization.mjs';
import {CORPUS_GRAPH_ORIGIN, qualifyOriginId}                                       from '../graph/corpusProjectionContract.mjs';
import {isAdrRedirect}                                                              from '../shared/adrRedirect.mjs';
import {
    ADR_FILE_REGEX,
    ADR_NUMBER_REGEX,
    ADR_SLUG_REGEX,
    FORGE_AUTHORITY_REGEX,
    FULL_NAMESPACE_REGEX,
    KNOWN_CUT_REPOSITORIES,
    SHARED_ADR_CATALOG_STATE,
    bindSharedAdrRecordAliases,
    buildCanonicalAdrKey,
    createCodedError,
    decodeAdrKeyField,
    encodeAdrKeyField,
    ensureSharedReservationBucket,
    parseCanonicalAdrKey,
    registerSharedForgeRepository,
    resetSharedAdrCatalog,
    resolveSharedAdrReference,
    validateAdrIdentityFields
} from '../shared/adrIdentityCodec.mjs';
import {
    buildAdmittedAdrRecord,
    computeAdrPayloadHash,
    evaluateAdrCandidateConflicts,
    extractAdrTitleAndStatus,
    extractCitationSurfaceContext,
    measureAdrAuthorActions,
    observeAdrCandidateAllocationFloor,
    parseAdrFilename,
    parseAdrOpeningAliases,
    parseAdrSupersedes,
    parseHumanOrNumericAdrReference,
    resolveAdrCandidateIdentity,
    stripMarkdownFences
} from '../shared/adrDocumentParser.mjs';

export {
    ADR_SLUG_REGEX,
    KNOWN_CUT_REPOSITORIES,
    buildCanonicalAdrKey,
    decodeAdrKeyField,
    encodeAdrKeyField,
    measureAdrAuthorActions,
    parseAdrFilename,
    parseAdrOpeningAliases,
    parseCanonicalAdrKey,
    validateAdrIdentityFields
};

export const ADR_EDGE_TYPES = Object.freeze({
    CITES_AUTHORITY    : 'CITES_AUTHORITY',
    CODIFIES_CONCEPT   : 'CODIFIES_CONCEPT',
    GOVERNS            : 'GOVERNS',
    GRADUATED_FROM     : 'GRADUATED_FROM',
    IMPLEMENTS_DECISION: 'IMPLEMENTS_DECISION'
});

const
    ISSUE_KEYWORD_REF_REGEX  = /\b(?:Epic|Issue|Ticket)\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+))\b/gi,
    ISSUE_LINK_REF_REGEX     = /\[[^\]]*\]\(https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[?#][^\s)]*)?\)/gi,
    PR_KEYWORD_REF_REGEX     = /\bPR\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+))\b/gi,
    PR_LINK_REF_REGEX        = /\[[^\]]*\]\(https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[?#][^\s)]*)?\)/gi,
    CONCEPT_REF_REGEX        = /\bCONCEPT:([A-Za-z0-9_.:-]+)\b/g,
    SESSION_REF_REGEX        = /\bOrigin Session ID:\s*`?([A-Za-z0-9_.:-]+)`?/gi,
    QUALIFIED_ISSUE_NODE_REX = /^(?:[a-z0-9_.-]+#)?issue-\d+$/i,
    QUALIFIED_PR_NODE_REX    = /^(?:[a-z0-9_.-]+#)?pr-\d+$/i,
    QUALIFIED_DISC_NODE_REX  = /^(?:[a-z0-9_.-]+#)?discussion-\d+$/i,
    SESSION_NODE_REGEX       = /^session:[A-Za-z0-9_.:-]+$/,
    ADR_SHAPED_ID_REGEX      = /^(?:adr[-:]|.*#adr[-:])/i;

function unresolvedResult(reasonCode, candidates = []) {
    return {
        status           : candidates.length > 1 ? 'ambiguous' : 'unresolved',
        resolved         : false,
        canonicalKey     : null,
        identityResolved : false,
        documentAvailable: false,
        candidates,
        reasonCode
    };
}

function resolvedResult(record) {
    return {
        status           : 'resolved',
        resolved         : true,
        canonicalKey     : record.canonicalKey,
        identityResolved : true,
        documentAvailable: Boolean(record.documentAvailable),
        kbAvailable      : Boolean(record.kbAvailable),
        stale            : Boolean(record.stale),
        record,
        candidates       : [record.canonicalKey]
    };
}

/**
 * @summary Deterministically ingests Architecture Decision Records into the Native Edge Graph as
 * first-class `ADR` nodes with repository-qualified identities, scoped slug/numeric aliases,
 * and consumer-backed relationship edges.
 *
 * @class Neo.ai.daemons.services.AdrIngestor
 * @extends Neo.core.Base
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md
 * @see Neo.ai.daemons.services.ConceptIngestor
 * @singleton
 */
class AdrIngestor extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.daemons.services.AdrIngestor'
         * @protected
         */
        className: 'Neo.ai.daemons.services.AdrIngestor',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    admissionCatalog       = SHARED_ADR_CATALOG_STATE.admissionCatalog
    repositoryReservations = SHARED_ADR_CATALOG_STATE.repositoryReservations
    forgeDirectory         = SHARED_ADR_CATALOG_STATE.forgeDirectory

    construct(config) {
        super.construct(config);
        this.resetCatalog();
    }

    /**
     * @summary Resets the in-memory admission catalog and seeds the default cut repositories.
     */
    resetCatalog() {
        resetSharedAdrCatalog();
    }

    /**
     * @summary Rehydrates `admissionCatalog`, `repositoryReservations`, and `forgeDirectory` from
     * persisted `ADR` nodes in `GraphService.db` so admitted aliases, numeric reservations, and
     * repository rename provenance survive process restarts or in-memory catalog resets.
     */
    rehydrateCatalogFromGraph() {
        const records = [];

        if (GraphService.db?.nodes?.items) {
            for (const node of GraphService.db.nodes.items) {
                const
                    label = node.isRecord ? node.get('label') : node.label,
                    props = (node.isRecord ? node.get('properties') : node.properties) || {};
                if (label === 'ADR' && props.adrAuthority?.admitted === true && props.adrAdmissionRecord) {
                    records.push(props.adrAdmissionRecord);
                }
            }
        }

        const sqlite = GraphService.db?.storage?.db;
        if (sqlite) {
            try {
                const rows = sqlite.prepare(`
                    SELECT id, data FROM Nodes WHERE json_extract(data, '$.label') = 'ADR'
                `).all();
                for (const row of rows) {
                    if (GraphService.db?.nodes?.has(row.id)) continue;
                    try {
                        const parsed = JSON.parse(row.data);
                        if (parsed?.properties?.adrAuthority?.admitted === true && parsed.properties.adrAdmissionRecord) {
                            records.push(parsed.properties.adrAdmissionRecord);
                        }
                    } catch {}
                }
            } catch {}
        }

        for (const rawRecord of records) {
            if (!rawRecord?.canonicalKey || this.admissionCatalog.has(rawRecord.canonicalKey)) continue;

            const record = {
                ...rawRecord,
                historicalAliases: [...(rawRecord.historicalAliases || [])],
                aliasBindings    : (rawRecord.aliasBindings || []).map(b => ({...b})),
                reservations     : (rawRecord.reservations || []).map(r => ({...r})),
                provenance       : {
                    ...(rawRecord.provenance || {}),
                    custodyTransitions: [...(rawRecord.provenance?.custodyTransitions || [])],
                    repositoryRenames : [...(rawRecord.provenance?.repositoryRenames || [])],
                    sourceLineage     : [...(rawRecord.provenance?.sourceLineage || [])]
                }
            };

            for (const tuple of [record.sourceTuple, record.assignmentEvidence]) {
                if (tuple?.repositoryId && tuple?.namespace) {
                    const forge = tuple.forge || 'github.com';
                    this.registerForgeRepository({forge, repositoryId: tuple.repositoryId, namespace: tuple.namespace});
                    this.#ensureReservationBucket(forge, tuple.repositoryId).numbers.add(record.adrNumber);
                }
            }

            for (const rename of record.provenance.repositoryRenames) {
                if (rename?.repositoryId && rename?.currentNamespace && rename?.previousNamespace) {
                    this.registerForgeRepository({
                        forge       : rename.forge || 'github.com',
                        repositoryId: rename.repositoryId,
                        namespace   : rename.currentNamespace,
                        aliases     : [rename.previousNamespace]
                    });
                }
            }

            for (const binding of record.aliasBindings) {
                const bucket = binding.repositoryId
                    ? this.#ensureReservationBucket(binding.forge || 'github.com', binding.repositoryId)
                    : null;
                if (bucket && binding.kind === 'legacy-number') bucket.numbers.add(binding.value);
                if (bucket && binding.namespace) {
                    bucket.aliases.set(`${binding.kind}:${binding.namespace.toLowerCase()}:${binding.value}`, {
                        ...binding,
                        targetKey: record.canonicalKey
                    });
                }
            }

            this.admissionCatalog.set(record.canonicalKey, record);
        }
    }

    /**
     * @summary Registers a repository's current namespace occupancy in the forge provider directory.
     * @param {Object} repo
     */
    registerForgeRepository(repo = {}) {
        registerSharedForgeRepository(repo);
    }

    /**
     * @summary Records a proved repository rename without rekeying existing decisions.
     * @param {Object} params
     * @returns {Object}
     */
    recordRepositoryRename({forge = 'github.com', repositoryId, previousNamespace, currentNamespace, proof} = {}) {
        this.rehydrateCatalogFromGraph();
        if (!proof) {
            throw createCodedError(
                'ADR_UNPROVED_REPOSITORY_IDENTITY_CHANGE',
                `Repository rename '${previousNamespace}' -> '${currentNamespace}' requires continuity proof.`
            );
        }

        validateAdrIdentityFields({forge, repositoryId, namespace: previousNamespace, number: '0001'});
        validateAdrIdentityFields({forge, repositoryId, namespace: currentNamespace, number: '0001'});
        this.registerForgeRepository({forge, repositoryId, namespace: currentNamespace, aliases: [previousNamespace]});

        const bucket = this.#ensureReservationBucket(forge, repositoryId);

        for (const record of this.admissionCatalog.values()) {
            const touchesRepo = record.assignmentEvidence?.forge === forge && (
                record.assignmentEvidence?.repositoryId === repositoryId ||
                record.sourceTuple?.repositoryId === repositoryId ||
                record.aliasBindings.some(b => b.forge === forge && b.repositoryId === repositoryId)
            );
            if (!touchesRepo) continue;

            record.provenance.repositoryRenames.push({forge, repositoryId, previousNamespace, currentNamespace, proof});

            const existingForRepo = record.aliasBindings.filter(
                b => b.forge === forge && b.repositoryId === repositoryId && b.namespace.toLowerCase() === previousNamespace.toLowerCase()
            );

            for (const binding of existingForRepo) {
                this.#addAliasBinding(record, bucket, {
                    kind     : binding.kind,
                    value    : binding.value,
                    forge,
                    repositoryId,
                    namespace: currentNamespace,
                    targetKey: record.canonicalKey,
                    current  : binding.current
                });
            }

            const existingNode = GraphService.db?.nodes?.get(record.canonicalKey);
            if (existingNode) {
                const props = (existingNode.isRecord ? existingNode.get('properties') : existingNode.properties) || {};
                GraphService.upsertNode({
                    id        : record.canonicalKey,
                    type      : 'ADR',
                    name      : props.title || record.title,
                    properties: {
                        ...props,
                        adrAdmissionRecord: record,
                        adrAuthority      : {...(props.adrAuthority || {}), admitted: true, canonicalKey: record.canonicalKey, renameVerified: true}
                    }
                });
            }
        }

        return {forge, repositoryId, previousNamespace, currentNamespace};
    }

    #ensureReservationBucket(forge, repositoryId) {
        const key = `${forge}:${repositoryId}`;
        if (!this.repositoryReservations.has(key)) {
            this.repositoryReservations.set(key, {forge, repositoryId, numbers: new Set(), aliases: new Map()});
        }
        return this.repositoryReservations.get(key);
    }

    #addAliasBinding(record, bucket, binding) {
        const
            normalizedNs = binding.namespace.toLowerCase(),
            matches      = item => item.kind === binding.kind && item.value === binding.value &&
                                   item.forge === binding.forge && item.repositoryId === binding.repositoryId &&
                                   item.namespace.toLowerCase() === normalizedNs,
            existing     = record.aliasBindings.find(matches);

        if (existing) {
            existing.current = Boolean(binding.current);
        } else {
            record.aliasBindings.push({...binding});
        }

        if (!record.reservations.some(matches)) {
            record.reservations.push({
                kind        : binding.kind,
                value       : binding.value,
                forge       : binding.forge,
                repositoryId: binding.repositoryId,
                namespace   : binding.namespace,
                targetKey   : record.canonicalKey
            });
        }

        if (bucket) {
            bucket.aliases.set(`${binding.kind}:${normalizedNs}:${binding.value}`, {...binding, targetKey: record.canonicalKey});
        }
    }

    /**
     * @summary Reserves historical ADR numbers (and optional slug/legacy-number locators) in a source
     * repository so move-outs and extractions never lower its local allocation floor.
     * @param {Object} params
     */
    reserveHistoricalNumbers({forge = 'github.com', repositoryId, namespace, reservations = []} = {}) {
        this.rehydrateCatalogFromGraph();
        validateAdrIdentityFields({forge, repositoryId, namespace, number: '0001'});
        const bucket = this.#ensureReservationBucket(forge, repositoryId);

        for (const item of reservations) {
            const
                number    = typeof item === 'string' ? item : item?.number,
                slug      = typeof item === 'object' ? item?.slug : null,
                targetKey = (typeof item === 'object' && item?.targetKey) || buildCanonicalAdrKey({forge, repositoryId, namespace, number});

            if (!ADR_NUMBER_REGEX.test(String(number || ''))) {
                throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid reserved ADR number: '${String(number)}'`);
            }

            bucket.numbers.add(number);
            bucket.aliases.set(`legacy-number:${namespace.toLowerCase()}:${number}`, {
                kind: 'legacy-number', value: number, forge, repositoryId, namespace, targetKey
            });

            if (slug) {
                if (!ADR_SLUG_REGEX.test(slug)) {
                    throw createCodedError('ADR_INVALID_ALIAS_TOKEN', `Invalid reserved ADR slug: '${slug}'`);
                }
                bucket.aliases.set(`slug:${namespace.toLowerCase()}:${slug}`, {
                    kind: 'slug', value: slug, forge, repositoryId, namespace, targetKey
                });
            }
        }
    }

    /**
     * @summary Computes the next local ADR number (`0001`..`9999`) for `(forge, repositoryId)` as one
     * above the greatest admitted or reserved decision number in that repository.
     * @param {Object} params
     * @returns {String}
     */
    allocateNextAdrNumber({forge = 'github.com', repositoryId} = {}) {
        this.rehydrateCatalogFromGraph();
        if (typeof forge !== 'string' || !FORGE_AUTHORITY_REGEX.test(forge) ||
            typeof repositoryId !== 'string' || !repositoryId.trim()) {
            throw createCodedError('ADR_INVALID_IDENTITY_FIELD', 'allocateNextAdrNumber requires valid forge and repositoryId.');
        }

        const bucket = this.repositoryReservations.get(`${forge}:${repositoryId}`);
        let   max    = 0;

        if (bucket) {
            for (const num of bucket.numbers) {
                const val = Number(num);
                if (Number.isFinite(val) && val > max) max = val;
            }
        }

        for (const record of this.admissionCatalog.values()) {
            const matchesRepo =
                (record.assignmentEvidence?.forge === forge && record.assignmentEvidence?.repositoryId === repositoryId) ||
                (record.sourceTuple?.forge === forge && record.sourceTuple?.repositoryId === repositoryId) ||
                record.reservations?.some(r => r.forge === forge && r.repositoryId === repositoryId);
            if (matchesRepo) {
                const val = Number(record.adrNumber);
                if (Number.isFinite(val) && val > max) max = val;
            }
        }

        if (max >= 9999) {
            throw createCodedError('ADR_ALLOCATION_EXHAUSTED', `Four-digit ADR range (0001..9999) is exhausted for ${forge}:${repositoryId}.`);
        }

        return String(max + 1).padStart(4, '0');
    }

    /**
     * @summary Exposes present-file and unfiltered-history observations as an advisory candidate floor,
     * while keeping admission's proved population as the sole certifier.
     * @param {Object} [options={}]
     * @returns {Object}
     */
    observeCandidateAllocationFloor(options = {}) {
        this.rehydrateCatalogFromGraph();
        const
            {forge = 'github.com', repositoryId = null} = options,
            certifiedEligibleNumber                     = repositoryId ? this.allocateNextAdrNumber({forge, repositoryId}) : null;
        return observeAdrCandidateAllocationFloor(options, certifiedEligibleNumber);
    }

    /**
     * @summary Measures normal author actions for creation or rename.
     * @param {Object} scenario
     * @returns {Object}
     */
    measureAuthorActions(scenario) {
        return measureAdrAuthorActions(scenario);
    }

    /**
     * @summary Computes the differential-sync hash stored under `properties.payloadHash`.
     * @param {Object} adr Parsed ADR metadata.
     * @returns {String}
     * @protected
     */
    computePayloadHash(adr) {
        return computeAdrPayloadHash(adr);
    }

    /**
     * @summary Parses a markdown ADR file into graph-node metadata, slug history, and deterministic edge rows.
     * @param {String} fileName ADR markdown file name.
     * @param {String} content ADR markdown body.
     * @param {String} source Repo-relative source path.
     * @param {Object} [options={}] Optional repository/assignment/citation context.
     * @returns {Object}
     * @protected
     */
    parseAdr(fileName, content, source, options = {}) {
        const
            {adrNumber, slug: currentSlug} = parseAdrFilename(fileName),
            aliasResult                    = parseAdrOpeningAliases(content),
            historicalAliases              = aliasResult.aliases,
            repository                     = options.repository || null,
            assignedIdentity               = options.assignedIdentity || repository;

        let canonicalKey = `adr-${adrNumber}`,
            id           = canonicalKey;

        if (options.canonicalKey) {
            const parsedKey = parseCanonicalAdrKey(options.canonicalKey);
            if (parsedKey.number !== adrNumber) {
                throw createCodedError('ADR_NUMBER_MISMATCH', `Canonical key number '${parsedKey.number}' does not match filename number '${adrNumber}'.`);
            }
            canonicalKey = parsedKey.canonicalKey;
            id           = canonicalKey;
        } else if (assignedIdentity) {
            canonicalKey = buildCanonicalAdrKey({
                forge       : assignedIdentity.forge || 'github.com',
                repositoryId: assignedIdentity.repositoryId,
                namespace   : assignedIdentity.namespace,
                number      : adrNumber
            });
            id = canonicalKey;
        }

        const
            {title, rawStatus, status} = extractAdrTitleAndStatus(fileName, content),
            supersedes                 = this.parseSupersedes(content),
            unresolvedReferences       = [],
            edges                      = this.parseEdges(id, content, {...options, unresolvedReferences});

        return {
            adrNumber,
            canonicalKey,
            currentSlug,
            hasAliasesRow           : aliasResult.hasAliasesRow,
            hasCanonicalOpeningTable: aliasResult.hasCanonicalOpeningTable,
            historicalAliases,
            id,
            rawStatus,
            source,
            status,
            supersedes,
            title,
            edges,
            unresolvedReferences
        };
    }

    /**
     * @summary Parses the ADR table's Supersedes cell into a reviewable array.
     * @param {String} content ADR markdown body.
     * @returns {String[]}
     * @protected
     */
    parseSupersedes(content) {
        return parseAdrSupersedes(content);
    }

    #resolveConversationEndpointId(kind, number, qualifiedOrgRepo = null, options = {}) {
        const bareId = `${kind}-${number}`;

        if (qualifiedOrgRepo) {
            if (!FULL_NAMESPACE_REGEX.test(qualifiedOrgRepo)) return null;
            const qualifiedId = qualifyOriginId(qualifiedOrgRepo.split('/').pop(), bareId);
            if (GraphService.db?.nodes) GraphService.db.getAdjacentNodes(qualifiedId, 'both');
            return qualifiedId;
        }

        const
            repository       = options.repository || null,
            assignedIdentity = options.assignedIdentity || null,
            citationOrigin   = options.citationOrigin !== undefined
                ? options.citationOrigin
                : (options.movedCustody ? null : (assignedIdentity || repository));

        if (options.movedCustody && !citationOrigin) {
            if (Array.isArray(options.unresolvedReferences)) {
                options.unresolvedReferences.push({kind, number, raw: `#${number}`, reasonCode: 'MISSING_CITATION_ORIGIN'});
            }
            return null;
        }

        const
            originNamespace = citationOrigin?.namespace || CORPUS_GRAPH_ORIGIN,
            candidateId     = qualifyOriginId(originNamespace.split('/').pop(), bareId);

        if (GraphService.db?.nodes) GraphService.db.getAdjacentNodes(candidateId, 'both');
        return candidateId;
    }

    /**
     * @summary Extracts only the consumer-backed ADR edge taxonomy from deterministic textual anchors.
     * @param {String} adrId Stable ADR node id.
     * @param {String} content ADR markdown body.
     * @param {Object} [options={}] Citation-origin options.
     * @returns {Object[]}
     * @protected
     */
    parseEdges(adrId, content, options = {}) {
        const
            edges     = new Map(),
            cleanBody = stripMarkdownFences(content),
            addEdge   = (source, target, type, properties = {}) => {
                if (source && target) edges.set(`${source}|${target}|${type}`, {source, target, type, properties});
            };

        for (const match of cleanBody.matchAll(ISSUE_LINK_REF_REGEX)) {
            const issueId = this.#resolveConversationEndpointId('issue', match[2], match[1], options);
            if (issueId) {
                addEdge(adrId, issueId, ADR_EDGE_TYPES.GOVERNS);
                addEdge(issueId, adrId, ADR_EDGE_TYPES.CITES_AUTHORITY);
            }
        }

        for (const match of cleanBody.matchAll(PR_LINK_REF_REGEX)) {
            const prId = this.#resolveConversationEndpointId('pr', match[2], match[1], options);
            if (prId) addEdge(prId, adrId, ADR_EDGE_TYPES.IMPLEMENTS_DECISION);
        }

        const proseWithoutRepoLinks = cleanBody.replace(ISSUE_LINK_REF_REGEX, ' ').replace(PR_LINK_REF_REGEX, ' ');

        for (const match of proseWithoutRepoLinks.matchAll(ISSUE_KEYWORD_REF_REGEX)) {
            const issueId = this.#resolveConversationEndpointId('issue', match[2] || match[3], match[1] || null, options);
            if (issueId) {
                addEdge(adrId, issueId, ADR_EDGE_TYPES.GOVERNS);
                addEdge(issueId, adrId, ADR_EDGE_TYPES.CITES_AUTHORITY);
            }
        }

        for (const match of proseWithoutRepoLinks.matchAll(PR_KEYWORD_REF_REGEX)) {
            const prId = this.#resolveConversationEndpointId('pr', match[2] || match[3], match[1] || null, options);
            if (prId) addEdge(prId, adrId, ADR_EDGE_TYPES.IMPLEMENTS_DECISION);
        }

        for (const match of cleanBody.matchAll(SESSION_REF_REGEX)) {
            addEdge(adrId, `session:${match[1]}`, ADR_EDGE_TYPES.GRADUATED_FROM);
        }

        for (const match of cleanBody.matchAll(CONCEPT_REF_REGEX)) {
            addEdge(adrId, canonicalizeConceptId(match[1]) || match[1], ADR_EDGE_TYPES.CODIFIES_CONCEPT);
        }

        return Array.from(edges.values());
    }

    /**
     * @summary Checks whether a candidate graph endpoint ID is an admitted `ADR` in the catalog or
     * persisted graph with `adrAuthority.admitted === true`.
     * @param {String} id
     * @returns {Boolean}
     */
    isAdmittedAdrEndpoint(id) {
        if (typeof id !== 'string' || !id) return false;
        this.rehydrateCatalogFromGraph();
        if (this.admissionCatalog.has(id)) return true;

        for (const record of this.admissionCatalog.values()) {
            if (record.aliasBindings?.some(b =>
                `${b.namespace}#adr:${b.value}` === id ||
                `${b.forge}/${b.namespace}#adr:${b.value}` === id ||
                (b.kind === 'legacy-number' && (`${b.namespace}#adr-${b.value}` === id || `${b.forge}/${b.namespace}#adr-${b.value}` === id))
            )) {
                return true;
            }
        }

        if (GraphService.db?.nodes) {
            GraphService.db.getAdjacentNodes(id, 'both');
            const existing = GraphService.db.nodes.get(id);
            if (existing) {
                const
                    label = existing.isRecord ? existing.get('label') : existing.label,
                    props = existing.isRecord ? existing.get('properties') : existing.properties;
                if (label === 'ADR' && props?.adrAuthority?.admitted === true) return true;
            }
        }

        return false;
    }

    /**
     * @summary Derives canonical graph endpoint typing (`ADR`, `ISSUE`, `PULL_REQUEST`, `DISCUSSION`,
     * `SESSION`, `CONCEPT`) from admitted authority and conversation-origin grammar.
     * @param {String} id Candidate endpoint id.
     * @returns {String|null}
     */
    resolveEndpointType(id) {
        if (typeof id !== 'string' || !id) return null;

        if (GraphService.db?.nodes) {
            GraphService.db.getAdjacentNodes(id, 'both');
            const existing = GraphService.db.nodes.get(id);
            if (existing) return existing.isRecord ? existing.get('label') : existing.label;
        }

        if (this.isAdmittedAdrEndpoint(id))    return 'ADR';
        if (ADR_SHAPED_ID_REGEX.test(id))      return null;
        if (QUALIFIED_ISSUE_NODE_REX.test(id)) return 'ISSUE';
        if (QUALIFIED_PR_NODE_REX.test(id))    return 'PULL_REQUEST';
        if (QUALIFIED_DISC_NODE_REX.test(id))  return 'DISCUSSION';
        if (SESSION_NODE_REGEX.test(id))       return 'SESSION';
        if (/[#/:]/.test(id))                  return null;

        return 'CONCEPT';
    }

    ensureEdgeEndpointsExist(edges) {
        const validEdges = [];
        for (const edge of edges) {
            if (this.ensureNodeExists(edge.source) && this.ensureNodeExists(edge.target)) {
                validEdges.push(edge);
            }
        }
        return validEdges;
    }

    ensureNodeExists(id) {
        GraphService.db.getAdjacentNodes(id, 'both');
        const existing = GraphService.db.nodes.get(id);
        if (existing) return existing;

        const type = this.resolveEndpointType(id);
        if (!type) return null;

        GraphService.upsertNode({id, type, name: id, properties: {isAdrEdgeStub: true}});
        return GraphService.db.nodes.get(id);
    }

    replaceAdrEdges(adrId, edges) {
        const
            db            = GraphService.db,
            adrEdgeTypes  = new Set(Object.values(ADR_EDGE_TYPES)),
            edgesToRemove = db.edges.items.slice().filter(edge =>
                adrEdgeTypes.has(edge.type) && (edge.source === adrId || edge.target === adrId)
            );

        if (edgesToRemove.length > 0) db.edges.remove(edgesToRemove);

        const validEdges = this.ensureEdgeEndpointsExist(edges);
        for (const edge of validEdges) db.addEdge(edge);
        return validEdges.length;
    }

    /**
     * @summary Inventories every graph node that references `vectorId` as its `semanticVectorId`.
     * @param {String} vectorId
     * @returns {Array<{nodeId: String, label: String, isAdmittedAdr: Boolean}>}
     */
    inventoryVectorOwners(vectorId) {
        if (typeof vectorId !== 'string' || !vectorId || !GraphService.db?.nodes) return [];
        const owners = new Map();

        for (const node of GraphService.db.nodes.items) {
            const
                nodeId = node.isRecord ? node.get('id') : node.id,
                label  = node.isRecord ? node.get('label') : node.label,
                props  = (node.isRecord ? node.get('properties') : node.properties) || {};

            if (props.semanticVectorId === vectorId) {
                owners.set(nodeId, {nodeId, label, isAdmittedAdr: label === 'ADR' && props.adrAuthority?.admitted === true});
            }
        }

        const sqlite = GraphService.db.storage?.db;
        if (sqlite) {
            try {
                const rows = sqlite.prepare(`
                    SELECT id, json_extract(data, '$.label') AS label, data
                    FROM Nodes WHERE json_extract(data, '$.properties.semanticVectorId') = ?
                `).all(vectorId);
                for (const row of rows) {
                    if (!owners.has(row.id)) {
                        let parsed = {};
                        try { parsed = JSON.parse(row.data); } catch {}
                        const label = row.label || parsed.label || 'NODE';
                        owners.set(row.id, {
                            nodeId       : row.id,
                            label,
                            isAdmittedAdr: label === 'ADR' && parsed.properties?.adrAuthority?.admitted === true
                        });
                    }
                }
            } catch {}
        }

        return Array.from(owners.values());
    }

    /**
     * @summary Resolves a human or machine ADR citation against the admitted catalog using evidenced
     * citation context, forge-adapter repository identity lookup, rename/reuse conflict rules, and
     * reader authorization.
     * @param {String} reference Raw citation string.
     * @param {Object} [context={}] Citation context and reader authorization options.
     * @returns {Object}
     */
    resolveAdrReference(reference, context = {}) {
        this.rehydrateCatalogFromGraph();
        return resolveSharedAdrReference(reference, context);
    }

    /**
     * @summary Reconstructs or reconciles an ADR record when declared sources are lost or when
     * rebuilding projections from source plus retained admission evidence.
     * @param {Object} [params={}]
     * @returns {Object}
     */
    reconcileSourceAndEvidence({retainedRecord = null, survivingSource = null} = {}) {
        if (!retainedRecord || !retainedRecord.canonicalKey || !retainedRecord.assignmentEvidence?.repositoryId) {
            throw createCodedError(
                'ADR_ADMISSION_EVIDENCE_MISSING',
                'Cannot reconstruct ADR authority without retained assignment and scope admission evidence.'
            );
        }

        if (!survivingSource || !survivingSource.content) {
            const staleRecord = {...retainedRecord, stale: true, documentAvailable: false, kbAvailable: false};
            this.admissionCatalog.set(staleRecord.canonicalKey, staleRecord);

            const existingNode = GraphService.db?.nodes?.get(staleRecord.canonicalKey);
            if (existingNode) {
                const props = (existingNode.isRecord ? existingNode.get('properties') : existingNode.properties) || {};
                GraphService.upsertNode({
                    id        : staleRecord.canonicalKey,
                    type      : 'ADR',
                    name      : props.title || staleRecord.title,
                    properties: {
                        ...props,
                        stale             : true,
                        documentAvailable : false,
                        adrAdmissionRecord: staleRecord,
                        adrAuthority      : {
                            ...(props.adrAuthority || {}),
                            admitted         : true,
                            canonicalKey     : staleRecord.canonicalKey,
                            stale            : true,
                            documentAvailable: false
                        }
                    }
                });
            }

            return {
                status           : 'retained-stale',
                canonicalKey     : staleRecord.canonicalKey,
                identityResolved : true,
                documentAvailable: false,
                kbAvailable      : false,
                stale            : true,
                record           : staleRecord
            };
        }

        return {
            status           : 'available',
            canonicalKey     : retainedRecord.canonicalKey,
            identityResolved : true,
            documentAvailable: true,
            kbAvailable      : true,
            stale            : false,
            record           : retainedRecord
        };
    }

    #resolveCandidateIdentity(params) {
        return resolveAdrCandidateIdentity({
            ...params,
            admissionCatalog: this.admissionCatalog,
            onRegisterRepo  : repo => this.registerForgeRepository(repo)
        });
    }

    /**
     * @summary Scans local ADR markdown files (or a multi-repository `sources` batch),
     * rehydrates persisted admission records from the graph, validates canonical keys and
     * opening-table `Aliases` history, enforces batch and owner conflict refusal, upserts `ADR`
     * nodes without stealing shared summary vectors, and refreshes the deterministic ADR edge taxonomy.
     * @param {Object} [options={}]
     * @returns {Promise<Object>}
     */
    async syncAdrsToGraph(options = {}) {
        const {
            decisionsDir          = 'learn/agentos/decisions',
            sourceRoot            = process.cwd(),
            repository            = null,
            sources               = null,
            custodyTransitions    = [],
            sourceLineageEvidence = [],
            legacyManifest        = null
        } = options;

        this.rehydrateCatalogFromGraph();

        const stats = {
            adrsProcessed         : 0,
            adrsUpserted          : 0,
            adrsSkipped           : 0,
            edgesReplaced         : 0,
            refused               : [],
            preservedSharedVectors: [],
            staleRecords          : [],
            errors                : []
        };

        try {
            const
                sourceSpecs          = Array.isArray(sources) && sources.length > 0 ? sources : [{decisionsDir, sourceRoot, repository}],
                candidates           = [],
                scannedRepoScopes    = [],
                seenKeysInScanByRepo = new Map();

            for (const spec of sourceSpecs) {
                const
                    specRootDir      = path.resolve(spec.sourceRoot || sourceRoot),
                    specDecisionsDir = path.resolve(specRootDir, spec.decisionsDir || 'learn/agentos/decisions'),
                    specRepo         = spec.repository || null;

                if (specRepo) {
                    try {
                        validateAdrIdentityFields({
                            forge       : specRepo.forge || 'github.com',
                            repositoryId: specRepo.repositoryId,
                            namespace   : specRepo.namespace,
                            number      : '0001'
                        });
                    } catch (e) {
                        stats.errors.push(`[repository] ${e.message}`);
                        stats.refused.push({code: e.code || 'ADR_INVALID_IDENTITY_FIELD', message: e.message});
                        continue;
                    }

                    const repoScopeKey = `${specRepo.forge || 'github.com'}:${specRepo.repositoryId}`;
                    scannedRepoScopes.push({forge: specRepo.forge || 'github.com', repositoryId: specRepo.repositoryId, namespace: specRepo.namespace, repoScopeKey});
                    if (!seenKeysInScanByRepo.has(repoScopeKey)) seenKeysInScanByRepo.set(repoScopeKey, new Set());
                }

                if (!fs.existsSync(specDecisionsDir)) {
                    stats.errors.push(`[input] ADR directory not found: ${specDecisionsDir}`);
                    continue;
                }

                const files = (await fs.promises.readdir(specDecisionsDir)).filter(file => ADR_FILE_REGEX.test(file)).sort();

                for (const file of files) {
                    const
                        filePath = path.join(specDecisionsDir, file),
                        content  = await fs.promises.readFile(filePath, 'utf8');

                    if (isAdrRedirect(content)) continue;
                    stats.adrsProcessed++;

                    try {
                        const
                            relSource         = path.relative(specRootDir, filePath),
                            {adrNumber, slug} = parseAdrFilename(file),
                            aliasInfo         = parseAdrOpeningAliases(content),
                            identityInfo      = this.#resolveCandidateIdentity({
                                adrNumber,
                                currentSlug       : slug,
                                historicalAliases : aliasInfo.aliases,
                                sourceRepo        : specRepo,
                                custodyTransitions: spec.custodyTransitions || custodyTransitions,
                                legacyManifest    : spec.legacyManifest || legacyManifest
                            }),
                            adr = this.parseAdr(file, content, relSource, {
                                canonicalKey    : specRepo ? identityInfo.canonicalKey : null,
                                assignedIdentity: identityInfo.assignedIdentity,
                                repository      : specRepo,
                                citationOrigin  : spec.citationOrigin !== undefined ? spec.citationOrigin : specRepo?.citationOrigin,
                                movedCustody    : Boolean(spec.movedCustody ?? specRepo?.movedCustody ?? identityInfo.isCustodyMove)
                            });

                        candidates.push({file, filePath, content, relSource, specRepo, adr, identityInfo});
                    } catch (e) {
                        stats.errors.push(`[${file}] ${e.message}`);
                        stats.refused.push({file, code: e.code || 'ADR_PARSE_ERROR', message: e.message});
                        logger.warn(`[AdrIngestor] Failed to parse ADR '${file}': ${e.message}`);
                    }
                }
            }

            const
                refusedCandidates = new Set(),
                refuseCandidate   = (cand, code, message) => {
                    if (refusedCandidates.has(cand)) return;
                    refusedCandidates.add(cand);
                    stats.errors.push(`[${cand.file}] ${message}`);
                    stats.refused.push({file: cand.file, canonicalKey: cand.adr.canonicalKey, code, message});
                    logger.warn(`[AdrIngestor] Refused ADR '${cand.file}' (${code}): ${message}`);
                };

            evaluateAdrCandidateConflicts({
                candidates,
                admissionCatalog       : this.admissionCatalog,
                ensureReservationBucket: (f, r) => this.#ensureReservationBucket(f, r),
                sourceLineageEvidence,
                legacyManifest,
                refusedCandidates,
                refuseCandidate
            });

            const nodesCollection = StorageRouter ? await StorageRouter.getGraphCollection() : null;

            for (const cand of candidates) {
                if (refusedCandidates.has(cand)) continue;

                try {
                    const
                        {content, specRepo, adr, identityInfo} = cand,
                        existingRecord                         = identityInfo.existingRecord,
                        payloadHash                            = this.computePayloadHash(adr),
                        existingNode                           = GraphService.db.nodes.get(adr.id),
                        docText                                = `${adr.title}\n\n${content}`,
                        contentHash                            = crypto.createHash('md5').update(docText).digest('hex');

                    if (specRepo) {
                        seenKeysInScanByRepo.get(`${specRepo.forge || 'github.com'}:${specRepo.repositoryId}`)?.add(adr.canonicalKey);
                    }

                    const prevVectorId = existingNode?.properties?.semanticVectorId;
                    if (prevVectorId && prevVectorId !== adr.id) {
                        const nonAdrOwners = this.inventoryVectorOwners(prevVectorId).filter(o => o.nodeId !== adr.id);
                        if (nonAdrOwners.length > 0 || prevVectorId.startsWith('summary_')) {
                            stats.preservedSharedVectors.push({
                                adrId         : adr.id,
                                sharedVectorId: prevVectorId,
                                retainedOwners: nonAdrOwners.map(o => o.nodeId)
                            });
                        }
                    }

                    let embedCurrent = false;
                    if (nodesCollection) {
                        try {
                            const existing = await nodesCollection.get({ids: [adr.id], include: ['metadatas']});
                            embedCurrent = existing?.ids?.length > 0 && (existing.metadatas[0] || {}).hash === contentHash;
                        } catch (e) {
                            logger.warn(`[AdrIngestor] graph-collection GET failed for ${adr.id}: ${e.message}`);
                        }
                    }

                    const
                        forge        = specRepo?.forge || identityInfo.assignedIdentity?.forge || 'github.com',
                        sourceRepoId = specRepo?.repositoryId || null,
                        sourceNs     = specRepo?.namespace || null,
                        record       = buildAdmittedAdrRecord({existingRecord, adr, identityInfo, specRepo, payloadHash, contentHash});

                    if (specRepo) {
                        const bucket = this.#ensureReservationBucket(forge, sourceRepoId);
                        bucket.numbers.add(adr.adrNumber);

                        for (const b of record.aliasBindings) {
                            if (b.kind === 'slug' && b.forge === forge && b.repositoryId === sourceRepoId) {
                                b.current = (b.value === adr.currentSlug && b.namespace.toLowerCase() === sourceNs.toLowerCase());
                            }
                        }

                        this.#addAliasBinding(record, bucket, {kind: 'slug', value: adr.currentSlug, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: true});
                        this.#addAliasBinding(record, bucket, {kind: 'legacy-number', value: adr.adrNumber, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: true});

                        for (const histSlug of adr.historicalAliases) {
                            const alreadyAdmitted = record.aliasBindings.some(b => b.kind === 'slug' && b.value === histSlug);
                            if (!alreadyAdmitted && !identityInfo.isCustodyMove) {
                                this.#addAliasBinding(record, bucket, {kind: 'slug', value: histSlug, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: false});
                            }
                        }

                        if (record.assignmentEvidence?.repositoryId && record.assignmentEvidence.repositoryId !== sourceRepoId) {
                            this.#ensureReservationBucket(record.assignmentEvidence.forge || forge, record.assignmentEvidence.repositoryId).numbers.add(adr.adrNumber);
                        }
                    } else {
                        this.#addAliasBinding(record, null, {kind: 'slug', value: adr.currentSlug, forge: 'github.com', repositoryId: null, namespace: CORPUS_GRAPH_ORIGIN, targetKey: adr.canonicalKey, current: true});
                        this.#addAliasBinding(record, null, {kind: 'legacy-number', value: adr.adrNumber, forge: 'github.com', repositoryId: null, namespace: CORPUS_GRAPH_ORIGIN, targetKey: adr.canonicalKey, current: true});
                    }

                    this.admissionCatalog.set(adr.canonicalKey, record);

                    const
                        existingLabel   = existingNode ? (existingNode.isRecord ? existingNode.get('label') : existingNode.label) : null,
                        sourceUnchanged = existingNode?.properties?.payloadHash === payloadHash &&
                                           existingNode?.properties?.source === adr.source &&
                                           existingLabel === 'ADR' &&
                                           existingNode?.properties?.semanticVectorId === adr.id &&
                                           existingNode?.properties?.stale !== true;

                    if (sourceUnchanged && (embedCurrent || !nodesCollection)) {
                        stats.adrsSkipped++;
                        continue;
                    }

                    const renameVerified = Boolean(
                        existingRecord &&
                        (!specRepo || existingRecord.sourceTuple?.repositoryId === specRepo.repositoryId) &&
                        existingRecord.sourceTuple?.path !== adr.source
                    );

                    GraphService.upsertNode({
                        id        : adr.id,
                        type      : 'ADR',
                        name      : adr.title,
                        properties: {
                            adrAdmissionRecord: record,
                            adrAuthority      : {
                                admitted                 : true,
                                adrNumber                : adr.adrNumber,
                                canonicalKey             : adr.canonicalKey,
                                custodyTransitionVerified: Boolean(identityInfo.custodyTransitionVerified),
                                documentAvailable        : true,
                                forge                    : specRepo?.forge || null,
                                namespace                : specRepo?.namespace || null,
                                renameVerified,
                                repositoryId             : specRepo?.repositoryId || null,
                                revision                 : specRepo?.revision || null,
                                semanticVectorId         : adr.id,
                                source                   : adr.source,
                                sourceHash               : payloadHash,
                                stale                    : false
                            },
                            adrNumber        : adr.adrNumber,
                            adrNumberValue   : Number(adr.adrNumber),
                            canonicalKey     : adr.canonicalKey,
                            currentSlug      : adr.currentSlug,
                            documentAvailable: true,
                            historicalAliases: adr.historicalAliases,
                            payloadHash,
                            rawStatus        : adr.rawStatus,
                            semanticVectorId : adr.id,
                            source           : adr.source,
                            stale            : false,
                            status           : adr.status,
                            supersedes       : adr.supersedes,
                            title            : adr.title
                        }
                    });

                    if (nodesCollection && !embedCurrent) {
                        await nodesCollection.upsert({
                            ids      : [adr.id],
                            documents: [docText],
                            metadatas: [{canonicalKey: adr.canonicalKey, hash: contentHash, title: adr.title, type: 'ADR'}]
                        });
                    }

                    stats.adrsUpserted++;
                    stats.edgesReplaced += this.replaceAdrEdges(adr.id, adr.edges);
                } catch (e) {
                    stats.errors.push(`[${cand.file}] ${e.message}`);
                    logger.warn(`[AdrIngestor] Failed to ingest ADR '${cand.file}': ${e.message}`);
                }
            }

            for (const scope of scannedRepoScopes) {
                const seenKeys = seenKeysInScanByRepo.get(scope.repoScopeKey) || new Set();
                for (const record of this.admissionCatalog.values()) {
                    if (record.sourceTuple?.forge === scope.forge &&
                        record.sourceTuple?.repositoryId === scope.repositoryId &&
                        !seenKeys.has(record.canonicalKey)) {
                        if (Array.from(refusedCandidates).some(c => c.adr.canonicalKey === record.canonicalKey)) continue;
                        this.reconcileSourceAndEvidence({retainedRecord: record, survivingSource: null});
                        stats.staleRecords.push(record.canonicalKey);
                    }
                }
            }

            logger.info(`[AdrIngestor] Sync complete: ${stats.adrsUpserted} upserted, ${stats.adrsSkipped} unchanged, ${stats.edgesReplaced} edges${stats.errors.length > 0 ? `, ${stats.errors.length} errors` : ''}.`);
        } catch (e) {
            logger.error('[AdrIngestor] Fatal sync error:', e);
            stats.errors.push(`[fatal] ${e.message}`);
        }

        return stats;
    }
}

export default Neo.setupClass(AdrIngestor);
