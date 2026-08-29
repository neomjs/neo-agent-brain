import {test, expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import fs             from 'node:fs';
import path           from 'node:path';

import {load as loadYaml} from 'js-yaml';

/**
 * @summary Pins the Host-Edge root and independently installed Container-Cloud package boundary.
 *
 * This is deliberately a filesystem contract, not another migration inventory. The package homes,
 * manifests, script ownership, and normalized Compose paths are the product surface themselves.
 */

const
    repoRoot          = path.resolve(process.cwd()),
    hostDir           = path.join(repoRoot, 'deploy/host'),
    cloudDir          = path.join(repoRoot, 'deploy/cloud'),
    cloudPackageDir   = path.join(repoRoot, 'cloud'),
    installedBrainDir = path.join(cloudPackageDir, 'node_modules/neo-agent-brain'),
    testServersDir    = path.join(repoRoot, 'test/playwright/integration/fixtures/servers'),

    HOST_DEFINITIONS = [
        'com.neomjs.agent-os-host-edge.plist',
        'com.neomjs.agent-os-wake.plist'
    ],

    CLOUD_DEFINITIONS = [
        'Caddyfile',
        'Caddyfile.local-agent-os',
        'Caddyfile.parity-capture',
        'Dockerfile',
        'Dockerfile.dockerignore',
        'docker-compose.dev.yml',
        'docker-compose.local-agent-os.yml',
        'docker-compose.parity-capture.yml',
        'docker-compose.parity-ci.yml',
        'docker-compose.provider-lanes.yml',
        'docker-compose.test.yml',
        'docker-compose.yml',
        'kb-config.yaml'
    ],

    CLOUD_PACKAGE_FILES = ['.npmrc', 'package-lock.json', 'package.json'],

    TEST_SERVER_FIXTURES = [
        'mock-oidc-server.mjs',
        'mock-openai-embedding-server.mjs'
    ],

    CLOUD_SCRIPT_KEYS = [
        'ai:backup',
        'ai:check-backup-integrity',
        'ai:check-chroma-integrity',
        'ai:community-source-operator',
        'ai:compact-graphlog',
        'ai:defrag-kb',
        'ai:download-kb',
        'ai:fleet-healthcheck',
        'ai:fleet-server',
        'ai:graph-lifecycle-report',
        'ai:ingest-tenant',
        'ai:mcp-server-knowledge-base',
        'ai:mcp-server-memory-core',
        'ai:migration-census-report',
        'ai:orchestrator',
        'ai:provider-lane-composition',
        'ai:provider-lane-election',
        'ai:reseed',
        'ai:restore',
        'ai:run-sandman',
        'ai:server',
        'ai:summarize-sessions',
        'ai:sync-kb',
        'compose:up',
        'prepare:runtime'
    ];

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * @summary Whether `candidate` resolves at or below `root`, with path segments normalized first.
 * @param {String} root
 * @param {String} candidate
 * @returns {Boolean}
 */
function resolvesInside(root, candidate) {
    const resolved = path.resolve(root, candidate);

    return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

test('deployment definitions have one exact plane-owned home', () => {
    expect(fs.readdirSync(hostDir).sort()).toEqual(HOST_DEFINITIONS.sort());
    expect(fs.readdirSync(cloudDir).sort()).toEqual(CLOUD_DEFINITIONS.sort());
    expect(fs.readdirSync(cloudPackageDir).filter(name => !['node_modules', 'neo-agent-brain-head.tgz'].includes(name)).sort())
        .toEqual(CLOUD_PACKAGE_FILES.sort());
    for (const fixture of TEST_SERVER_FIXTURES) {
        expect(fs.existsSync(path.join(testServersDir, fixture)), fixture).toBe(true)
    }
    expect(fs.existsSync(path.join(repoRoot, 'src/composition/orchestrator/hostEdgeProfile.mjs'))).toBe(true);

    const legacyDeployPath = ['ai', 'deploy'].join('/');

    expect(fs.existsSync(path.join(repoRoot, ...legacyDeployPath.split('/')))).toBe(false);

    const trackedFiles = execFileSync('git', [
        '-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'
    ]).toString('utf8').split('\0').filter(file => file && fs.existsSync(path.join(repoRoot, file)));
    const legacyReference         = new RegExp(`${legacyDeployPath}(?:/|\\b)`);
    const forbiddenDeployArtifact = /^deploy\/.*(?:\.mjs|\/package(?:-lock)?\.json|\/\.npmrc)$/;

    for (const file of trackedFiles) {
        expect(file, 'deployment is declarative-only').not.toMatch(forbiddenDeployArtifact);

        const contents = fs.readFileSync(path.join(repoRoot, file));

        if (contents.includes(0)) continue;

        expect(contents.toString('utf8'), file).not.toMatch(legacyReference)
    }
});

test('the Cloud package owns its manifest, lock, dependencies, and commands independently', () => {
    const
        rootManifest  = readJson(path.join(repoRoot, 'package.json')),
        cloudManifest = readJson(path.join(cloudPackageDir, 'package.json')),
        cloudLock     = readJson(path.join(cloudPackageDir, 'package-lock.json')),
        cloudRootLock = cloudLock.packages[''];

    expect(rootManifest).not.toHaveProperty('workspaces');
    expect(cloudManifest).not.toHaveProperty('workspaces');
    expect(cloudRootLock).not.toHaveProperty('workspaces');
    expect(cloudRootLock.name).toBe(cloudManifest.name);
    expect(cloudRootLock.version).toBe(cloudManifest.version);
    expect(cloudRootLock.dependencies).toEqual(cloudManifest.dependencies);

    expect(Object.keys(cloudManifest.dependencies).sort()).toEqual([
        '@chroma-core/default-embed',
        'better-sqlite3',
        'chromadb',
        'neo-agent-brain',
        'neo-agent-skills'
    ]);

    for (const [name, coordinate] of Object.entries(cloudManifest.dependencies)) {
        expect(coordinate, name).not.toMatch(/^(?:file:|link:|workspace:)|\.\.\//)
    }

    expect(Object.keys(cloudManifest.scripts).sort()).toEqual(CLOUD_SCRIPT_KEYS.sort());

    for (const [key, command] of Object.entries(cloudManifest.scripts)) {
        const entrypoint = command.match(/^node \.\/node_modules\/neo-agent-brain\/(\S+\.mjs)(?:\s|$)/)?.[1];

        if (entrypoint) expect(fs.existsSync(path.join(repoRoot, entrypoint)), key).toBe(true)
    }

    expect(cloudManifest.scripts['compose:up']).toContain('../deploy/cloud/docker-compose.yml');

    const overlap = Object.keys(rootManifest.scripts).filter(key => key in cloudManifest.scripts);

    expect(overlap).toEqual([]);
    expect(rootManifest.scripts).not.toHaveProperty('ai:config-print');

    for (const [key, command] of Object.entries(rootManifest.scripts)) {
        expect(command, key).not.toContain('docker compose');
        expect(command, key).not.toContain('deploy/cloud')
    }
});

test('every Compose build and non-dev bind resolves inside its owning deployment or test fixture', () => {
    const
        liveDevBinds        = [],
        installedBrainBinds = new Set(),
        testFixtureBinds    = new Set();

    for (const file of CLOUD_DEFINITIONS.filter(name => name.endsWith('.yml'))) {
        const
            source  = fs.readFileSync(path.join(cloudDir, file), 'utf8').replace(/!override\b/g, ''),
            compose = loadYaml(source);

        for (const [serviceName, service] of Object.entries(compose.services || {})) {
            if (service.build && typeof service.build === 'object') {
                const
                    context    = service.build.context || '.',
                    contextDir = path.resolve(cloudDir, context),
                    dockerfile = service.build.dockerfile || 'Dockerfile';

                if (context === '.') {
                    expect(contextDir, `${file}:${serviceName}:context`).toBe(cloudDir);
                    expect(path.resolve(contextDir, dockerfile), `${file}:${serviceName}:dockerfile`)
                        .toBe(path.join(cloudDir, 'Dockerfile'))
                } else {
                    expect(contextDir, `${file}:${serviceName}:installed-context`).toBe(installedBrainDir);
                    expect(path.resolve(contextDir, dockerfile), `${file}:${serviceName}:dockerfile`)
                        .toBe(path.join(cloudDir, 'Dockerfile'))
                }
            }

            for (const volume of service.volumes || []) {
                if (typeof volume !== 'string') continue;

                const sourcePath = volume.split(':', 1)[0];

                if (!sourcePath.startsWith('.')) continue;

                if (file === 'docker-compose.dev.yml' && sourcePath === '../..' && volume.endsWith(':/app')) {
                    liveDevBinds.push(serviceName);
                    continue
                }

                if (sourcePath.startsWith('../../test/playwright/integration/fixtures/servers/')) {
                    expect(resolvesInside(testServersDir, path.relative(testServersDir, path.resolve(cloudDir, sourcePath))),
                        `${file}:${serviceName}:test-fixture:${sourcePath}`).toBe(true);
                    testFixtureBinds.add(path.basename(sourcePath));
                    continue
                }

                if (sourcePath.startsWith('../../cloud/node_modules/neo-agent-brain/')) {
                    expect(resolvesInside(installedBrainDir, path.relative(installedBrainDir, path.resolve(cloudDir, sourcePath))),
                        `${file}:${serviceName}:installed-brain:${sourcePath}`).toBe(true);
                    installedBrainBinds.add(path.relative(installedBrainDir, path.resolve(cloudDir, sourcePath)));
                    continue
                }

                expect(resolvesInside(cloudDir, sourcePath), `${file}:${serviceName}:volume:${sourcePath}`)
                    .toBe(true)
            }
        }
    }

    expect(liveDevBinds.sort()).toEqual(['kb-server', 'mc-server', 'orchestrator']);
    expect([...installedBrainBinds].sort()).toEqual([
        'ai/mcp/deploy/proxy/Caddyfile',
        'test/playwright/integration/ai/kb-ingestion/fixtures/external-workspaces'
    ]);
    expect([...testFixtureBinds].sort()).toEqual(TEST_SERVER_FIXTURES.sort())
});

test('integration installs the independent package and then tests the exact checkout', () => {
    const
        workflow = loadYaml(fs.readFileSync(path.join(repoRoot, '.github/workflows/brain-integration.yml'), 'utf8')),
        setup    = workflow.jobs.test.steps.find(step => step.uses === 'actions/setup-node@v6'),
        commands = workflow.jobs.test.steps.filter(step => step.run).map(step => ({
            cwd: step['working-directory'] || '.',
            run: step.run
        }));

    expect(setup.with['cache-dependency-path']).toContain('package-lock.json');
    expect(setup.with['cache-dependency-path']).toContain('cloud/package-lock.json');
    expect(commands).toContainEqual({
        cwd: 'cloud',
        run: 'npm ci --ignore-scripts --no-audit --no-fund'
    });
    expect(commands).toContainEqual({
        cwd: '.',
        run: 'git archive --format=tar.gz --prefix=package/ --output=cloud/neo-agent-brain-head.tgz HEAD'
    });
    expect(commands).toContainEqual({
        cwd: 'cloud',
        run: 'npm install --ignore-scripts --no-save --package-lock=false ./neo-agent-brain-head.tgz'
    })
});
