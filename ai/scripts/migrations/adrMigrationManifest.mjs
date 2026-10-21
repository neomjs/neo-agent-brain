import {buildCanonicalAdrKey} from '../../services/shared/adrIdentityCodec.mjs';

/**
 * @module ai/scripts/migrations/adrMigrationManifest
 * @summary Reviewed 41-record legacy ADR identity migration manifest, observed vector/node/edge
 * census state, shared summary-vector owner inventory, and operator migration/recovery runbook.
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §§2.6–2.10
 */

export const MIGRATION_MANIFEST_VERSION = '1.0.0';

const NS_MAP = {B: 'neomjs/neo-agent-brain', N: 'neomjs/neo', I: 'neomjs/neo-agent-institution'};

/**
 * Source cut revisions and repository bindings for the multi-repository ADR migration.
 */
export const MIGRATION_CUT_REPOSITORIES = Object.freeze({
    'neomjs/neo': Object.freeze({
        forge      : 'github.com', repositoryId: '220867748', namespace: 'neomjs/neo',
        cutRevision: '33074574', territoryRoot: 'learn/agentos/decisions', visibility: 'public'
    }),
    'neomjs/neo-agent-brain': Object.freeze({
        forge      : 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain',
        cutRevision: '3443a409', territoryRoot: 'learn/agentos/decisions', visibility: 'public'
    }),
    'neomjs/neo-agent-institution': Object.freeze({
        forge      : 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution',
        cutRevision: '477718f9', territoryRoot: 'learn/agentos/decisions', visibility: 'public'
    }),
    'neomjs/neo-stage': Object.freeze({
        forge      : 'github.com', repositoryId: '1413810081', namespace: 'neomjs/neo-stage',
        cutRevision: 'ca26ffd9', territoryRoot: 'learn/agentos/decisions', visibility: 'private',
        probeRecord: Object.freeze({
            adrNumber   : '0001', currentSlug: 'the-engine-contract', fileName: '0001-the-engine-contract.md',
            sourcePath  : 'learn/agentos/decisions/0001-the-engine-contract.md', contentHash: '4a580037288a',
            canonicalKey: buildCanonicalAdrKey({
                forge: 'github.com', repositoryId: '1413810081', namespace: 'neomjs/neo-stage', number: '0001'
            }),
            authorizedReaderContext: Object.freeze({
                agentIdentity          : '@neo-migration-verifier', authorizedNamespaces: Object.freeze(['neomjs/neo-stage']),
                authorizedRepositoryIds: Object.freeze(['1413810081']), authorizedRepositories: Object.freeze(['neomjs/neo-stage']), allowPrivate: true
            }),
            unauthorizedReaderContext: Object.freeze({
                agentIdentity          : '@neo-public-reader', authorizedNamespaces: Object.freeze([]),
                authorizedRepositoryIds: Object.freeze([]), authorizedRepositories: Object.freeze([]), allowPrivate: false
            })
        })
    })
});

export const OBSERVED_11_CENSUS_ANOMALY_NUMBERS = Object.freeze(['0004', '0020', '0024', '0026', '0027', '0028', '0029', '0031', '0032', '0034', '0038']);
export const OBSERVED_LIVE_ANOMALY_NUMBERS      = Object.freeze([...OBSERVED_11_CENSUS_ANOMALY_NUMBERS, '0019']);
export const MOVED_FM_ADR_NUMBERS               = Object.freeze(['0020', '0032', '0034', '0037', '0038']);

// Compact 41-row table: [num, slug, title, nsCode, hash, label, edges, vecId, owners, refs, redirHash, disposition]
const RAW_41_ROWS = [
    ['0001', 'cross-process-cache-coherence', 'Cross-Process Cache Coherence', 'B', '20222e2aebd8', 'ADR', 7, null, [], ['ISSUE:neomjs/neo#10447']],
    ['0002', 'phase3-wake-substrate-standards-alignment', 'Phase-3 Wake Substrate Standards Alignment', 'B', '5269cc2e8cbd', 'ADR', 5],
    ['0003', 'chroma-topology-unified-only', 'Chroma Topology Unified-Only', 'B', '4147bd73a58f', 'ADR', 2],
    ['0004', 'github-content-architecture', 'GitHub Content Architecture', 'N', 'a5b909852c7d', 'CONCEPT', 19, 'summary_045f8864-a82d-46c5-851b-f61cab59f15b', ['summary_045f8864-a82d-46c5-851b-f61cab59f15b|SESSION_SUMMARY', 'session:audit_15453|SESSION', 'ISSUE:15452|ISSUE', 'EPIC:15435|STRATEGY'], ['ISSUE:neomjs/neo#15452']],
    ['0005', 'adr-at-graduation-for-ideation-sandbox', 'ADR at Graduation for Ideation Sandbox', 'B', '26ff1cb97e2f', 'ADR', 14],
    ['0006', 'adrs-as-graph-queryable-entities', 'ADRs as Graph-Queryable Entities', 'B', '940e4a0b7f36', 'ADR', 24, null, [], ['ISSUE:neomjs/neo#11377', 'PULL_REQUEST:neomjs/neo#11380']],
    ['0007', 'agents-md-compaction-taxonomy', 'AGENTS.md Compaction Taxonomy', 'N', '80bc75be5a25', 'ADR', 6, null, [], ['ISSUE:neomjs/neo#11420']],
    ['0008', 'skill-anatomy-and-authoring-contract', 'Skill Anatomy and Authoring Contract', 'N', '1417ad8786db', 'ADR', 0],
    ['0009', 'cross-daemon-lease-inheritance', 'Cross-Daemon Lease Inheritance', 'B', '6297439c77fe', 'ADR', 5],
    ['0010', 'lane-intent-coordination-primitive', 'Lane-Intent Coordination Primitive', 'B', '39d06e29bcb3', 'ADR', 5],
    ['0011', 'substrate-numbering-convention', 'Substrate Numbering Convention', 'B', 'f2ef0f9632cf', 'ADR', 19],
    ['0012', 'model-stats-framework', 'Model Stats Framework', 'B', '2efdc5231a90', 'ADR', 10],
    ['0013', 'kb-ingestion-telemetry-schema', 'KB Ingestion Telemetry Schema', 'B', 'd7f5d805e7de', 'ADR', 1],
    ['0014', 'cloud-deployment-topology-and-scheduler-task-taxonomy', 'Cloud Deployment Topology and Scheduler Task Taxonomy', 'B', 'f404ed672b06', 'ADR', 27],
    ['0015', 'graph-store-backend-posture', 'Graph Store Backend Posture', 'B', 'b4d3a0758f8f', 'ADR', 4],
    ['0016', 'ai-script-cli-parser-convention', 'AI Script CLI Parser Convention', 'B', 'a4cda306e393', 'ADR', 6],
    ['0017', 'chroma-single-flat-unified-store', 'Chroma Single Flat Unified Store', 'B', '93edfb084617', 'ADR', 4],
    ['0018', 'neo-identity-source-of-truth-model', 'Neo Identity Source of Truth Model', 'N', '18acf3d3e8ad', 'ADR', 9],
    ['0019', 'aiconfig-reactive-provider-ssot', 'AiConfig Reactive Provider SSOT', 'B', 'd0c12523481a', 'CONCEPT', 222, 'summary_28bfbdc1-3d2b-4b29-bfb3-5267a07ad2cb', ['summary_28bfbdc1-3d2b-4b29-bfb3-5267a07ad2cb|SESSION_SUMMARY', 'session:antigravity_diagnostic|SESSION', 'config-provider|CONCEPT']],
    ['0020', 'agent-harness-concept', 'Agent Harness Concept', 'I', '395b931a91a0', 'CONCEPT', 9, 'summary_0eb6a198-3612-4b0b-9c9e-75e7618faf1d', ['summary_0eb6a198-3612-4b0b-9c9e-75e7618faf1d|SESSION_SUMMARY', 'CLASS:Neo.identityRoots|CLASS', 'session:ada_fable_v13|SESSION'], ['ISSUE:neomjs/neo#19015'], 'ebed776c976f'],
    ['0021', 'extended-nl-multi-writer-write-enforcement', 'Extended NL Multi-Writer Write Enforcement', 'N', 'cda2bc31299e', 'ADR', 2],
    ['0022', 'heavy-maintenance-scheduling-fairness', 'Heavy Maintenance Scheduling Fairness', 'B', '0048cddaf383', 'ADR', 2],
    ['0023', 'dreamservice-organism-map-fidelity-consolidation-liveness', 'DreamService Organism Map Fidelity Consolidation Liveness', 'B', '4dcf404d40da', 'ADR', 4],
    ['0024', 'native-edge-graph-model', 'Native Edge Graph Model', 'B', '6a0dd9693b2c', 'CLASS', 8, 'summary_6ce9ff05-0291-430d-bac4-73b60a2d7789', ['summary_6ce9ff05-0291-430d-bac4-73b60a2d7789|SESSION_SUMMARY', 'METHOD:withHeavyMaintenanceLease|METHOD', 'ISSUE:13765|ISSUE'], ['ISSUE:neomjs/neo#13765']],
    ['0025', 'orchestrator-container-health-self-healing', 'Orchestrator Container Health Self-Healing', 'B', '5f3466df06a6', 'ADR', 9],
    ['0026', 'recovery-actuator', 'Recovery Actuator', 'B', '3e5c3751fdf4', 'CONCEPT', 22, 'summary_37500317-3b4d-4d1c-ab76-ef5c9925f720', ['summary_37500317-3b4d-4d1c-ab76-ef5c9925f720|SESSION_SUMMARY', 'reconfigure-service|CLASS', 'memory:session_analysis|SESSION'], ['ISSUE:neomjs/neo#16374']],
    ['0027', 'autonomous-data-recovery-actuator', 'Autonomous Data Recovery Actuator', 'B', 'dddc13dfa147', 'CONCEPT', 13, 'summary_9fcbc1c9-0d44-4c1e-af9a-e533583305a6', ['summary_9fcbc1c9-0d44-4c1e-af9a-e533583305a6|SESSION_SUMMARY', 'ac5-logic|CONCEPT']],
    ['0028', 'temporal-pyramid-summarization-substrate', 'Temporal Pyramid Summarization Substrate', 'B', 'a09b60e3634b', 'CONCEPT', 7, 'summary_838a9731-405d-4f5f-b051-e944f9950a19', ['ISSUE:15088|ISSUE', 'EPIC:12679|STRATEGY', 'adr-relationship|CONCEPT', 'session:audit_15088|SESSION'], ['ISSUE:neomjs/neo#15088']],
    ['0029', 'docking-design', 'Docking Design', 'N', '9b0185792b19', 'CONCEPT', 50, 'summary_771833a0-8bd1-4520-8e2c-138d82c15a53', ['summary_771833a0-8bd1-4520-8e2c-138d82c15a53|SESSION_SUMMARY', 'container-mjs|CLASS', 'vessel-container-mjs|CLASS']],
    ['0030', 'work-graph-stall-inference', 'Work Graph Stall Inference', 'B', '5f42741132b6', 'ADR', 5],
    ['0031', 'target-architecture-composition', 'Target Architecture Composition', 'N', '35ebf04ac30b', 'CONCEPT', 7, 'summary_5b83bd4a-3c7a-4063-be83-a9549ec83937', ['ISSUE:14362|ISSUE', 'session:audit_17507|SESSION', 'harness-wire-strings|CONCEPT', 'ISSUE:17503|ISSUE'], ['ISSUE:neomjs/neo#17503']],
    ['0032', 'institution-cockpit-render-model', 'Institution Cockpit Render Model', 'I', '1c967cbe183f', 'CONCEPT', 5, 'summary_011986c4-3bf2-41c2-a4c1-d48019d1a0f3', ['model-stats|CONCEPT', 'ISSUE:15421|ISSUE', 'session:audit_pr_15425|SESSION', 'GUIDE:ADR_0032|CONCEPT', 'session:audit_15425|SESSION'], ['ISSUE:neomjs/neo#15421'], '15b43d769e0e'],
    ['0033', 'direction-contract', 'Direction Contract', 'B', '1f18fc42cf95', 'ADR', 3],
    ['0034', 'electron-shell-architecture', 'Electron Shell Architecture', 'I', 'd42c0ab0c3e6', 'CLASS', 51, 'summary_2ef4256d-e5c9-4c1c-8193-c39a5c1088a7', ['chroma-manager|CLASS', 'seat-survival|CONCEPT', 'summary_2ef4256d-e5c9-4c1c-8193-c39a5c1088a7|SESSION_SUMMARY', 'session:brain_handoff_analysis|SESSION'], [], 'c815d7c23665', 'retain-landed-amendment'],
    ['0035', 'live-lane-awareness-composition', 'Live Lane Awareness Composition', 'B', '2dd51fdb2f99', 'ADR', 19],
    ['0036', 'durable-community-activity-authority', 'Durable Community Activity Authority', 'B', 'c00897878d1d', 'ADR', 25],
    ['0037', 'fleet-manager-outward-door-topology', 'Fleet Manager Outward Door Topology', 'I', 'b0345296b937', 'ADR', 13, null, [], [], 'face6cac3cf3', 'pending'],
    ['0038', 'fm-client-topology', 'FM Client Topology', 'I', '512a008dc43b', 'CONCEPT', 11, 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b', ['session:neo_recovery|SESSION', 'vessel-workspace|CLASS', 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b|SESSION_SUMMARY', 'workstation-reclaim-embodiment|CLASS', 'TASK:PR_19722|ARTIFACT_TASK'], ['PULL_REQUEST:neomjs/neo#19722'], '4fcfd997b36f', 'retain-landed-amendment'],
    ['0039', 'two-plane-sdk-barrel-boundary', 'Two-Plane SDK Barrel Boundary', 'B', '991b04b5d9f3', 'ADR', 2],
    ['0040', 'agentos-extraction-topology', 'AgentOS Extraction Topology', 'B', 'f502532b83af', 'ADR', 31],
    ['0041', 'bootstrap-record-verified-plane-handoff', 'Bootstrap Record Verified Plane Handoff', 'B', '8373ac1edd99', 'ADR', 5, null, [], ['PULL_REQUEST:neomjs/neo-agent-brain#680', 'ISSUE:neomjs/neo-agent-brain#678', 'DISCUSSION:neomjs/neo#18965', 'ISSUE:neomjs/neo-agent-institution#351']]
];

/**
 * @summary Expands a compact tuple row into a frozen reviewed manifest entry.
 * @param {Array} tuple
 * @returns {Object}
 * @private
 */
function buildReviewedManifestEntry([
    adrNumber, currentSlug, title, nsCode, contentHash, nodeLabel = 'ADR',
    edgeCount = 0, vecId = null, ownerSpecs = [], histRefs = [], redirectContentHash = null, semanticDisposition = 'retain'
]) {
    const
        namespace          = NS_MAP[nsCode],
        repoMeta           = MIGRATION_CUT_REPOSITORIES[namespace],
        isCustodyMove      = Boolean(redirectContentHash),
        originMeta         = isCustodyMove ? MIGRATION_CUT_REPOSITORIES['neomjs/neo'] : null,
        legacyId           = `adr-${adrNumber}`,
        vectorId           = vecId || legacyId,
        fileName           = `${adrNumber}-${currentSlug}.md`,
        sourcePath         = `${repoMeta.territoryRoot}/${fileName}`,
        isAnomaly          = nodeLabel !== 'ADR' || vectorId.startsWith('summary_'),
        canonicalKey       = buildCanonicalAdrKey({forge: repoMeta.forge, repositoryId: repoMeta.repositoryId, namespace: repoMeta.namespace, number: adrNumber}),
        originCanonicalKey = originMeta ? buildCanonicalAdrKey({forge: originMeta.forge, repositoryId: originMeta.repositoryId, namespace: originMeta.namespace, number: adrNumber}) : null,
        mkBinding          = (meta, kind, value, current) => Object.freeze({
            kind, value, forge: meta.forge, repositoryId: meta.repositoryId, namespace: meta.namespace, targetKey: canonicalKey, current,
            ...(current ? {} : {historical: true})
        }),
        aliasBindings = [
            mkBinding(repoMeta, 'slug', currentSlug, true),
            mkBinding(repoMeta, 'legacy-number', adrNumber, true),
            ...(originMeta ? [mkBinding(originMeta, 'slug', currentSlug, false), mkBinding(originMeta, 'legacy-number', adrNumber, false)] : [])
        ],
        reservations = [
            Object.freeze({forge: repoMeta.forge, repositoryId: repoMeta.repositoryId, namespace: repoMeta.namespace, adrNumber, reason: 'assigned-custody'}),
            ...(originMeta ? [Object.freeze({forge: originMeta.forge, repositoryId: originMeta.repositoryId, namespace: originMeta.namespace, adrNumber, reason: 'historical-custody-redirect-reservation'})] : [])
        ];

    return Object.freeze({
        adrNumber, legacyId, canonicalKey, originCanonicalKey, title, status: 'Accepted', currentSlug, fileName, sourcePath,
        assignmentEvidence: Object.freeze({
            forge      : repoMeta.forge, repositoryId: repoMeta.repositoryId, namespace: repoMeta.namespace,
            cutRevision: repoMeta.cutRevision, provenance: isCustodyMove ? 'reviewed-manifest-custody-move' : 'reviewed-manifest-assignment', verified: true
        }),
        sourceTuple: Object.freeze({
            forge   : repoMeta.forge, repositoryId: repoMeta.repositoryId, namespace: repoMeta.namespace,
            revision: repoMeta.cutRevision, path: sourcePath, contentHash, payloadHash: `sha256:${contentHash}`
        }),
        custodyTransition: isCustodyMove ? Object.freeze({
            adrNumber, canonicalKey, fromForge: originMeta.forge, fromRepositoryId: originMeta.repositoryId, fromNamespace: originMeta.namespace,
            toForge     : repoMeta.forge, toRepositoryId: repoMeta.repositoryId, toNamespace: repoMeta.namespace,
            redirectPath: `${originMeta.territoryRoot}/${fileName}`, redirectContentHash,
            proof       : `reviewed-manifest-redirect-${adrNumber}-${redirectContentHash}`, verified: true
        }) : null,
        historicalReservationInOrigin: isCustodyMove,
        aliases                      : Object.freeze([currentSlug]),
        historicalAliases            : Object.freeze(isCustodyMove ? [`${originMeta.namespace}#adr:${currentSlug}`, `${originMeta.namespace}#${adrNumber}`, legacyId] : [legacyId]),
        aliasBindings                : Object.freeze(aliasBindings),
        reservations                 : Object.freeze(reservations),
        historicalReferences         : Object.freeze([...histRefs]),
        observedState                : Object.freeze({
            nodeLabel,
            anomalyShape            : !isAnomaly ? 'NONE' : adrNumber === '0038' ? 'SHARED_SUMMARY_VECTOR_WITH_NON_ADR_OWNER' : nodeLabel === 'CLASS' ? 'CLASS_SUMMARY_VECTOR_OVERWRITE' : 'CONCEPT_SUMMARY_VECTOR_OVERWRITE',
            observedSemanticVectorId: vectorId,
            reusedVectorOwners      : Object.freeze(ownerSpecs.map(spec => {
                const [id, label] = spec.split('|');
                return Object.freeze({id, label, nodeId: id, isAdr: label === 'ADR'});
            })),
            observedEdgeCount: edgeCount,
            kbState          : Object.freeze({indexedUnderLegacyId: true, canonicalKeyIndexed: false})
        }),
        semanticDisposition, visibility: repoMeta.visibility, tenantId: null
    });
}

export const REVIEWED_41_ADR_MIGRATION_MANIFEST = Object.freeze(RAW_41_ROWS.map(buildReviewedManifestEntry));

export const ADR_MIGRATION_RUNBOOK = Object.freeze({
    manifestVersion           : MIGRATION_MANIFEST_VERSION,
    manifestRecordCount       : REVIEWED_41_ADR_MIGRATION_MANIFEST.length,
    requiredReaderCapabilities: Object.freeze({
        adrIdentityCodec            : 'ai/services/shared/adrIdentityCodec.mjs',
        adrDocumentParser           : 'ai/services/shared/adrDocumentParser.mjs',
        adrAdmissionCatalog         : 'ai/services/ingestion/adrAdmissionCatalog.mjs',
        adrIngestor                 : 'ai/services/ingestion/AdrIngestor.mjs',
        adrSource                   : 'ai/services/knowledge-base/source/AdrSource.mjs',
        crossProcessAdmissionChannel: 'aiConfig.memoryCoreDbPath'
    }),
    writerCoordination: Object.freeze([
        '1. Quiesce or pause background graph/KB writers (DreamService, SemanticGraphExtractor, AdrIngestor, KB sync) before running --apply.',
        '2. Verify that AdrIngestor and AdrSource reader capabilities are installed in the active checkout.',
        '3. Execute dry-run first: node ai/scripts/migrations/migrateLegacyAdrIdentities.mjs --dry-run --db <sqlite-path>',
        '4. Materialize a pre-apply backup: node ai/scripts/migrations/migrateLegacyAdrIdentities.mjs --backup <backup-file.json> --db <sqlite-path>',
        '5. Execute restartable cross-store apply: node ai/scripts/migrations/migrateLegacyAdrIdentities.mjs --apply --backup <backup-file.json> --db <sqlite-path>',
        '6. If interrupted at any store boundary (graph_sqlite_applied, vector_store_applied, kb_projection_applied, reader_verified), re-run the exact --apply command to resume from AdrIdentityMigrationJournal.',
        '7. To roll back to pre-migration state without harming unrelated consumers: node ai/scripts/migrations/migrateLegacyAdrIdentities.mjs --restore <backup-file.json> --db <sqlite-path>',
        '8. Verify final native Graph + KB readback across canonical keys, historical 0001..0041 short aliases, moved FM records (0020, 0032, 0034, 0037, 0038), and private neo-stage reader authorization.'
    ]),
    postMergeLiveApplyBoundary:
        'Merging this migration script NEVER performs an automatic live cut. Live production apply and native graph/KB readback are post-merge acceptance steps retained on the parent epic until explicitly executed and witnessed by an operator.'
});
