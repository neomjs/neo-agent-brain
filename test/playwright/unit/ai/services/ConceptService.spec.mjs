import {setup} from '../../../setup.mjs';

const appName = 'ConceptServiceTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                                      from '@playwright/test';
import Neo                                                 from 'neo.mjs/src/Neo.mjs';
import * as core                                           from 'neo.mjs/src/core/_export.mjs';
import ConceptService                                      from '../../../../../ai/services/ConceptService.mjs';
import {isValidDecisionReference, resolveBrainRootVersion} from '../../../../../ai/services/shared/conceptEdgeValidation.mjs';
import fs                                                  from 'fs';
import path                                                from 'path';
import os                                                  from 'os';
import {createRequire}                                     from 'module';

// The production ontology stayed in the Engine at the split; the Brain reads it through its Engine dependency.
const productionConceptsDir = path.join(path.dirname(createRequire(import.meta.url).resolve('neo.mjs/package.json')), '.neo-ai-data/concepts');

/**
 * Creates a temporary concepts directory with test JSONL files.
 * Returns the absolute path to the temp directory.
 * @param {Array<Object>} nodes Array of node objects
 * @param {Array<Object>} edges Array of edge objects
 * @returns {String} Path to temp concepts directory
 */
function createTestFixture(nodes, edges) {
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-concept-test-')),
          nodesData = nodes.map(n => JSON.stringify(n)).join('\n'),
          edgesData = edges.map(e => JSON.stringify(e)).join('\n');

    fs.writeFileSync(path.join(tmpDir, 'nodes.jsonl'), nodesData, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'edges.jsonl'), edgesData, 'utf8');

    return tmpDir;
}

/**
 * Minimal fixture: a root anchor with two tier-1 children, one with an EXPLAINED_BY edge.
 */
function createMinimalFixture() {
    const nodes = [
        {id: 'root', name: 'Neo.mjs', tier: 0, description: 'System anchor', uniqueToNeo: false, tags: []},
        {id: 'threading', name: 'Multi-Threading', tier: 1, description: 'Worker-based threading', uniqueToNeo: true, tags: ['architecture'], aliases: ['multi-worker', 'OMT architecture']},
        {id: 'vdom', name: 'JSON-First VDOM', tier: 1, description: 'VDOM protocol', uniqueToNeo: true, tags: ['vdom'], aliases: ['JSON VDOM']},
        {id: 'reactivity', name: 'Reactivity', tier: 2, description: 'Config system', uniqueToNeo: true, tags: ['reactivity']}
    ];

    const edges = [
        {source: 'root', target: 'threading', type: 'PARENT_CONCEPT'},
        {source: 'root', target: 'vdom', type: 'PARENT_CONCEPT'},
        {source: 'threading', target: 'reactivity', type: 'PARENT_CONCEPT'},
        {source: 'threading', target: 'file:learn/guides/Threading.md', type: 'EXPLAINED_BY'},
        {source: 'threading', target: 'file:src/worker/Manager.mjs', type: 'IMPLEMENTED_BY'},
        {source: 'reactivity', target: 'file:learn/guides/Reactivity.md', type: 'EXPLAINED_BY'},
        {source: 'vdom', target: 'ext:react-jsx', type: 'ANALOGOUS_TO', note: 'JSX compiles to createElement; Neo VDOM is raw JSON.'},
        {source: 'threading', target: 'ext:react-concurrent', type: 'ANALOGOUS_TO', note: 'React simulates scheduling on one thread; Neo uses real Web Workers.'}
    ];

    return createTestFixture(nodes, edges);
}

test.describe('Neo.ai.services.ConceptService', () => {
    let testRun = 0;

    test.beforeEach(() => {
        testRun++;
    });

    test.afterEach(() => {
        // Reset the singleton state for isolation between tests
        ConceptService.defaultConceptsDir = null;
        ConceptService.nodes.clear();
        ConceptService.edgesBySource.clear();
        ConceptService.edgesByTarget.clear();
        ConceptService.aliasIndex.clear();
        ConceptService.loaded = false;
    });

    // ── loadGraph ──────────────────────────────────────────────

    test('getConceptsDir fails loud without composing-entrypoint injection', () => {
        ConceptService.defaultConceptsDir = null;

        expect(() => ConceptService.getConceptsDir()).toThrow('concepts directory must be injected')
    });

    test('loadGraph should parse JSONL files and return correct statistics', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;

        const stats = ConceptService.loadGraph();

        expect(stats.nodeCount).toBe(4);
        expect(stats.edgeCount).toBe(8);
        expect(stats.errors.length).toBe(0);

        fs.rmSync(tmpDir, {recursive: true});
    });

    test('loadGraph should report errors for malformed nodes', () => {
        const nodes = [
            {id: 'valid', name: 'Valid', tier: 1, description: 'OK', uniqueToNeo: false, tags: []},
            {name: 'MissingId', tier: 1}  // missing id
        ];
        const edges  = [];
        const tmpDir = createTestFixture(nodes, edges);

        ConceptService.defaultConceptsDir = tmpDir;

        const stats = ConceptService.loadGraph();

        expect(stats.nodeCount).toBe(1);
        expect(stats.errors.length).toBe(1);
        expect(stats.errors[0]).toContain('missing required fields');

        fs.rmSync(tmpDir, {recursive: true});
    });

    test('loadGraph should report duplicate node IDs', () => {
        const nodes = [
            {id: 'dupe', name: 'First', tier: 1, description: 'A', uniqueToNeo: false, tags: []},
            {id: 'dupe', name: 'Second', tier: 1, description: 'B', uniqueToNeo: false, tags: []}
        ];
        const tmpDir = createTestFixture(nodes, []);

        ConceptService.defaultConceptsDir = tmpDir;

        const stats = ConceptService.loadGraph();

        expect(stats.nodeCount).toBe(1);
        expect(stats.errors.length).toBe(1);
        expect(stats.errors[0]).toContain('Duplicate node ID');

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── ensureLoaded guard ────────────────────────────────────

    test('should throw if query methods are called before loadGraph', () => {
        expect(() => ConceptService.getConceptTree()).toThrow('Graph not loaded');
        expect(() => ConceptService.findGuideGaps()).toThrow('Graph not loaded');
        expect(() => ConceptService.serializeForLLM()).toThrow('Graph not loaded');
    });

    // ── getConceptCoverage ────────────────────────────────────

    test('getConceptCoverage should return correct edge counts', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const coverage = ConceptService.getConceptCoverage('threading');

        expect(coverage.explainedBy.length).toBe(1);
        expect(coverage.implementedBy.length).toBe(1);
        expect(coverage.exemplifiedBy.length).toBe(0);

        // vdom has no edges
        const vdomCoverage = ConceptService.getConceptCoverage('vdom');

        expect(vdomCoverage.explainedBy.length).toBe(0);
        expect(vdomCoverage.implementedBy.length).toBe(0);

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── findGuideGaps ─────────────────────────────────────────

    test('findGuideGaps should identify concepts missing EXPLAINED_BY edges', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const gaps = ConceptService.findGuideGaps();

        // vdom has no EXPLAINED_BY or IMPLEMENTED_BY
        const vdomGap = gaps.find(g => g.concept.id === 'vdom');

        expect(vdomGap).toBeTruthy();
        expect(vdomGap.missingEdgeTypes).toContain('EXPLAINED_BY');
        expect(vdomGap.missingEdgeTypes).toContain('IMPLEMENTED_BY');
        expect(vdomGap.severity).toBe('CRITICAL');

        // threading is fully covered — should NOT appear
        const threadingGap = gaps.find(g => g.concept.id === 'threading');
        expect(threadingGap).toBeUndefined();
    });

    test('findGuideGaps should sort by weight descending', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const gaps = ConceptService.findGuideGaps();

        for (let i = 1; i < gaps.length; i++) {
            expect(gaps[i].weight).toBeLessThanOrEqual(gaps[i - 1].weight);
        }

        fs.rmSync(tmpDir, {recursive: true});
    });

    test('findGuideGaps should respect minWeight threshold', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const allGaps      = ConceptService.findGuideGaps(0),
              filteredGaps = ConceptService.findGuideGaps(1.0);

        expect(filteredGaps.length).toBeLessThanOrEqual(allGaps.length);

        for (const gap of filteredGaps) {
            expect(gap.weight).toBeGreaterThanOrEqual(1.0);
        }

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── calculateWeight ───────────────────────────────────────

    test('calculateWeight should factor tier, uniqueness, and coverage deficit', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        // vdom: tier 1 (0.8) + uniqueToNeo (0.2) + no EXPLAINED_BY (0.3) = 1.3
        const vdomNode   = ConceptService.nodes.get('vdom'),
              vdomWeight = ConceptService.calculateWeight(vdomNode);

        expect(vdomWeight).toBeCloseTo(1.3, 1);

        // threading: tier 1 (0.8) + uniqueToNeo (0.2) + has guide (0) = 1.0
        const threadingNode   = ConceptService.nodes.get('threading'),
              threadingWeight = ConceptService.calculateWeight(threadingNode);

        expect(threadingWeight).toBeCloseTo(1.0, 1);

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── classifyConcept ───────────────────────────────────────

    test('classifyConcept should return concepts implementing a given file', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const concepts = ConceptService.classifyConcept('src/worker/Manager.mjs');

        expect(concepts.length).toBe(1);
        expect(concepts[0].id).toBe('threading');
    });

    test('classifyConcept should return empty array for unknown files', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        expect(ConceptService.classifyConcept('src/unknown/Foo.mjs').length).toBe(0);

        fs.rmSync(tmpDir, {recursive: true});
    });

    test('classifyConcept should respect the limit parameter', () => {
        const nodes = [
            {id: 'c1', name: 'C1', tier: 1, description: 'A', uniqueToNeo: false, tags: []},
            {id: 'c2', name: 'C2', tier: 1, description: 'B', uniqueToNeo: false, tags: []},
            {id: 'c3', name: 'C3', tier: 1, description: 'C', uniqueToNeo: false, tags: []}
        ];
        const edges = [
            {source: 'c1', target: 'file:src/shared/Foo.mjs', type: 'IMPLEMENTED_BY'},
            {source: 'c2', target: 'file:src/shared/Foo.mjs', type: 'IMPLEMENTED_BY'},
            {source: 'c3', target: 'file:src/shared/Foo.mjs', type: 'IMPLEMENTED_BY'}
        ];
        const tmpDir = createTestFixture(nodes, edges);

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const defaultResult = ConceptService.classifyConcept('src/shared/Foo.mjs');
        expect(defaultResult.length).toBe(3);

        const limitedResult = ConceptService.classifyConcept('src/shared/Foo.mjs', {limit: 2});
        expect(limitedResult.length).toBe(2);

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── findConceptsRelevantTo ────────────────────────────────

    test('findConceptsRelevantTo should rank matches and respect limits', () => {
        const nodes = [
            {id: 'c1', name: 'Grid Component', tier: 1, description: 'Main grid component', uniqueToNeo: false, tags: ['grid']},
            {id: 'c2', name: 'Grid Row', tier: 2, description: 'Row for grid', uniqueToNeo: false, tags: ['grid', 'row']},
            {id: 'c3', name: 'Grid Cell', tier: 3, description: 'Cell for grid row', uniqueToNeo: false, tags: ['grid', 'cell']},
            {id: 'c4', name: 'Button', tier: 1, description: 'Clickable button', uniqueToNeo: false, tags: ['button']}
        ];
        const tmpDir = createTestFixture(nodes, []);

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const results = ConceptService.findConceptsRelevantTo('I need to fix the grid component', {limit: 2});
        expect(results.length).toBe(2);
        expect(results[0].id).toBe('c1');
        expect(results[1].id).toBe('c2');

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── findGapsRelevantTo ────────────────────────────────────

    test('findGapsRelevantTo should return missing gaps filtered by relevance and limit', () => {
        const nodes = [
            {id: 'c1', name: 'Grid Component', tier: 1, description: 'Main grid', uniqueToNeo: false, tags: ['grid']},
            {id: 'c2', name: 'Grid View', tier: 2, description: 'Grid visual', uniqueToNeo: false, tags: ['grid']},
            {id: 'c3', name: 'Button', tier: 1, description: 'Button', uniqueToNeo: false, tags: ['button']}
        ];
        const edges = [
            {source: 'c3', target: 'file:learn/guides/Button.md', type: 'EXPLAINED_BY'}
        ];
        const tmpDir = createTestFixture(nodes, edges);

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const gaps = ConceptService.findGapsRelevantTo('Document the grid component', {limit: 1});

        expect(gaps.length).toBe(1);
        expect(gaps[0].concept.id).toBe('c1');
        expect(gaps[0].missingEdgeTypes).toContain('EXPLAINED_BY');

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── getConceptTree ────────────────────────────────────────

    test('getConceptTree should build a nested tree from the anchor', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const tree = ConceptService.getConceptTree();

        expect(tree.id).toBe('root');
        expect(tree.tier).toBe(0);
        expect(tree.children.length).toBe(2);

        // Root nodes are Tier 1 concepts — every direct child of the anchor
        // must be tier 1, enforcing the ontology's top-level structure
        expect(tree.children.every(c => c.tier === 1)).toBe(true);

        const threadingChild = tree.children.find(c => c.id === 'threading');
        expect(threadingChild).toBeTruthy();
        expect(threadingChild.children.length).toBe(1);
        expect(threadingChild.children[0].id).toBe('reactivity');

        fs.rmSync(tmpDir, {recursive: true});
    });

    test('getConceptTree should respect maxTier filter', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const tree = ConceptService.getConceptTree(1);

        // Only tier 0 and tier 1 — reactivity (tier 2) should be excluded
        const threadingChild = tree.children.find(c => c.id === 'threading');

        expect(threadingChild.children.length).toBe(0);

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── serializeForLLM ───────────────────────────────────────

    test('serializeForLLM should produce tree with connector characters', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const tree  = ConceptService.serializeForLLM(2),
              lines = tree.split('\n');

        // Root line has no connector
        expect(lines[0]).toBe('Neo.mjs');

        // Children have connectors
        expect(tree).toContain('├─');
        expect(tree).toContain('└─');

        // Coverage annotations are correct — threading has an EXPLAINED_BY
        // edge so its line must carry the ✅ marker; vdom has no EXPLAINED_BY so its line
        // must carry the ❌ marker. Asserts markers are placed per-concept, not just present.
        const threadingLine = lines.find(l => l.includes('Multi-Threading'));
        const vdomLine      = lines.find(l => l.includes('JSON-First VDOM'));

        expect(threadingLine).toBeTruthy();
        expect(vdomLine).toBeTruthy();
        expect(threadingLine).toContain('✅');
        expect(vdomLine).toContain('❌');

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── getSummary ────────────────────────────────────────────

    test('getSummary should return correct coverage statistics', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const summary = ConceptService.getSummary();

        // 3 non-anchor concepts: threading (covered), vdom (gap), reactivity (covered)
        expect(summary.totalConcepts).toBe(3);
        expect(summary.guideGapCount).toBe(1);  // only vdom
        expect(summary.coveragePercent).toBe(67); // 2/3 covered

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── Production graph ──────────────────────────────────────

    test('should load the real production ontology without errors', () => {
        ConceptService.defaultConceptsDir = productionConceptsDir;

        const stats = ConceptService.loadGraph();

        expect(stats.errors.length).toBe(0);
        expect(stats.nodeCount).toBeGreaterThan(50);
        expect(stats.edgeCount).toBeGreaterThan(100);
    });

    // ── resolveAlias ──────────────────────────────────────────

    test('resolveAlias should resolve case-insensitive aliases to canonical concepts', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        // Exact alias match
        const result = ConceptService.resolveAlias('multi-worker');
        expect(result).toBeTruthy();
        expect(result.id).toBe('threading');

        // Case-insensitive
        const upper = ConceptService.resolveAlias('OMT Architecture');
        expect(upper).toBeTruthy();
        expect(upper.id).toBe('threading');

        // JSON VDOM alias
        const vdom = ConceptService.resolveAlias('json vdom');
        expect(vdom).toBeTruthy();
        expect(vdom.id).toBe('vdom');

        // Non-existent alias
        expect(ConceptService.resolveAlias('nonexistent-term')).toBeNull();

        // Direct ID lookup fallback
        const direct = ConceptService.resolveAlias('threading');
        expect(direct).toBeTruthy();
        expect(direct.id).toBe('threading');

        fs.rmSync(tmpDir, {recursive: true});
    });

    test('loadGraph should detect duplicate aliases across nodes', () => {
        const nodes = [
            {id: 'a', name: 'A', tier: 1, description: 'First', uniqueToNeo: false, tags: [], aliases: ['shared-alias']},
            {id: 'b', name: 'B', tier: 1, description: 'Second', uniqueToNeo: false, tags: [], aliases: ['shared-alias']}
        ];
        const tmpDir = createTestFixture(nodes, []);

        ConceptService.defaultConceptsDir = tmpDir;

        const stats = ConceptService.loadGraph();

        expect(stats.errors.length).toBe(1);
        expect(stats.errors[0]).toContain('Duplicate alias');
        expect(stats.errors[0]).toContain('shared-alias');

        fs.rmSync(tmpDir, {recursive: true});
    });

    test('loadGraph should clear aliasIndex on reload', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        expect(ConceptService.resolveAlias('multi-worker')).toBeTruthy();

        // Create a second fixture without aliases
        const tmpDir2 = createTestFixture(
            [{id: 'x', name: 'X', tier: 0, description: 'Clean', uniqueToNeo: false, tags: []}],
            []
        );

        ConceptService.defaultConceptsDir = tmpDir2;
        ConceptService.loadGraph();

        // Old aliases should be cleared
        expect(ConceptService.resolveAlias('multi-worker')).toBeNull();

        fs.rmSync(tmpDir, {recursive: true});
        fs.rmSync(tmpDir2, {recursive: true});
    });

    // ── getAnalogousConcepts ──────────────────────────────────

    test('getAnalogousConcepts should return ANALOGOUS_TO edges with notes', () => {
        const tmpDir = createMinimalFixture();

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const analogues = ConceptService.getAnalogousConcepts('vdom');

        expect(analogues.length).toBe(1);
        expect(analogues[0].target).toBe('ext:react-jsx');
        expect(analogues[0].type).toBe('ANALOGOUS_TO');
        expect(analogues[0].note).toContain('JSX');

        // Threading has one analogue
        const threadAnalogues = ConceptService.getAnalogousConcepts('threading');
        expect(threadAnalogues.length).toBe(1);
        expect(threadAnalogues[0].target).toBe('ext:react-concurrent');

        // No analogues for reactivity
        expect(ConceptService.getAnalogousConcepts('reactivity').length).toBe(0);

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── Tier 1-2 coverage completeness ───────────────────────

    test('serializeForLLM Tier 1-2 from production graph should produce non-empty output and report current size', () => {
        // Observability test (NOT a ceiling). The original contract called for a 100-line
        // cap, which codified a stale heuristic from a smaller-context era. Capping output
        // length works against the concept ontology's core purpose — it IS designed to grow
        // as the ontology gains richer Tier 1-2 coverage. A hard cap creates perverse
        // incentives: demote legitimate concepts to pass the test, or silently lift the cap.
        // Line count is a formatting proxy, not an architectural invariant — the real
        // curation discipline lives at the `tier` assignment layer in nodes.jsonl.
        //
        // This test logs the current size on every run (visible in CI output) so growth
        // trends and sudden jumps are observable, and asserts only that the serializer
        // didn't regress to empty output. The behavior-first rationale above is the durable contract.
        ConceptService.defaultConceptsDir = productionConceptsDir;
        ConceptService.loadGraph();

        const tree  = ConceptService.serializeForLLM(2),
              lines = tree.split('\n');

        console.log(`[ConceptService] serializeForLLM(2) produced ${lines.length} lines from the production graph`);

        expect(lines.length).toBeGreaterThan(0);
    });

    test('calculateWeight should order tier 1 above tier 3 at equal coverage', () => {
        // Tier 1 > Tier 3 in weight — explicit cross-tier ordering assertion.
        // Fixture holds a tier-1 and a tier-3 concept with identical coverage so the only
        // signal driving the weight delta is the tier multiplier.
        const nodes = [
            {id: 'tier1-node', name: 'Tier1', tier: 1, description: 'T1', uniqueToNeo: false, tags: []},
            {id: 'tier3-node', name: 'Tier3', tier: 3, description: 'T3', uniqueToNeo: false, tags: []}
        ];
        const edges = [
            {source: 'tier1-node', target: 'file:guide-1.md',  type: 'EXPLAINED_BY'},
            {source: 'tier1-node', target: 'file:impl-1.mjs',  type: 'IMPLEMENTED_BY'},
            {source: 'tier3-node', target: 'file:guide-3.md',  type: 'EXPLAINED_BY'},
            {source: 'tier3-node', target: 'file:impl-3.mjs',  type: 'IMPLEMENTED_BY'}
        ];
        const tmpDir = createTestFixture(nodes, edges);

        ConceptService.defaultConceptsDir = tmpDir;
        ConceptService.loadGraph();

        const tier1Weight = ConceptService.calculateWeight(ConceptService.nodes.get('tier1-node'));
        const tier3Weight = ConceptService.calculateWeight(ConceptService.nodes.get('tier3-node'));

        expect(tier1Weight).toBeGreaterThan(tier3Weight);

        fs.rmSync(tmpDir, {recursive: true});
    });

    // ── Production graph: aliases & ANALOGOUS_TO ──────────────

    test('production graph should have aliases and ANALOGOUS_TO edges', () => {
        ConceptService.defaultConceptsDir = productionConceptsDir;
        ConceptService.loadGraph();

        // Alias index should be populated
        expect(ConceptService.aliasIndex.size).toBeGreaterThan(0);

        // OMT should resolve to off-main-thread
        const omt = ConceptService.resolveAlias('OMT');
        expect(omt).toBeTruthy();
        expect(omt.id).toBe('off-main-thread');

        // ANALOGOUS_TO edges should exist in the production graph
        const stateAnalogues = ConceptService.getAnalogousConcepts('state-provider');
        expect(stateAnalogues.length).toBeGreaterThan(0);

        // All ANALOGOUS_TO targets should use the ext: prefix
        for (const edge of stateAnalogues) {
            expect(edge.target.startsWith('ext:')).toBe(true);
        }
    });

    // ── importEdges ───────────────────────────────────────────

    test.describe('importEdges', () => {
        const
            engineVersion = createRequire(import.meta.url)('neo.mjs/package.json').version,
            brainVersion  = resolveBrainRootVersion();

        function createSyntheticImportStore(edges = []) {
            const nodes = [
                {id: 'root-anchor',       name: 'Root Anchor',       tier: 0, description: 'Anchor',    uniqueToNeo: false, tags: []},
                {id: 'alpha-concept',     name: 'Alpha Concept',     tier: 1, description: 'Validated', uniqueToNeo: true,  tags: ['core']},
                {id: 'beta-concept',      name: 'Beta Concept',      tier: 2, description: 'Validated', uniqueToNeo: false, tags: ['core'], validated: true},
                {id: 'candidate-concept', name: 'Candidate Concept', tier: 3, description: 'Candidate', uniqueToNeo: false, tags: [],       validated: false}
            ];

            return createTestFixture(nodes, edges);
        }

        test('classifies added, equal, differs, removed, absent, and refused rows in separate report lists', () => {
            expect(brainVersion).toMatch(/^[a-f0-9]{40}$/);

            const tmpDir = createSyntheticImportStore([
                {source: 'alpha-concept', target: 'file:src/Neo.mjs',                             type: 'IMPLEMENTED_BY'},
                {source: 'beta-concept',  target: 'ext:prior-analogue',                           type: 'ANALOGOUS_TO', note: 'Original distinction.'},
                {source: 'beta-concept',  target: 'file:ai/services/DeletedHistoricalTarget.mjs', type: 'IMPLEMENTED_BY'}
            ]);

            try {
                ConceptService.defaultConceptsDir = tmpDir;

                const report = ConceptService.importEdges({
                    tenant: 'neo-shared',
                    rows  : [
                        {source: 'alpha-concept', target: 'file:ai/services/ConceptService.mjs',          type: 'IMPLEMENTED_BY'},
                        {source: 'alpha-concept', target: 'file:src/Neo.mjs',                             type: 'IMPLEMENTED_BY'},
                        {source: 'beta-concept',  target: 'ext:prior-analogue',                           type: 'ANALOGOUS_TO', note: 'Changed without removal.'},
                        {source: 'beta-concept',  target: 'file:ai/services/DeletedHistoricalTarget.mjs', type: 'IMPLEMENTED_BY', op: 'remove', decision: 'neomjs/neo#19235'},
                        {source: 'alpha-concept', target: 'ext:never-existed',                            type: 'ANALOGOUS_TO',   op: 'remove', decision: 'adr:0024-native-edge-graph-model'},
                        {source: 'alpha-concept', target: 'file:src/Neo.mjs',                             type: 'NOT_A_REAL_TYPE'}
                    ]
                });

                expect(report.ok).toBe(false);
                expect(report.written).toBe(true);
                expect(report.tenant).toBe('neo-shared');
                expect(report.counts).toEqual({
                    total  : 6,
                    added  : 1,
                    equal  : 1,
                    differs: 1,
                    removed: 1,
                    absent : 1,
                    refused: 1
                });

                expect(report.added).toEqual([{
                    index      : 0,
                    source     : 'alpha-concept',
                    target     : 'file:ai/services/ConceptService.mjs',
                    type       : 'IMPLEMENTED_BY',
                    root       : 'neo-agent-brain',
                    rootVersion: brainVersion
                }]);
                expect(report.equal).toEqual([{
                    index      : 1,
                    source     : 'alpha-concept',
                    target     : 'file:src/Neo.mjs',
                    type       : 'IMPLEMENTED_BY',
                    root       : 'neo.mjs',
                    rootVersion: engineVersion
                }]);
                expect(report.differs).toMatchObject([{
                    index       : 2,
                    source      : 'beta-concept',
                    target      : 'ext:prior-analogue',
                    type        : 'ANALOGOUS_TO',
                    existingNote: 'Original distinction.',
                    note        : 'Changed without removal.'
                }]);
                expect(report.removed).toEqual([{
                    index   : 3,
                    source  : 'beta-concept',
                    target  : 'file:ai/services/DeletedHistoricalTarget.mjs',
                    type    : 'IMPLEMENTED_BY',
                    decision: 'neomjs/neo#19235'
                }]);
                expect(report.absent).toEqual([{
                    index   : 4,
                    source  : 'alpha-concept',
                    target  : 'ext:never-existed',
                    type    : 'ANALOGOUS_TO',
                    decision: 'adr:0024-native-edge-graph-model'
                }]);
                expect(report.refused).toMatchObject([{
                    index: 5,
                    code : 'UNSUPPORTED_EDGE_TYPE'
                }]);

                const persisted = ConceptService.parseJsonl(path.join(tmpDir, 'edges.jsonl'));
                expect(persisted).toEqual([
                    {source: 'alpha-concept', target: 'file:src/Neo.mjs',                    type: 'IMPLEMENTED_BY'},
                    {source: 'beta-concept',  target: 'ext:prior-analogue',                  type: 'ANALOGOUS_TO', note: 'Original distinction.'},
                    {source: 'alpha-concept', target: 'file:ai/services/ConceptService.mjs', type: 'IMPLEMENTED_BY'}
                ]);
            } finally {
                fs.rmSync(tmpDir, {recursive: true, force: true});
            }
        });

        test('covers every refusal reason for invalid endpoints, targets, types, and unbacked removals', () => {
            const tmpDir = createSyntheticImportStore([
                {source: 'alpha-concept', target: 'ext:kept-analogue', type: 'ANALOGOUS_TO', note: 'Kept.'}
            ]);

            try {
                ConceptService.defaultConceptsDir = tmpDir;
                const beforeBytes = fs.readFileSync(path.join(tmpDir, 'edges.jsonl'), 'utf8');

                const report = ConceptService.importEdges({
                    tenant: 'neo-shared',
                    rows  : [
                        null,
                        {source: '',                  target: 'file:src/Neo.mjs',             type: 'IMPLEMENTED_BY'},
                        {source: 'unknown-concept',   target: 'file:src/Neo.mjs',             type: 'IMPLEMENTED_BY'},
                        {source: 'candidate-concept', target: 'file:src/Neo.mjs',             type: 'IMPLEMENTED_BY'},
                        {source: 'alpha-concept',     target: 'unknown-target-concept',       type: 'REQUIRES'},
                        {source: 'alpha-concept',     target: 'candidate-concept',            type: 'REQUIRES'},
                        {source: 'alpha-concept',     target: 'file:src/Neo.mjs',             type: 'INVENTED_EDGE'},
                        {source: 'alpha-concept',     target: '   ',                          type: 'IMPLEMENTED_BY'},
                        {source: 'alpha-concept',     target: 'file:src/DoesNotExistAtAll.js', type: 'IMPLEMENTED_BY'},
                        {source: 'alpha-concept',     target: 'ext:   ',                      type: 'ANALOGOUS_TO'},
                        {source: 'alpha-concept',     target: 'ext:kept-analogue',            type: 'ANALOGOUS_TO', op: 'remove'},
                        {source: 'alpha-concept',     target: 'ext:kept-analogue',            type: 'ANALOGOUS_TO', op: 'remove', decision: 'just cleaning up'},
                        {source: 'alpha-concept',     target: 'ext:kept-analogue',            type: 'ANALOGOUS_TO', op: 'remove', decision: 'agreed on 2026-11-09'},
                        {source: 'alpha-concept',     target: 'ext:kept-analogue',            type: 'ANALOGOUS_TO', op: 'remove', decision: 'see chat 1234-abc'},
                        {source: 'alpha-concept',     target: 'ext:kept-analogue',            type: 'ANALOGOUS_TO', op: 'upsert'},
                        {source: 'alpha-concept',     target: 'ext:new-analogue',             type: 'ANALOGOUS_TO', note: 42}
                    ]
                });

                expect(isValidDecisionReference('agreed on 2026-11-09')).toBe(false);
                expect(isValidDecisionReference('2026-11-09')).toBe(false);
                expect(isValidDecisionReference('see chat 1234-abc')).toBe(false);
                expect(isValidDecisionReference('0024-native-edge-graph-model')).toBe(false);
                expect(isValidDecisionReference('#1551')).toBe(true);
                expect(isValidDecisionReference('neomjs/neo#19235')).toBe(true);
                expect(isValidDecisionReference('GH-1549')).toBe(true);
                expect(isValidDecisionReference('https://github.com/neomjs/neo-agent-brain/pull/1549')).toBe(true);
                expect(isValidDecisionReference('ADR-0024')).toBe(true);
                expect(isValidDecisionReference('adr:0024-native-edge-graph-model')).toBe(true);
                expect(isValidDecisionReference('learn/agentos/decisions/0024-native-edge-graph-model.md')).toBe(true);

                expect(report.ok).toBe(false);
                expect(report.written).toBe(false);
                expect(report.refused.map(entry => entry.code)).toEqual([
                    'INVALID_ROW',
                    'MISSING_SOURCE_CONCEPT',
                    'MISSING_SOURCE_CONCEPT',
                    'UNVALIDATED_SOURCE_CONCEPT',
                    'MISSING_TARGET_CONCEPT',
                    'UNVALIDATED_TARGET_CONCEPT',
                    'UNSUPPORTED_EDGE_TYPE',
                    'INVALID_EDGE_TARGET',
                    'MISSING_FILE',
                    'INVALID_EDGE_TARGET',
                    'MISSING_DECISION',
                    'INVALID_DECISION',
                    'INVALID_DECISION',
                    'INVALID_DECISION',
                    'UNSUPPORTED_OP',
                    'INVALID_NOTE'
                ]);
                expect(fs.readFileSync(path.join(tmpDir, 'edges.jsonl'), 'utf8')).toBe(beforeBytes);
            } finally {
                fs.rmSync(tmpDir, {recursive: true, force: true});
            }
        });

        test('second identical run reports only equal and absent and leaves edges.jsonl untouched', () => {
            const tmpDir = createSyntheticImportStore([
                {source: 'beta-concept', target: 'file:ai/services/LegacyGone.mjs', type: 'IMPLEMENTED_BY'}
            ]);

            try {
                ConceptService.defaultConceptsDir = tmpDir;

                const batch = [
                    {source: 'alpha-concept', target: 'file:src/Neo.mjs',                    type: 'IMPLEMENTED_BY'},
                    {source: 'alpha-concept', target: 'file:ai/services/ConceptService.mjs', type: 'IMPLEMENTED_BY'},
                    {source: 'alpha-concept', target: 'beta-concept',                        type: 'PARENT_CONCEPT'},
                    {source: 'alpha-concept', target: 'ext:external-ref',                    type: 'ANALOGOUS_TO', note: 'Explicit note.'},
                    {source: 'beta-concept',  target: 'file:ai/services/LegacyGone.mjs',     type: 'IMPLEMENTED_BY', op: 'remove', decision: '#1551'}
                ];

                const first = ConceptService.importEdges({tenant: 'neo-shared', rows: batch});
                expect(first.ok).toBe(true);
                expect(first.written).toBe(true);
                expect(first.counts).toEqual({total: 5, added: 4, equal: 0, differs: 0, removed: 1, absent: 0, refused: 0});

                const afterFirstBytes = fs.readFileSync(path.join(tmpDir, 'edges.jsonl'), 'utf8');

                const second = ConceptService.importEdges({tenant: 'neo-shared', rows: batch});
                expect(second.ok).toBe(true);
                expect(second.written).toBe(false);
                expect(second.counts).toEqual({total: 5, added: 0, equal: 4, differs: 0, removed: 0, absent: 1, refused: 0});
                expect(fs.readFileSync(path.join(tmpDir, 'edges.jsonl'), 'utf8')).toBe(afterFirstBytes);
            } finally {
                fs.rmSync(tmpDir, {recursive: true, force: true});
            }
        });

        test('replaces a note cleanly when removed with a valid decision reference and re-added', () => {
            const tmpDir = createSyntheticImportStore([
                {source: 'alpha-concept', target: 'ext:sample-system', type: 'ANALOGOUS_TO', note: 'Old note.'}
            ]);

            try {
                ConceptService.defaultConceptsDir = tmpDir;

                const result = ConceptService.importEdges({
                    tenant: 'neo-shared',
                    rows  : [
                        {source: 'alpha-concept', target: 'ext:sample-system', type: 'ANALOGOUS_TO', op: 'remove', decision: 'ADR-0024'},
                        {source: 'alpha-concept', target: 'ext:sample-system', type: 'ANALOGOUS_TO', note: 'Updated note.'}
                    ]
                });

                expect(result.ok).toBe(true);
                expect(result.counts.removed).toBe(1);
                expect(result.counts.added).toBe(1);
                expect(ConceptService.parseJsonl(path.join(tmpDir, 'edges.jsonl'))).toEqual([
                    {source: 'alpha-concept', target: 'ext:sample-system', type: 'ANALOGOUS_TO', note: 'Updated note.'}
                ]);
            } finally {
                fs.rmSync(tmpDir, {recursive: true, force: true});
            }
        });

        test('requires tenant, refuses non-core tenants naming #473, and reports nothing written on missing store or dryRun', () => {
            const tmpDir = createSyntheticImportStore([]);

            try {
                ConceptService.defaultConceptsDir = tmpDir;

                const missingTenant = ConceptService.importEdges({
                    rows: [{source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}]
                });
                expect(missingTenant.ok).toBe(false);
                expect(missingTenant.written).toBe(false);
                expect(missingTenant.code).toBe('MISSING_TENANT');

                const foreignTenant = ConceptService.importEdges({
                    tenant: 'other-tenant',
                    rows  : [{source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}]
                });
                expect(foreignTenant.ok).toBe(false);
                expect(foreignTenant.written).toBe(false);
                expect(foreignTenant.tenant).toBe('other-tenant');
                expect(foreignTenant.code).toBe('UNSUPPORTED_TENANT');
                expect(foreignTenant.reason).toContain('#473');

                const dryRunReport = ConceptService.importEdges({
                    tenant: 'neo-shared',
                    dryRun: true,
                    rows  : [{source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}]
                });
                expect(dryRunReport.ok).toBe(true);
                expect(dryRunReport.written).toBe(false);
                expect(dryRunReport.dryRun).toBe(true);
                expect(dryRunReport.added).toHaveLength(1);
                expect(fs.readFileSync(path.join(tmpDir, 'edges.jsonl'), 'utf8')).toBe('');

                const missingStoreDir = path.join(tmpDir, 'does-not-exist');
                ConceptService.defaultConceptsDir = missingStoreDir;
                const noDirReport = ConceptService.importEdges({
                    tenant: 'neo-shared',
                    rows  : [{source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}]
                });
                expect(noDirReport.ok).toBe(false);
                expect(noDirReport.written).toBe(false);
                expect(noDirReport.code).toBe('STORE_NOT_FOUND');
                expect(fs.existsSync(missingStoreDir)).toBe(false);

                const emptyStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-concept-empty-'));
                try {
                    ConceptService.defaultConceptsDir = emptyStoreDir;
                    const noNodesReport = ConceptService.importEdges({
                        tenant: 'neo-shared',
                        rows  : [{source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}]
                    });
                    expect(noNodesReport.ok).toBe(false);
                    expect(noNodesReport.written).toBe(false);
                    expect(noNodesReport.code).toBe('STORE_NOT_FOUND');
                    expect(fs.existsSync(path.join(emptyStoreDir, 'edges.jsonl'))).toBe(false);
                } finally {
                    fs.rmSync(emptyStoreDir, {recursive: true, force: true});
                }
            } finally {
                fs.rmSync(tmpDir, {recursive: true, force: true});
            }
        });

        test('preserves untouched store lines verbatim—including duplicate tuples, rows missing type, and malformed JSONL—and refuses ambiguous duplicate-tuple removals', () => {
            const tmpDir = createSyntheticImportStore([]);

            try {
                const
                    edgesPath    = path.join(tmpDir, 'edges.jsonl'),
                    initialLines = [
                        JSON.stringify({source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}),
                        JSON.stringify({source: 'beta-concept',  target: 'ext:shared-tuple', type: 'ANALOGOUS_TO', note: 'First note.'}),
                        JSON.stringify({source: 'beta-concept',  target: 'ext:shared-tuple', type: 'ANALOGOUS_TO', note: 'Second note.'}),
                        JSON.stringify({source: 'alpha-concept', target: 'beta-concept'}),
                        '{"source":"alpha-concept","target":"beta-concept","type":"PARENT_CONCEPT",}'
                    ];

                fs.writeFileSync(edgesPath, `${initialLines.join('\n')}\n`, 'utf8');
                ConceptService.defaultConceptsDir = tmpDir;

                const addReport = ConceptService.importEdges({
                    tenant: 'neo-shared',
                    rows  : [
                        {source: 'alpha-concept', target: 'file:ai/services/ConceptService.mjs', type: 'IMPLEMENTED_BY'}
                    ]
                });

                expect(addReport.ok).toBe(true);
                expect(addReport.written).toBe(true);
                expect(addReport.counts).toEqual({
                    total  : 1,
                    added  : 1,
                    equal  : 0,
                    differs: 0,
                    removed: 0,
                    absent : 0,
                    refused: 0
                });

                const afterAddLines = fs.readFileSync(edgesPath, 'utf8').trimEnd().split('\n');
                expect(afterAddLines).toEqual([
                    ...initialLines,
                    JSON.stringify({source: 'alpha-concept', target: 'file:ai/services/ConceptService.mjs', type: 'IMPLEMENTED_BY'})
                ]);

                const dupRemoveReport = ConceptService.importEdges({
                    tenant: 'neo-shared',
                    rows  : [
                        {source: 'beta-concept', target: 'ext:shared-tuple', type: 'ANALOGOUS_TO', op: 'remove', decision: '#1551'}
                    ]
                });

                expect(dupRemoveReport.ok).toBe(false);
                expect(dupRemoveReport.written).toBe(false);
                expect(dupRemoveReport.refused).toMatchObject([{
                    index: 0,
                    code : 'DUPLICATE_STORE_TUPLE'
                }]);
                expect(fs.readFileSync(edgesPath, 'utf8').trimEnd().split('\n')).toEqual(afterAddLines);
            } finally {
                fs.rmSync(tmpDir, {recursive: true, force: true});
            }
        });

        test('resolves Brain rootVersion from .neo-revision image stamp when git metadata is absent', () => {
            const stampDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-brain-stamp-')),
                  stampSha = 'b'.repeat(40);

            try {
                fs.writeFileSync(path.join(stampDir, '.neo-revision'), `${stampSha}\n`, 'utf8');
                expect(resolveBrainRootVersion(stampDir)).toBe(stampSha);
            } finally {
                fs.rmSync(stampDir, {recursive: true, force: true});
            }
        });

        test('refuses production store paths under a test runner via assertTestWriteIsolated without an env bypass option', () => {
            ConceptService.defaultConceptsDir = '/var/neo-ai-data/concepts';

            expect(() => ConceptService.importEdges({
                tenant: 'neo-shared',
                rows  : [{source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}]
            })).toThrow(/STORE_WRITE_GUARD: refusing a concept-ontology write/);

            expect(() => ConceptService.importEdges({
                tenant: 'neo-shared',
                env   : {},
                rows  : [{source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}]
            })).toThrow(/STORE_WRITE_GUARD: refusing a concept-ontology write/);

            ConceptService.defaultConceptsDir = productionConceptsDir;

            let thrown = null;
            try {
                ConceptService.importEdges({
                    tenant: 'neo-shared',
                    env   : {},
                    rows  : [{source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}]
                });
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeTruthy();
            expect(thrown.message).toContain('STORE_WRITE_GUARD');
        });
    });
});
