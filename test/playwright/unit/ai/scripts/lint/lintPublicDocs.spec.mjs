import {test, expect}                          from '@playwright/test';
import fs                                      from 'node:fs';
import os                                      from 'node:os';
import path                                    from 'node:path';
import {lintPublicDocs, stripFencedCodeBlocks} from '../../../../../../ai/scripts/lint/lint-public-docs.mjs';

const createdRoots = [];

/**
 * @summary Builds an isolated Brain docs fixture under `os.tmpdir()` for targeted public-docs lint verification.
 * @param {Object} [overrides={}]
 * @returns {String}
 */
function createFixture({
    guideBody          = '# Memory Core\n\nSee [A2A](./A2A.md) and [`ai/services.mjs`](../../ai/services.mjs) by `@neo-opus-grace`.\n',
    extraTreeLeaf      = false,
    extraManifestEntry = false,
    includeAdrInTree   = false,
    orphanParentId     = false,
    routeOverride      = null
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-public-docs-'));
    createdRoots.push(root);

    fs.mkdirSync(path.join(root, 'docs'), {recursive: true});
    fs.mkdirSync(path.join(root, 'learn/agentos/decisions'), {recursive: true});
    fs.mkdirSync(path.join(root, 'learn/benefits/brain'), {recursive: true});
    fs.mkdirSync(path.join(root, 'ai/mcp/server/knowledge-base'), {recursive: true});
    fs.mkdirSync(path.join(root, 'deploy/cloud'), {recursive: true});

    fs.writeFileSync(path.join(root, 'ai/services.mjs'), 'export default {};\n');
    fs.writeFileSync(path.join(root, 'ai/mcp/server/knowledge-base/config.mjs'), 'export default {};\n');
    fs.writeFileSync(path.join(root, 'deploy/cloud/docker-compose.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(root, 'learn/agentos/A2A.md'), '# A2A\n');
    fs.writeFileSync(path.join(root, 'learn/agentos/MemoryCore.md'), guideBody);
    fs.writeFileSync(path.join(root, 'learn/agentos/IdentitySchema.md'), '# Unlisted Stage-2 Doc\n');
    fs.writeFileSync(path.join(root, 'learn/agentos/decisions/0019-aiconfig-reactive-provider-ssot.md'), '# ADR 0019\n');

    const treeData = [
        {name: 'Brain Interface, Fleet & Agent Tooling', parentId: null,              isLeaf: false, id: 'AgentInterfaces'},
        {name: 'Agent OS',                               parentId: 'AgentInterfaces', isLeaf: false, id: 'AgentOS'},
        {name: 'A2A Messaging',                          parentId: 'AgentOS',                        id: 'agentos/A2A'},
        {name: 'Memory Core',                            parentId: orphanParentId ? 'Missing' : 'AgentOS', id: 'agentos/MemoryCore'}
    ];

    if (extraTreeLeaf) {
        fs.writeFileSync(path.join(root, 'learn/agentos/Extra.md'), '# Extra\n');
        treeData.push({name: 'Extra', parentId: 'AgentOS', id: 'agentos/Extra'})
    }

    const entries = [
        {file: 'learn/agentos/A2A.md',        route: '/learn/agentos/A2A'},
        {file: 'learn/agentos/MemoryCore.md', route: routeOverride || '/learn/agentos/MemoryCore'}
    ];

    if (extraManifestEntry) {
        entries.push({file: 'learn/agentos/IdentitySchema.md', route: '/learn/agentos/IdentitySchema'})
    }

    if (includeAdrInTree) {
        treeData.push({name: 'ADR 0019', parentId: 'AgentOS', id: 'agentos/decisions/0019-aiconfig-reactive-provider-ssot'});
        entries.push({
            file : 'learn/agentos/decisions/0019-aiconfig-reactive-provider-ssot.md',
            route: '/learn/agentos/decisions/0019-aiconfig-reactive-provider-ssot'
        })
    }

    fs.writeFileSync(path.join(root, 'learn/tree.json'), JSON.stringify({data: treeData}, null, 4));
    fs.writeFileSync(path.join(root, 'docs/public-manifest.json'), JSON.stringify({
        schema    : 'public-manifest.v1',
        spoke     : 'neomjs/neo-agent-brain',
        treeFile  : 'learn/tree.json',
        treeMounts: [
            {parentId: 'AgentInterfaces', id: 'AgentOS', name: 'Agent OS'}
        ],
        entries
    }, null, 4));

    return root
}

test.describe('ai/scripts/lint/lint-public-docs', () => {
    test.afterEach(() => {
        while (createdRoots.length > 0) {
            fs.rmSync(createdRoots.pop(), {recursive: true, force: true})
        }
    });

    test('the live neomjs/neo-agent-brain manifest admits all 62 pre-split product guides (6 + 23 + 18 + 15) and excludes ADRs/measurements/incidents', () => {
        const result = lintPublicDocs();

        expect(result.entryCount).toBe(62);

        const benefitsRoutes = result.routes.filter(r => r.startsWith('/learn/benefits/brain/'));
        const toolingRoutes  = result.routes.filter(r => r.startsWith('/learn/agentos/tooling/'));
        const cloudRoutes    = result.routes.filter(r => r.startsWith('/learn/agentos/cloud-deployment/'));
        const coreRoutes     = result.routes.filter(r =>
            r.startsWith('/learn/agentos/') &&
            !r.startsWith('/learn/agentos/tooling/') &&
            !r.startsWith('/learn/agentos/cloud-deployment/')
        );

        expect(benefitsRoutes).toHaveLength(6);
        expect(coreRoutes).toHaveLength(23);
        expect(toolingRoutes).toHaveLength(18);
        expect(cloudRoutes).toHaveLength(15);

        for (const required of [
            '/learn/agentos/tooling/Introduction',
            '/learn/agentos/SharedDeployment',
            '/learn/agentos/DeploymentCookbook',
            '/learn/agentos/cloud-deployment/PipelineWiring',
            '/learn/agentos/MemoryCore',
            '/learn/agentos/KnowledgeBase',
            '/learn/agentos/DreamPipeline',
            '/learn/agentos/SwarmIntelligence',
            '/learn/agentos/StrategicWorkflows',
            '/learn/agentos/SelfHealing',
            '/learn/agentos/CodeExecution',
            '/learn/benefits/brain/AIEngineeringTeam',
            '/learn/benefits/brain/IdentityRitualsCulture',
            '/learn/benefits/brain/AgentMemory',
            '/learn/benefits/brain/SelfEvolution',
            '/learn/benefits/brain/AgentOSOnYourCodebase',
            '/learn/benefits/brain/DeployingTheAgentOS'
        ]) {
            expect(result.routes).toContain(required)
        }

        expect(result.routes.some(r => /\/(?:decisions|measurements|incidents)\//.test(r))).toBe(false)
    });

    test('passes clean prose with committed ai/** links, /Users/<you>/ placeholders, and public @neo-* handles', () => {
        const root = createFixture({
            guideBody: [
                '# Memory Core',
                '',
                'Clone into `/Users/<you>/workspace/neo-agent-brain` and inspect [`ai/services.mjs`](../../ai/services.mjs).',
                'Reviewed by `@neo-gemini-julia` and `@neo-opus-grace`. See [A2A](./A2A.md).'
            ].join('\n')
        });

        expect(lintPublicDocs({root}).entryCount).toBe(2)
    });

    test('rejects real Unix/macOS and Windows host filesystem paths including file:// URLs', () => {
        const unixRoot    = createFixture({guideBody: '# Leak\n\nPath `/Users/alice/.neo-ai/brain/learn/A2A.md`.\n'});
        const fileUrlRoot = createFixture({guideBody: '# Leak\n\nShot at `file:///Users/alice/x/shot.png`.\n'});
        const winRoot     = createFixture({guideBody: '# Leak\n\nPath `C:\\Users\\alice\\brain\\learn\\A2A.md`.\n'});

        expect(() => lintPublicDocs({root: unixRoot})).toThrow(/forbidden host filesystem path "\/Users\/alice\//);
        expect(() => lintPublicDocs({root: fileUrlRoot})).toThrow(/forbidden host filesystem path "\/Users\/alice\/x\/shot\.png"/);
        expect(() => lintPublicDocs({root: winRoot})).toThrow(/forbidden Windows host filesystem path/)
    });

    test('rejects private repository references, externally supplied forbidden terms, and ADR leakage', () => {
        for (const repo of ['neomjs/business', 'neomjs/neo-stage', 'neomjs/neo-pro']) {
            const root = createFixture({guideBody: `# Leak\n\nSee ${repo}#10.\n`});
            expect(() => lintPublicDocs({root})).toThrow(/forbidden private-repository reference/)
        }

        const termRoot = createFixture({guideBody: '# Leak\n\nBuilt for SyntheticRestrictedClientName internal use.\n'});
        expect(() => lintPublicDocs({root: termRoot, forbiddenTerms: ['SyntheticRestrictedClientName']}))
            .toThrow(/forbidden term "SyntheticRestrictedClientName"/);

        const adrRoot = createFixture({includeAdrInTree: true});
        expect(() => lintPublicDocs({root: adrRoot})).toThrow(/excluded internal record/)
    });

    test('rejects manifest/tree drift, orphan parentIds, and unpublished/gitignored/non-ai relative links', () => {
        expect(() => lintPublicDocs({root: createFixture({extraTreeLeaf: true})}))
            .toThrow(/leaf "learn\/agentos\/Extra\.md" is missing/);

        expect(() => lintPublicDocs({root: createFixture({extraManifestEntry: true})}))
            .toThrow(/"learn\/agentos\/IdentitySchema\.md" is not a leaf/);

        expect(() => lintPublicDocs({root: createFixture({orphanParentId: true})}))
            .toThrow(/references missing or leaf parentId "Missing"/);

        expect(() => lintPublicDocs({root: createFixture({routeOverride: '/learn/wrong/MemoryCore'})}))
            .toThrow(/does not match expected route/);

        const fencedRoot = createFixture({
            guideBody: '# Memory Core\n\n```markdown\n[Example](./DoesNotExist.md)\n```\nInline `[Code](./DoesNotExist.md)` stays inert.\n'
        });
        expect(stripFencedCodeBlocks('a\n```js\nb\n```\nc')).toBe('a\n\n\n\nc');
        expect(lintPublicDocs({root: fencedRoot}).entryCount).toBe(2);

        const unlistedDocRoot = createFixture({
            guideBody: '# Memory Core\n\nSee [IdentitySchema](./IdentitySchema.md) and [ADR](./decisions/0019-aiconfig-reactive-provider-ssot.md).\n'
        });
        expect(() => lintPublicDocs({root: unlistedDocRoot})).toThrow(/broken relative Markdown link "\.\/IdentitySchema\.md"/);

        const gitignoredConfigRoot = createFixture({
            guideBody: '# Memory Core\n\nSee [`config.mjs`](../../ai/mcp/server/knowledge-base/config.mjs).\n'
        });
        expect(() => lintPublicDocs({root: gitignoredConfigRoot})).toThrow(/broken relative Markdown link "\.\.\/\.\.\/ai\/mcp\/server\/knowledge-base\/config\.mjs"/);

        const nonAiOutsideRoot = createFixture({
            guideBody: '# Memory Core\n\nSee [`docker-compose.yml`](../../deploy/cloud/docker-compose.yml).\n'
        });
        expect(() => lintPublicDocs({root: nonAiOutsideRoot})).toThrow(/broken relative Markdown link "\.\.\/\.\.\/deploy\/cloud\/docker-compose\.yml"/)
    })
});
