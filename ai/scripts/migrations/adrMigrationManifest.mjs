import {buildCanonicalAdrKey} from '../../services/shared/adrIdentityCodec.mjs';

/**
 * @module ai/scripts/migrations/adrMigrationManifest
 * @summary Reviewed 41-record legacy ADR identity migration manifest, observed vector/node/edge
 * census state, shared summary-vector owner inventory, and operator migration/recovery runbook.
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §§2.6–2.10
 */

export const MIGRATION_MANIFEST_VERSION = '1.0.0';

/**
 * Source cut revisions and repository bindings for the multi-repository ADR migration.
 */
export const MIGRATION_CUT_REPOSITORIES = Object.freeze({
    'neomjs/neo': Object.freeze({
        forge        : 'github.com',
        repositoryId : '220867748',
        namespace    : 'neomjs/neo',
        cutRevision  : '731b70d1',
        territoryRoot: 'learn/agentos/decisions',
        visibility   : 'public'
    }),
    'neomjs/neo-agent-brain': Object.freeze({
        forge        : 'github.com',
        repositoryId : '1344062228',
        namespace    : 'neomjs/neo-agent-brain',
        cutRevision  : 'd628999a',
        territoryRoot: 'learn/agentos/decisions',
        visibility   : 'public'
    }),
    'neomjs/neo-agent-institution': Object.freeze({
        forge        : 'github.com',
        repositoryId : '1347756127',
        namespace    : 'neomjs/neo-agent-institution',
        cutRevision  : 'e5aa4238',
        territoryRoot: 'learn/agentos/decisions',
        visibility   : 'public'
    }),
    'neomjs/neo-stage': Object.freeze({
        forge        : 'github.com',
        repositoryId : '1413810081',
        namespace    : 'neomjs/neo-stage',
        cutRevision  : 'eab1dcca',
        territoryRoot: 'learn/decisions',
        visibility   : 'private'
    })
});

/**
 * The 11 non-ADR legacy IDs observed in the initial live census (`9 CONCEPT` + `2 CLASS`),
 * all carrying summary-vector pointers.
 */
export const OBSERVED_11_CENSUS_ANOMALY_NUMBERS = Object.freeze([
    '0004',
    '0020',
    '0024',
    '0026',
    '0027',
    '0028',
    '0029',
    '0031',
    '0032',
    '0034',
    '0038'
]);

/**
 * Full set of observed live non-ADR legacy IDs including `0019`.
 */
export const OBSERVED_LIVE_ANOMALY_NUMBERS = Object.freeze([
    ...OBSERVED_11_CENSUS_ANOMALY_NUMBERS,
    '0019'
]);

/**
 * The 5 Fleet Manager ADRs whose custody moved from `neomjs/neo` (`220867748`) to
 * `neomjs/neo-agent-institution` (`1347756127`) while reserving their numbers in `neomjs/neo`.
 */
export const MOVED_FM_ADR_NUMBERS = Object.freeze([
    '0020',
    '0032',
    '0034',
    '0037',
    '0038'
]);

const RAW_41_RECORDS = [
    {
        adrNumber   : '0001',
        currentSlug : 'cross-process-cache-coherence',
        title       : 'Cross-Process Cache Coherence',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '20222e2aebd8',
        nodeLabel   : 'ADR',
        edgeCount   : 7,
        vectorId    : 'adr-0001',
        vectorOwners: [],
        histRefs    : ['ISSUE:neomjs/neo#10447']
    },
    {
        adrNumber   : '0002',
        currentSlug : 'phase3-wake-substrate-standards-alignment',
        title       : 'Phase-3 Wake Substrate Standards Alignment',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '5269cc2e8cbd',
        nodeLabel   : 'ADR',
        edgeCount   : 5,
        vectorId    : 'adr-0002',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0003',
        currentSlug : 'chroma-topology-unified-only',
        title       : 'Chroma Topology Unified-Only',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '4147bd73a58f',
        nodeLabel   : 'ADR',
        edgeCount   : 2,
        vectorId    : 'adr-0003',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0004',
        currentSlug : 'github-content-architecture',
        title       : 'GitHub Content Architecture',
        namespace   : 'neomjs/neo',
        contentHash : 'a5b909852c7d',
        nodeLabel   : 'CONCEPT',
        edgeCount   : 19,
        vectorId    : 'summary_045f8864-a82d-46c5-851b-f61cab59f15b',
        vectorOwners: [
            {id: 'summary_045f8864-a82d-46c5-851b-f61cab59f15b', label: 'SESSION_SUMMARY'},
            {id: 'session:audit_15453',                          label: 'SESSION'},
            {id: 'ISSUE:15452',                                  label: 'ISSUE'},
            {id: 'EPIC:15435',                                   label: 'STRATEGY'}
        ],
        histRefs: ['ISSUE:neomjs/neo#15452']
    },
    {
        adrNumber   : '0005',
        currentSlug : 'adr-at-graduation-for-ideation-sandbox',
        title       : 'ADR at Graduation for Ideation Sandbox',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '26ff1cb97e2f',
        nodeLabel   : 'ADR',
        edgeCount   : 14,
        vectorId    : 'adr-0005',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0006',
        currentSlug : 'adrs-as-graph-queryable-entities',
        title       : 'ADRs as Graph-Queryable Entities',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '940e4a0b7f36',
        nodeLabel   : 'ADR',
        edgeCount   : 24,
        vectorId    : 'adr-0006',
        vectorOwners: [],
        histRefs    : ['ISSUE:neomjs/neo#11377', 'PULL_REQUEST:neomjs/neo#11380']
    },
    {
        adrNumber   : '0007',
        currentSlug : 'agents-md-compaction-taxonomy',
        title       : 'AGENTS.md Compaction Taxonomy',
        namespace   : 'neomjs/neo',
        contentHash : '80bc75be5a25',
        nodeLabel   : 'ADR',
        edgeCount   : 6,
        vectorId    : 'adr-0007',
        vectorOwners: [],
        histRefs    : ['ISSUE:neomjs/neo#11420']
    },
    {
        adrNumber   : '0008',
        currentSlug : 'skill-anatomy-and-authoring-contract',
        title       : 'Skill Anatomy and Authoring Contract',
        namespace   : 'neomjs/neo',
        contentHash : '1417ad8786db',
        nodeLabel   : 'ADR',
        edgeCount   : 0,
        vectorId    : 'adr-0008',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0009',
        currentSlug : 'cross-daemon-lease-inheritance',
        title       : 'Cross-Daemon Lease Inheritance',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '6297439c77fe',
        nodeLabel   : 'ADR',
        edgeCount   : 5,
        vectorId    : 'adr-0009',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0010',
        currentSlug : 'lane-intent-coordination-primitive',
        title       : 'Lane-Intent Coordination Primitive',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '39d06e29bcb3',
        nodeLabel   : 'ADR',
        edgeCount   : 5,
        vectorId    : 'adr-0010',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0011',
        currentSlug : 'substrate-numbering-convention',
        title       : 'Substrate Numbering Convention',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'f2ef0f9632cf',
        nodeLabel   : 'ADR',
        edgeCount   : 19,
        vectorId    : 'adr-0011',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0012',
        currentSlug : 'model-stats-framework',
        title       : 'Model Stats Framework',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '2efdc5231a90',
        nodeLabel   : 'ADR',
        edgeCount   : 10,
        vectorId    : 'adr-0012',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0013',
        currentSlug : 'kb-ingestion-telemetry-schema',
        title       : 'KB Ingestion Telemetry Schema',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'd7f5d805e7de',
        nodeLabel   : 'ADR',
        edgeCount   : 1,
        vectorId    : 'adr-0013',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0014',
        currentSlug : 'cloud-deployment-topology-and-scheduler-task-taxonomy',
        title       : 'Cloud Deployment Topology and Scheduler Task Taxonomy',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'f404ed672b06',
        nodeLabel   : 'ADR',
        edgeCount   : 27,
        vectorId    : 'adr-0014',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0015',
        currentSlug : 'graph-store-backend-posture',
        title       : 'Graph Store Backend Posture',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'b4d3a0758f8f',
        nodeLabel   : 'ADR',
        edgeCount   : 4,
        vectorId    : 'adr-0015',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0016',
        currentSlug : 'ai-script-cli-parser-convention',
        title       : 'AI Script CLI Parser Convention',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'a4cda306e393',
        nodeLabel   : 'ADR',
        edgeCount   : 6,
        vectorId    : 'adr-0016',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0017',
        currentSlug : 'chroma-single-flat-unified-store',
        title       : 'Chroma Single Flat Unified Store',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '93edfb084617',
        nodeLabel   : 'ADR',
        edgeCount   : 4,
        vectorId    : 'adr-0017',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0018',
        currentSlug : 'neo-identity-source-of-truth-model',
        title       : 'Neo Identity Source of Truth Model',
        namespace   : 'neomjs/neo',
        contentHash : '18acf3d3e8ad',
        nodeLabel   : 'ADR',
        edgeCount   : 9,
        vectorId    : 'adr-0018',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0019',
        currentSlug : 'aiconfig-reactive-provider-ssot',
        title       : 'AiConfig Reactive Provider SSOT',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'd0c12523481a',
        nodeLabel   : 'CONCEPT',
        edgeCount   : 222,
        vectorId    : 'summary_28bfbdc1-3d2b-4b29-bfb3-5267a07ad2cb',
        vectorOwners: [
            {id: 'summary_28bfbdc1-3d2b-4b29-bfb3-5267a07ad2cb', label: 'SESSION_SUMMARY'},
            {id: 'session:antigravity_diagnostic',               label: 'SESSION'},
            {id: 'config-provider',                              label: 'CONCEPT'}
        ],
        histRefs: []
    },
    {
        adrNumber          : '0020',
        currentSlug        : 'agent-harness-concept',
        title              : 'Agent Harness Concept',
        namespace          : 'neomjs/neo-agent-institution',
        originNamespace    : 'neomjs/neo',
        redirectContentHash: 'ebed776c976f',
        contentHash        : '395b931a91a0',
        nodeLabel          : 'CONCEPT',
        edgeCount          : 9,
        vectorId           : 'summary_0eb6a198-3612-4b0b-9c9e-75e7618faf1d',
        vectorOwners       : [
            {id: 'summary_0eb6a198-3612-4b0b-9c9e-75e7618faf1d', label: 'SESSION_SUMMARY'},
            {id: 'CLASS:Neo.identityRoots',                      label: 'CLASS'},
            {id: 'session:ada_fable_v13',                        label: 'SESSION'}
        ],
        histRefs: ['ISSUE:neomjs/neo#19015']
    },
    {
        adrNumber   : '0021',
        currentSlug : 'extended-nl-multi-writer-write-enforcement',
        title       : 'Extended NL Multi-Writer Write Enforcement',
        namespace   : 'neomjs/neo',
        contentHash : 'cda2bc31299e',
        nodeLabel   : 'ADR',
        edgeCount   : 2,
        vectorId    : 'adr-0021',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0022',
        currentSlug : 'heavy-maintenance-scheduling-fairness',
        title       : 'Heavy Maintenance Scheduling Fairness',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '0048cddaf383',
        nodeLabel   : 'ADR',
        edgeCount   : 2,
        vectorId    : 'adr-0022',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0023',
        currentSlug : 'dreamservice-organism-map-fidelity-consolidation-liveness',
        title       : 'DreamService Organism Map Fidelity Consolidation Liveness',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '4dcf404d40da',
        nodeLabel   : 'ADR',
        edgeCount   : 4,
        vectorId    : 'adr-0023',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0024',
        currentSlug : 'native-edge-graph-model',
        title       : 'Native Edge Graph Model',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '6a0dd9693b2c',
        nodeLabel   : 'CLASS',
        edgeCount   : 8,
        vectorId    : 'summary_6ce9ff05-0291-430d-bac4-73b60a2d7789',
        vectorOwners: [
            {id: 'summary_6ce9ff05-0291-430d-bac4-73b60a2d7789', label: 'SESSION_SUMMARY'},
            {id: 'METHOD:withHeavyMaintenanceLease',             label: 'METHOD'},
            {id: 'ISSUE:13765',                                  label: 'ISSUE'}
        ],
        histRefs: ['ISSUE:neomjs/neo#13765']
    },
    {
        adrNumber   : '0025',
        currentSlug : 'orchestrator-container-health-self-healing',
        title       : 'Orchestrator Container Health Self-Healing',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '5f3466df06a6',
        nodeLabel   : 'ADR',
        edgeCount   : 9,
        vectorId    : 'adr-0025',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0026',
        currentSlug : 'recovery-actuator',
        title       : 'Recovery Actuator',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '3e5c3751fdf4',
        nodeLabel   : 'CONCEPT',
        edgeCount   : 22,
        vectorId    : 'summary_37500317-3b4d-4d1c-ab76-ef5c9925f720',
        vectorOwners: [
            {id: 'summary_37500317-3b4d-4d1c-ab76-ef5c9925f720', label: 'SESSION_SUMMARY'},
            {id: 'reconfigure-service',                          label: 'CLASS'},
            {id: 'memory:session_analysis',                      label: 'SESSION'}
        ],
        histRefs: ['ISSUE:neomjs/neo#16374']
    },
    {
        adrNumber   : '0027',
        currentSlug : 'autonomous-data-recovery-actuator',
        title       : 'Autonomous Data Recovery Actuator',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'dddc13dfa147',
        nodeLabel   : 'CONCEPT',
        edgeCount   : 13,
        vectorId    : 'summary_9fcbc1c9-0d44-4c1e-af9a-e533583305a6',
        vectorOwners: [
            {id: 'summary_9fcbc1c9-0d44-4c1e-af9a-e533583305a6', label: 'SESSION_SUMMARY'},
            {id: 'ac5-logic',                                    label: 'CONCEPT'}
        ],
        histRefs: []
    },
    {
        adrNumber   : '0028',
        currentSlug : 'temporal-pyramid-summarization-substrate',
        title       : 'Temporal Pyramid Summarization Substrate',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'a09b60e3634b',
        nodeLabel   : 'CONCEPT',
        edgeCount   : 7,
        vectorId    : 'summary_838a9731-405d-4f5f-b051-e944f9950a19',
        vectorOwners: [
            {id: 'ISSUE:15088',          label: 'ISSUE'},
            {id: 'EPIC:12679',           label: 'STRATEGY'},
            {id: 'adr-relationship',     label: 'CONCEPT'},
            {id: 'session:audit_15088',  label: 'SESSION'}
        ],
        histRefs: ['ISSUE:neomjs/neo#15088']
    },
    {
        adrNumber   : '0029',
        currentSlug : 'docking-design',
        title       : 'Docking Design',
        namespace   : 'neomjs/neo',
        contentHash : '9b0185792b19',
        nodeLabel   : 'CONCEPT',
        edgeCount   : 50,
        vectorId    : 'summary_771833a0-8bd1-4520-8e2c-138d82c15a53',
        vectorOwners: [
            {id: 'summary_771833a0-8bd1-4520-8e2c-138d82c15a53', label: 'SESSION_SUMMARY'},
            {id: 'container-mjs',                                label: 'CLASS'},
            {id: 'vessel-container-mjs',                         label: 'CLASS'}
        ],
        histRefs: []
    },
    {
        adrNumber   : '0030',
        currentSlug : 'work-graph-stall-inference',
        title       : 'Work Graph Stall Inference',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '5f42741132b6',
        nodeLabel   : 'ADR',
        edgeCount   : 5,
        vectorId    : 'adr-0030',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0031',
        currentSlug : 'target-architecture-composition',
        title       : 'Target Architecture Composition',
        namespace   : 'neomjs/neo',
        contentHash : '35ebf04ac30b',
        nodeLabel   : 'CONCEPT',
        edgeCount   : 7,
        vectorId    : 'summary_5b83bd4a-3c7a-4063-be83-a9549ec83937',
        vectorOwners: [
            {id: 'ISSUE:14362',           label: 'ISSUE'},
            {id: 'session:audit_17507',   label: 'SESSION'},
            {id: 'harness-wire-strings',  label: 'CONCEPT'},
            {id: 'ISSUE:17503',           label: 'ISSUE'}
        ],
        histRefs: ['ISSUE:neomjs/neo#17503']
    },
    {
        adrNumber          : '0032',
        currentSlug        : 'institution-cockpit-render-model',
        title              : 'Institution Cockpit Render Model',
        namespace          : 'neomjs/neo-agent-institution',
        originNamespace    : 'neomjs/neo',
        redirectContentHash: '15b43d769e0e',
        contentHash        : '1c967cbe183f',
        nodeLabel          : 'CONCEPT',
        edgeCount          : 5,
        vectorId           : 'summary_011986c4-3bf2-41c2-a4c1-d48019d1a0f3',
        vectorOwners       : [
            {id: 'model-stats',              label: 'CONCEPT'},
            {id: 'ISSUE:15421',              label: 'ISSUE'},
            {id: 'session:audit_pr_15425',   label: 'SESSION'},
            {id: 'GUIDE:ADR_0032',           label: 'CONCEPT'},
            {id: 'session:audit_15425',      label: 'SESSION'}
        ],
        histRefs: ['ISSUE:neomjs/neo#15421']
    },
    {
        adrNumber   : '0033',
        currentSlug : 'direction-contract',
        title       : 'Direction Contract',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '1f18fc42cf95',
        nodeLabel   : 'ADR',
        edgeCount   : 3,
        vectorId    : 'adr-0033',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber          : '0034',
        currentSlug        : 'electron-shell-architecture',
        title              : 'Electron Shell Architecture',
        namespace          : 'neomjs/neo-agent-institution',
        originNamespace    : 'neomjs/neo',
        redirectContentHash: 'c815d7c23665',
        contentHash        : 'd42c0ab0c3e6',
        nodeLabel          : 'CLASS',
        edgeCount          : 51,
        vectorId           : 'summary_2ef4256d-e5c9-4c1c-8193-c39a5c1088a7',
        vectorOwners       : [
            {id: 'chroma-manager',                 label: 'CLASS'},
            {id: 'seat-survival',                  label: 'CONCEPT'},
            {id: 'summary_2ef4256d-e5c9-4c1c-8193-c39a5c1088a7', label: 'SESSION_SUMMARY'},
            {id: 'session:brain_handoff_analysis', label: 'SESSION'}
        ],
        semanticDisposition: 'retain-landed-amendment',
        histRefs           : []
    },
    {
        adrNumber   : '0035',
        currentSlug : 'live-lane-awareness-composition',
        title       : 'Live Lane Awareness Composition',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '2dd51fdb2f99',
        nodeLabel   : 'ADR',
        edgeCount   : 19,
        vectorId    : 'adr-0035',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0036',
        currentSlug : 'durable-community-activity-authority',
        title       : 'Durable Community Activity Authority',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'c00897878d1d',
        nodeLabel   : 'ADR',
        edgeCount   : 25,
        vectorId    : 'adr-0036',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber          : '0037',
        currentSlug        : 'fleet-manager-outward-door-topology',
        title              : 'Fleet Manager Outward Door Topology',
        namespace          : 'neomjs/neo-agent-institution',
        originNamespace    : 'neomjs/neo',
        redirectContentHash: 'face6cac3cf3',
        contentHash        : 'b0345296b937',
        nodeLabel          : 'ADR',
        edgeCount          : 13,
        vectorId           : 'adr-0037',
        vectorOwners       : [],
        semanticDisposition: 'pending',
        histRefs           : []
    },
    {
        adrNumber          : '0038',
        currentSlug        : 'fm-client-topology',
        title              : 'FM Client Topology',
        namespace          : 'neomjs/neo-agent-institution',
        originNamespace    : 'neomjs/neo',
        redirectContentHash: '4fcfd997b36f',
        contentHash        : '512a008dc43b',
        nodeLabel          : 'CONCEPT',
        edgeCount          : 11,
        vectorId           : 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',
        vectorOwners       : [
            {id: 'session:neo_recovery',                          label: 'SESSION'},
            {id: 'vessel-workspace',                              label: 'CLASS'},
            {id: 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',  label: 'SESSION_SUMMARY'},
            {id: 'workstation-reclaim-embodiment',                label: 'CLASS'},
            {id: 'TASK:PR_19722',                                 label: 'ARTIFACT_TASK'}
        ],
        semanticDisposition: 'retain-landed-amendment',
        histRefs           : ['PULL_REQUEST:neomjs/neo#19722']
    },
    {
        adrNumber   : '0039',
        currentSlug : 'two-plane-sdk-barrel-boundary',
        title       : 'Two-Plane SDK Barrel Boundary',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '991b04b5d9f3',
        nodeLabel   : 'ADR',
        edgeCount   : 2,
        vectorId    : 'adr-0039',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0040',
        currentSlug : 'agentos-extraction-topology',
        title       : 'AgentOS Extraction Topology',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : 'f502532b83af',
        nodeLabel   : 'ADR',
        edgeCount   : 31,
        vectorId    : 'adr-0040',
        vectorOwners: [],
        histRefs    : []
    },
    {
        adrNumber   : '0041',
        currentSlug : 'bootstrap-record-verified-plane-handoff',
        title       : 'Bootstrap Record Verified Plane Handoff',
        namespace   : 'neomjs/neo-agent-brain',
        contentHash : '8373ac1edd99',
        nodeLabel   : 'ADR',
        edgeCount   : 5,
        vectorId    : 'adr-0041',
        vectorOwners: [],
        histRefs    : []
    }
];

/**
 * @summary Builds a reviewed manifest entry for one legacy ADR record.
 * @param {Object} row
 * @returns {Object}
 * @private
 */
function buildReviewedManifestEntry(row) {
    const
        repoMeta      = MIGRATION_CUT_REPOSITORIES[row.namespace],
        originMeta    = row.originNamespace ? MIGRATION_CUT_REPOSITORIES[row.originNamespace] : null,
        isCustodyMove = Boolean(originMeta),
        // Historical FM decisions (0020, 0032, 0034, 0037, 0038) were assigned in neomjs/neo
        // or neomjs/neo-agent-institution per the reviewed manifest:
        canonicalKey  = buildCanonicalAdrKey({
            forge       : repoMeta.forge,
            repositoryId: repoMeta.repositoryId,
            namespace   : repoMeta.namespace,
            number      : row.adrNumber
        }),
        originCanonicalKey = originMeta
            ? buildCanonicalAdrKey({
                forge       : originMeta.forge,
                repositoryId: originMeta.repositoryId,
                namespace   : originMeta.namespace,
                number      : row.adrNumber
            })
            : null,
        fileName   = `${row.adrNumber}-${row.currentSlug}.md`,
        sourcePath = `${repoMeta.territoryRoot}/${fileName}`,
        legacyId   = `adr-${row.adrNumber}`,
        isAnomaly  = row.nodeLabel !== 'ADR' || row.vectorId.startsWith('summary_');

    const aliasBindings = [
        {
            kind        : 'slug',
            value       : row.currentSlug,
            forge       : repoMeta.forge,
            repositoryId: repoMeta.repositoryId,
            namespace   : repoMeta.namespace,
            targetKey   : canonicalKey,
            current     : true
        },
        {
            kind        : 'legacy-number',
            value       : row.adrNumber,
            forge       : repoMeta.forge,
            repositoryId: repoMeta.repositoryId,
            namespace   : repoMeta.namespace,
            targetKey   : canonicalKey,
            current     : true
        }
    ];

    if (originMeta) {
        aliasBindings.push(
            {
                kind        : 'slug',
                value       : row.currentSlug,
                forge       : originMeta.forge,
                repositoryId: originMeta.repositoryId,
                namespace   : originMeta.namespace,
                targetKey   : canonicalKey,
                current     : false,
                historical  : true
            },
            {
                kind        : 'legacy-number',
                value       : row.adrNumber,
                forge       : originMeta.forge,
                repositoryId: originMeta.repositoryId,
                namespace   : originMeta.namespace,
                targetKey   : canonicalKey,
                current     : false,
                historical  : true
            }
        );
    }

    const reservations = [
        {
            forge       : repoMeta.forge,
            repositoryId: repoMeta.repositoryId,
            namespace   : repoMeta.namespace,
            adrNumber   : row.adrNumber,
            reason      : 'assigned-custody'
        }
    ];

    if (originMeta) {
        reservations.push({
            forge       : originMeta.forge,
            repositoryId: originMeta.repositoryId,
            namespace   : originMeta.namespace,
            adrNumber   : row.adrNumber,
            reason      : 'historical-custody-redirect-reservation'
        });
    }

    return Object.freeze({
        adrNumber         : row.adrNumber,
        legacyId,
        canonicalKey,
        originCanonicalKey,
        title             : row.title,
        status            : 'Accepted',
        currentSlug       : row.currentSlug,
        fileName,
        sourcePath,
        assignmentEvidence: Object.freeze({
            forge       : repoMeta.forge,
            repositoryId: repoMeta.repositoryId,
            namespace   : repoMeta.namespace,
            cutRevision : repoMeta.cutRevision,
            provenance  : isCustodyMove ? 'reviewed-manifest-custody-move' : 'reviewed-manifest-assignment',
            verified    : true
        }),
        sourceTuple                  : Object.freeze({
            forge       : repoMeta.forge,
            repositoryId: repoMeta.repositoryId,
            namespace   : repoMeta.namespace,
            revision    : repoMeta.cutRevision,
            path        : sourcePath,
            contentHash : row.contentHash,
            payloadHash : `sha256:${row.contentHash}`
        }),
        custodyTransition            : isCustodyMove
            ? Object.freeze({
                adrNumber          : row.adrNumber,
                canonicalKey,
                fromForge          : originMeta.forge,
                fromRepositoryId   : originMeta.repositoryId,
                fromNamespace      : originMeta.namespace,
                toForge            : repoMeta.forge,
                toRepositoryId     : repoMeta.repositoryId,
                toNamespace        : repoMeta.namespace,
                redirectPath       : `${originMeta.territoryRoot}/${fileName}`,
                redirectContentHash: row.redirectContentHash,
                proof              : `reviewed-manifest-redirect-${row.adrNumber}-${row.redirectContentHash}`,
                verified           : true
            })
            : null,
        historicalReservationInOrigin: isCustodyMove,
        aliases                      : Object.freeze([row.currentSlug]),
        historicalAliases            : Object.freeze(
            isCustodyMove
                ? [
                    `${originMeta.namespace}#adr:${row.currentSlug}`,
                    `${originMeta.namespace}#${row.adrNumber}`,
                    legacyId
                ]
                : [legacyId]
        ),
        aliasBindings       : Object.freeze(aliasBindings.map(b => Object.freeze(b))),
        reservations        : Object.freeze(reservations.map(r => Object.freeze(r))),
        historicalReferences: Object.freeze([...(row.histRefs || [])]),
        observedState       : Object.freeze({
            nodeLabel   : row.nodeLabel,
            anomalyShape: !isAnomaly
                ? 'NONE'
                : row.adrNumber === '0038'
                    ? 'SHARED_SUMMARY_VECTOR_WITH_NON_ADR_OWNER'
                    : row.nodeLabel === 'CLASS'
                        ? 'CLASS_SUMMARY_VECTOR_OVERWRITE'
                        : 'CONCEPT_SUMMARY_VECTOR_OVERWRITE',
            observedSemanticVectorId: row.vectorId,
            reusedVectorOwners      : Object.freeze((row.vectorOwners || []).map(o => Object.freeze({
                ...o,
                nodeId: o.nodeId || o.id,
                isAdr : o.isAdr ?? (o.label === 'ADR')
            }))),
            observedEdgeCount: row.edgeCount,
            kbState          : Object.freeze({
                indexedUnderLegacyId: true,
                canonicalKeyIndexed : false
            })
        }),
        semanticDisposition: row.semanticDisposition || 'retain',
        visibility         : repoMeta.visibility,
        tenantId           : null
    });
}

/**
 * Complete, reviewed 41-record legacy ADR migration manifest (`0001`..`0041`).
 */
export const REVIEWED_41_ADR_MIGRATION_MANIFEST = Object.freeze(
    RAW_41_RECORDS.map(buildReviewedManifestEntry)
);

/**
 * Operator migration and recovery runbook binding the reviewed manifest, installed reader
 * versions, writer coordination, and post-merge live apply acceptance boundary.
 */
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
    writerCoordination     : Object.freeze([
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
