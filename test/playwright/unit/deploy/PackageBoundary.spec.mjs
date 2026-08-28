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
    repoRoot = path.resolve(process.cwd()),
    hostDir  = path.join(repoRoot, 'deploy/host'),
    cloudDir = path.join(repoRoot, 'deploy/cloud'),

    HOST_DEFINITIONS = [
        'com.neomjs.agent-os-host-edge.plist',
        'com.neomjs.agent-os-wake.plist',
        'hostEdgeProfile.mjs'
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
        'kb-config.yaml',
        'mock-oidc-server.mjs',
        'mock-openai-embedding-server.mjs'
    ],

    CLOUD_PACKAGE_FILES = ['.npmrc', 'package-lock.json', 'package.json'],

    CLOUD_SCRIPT_KEYS = [
        'ai:audit-integrity',
        'ai:backup',
        'ai:build-kb-faqs',
        'ai:check-backup-integrity',
        'ai:check-chroma-integrity',
        'ai:community-source-operator',
        'ai:compact-graphlog',
        'ai:defrag-kb',
        'ai:defrag-memory',
        'ai:defrag-sqlite',
        'ai:download-kb',
        'ai:fleet-server',
        'ai:graph-lifecycle-report',
        'ai:ingest-tenant',
        'ai:kb-alerting',
        'ai:kb-gc',
        'ai:kb-reconciliation',
        'ai:mcp-server-knowledge-base',
        'ai:mcp-server-memory-core',
        'ai:migration-census-report',
        'ai:orchestrator',
        'ai:purge-no-content-graph-memories',
        'ai:purge-test-collections',
        'ai:reconcile-raw-memory-identities',
        'ai:reseed',
        'ai:restore',
        'ai:run-sandman',
        'ai:server',
        'ai:stale-embedding-census',
        'ai:stale-embedding-repair',
        'ai:summarize-sessions',
        'ai:sync-kb',
        'compose:config',
        'compose:down',
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
    expect(fs.readdirSync(cloudDir).filter(name => name !== 'node_modules').sort())
        .toEqual([...CLOUD_DEFINITIONS, ...CLOUD_PACKAGE_FILES].sort());

    const legacyDeployPath = ['ai', 'deploy'].join('/');

    expect(fs.existsSync(path.join(repoRoot, ...legacyDeployPath.split('/')))).toBe(false);

    const trackedFiles = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'])
        .toString('utf8').split('\0').filter(Boolean);
    const legacyReference = new RegExp(`${legacyDeployPath}(?:/|\\b)`);

    for (const file of trackedFiles) {
        const contents = fs.readFileSync(path.join(repoRoot, file));

        if (contents.includes(0)) continue;

        expect(contents.toString('utf8'), file).not.toMatch(legacyReference)
    }
});

test('the Cloud package owns its manifest, lock, dependencies, and commands independently', () => {
    const
        rootManifest  = readJson(path.join(repoRoot, 'package.json')),
        cloudManifest = readJson(path.join(cloudDir, 'package.json')),
        cloudLock     = readJson(path.join(cloudDir, 'package-lock.json')),
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

    const overlap = Object.keys(rootManifest.scripts).filter(key => key in cloudManifest.scripts);

    expect(overlap).toEqual([]);
    expect(rootManifest.scripts).not.toHaveProperty('ai:config-print');

    for (const [key, command] of Object.entries(rootManifest.scripts)) {
        expect(command, key).not.toContain('docker compose');
        expect(command, key).not.toContain('deploy/cloud')
    }
});

test('every Compose build and non-dev bind resolves inside the Cloud package', () => {
    const liveDevBinds = [];

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

                expect(resolvesInside(cloudDir, context), `${file}:${serviceName}:context`).toBe(true);
                expect(resolvesInside(cloudDir, path.relative(cloudDir, path.resolve(contextDir, dockerfile))),
                    `${file}:${serviceName}:dockerfile`).toBe(true)
            }

            for (const volume of service.volumes || []) {
                if (typeof volume !== 'string') continue;

                const sourcePath = volume.split(':', 1)[0];

                if (!sourcePath.startsWith('.')) continue;

                if (file === 'docker-compose.dev.yml' && sourcePath === '../..' && volume.endsWith(':/app')) {
                    liveDevBinds.push(serviceName);
                    continue
                }

                expect(resolvesInside(cloudDir, sourcePath), `${file}:${serviceName}:volume:${sourcePath}`)
                    .toBe(true)
            }
        }
    }

    expect(liveDevBinds.sort()).toEqual(['kb-server', 'mc-server', 'orchestrator'])
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
    expect(setup.with['cache-dependency-path']).toContain('deploy/cloud/package-lock.json');
    expect(commands).toContainEqual({
        cwd: 'deploy/cloud',
        run: 'npm ci --ignore-scripts --no-audit --no-fund'
    });
    expect(commands).toContainEqual({
        cwd: '.',
        run: 'npm pack --ignore-scripts --pack-destination deploy/cloud'
    });
    expect(commands).toContainEqual({
        cwd: 'deploy/cloud',
        run: 'npm install --ignore-scripts --no-save --package-lock=false ./neo-agent-brain-0.0.0.tgz'
    })
});
