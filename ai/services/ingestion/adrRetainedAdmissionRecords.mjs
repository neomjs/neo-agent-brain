import {buildCanonicalAdrKey} from '../shared/adrIdentityCodec.mjs';

/**
 * @module ai/services/ingestion/adrRetainedAdmissionRecords
 * @summary Canonical reviewed ADR admission evidence baseline (42 reviewed decisions across
 * `neomjs/neo`, `neomjs/neo-agent-brain`, `neomjs/neo-agent-institution`, and `neomjs/neo-stage`)
 * and custody transitions. Consumed by `adrAdmissionCatalog.mjs` so both `AdrIngestor` and
 * cross-process Knowledge Base extraction (`ExtractorCatalogue` -> `AdrSource`) admit against
 * the same retained authority without reconstructing identity from markdown files alone.
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md
 */

const REPOS = Object.freeze({
    neo        : Object.freeze({forge: 'github.com', repositoryId: '220867748',  namespace: 'neomjs/neo',                   visibility: 'public',  tenantId: null}),
    brain      : Object.freeze({forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain',       visibility: 'public',  tenantId: null}),
    institution: Object.freeze({forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution', visibility: 'public',  tenantId: null}),
    stage      : Object.freeze({forge: 'github.com', repositoryId: '1413810081', namespace: 'neomjs/neo-stage',             visibility: 'private', tenantId: 'neo-stage'})
});

/**
 * @summary Builds one frozen reviewed admission record for the baseline manifest.
 * @param {Object} spec
 * @returns {Object}
 * @private
 */
function createReviewedRecord({
    repo,
    adrNumber,
    slug,
    title,
    sourceRoot         = 'learn/agentos/decisions',
    historicalEngineOrigin = false,
    extraNumberReservations = []
}) {
    const
        canonicalKey = buildCanonicalAdrKey({
            forge       : repo.forge,
            repositoryId: repo.repositoryId,
            namespace   : repo.namespace,
            number      : adrNumber
        }),
        sourcePath   = `${sourceRoot}/${adrNumber}-${slug}.md`,
        aliasBindings = [
            {
                kind        : 'slug',
                value       : slug,
                forge       : repo.forge,
                repositoryId: repo.repositoryId,
                namespace   : repo.namespace,
                targetKey   : canonicalKey,
                current     : true
            },
            {
                kind        : 'legacy-number',
                value       : adrNumber,
                forge       : repo.forge,
                repositoryId: repo.repositoryId,
                namespace   : repo.namespace,
                targetKey   : canonicalKey,
                current     : true
            }
        ],
        reservations = [
            {
                kind        : 'number',
                value       : adrNumber,
                forge       : repo.forge,
                repositoryId: repo.repositoryId,
                namespace   : repo.namespace
            },
            {
                kind        : 'slug',
                value       : slug,
                forge       : repo.forge,
                repositoryId: repo.repositoryId,
                namespace   : repo.namespace
            }
        ],
        custodyTransitions = [];

    if (historicalEngineOrigin) {
        aliasBindings.push(
            {
                kind        : 'slug',
                value       : slug,
                forge       : REPOS.neo.forge,
                repositoryId: REPOS.neo.repositoryId,
                namespace   : REPOS.neo.namespace,
                targetKey   : canonicalKey,
                current     : false
            },
            {
                kind        : 'legacy-number',
                value       : adrNumber,
                forge       : REPOS.neo.forge,
                repositoryId: REPOS.neo.repositoryId,
                namespace   : REPOS.neo.namespace,
                targetKey   : canonicalKey,
                current     : false
            }
        );
        reservations.push(
            {
                kind        : 'number',
                value       : adrNumber,
                forge       : REPOS.neo.forge,
                repositoryId: REPOS.neo.repositoryId,
                namespace   : REPOS.neo.namespace
            },
            {
                kind        : 'slug',
                value       : slug,
                forge       : REPOS.neo.forge,
                repositoryId: REPOS.neo.repositoryId,
                namespace   : REPOS.neo.namespace
            }
        );
        custodyTransitions.push({
            adrNumber,
            canonicalKey,
            fromForge       : REPOS.neo.forge,
            fromRepositoryId: REPOS.neo.repositoryId,
            fromNamespace   : REPOS.neo.namespace,
            toForge         : repo.forge,
            toRepositoryId  : repo.repositoryId,
            toNamespace     : repo.namespace
        });
    }

    for (const extraRepo of extraNumberReservations) {
        aliasBindings.push({
            kind        : 'legacy-number',
            value       : adrNumber,
            forge       : extraRepo.forge,
            repositoryId: extraRepo.repositoryId,
            namespace   : extraRepo.namespace,
            targetKey   : canonicalKey,
            current     : false
        });
        reservations.push({
            kind        : 'number',
            value       : adrNumber,
            forge       : extraRepo.forge,
            repositoryId: extraRepo.repositoryId,
            namespace   : extraRepo.namespace
        });
    }

    return Object.freeze({
        canonicalKey,
        adrNumber,
        title,
        status            : 'Accepted',
        rawStatus         : 'Accepted',
        supersedes        : [],
        currentSlug       : slug,
        historicalAliases : [],
        tenantId          : repo.tenantId,
        visibility        : repo.visibility,
        assignmentEvidence: Object.freeze({
            forge             : repo.forge,
            repositoryId      : repo.repositoryId,
            namespace         : repo.namespace,
            number            : adrNumber,
            assignmentKind    : 'legacy-reviewed',
            reviewedManifestId: `reviewed-adr-${repo.namespace}-${adrNumber}`
        }),
        sourceTuple: Object.freeze({
            forge       : repo.forge,
            repositoryId: repo.repositoryId,
            namespace   : repo.namespace,
            revision    : null,
            path        : sourcePath
        }),
        aliasBindings,
        reservations,
        provenance: Object.freeze({
            createdAtRevision   : null,
            lastAdmittedRevision: null,
            custodyTransitions,
            repositoryRenames   : [],
            sourceLineage       : []
        }),
        documentAvailable: true,
        kbAvailable      : true,
        stale            : false
    });
}

export const REVIEWED_ADR_ADMISSION_RECORDS = Object.freeze([
    // 1. neomjs/neo (7 retained Engine ADRs)
    createReviewedRecord({repo: REPOS.neo, adrNumber: '0004', slug: 'github-content-architecture',               title: 'GitHub Content Architecture — Universal Ordinal-100 Chunking'}),
    createReviewedRecord({repo: REPOS.neo, adrNumber: '0007', slug: 'agents-md-compaction-taxonomy',             title: 'Compaction Taxonomy (3-Axis Slot Rule)'}),
    createReviewedRecord({repo: REPOS.neo, adrNumber: '0008', slug: 'skill-anatomy-and-authoring-contract',      title: 'SKILL.md Anatomy and Authoring Contract'}),
    createReviewedRecord({repo: REPOS.neo, adrNumber: '0018', slug: 'neo-identity-source-of-truth-model',        title: 'Neo Identity Source-of-Truth Model'}),
    createReviewedRecord({repo: REPOS.neo, adrNumber: '0021', slug: 'extended-nl-multi-writer-write-enforcement', title: 'Extended-NL multi-writer write enforcement'}),
    createReviewedRecord({repo: REPOS.neo, adrNumber: '0029', slug: 'docking-design',                            title: 'Docking Design — Multi-Window Layout Model, Perspectives, Cross-Window Drag'}),
    createReviewedRecord({repo: REPOS.neo, adrNumber: '0031', slug: 'target-architecture-composition',           title: 'Target-Architecture Composition — the Seam Table + Trajectory Layer'}),

    // 2. neomjs/neo-agent-institution (5 Fleet Manager ADRs moved from neomjs/neo)
    createReviewedRecord({repo: REPOS.institution, adrNumber: '0020', slug: 'agent-harness-concept',              title: 'The Agent Harness — concept anchor + session-intake recipe',                              historicalEngineOrigin: true}),
    createReviewedRecord({repo: REPOS.institution, adrNumber: '0032', slug: 'institution-cockpit-render-model',   title: 'Institution-Cockpit Render-Model — Object-Permanent Selves + the COP Contract',           historicalEngineOrigin: true}),
    createReviewedRecord({repo: REPOS.institution, adrNumber: '0034', slug: 'electron-shell-architecture',        title: 'Electron Shell Architecture — Process Model, Window Topology, Security Posture, Distribution', historicalEngineOrigin: true}),
    createReviewedRecord({repo: REPOS.institution, adrNumber: '0037', slug: 'fleet-manager-outward-door-topology', title: 'Fleet Manager Outward-Door Topology — One Site, Source-Less-of-Product Storefront',       historicalEngineOrigin: true}),
    createReviewedRecord({repo: REPOS.institution, adrNumber: '0038', slug: 'fm-client-topology',                 title: 'The FM client topology — the cockpit connects; the plane owns fleet truth',               historicalEngineOrigin: true}),

    // 3. neomjs/neo-agent-brain (29 Brain ADRs)
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0001', slug: 'cross-process-cache-coherence',                          title: 'Cross-Process Cache Coherence for Memory Core Graph'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0002', slug: 'phase3-wake-substrate-standards-alignment',              title: 'Phase 3 Wake-Substrate Standards Alignment'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0003', slug: 'chroma-topology-unified-only',                           title: 'Chroma Topology - Unified Only'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0005', slug: 'adr-at-graduation-for-ideation-sandbox',                 title: 'ADR-at-Graduation for Ideation Sandbox Discussions'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0006', slug: 'adrs-as-graph-queryable-entities',                       title: 'ADRs as Graph-Queryable Entities via Specific `ADR` Label'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0009', slug: 'cross-daemon-lease-inheritance',                         title: 'Cross-Daemon Heavy-Maintenance Lease Inheritance via Env-Var Token'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0010', slug: 'lane-intent-coordination-primitive',                     title: 'Lane-Intent: Pre-V-B-A Coordination Primitive'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0011', slug: 'substrate-numbering-convention',                         title: 'Substrate Numbering Convention'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0012', slug: 'model-stats-framework',                                  title: 'Model-Stats Framework'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0013', slug: 'kb-ingestion-telemetry-schema',                          title: 'KB Ingestion Telemetry Schema — Event-Shaped `kb_ingestion_metrics` Table'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0014', slug: 'cloud-deployment-topology-and-scheduler-task-taxonomy',  title: 'Cloud Deployment Topology + Scheduler Task Taxonomy'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0015', slug: 'graph-store-backend-posture',                            title: 'Graph Store Backend Posture - SQLite WAL First, Networked SQL Deferred'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0016', slug: 'ai-script-cli-parser-convention',                        title: 'AI Script CLI Parser Convention - Commander First'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0017', slug: 'chroma-single-flat-unified-store',                       title: 'Chroma — Single Flat Unified Store + Dev/Prod Parity'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0019', slug: 'aiconfig-reactive-provider-ssot',                        title: 'AiConfig is the reactive Provider SSOT for Agent OS config'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0022', slug: 'heavy-maintenance-scheduling-fairness',                  title: 'Heavy-Maintenance Scheduling Fairness Model'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0023', slug: 'dreamservice-organism-map-fidelity-consolidation-liveness', title: 'DreamService Organism — Map-Fidelity + Consolidation-Liveness'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0024', slug: 'native-edge-graph-model',                                title: 'The Native Edge Graph — Ontology, Storage, Active Interface & Provenance'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0025', slug: 'orchestrator-container-health-self-healing',             title: 'Orchestrator Container-Health Diagnostics Daemon'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0026', slug: 'recovery-actuator',                                      title: 'Orchestrator Recovery Actuator'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0027', slug: 'autonomous-data-recovery-actuator',                      title: 'Autonomous Memory Core Data-Recovery Actuator'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0028', slug: 'temporal-pyramid-summarization-substrate',               title: 'Temporal-Pyramid Summarization Substrate'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0030', slug: 'work-graph-stall-inference',                             title: 'Work-Graph Stall Inference'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0033', slug: 'direction-contract',                                     title: 'The Direction Contract — deterministic evolution-direction keys, per-direction velocity fields, and the fail-open additive boundary'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0035', slug: 'live-lane-awareness-composition',                        title: 'Live Lane Awareness — typed route, lifecycle frontier, Bird-View references, and fenced hook projection'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0036', slug: 'durable-community-activity-authority',                   title: 'Durable Community Activity — provider-neutral admission, zero-authority attention, and explicit Task claim'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0039', slug: 'two-plane-sdk-barrel-boundary',                          title: 'The Two-Plane SDK Barrel Boundary — A Host Entrypoint Cannot Reach a Durable Store by Import Alone'}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0040', slug: 'agentos-extraction-topology',                            title: 'The AgentOS Extraction Topology — One Repository Whose Root Is the Host Edge', extraNumberReservations: [REPOS.neo]}),
    createReviewedRecord({repo: REPOS.brain, adrNumber: '0041', slug: 'bootstrap-record-verified-plane-handoff',                title: 'The Bootstrap Record and the Verified-Plane Handoff'}),

    // 4. neomjs/neo-stage (1 private Stage ADR)
    createReviewedRecord({repo: REPOS.stage, adrNumber: '0001', slug: 'the-engine-contract',                                    title: '0001 — The engine contract', sourceRoot: 'learn/decisions'})
]);

export const REVIEWED_ADR_CUSTODY_TRANSITIONS = Object.freeze(
    ['0020', '0032', '0034', '0037', '0038'].map(adrNumber => Object.freeze({
        adrNumber,
        canonicalKey    : `adr:github.com:1347756127:neomjs%2Fneo-agent-institution:${adrNumber}`,
        fromForge       : 'github.com',
        fromRepositoryId: '220867748',
        fromNamespace   : 'neomjs/neo',
        toForge         : 'github.com',
        toRepositoryId  : '1347756127',
        toNamespace     : 'neomjs/neo-agent-institution'
    }))
);

export const REVIEWED_ADR_LEGACY_MANIFEST = Object.freeze(
    ['0020', '0032', '0034', '0037', '0038'].map(adrNumber => Object.freeze({
        id                  : `reviewed-adr-neomjs/neo-agent-institution-${adrNumber}`,
        adrNumber,
        forge               : 'github.com',
        sourceRepositoryId  : '220867748',
        assignedRepositoryId: '1347756127',
        assignedNamespace   : 'neomjs/neo-agent-institution',
        currentCustody      : Object.freeze({
            forge       : 'github.com',
            repositoryId: '1347756127',
            namespace   : 'neomjs/neo-agent-institution'
        }),
        canonicalKey             : `adr:github.com:1347756127:neomjs%2Fneo-agent-institution:${adrNumber}`,
        custodyTransitionVerified: true
    }))
);
