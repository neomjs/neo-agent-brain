import {expect, test}                                                    from '@playwright/test';
import {createHash}                                                      from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir}                                                          from 'node:os';
import {dirname, join}                                                   from 'node:path';

const PLANT_SOURCE = '../../../../../../ai/services/fleet/opencodeWakeEnvelopePlugin.mjs';
import {OPENCODE_SEAT_SERVERS, generateOpenCodeSeatConfig, isUnmodifiedGeneration, stampWakeEnvelopePlant} from '../../../../../../ai/services/fleet/generateOpenCodeSeatConfig.mjs';

// Imported directly — no Neo runtime — so the suite has no host side effects and each case is
// isolated. NOT fs-free or env-free, and the header no longer claims to be: the generator reads ONE
// file from its own package at module load (the plant source it must emit byte-identically), and the
// caller's-env arm below deliberately deletes `XDG_*` from `process.env` to reproduce the production
// launcher's shape. That read is intra-package and per-seat-path-free; it is documented on the
// generator's module JSDoc. Mirrors deriveHarnessLaunchSpec.spec.

const PARAMS = {
    agentosRuntimeRoot: '/agentos/runtime',
    targetRepoRoot    : '/seat/checkout',
    seatEnvFile       : '/seat/checkout/.env',
    memoryDir         : '/seat/memory',
    nodeBinary        : '/usr/local/bin/node',
    environment       : {NEO_OPENAI_COMPATIBLE_HOST: 'http://127.0.0.1:1234', PATH: '/usr/bin:/bin'},
    extraAllowedPaths : ['/opt/fleet/**'],
    wakeHookPath      : '/seat/write-wake-envelope.mjs'
};

const parseJsonc = content => JSON.parse(content.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n'));

test.describe('generateOpenCodeSeatConfig (OpenCode seat scaffold emission)', () => {
    test('golden shape: opencode.jsonc parses as comment-stripped JSON and wires the canonical four servers', () => {
        const
            {files}  = generateOpenCodeSeatConfig(PARAMS),
            config   = parseJsonc(files.find(file => file.path === '/seat/checkout/opencode.jsonc').content),
            expected = name => ['/usr/local/bin/node', '--env-file=/seat/checkout/.env', `/agentos/runtime/ai/mcp/server/${name}/mcp-server.mjs`];

        expect(config.$schema).toBe('https://opencode.ai/config.json');
        // The always-loaded slot carries the boot files ONLY — detail files (seat-pointers,
        // about-this-layer) load on demand by path; every instructions entry costs context
        // every turn (the 27.2KB → ~10KB hot-index reshape).
        expect(config.instructions).toEqual(['/seat/memory/MEMORY.md', '/seat/memory/identity.md']);

        // Local server code and Neural Link's package/Bridge cwd are Agent OS-owned. Project
        // artifacts and the seat env remain target-repository-owned.
        expect(config.mcp['neo-mjs-memory-core']).toEqual({type: 'local', command: expected('memory-core'), enabled: true, environment: PARAMS.environment});
        expect(config.mcp['neo-mjs-github-workflow'].command).toEqual(expected('github-workflow'));
        expect(config.mcp['neo-mjs-knowledge-base'].command).toEqual(expected('knowledge-base'));
        expect(config.mcp['neo-mjs-neural-link'].command).toEqual([...expected('neural-link'), '--cwd', '/agentos/runtime']);

        // Permission block: catch-all stays "ask" FIRST (last matching rule wins), seat paths allowed.
        const externalDirectory = config.permission.external_directory;

        expect(Object.keys(externalDirectory)[0]).toBe('*');
        expect(externalDirectory).toMatchObject({'*': 'ask', '/seat/**': 'allow', '/seat/checkout/**': 'allow', '/agentos/runtime/**': 'allow', '/opt/fleet/**': 'allow'});
    });

    test('emission list: five scaffold files by default, the wake hook only when wakeHookPath is given', () => {
        const
            withHook = generateOpenCodeSeatConfig(PARAMS).files.map(file => file.path),
            noHook   = generateOpenCodeSeatConfig({...PARAMS, wakeHookPath: undefined}).files.map(file => file.path);

        expect(withHook).toEqual([
            '/seat/checkout/opencode.jsonc',
            '/seat/memory/MEMORY.md',
            '/seat/memory/seat-pointers.md',
            '/seat/memory/identity.md',
            '/seat/memory/about-this-layer.md',
            '/seat/write-wake-envelope.mjs'
        ]);
        expect(noHook).toEqual(withHook.slice(0, 5));
    });

    test('memory scaffold: MEMORY.md is the capped hot index (Grace-pattern), weak-spots empty at birth (#15697)', () => {
        const files  = generateOpenCodeSeatConfig(PARAMS).files,
              memory = files.find(file => file.path.endsWith('MEMORY.md')).content;

        // The cap discipline travels with the file it governs: thresholds, measurement, levers.
        expect(memory).toContain('<17KB');
        expect(memory).toContain('24.6KB');
        expect(memory).toContain('wc -c');
        expect(memory).toContain('move-to-ARCHIVE');
        // The weak-spots section exists but starts EMPTY — the index accretes from the seat's
        // own public record, never from another seat's mistakes.
        expect(memory).toContain('Weak-spots');
        expect(memory).toContain('Empty at birth');
        // The opencode load-mechanism line names the instructions slot.
        expect(memory).toContain('instructions');

        const about = files.find(file => file.path.endsWith('about-this-layer.md')).content;
        expect(about).toContain('Grace-pattern');
        expect(about).toContain('opencode.jsonc');
        expect(about).toContain('story-sovereignty');
    });

    test('purity: identical params emit byte-identical files (deterministic, no hidden inputs)', () => {
        expect(generateOpenCodeSeatConfig(PARAMS)).toEqual(generateOpenCodeSeatConfig(PARAMS));
        expect(generateOpenCodeSeatConfig(PARAMS))
            .toEqual(generateOpenCodeSeatConfig({...PARAMS, remoteServers: {}}))
    });

    test('no remote intent stays byte-identical to the origin/dev stdio artifact set', () => {
        const digest = createHash('sha256')
            .update(JSON.stringify(generateOpenCodeSeatConfig(PARAMS).files))
            .digest('hex');

        // Live-frozen from the pre-change origin/dev artifact. This catches remote-only prose or grammar
        // leaking into the default artifact set even when current-vs-current purity stays green.
        // Bumped 2026-08-15: the seat-layer rules gained the defect-note anti-pattern line.
        // Bumped 2026-08-23: the wake hook now stamps `agentIdentity` from NEO_AGENT_IDENTITY so the
        // reader can refuse an envelope a DIFFERENT seat wrote to the same shared path. A change to
        // hook content is precisely what this digest exists to surface, so it is bumped, not relaxed.
        // Bumped 2026-08-24: AgentOS runtime and target-repository roots became explicit, and Neural
        // Link's package cwd moved to the runtime authority.
        // Bumped 2026-09-27: the hook stopped carrying the wake-envelope plant. It had inlined
        // ~26 KB of base64 and installed it behind an `XDG_CONFIG_HOME` guard the production caller does
        // not pass, so on a real Fleet seat the branch always skipped; the plant is now its own emitted
        // file at a caller-resolved path. Sole differing artifact: `/seat/write-wake-envelope.mjs`.
        // Verified against `origin/dev` at `bea77518…` before rebasing, so this bump is attributable to
        // the hook and not to inherited drift.
        // The explicit /seat/memory/** grant is the sole change from the prior artifact digest.
        expect(digest).toBe('87e67f14ef11fe244ae514da6b427d4492ab0b552308eb85c2592c52341fe2d8')
    });

    test('remote map replaces only selected servers with the exact OpenCode HTTP adapter grammar', () => {
        const
            remoteServers = {
                'neo-mjs-memory-core': {
                    url: 'https://tenant.example.com/mc/mcp', credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN'
                },
                'neo-mjs-knowledge-base': {
                    url: 'https://tenant.example.com/kb/mcp', credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN'
                }
            },
            config = parseJsonc(generateOpenCodeSeatConfig({...PARAMS, remoteServers}).files[0].content);

        expect(config.mcp['neo-mjs-memory-core']).toEqual({
            type   : 'remote',
            url    : 'https://tenant.example.com/mc/mcp',
            enabled: true,
            headers: {Authorization: 'Bearer {env:NEO_MCP_REMOTE_TOKEN}'},
            oauth  : false
        });
        expect(config.mcp['neo-mjs-knowledge-base']).toEqual({
            type   : 'remote',
            url    : 'https://tenant.example.com/kb/mcp',
            enabled: true,
            headers: {Authorization: 'Bearer {env:NEO_MCP_REMOTE_TOKEN}'},
            oauth  : false
        });
        expect(config.mcp['neo-mjs-github-workflow'].type).toBe('local');
        expect(config.mcp['neo-mjs-neural-link'].type).toBe('local');
        expect(JSON.stringify(config)).not.toContain('Bearer secret')
    });

    test('remote map rejects unknown servers and every secret/header/env-bearing carrier', () => {
        const malformed = [{
            unknown: {url: 'https://tenant.example.com/mc/mcp', credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN'}
        }, {
            'neo-mjs-memory-core': {
                url             : 'https://tenant.example.com/mc/mcp',
                credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN',
                credential      : 'secret'
            }
        }, {
            'neo-mjs-memory-core': {
                url             : 'https://tenant.example.com/mc/mcp',
                credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN',
                headers         : {Authorization: 'Bearer secret'}
            }
        }, {
            'neo-mjs-memory-core': {
                url             : 'https://tenant.example.com/mc/mcp',
                credentialEnvVar: 'GH_TOKEN'
            }
        }, {
            'neo-mjs-memory-core': {
                url             : 'https://tenant.example.com/mc/mcp',
                credentialEnvVar: '9INVALID'
            }
        }, []];

        malformed.forEach(remoteServers => {
            expect(() => generateOpenCodeSeatConfig({...PARAMS, remoteServers}))
                .toThrow(/remoteServers|remote server/)
        })
    });

    test('island guard: a server script escaping agentosRuntimeRoot throws; a malformed entry throws', () => {
        const evil = [{name: 'evil', script: '../evil/mcp-server.mjs', needsCwd: false}];

        expect(() => generateOpenCodeSeatConfig({...PARAMS, servers: evil})).toThrow(/island guard/);
        expect(() => generateOpenCodeSeatConfig({...PARAMS, servers: [{script: 'ai/x.mjs', needsCwd: false}]})).toThrow(/island guard/);
        expect(() => generateOpenCodeSeatConfig({...PARAMS, servers: []})).toThrow(/'servers' must be a non-empty array/);
    });

    test('island guard: a trailing-slash agentosRuntimeRoot is accepted (valid input must not mis-reject)', () => {
        const
            {files} = generateOpenCodeSeatConfig({...PARAMS, agentosRuntimeRoot: '/agentos/runtime/'}),
            config  = parseJsonc(files[0].content);

        expect(config.mcp['neo-mjs-memory-core'].command[2]).toBe('/agentos/runtime/ai/mcp/server/memory-core/mcp-server.mjs');
    });

    test('seatHome: explicit param wins; default derives from memoryDir parent', () => {
        const
            explicit = parseJsonc(generateOpenCodeSeatConfig({...PARAMS, seatHome: '/fleet/seat-alpha'}).files[0].content),
            derived  = parseJsonc(generateOpenCodeSeatConfig(PARAMS).files[0].content);

        expect(explicit.permission.external_directory).toHaveProperty('/fleet/seat-alpha/**', 'allow');
        expect(explicit.permission.external_directory).toHaveProperty('/seat/memory/**', 'allow');
        expect(explicit.permission.external_directory).not.toHaveProperty('/seat/**');
        expect(derived.permission.external_directory).toHaveProperty('/seat/**', 'allow');
    });

    test('named throws: every required param is validated by name', () => {
        for (const key of ['agentosRuntimeRoot', 'targetRepoRoot', 'seatEnvFile', 'memoryDir', 'nodeBinary']) {
            const params = {...PARAMS};

            delete params[key];
            expect(() => generateOpenCodeSeatConfig(params)).toThrow(new RegExp(`'${key}' must be a non-empty string`));
        }

        const legacyOnly = {
            ...PARAMS,
            canonicalRoot: PARAMS.agentosRuntimeRoot,
            workspaceRoot: PARAMS.targetRepoRoot
        };
        delete legacyOnly.agentosRuntimeRoot;
        delete legacyOnly.targetRepoRoot;

        expect(() => generateOpenCodeSeatConfig(legacyOnly)).toThrow(/'agentosRuntimeRoot'/)
    });

    test('sovereignty guard: the emitted identity.md is a template — sovereignty header, zero story content', () => {
        const identity = generateOpenCodeSeatConfig(PARAMS).files.find(file => file.path.endsWith('identity.md')).content;

        expect(identity).toContain('unwritten');
        expect(identity).toContain('nobody');
        expect(identity).not.toContain('@neo-');
        expect(identity).not.toContain('Phoebe');
    });

    test('servers override: a custom server set replaces the canonical four', () => {
        const
            custom = [{name: 'neo-mjs-memory-core', script: 'ai/mcp/server/memory-core/mcp-server.mjs', needsCwd: false}],
            config = parseJsonc(generateOpenCodeSeatConfig({...PARAMS, servers: custom}).files[0].content);

        expect(Object.keys(config.mcp)).toEqual(['neo-mjs-memory-core']);
    });

    test('wake hook: standalone (no Neo imports), env-only credentials, atomic 0600 write contract', () => {
        const hook = generateOpenCodeSeatConfig(PARAMS).files.find(file => file.path === '/seat/write-wake-envelope.mjs').content;

        expect(hook).toContain('OPENCODE_SERVER_PASSWORD');
        expect(hook).toContain('0o600');
        expect(hook).toContain('--data-home');
        expect(hook).not.toContain('secret flags');
        expect(hook).not.toMatch(/import .* from '(?!node:)/); // no non-node imports (C1-clean)
    });

    test('OPENCODE_SEAT_SERVERS: the canonical four are AgentOS-relative scripts', () => {
        expect(OPENCODE_SEAT_SERVERS.map(server => server.name)).toEqual([
            'neo-mjs-memory-core', 'neo-mjs-github-workflow', 'neo-mjs-knowledge-base', 'neo-mjs-neural-link'
        ]);
        OPENCODE_SEAT_SERVERS.forEach(server => expect(server.script.startsWith('ai/mcp/server/')).toBe(true));
    });
});

test.describe('the wake-envelope plant is emitted as a SIBLING of the boot hook', () => {
    const
        plantSource = readFileSync(new URL(PLANT_SOURCE, import.meta.url)),
        seatHome    = () => mkdtempSync(join(tmpdir(), 'seat-home-')),
        plantIn     = home => join(home, 'opencode', 'plugins', 'neo-wake-envelope.mjs');

    /**
     * @summary Emit for a seat, writing the files the way the composer does, under the PRODUCTION
     * caller's env shape: `AMBIENT_ENV_ALLOWLIST` plus the server credential pair, and deliberately
     * NO `XDG_CONFIG_HOME` / `XDG_DATA_HOME` — because `bootstrapOpenCodeWakeRoute` does not pass them.
     * A delivery path that needs an env var the only production caller never supplies is the defect
     * this whole shape exists to remove, so the arms assert the emission never reads one.
     * @param {String} home
     * @returns {{files: Array, written: String[]}}
     */
    function provision(home) {
        const
            {files} = generateOpenCodeSeatConfig({...PARAMS,
                wakeHookPath : join(home, 'write-wake-envelope.mjs'),
                wakePlantPath: plantIn(home)
            }),
            // Only the instance-home artifacts are written: the repo-root `opencode.jsonc` points at a
            // fixture path that does not exist, and these arms are about what lands in the seat home.
            written = files
                .filter(file => file.path.startsWith(home))
                .map(file => {
                    mkdirSync(dirname(file.path), {recursive: true});
                    writeFileSync(file.path, file.content);

                    return file.path
                });

        return {files, written}
    }

    test('the caller-resolved path carries the plant, stamped and otherwise byte-equivalent to its source', () => {
        const home    = seatHome(),
              {files} = provision(home),
              plant   = files.find(file => file.path === plantIn(home));

        expect(plant, 'the plant is emitted at the caller-resolved path, not left to the hook').toBeTruthy();
        expect(
            plant.content.replace(/^\/\* GENERATED by generateOpenCodeSeatConfig — plant generation sha256:[0-9a-f]{64} \*\/\n/, ''),
            'and apart from its generation marker its bytes are the source bytes'
        ).toBe(plantSource.toString('utf8'));
        expect(isUnmodifiedGeneration(plant.content), 'the marker agrees with the body it stamps').toBe(true)
    });

    test('the generation marker is what separates an earlier generation from a hand edit', () => {
        // Provenance is a CLAIM about a file, and a bare marker cannot carry it: anyone can keep the word
        // and edit underneath it. So the marker holds a hash of the body it precedes, which makes
        // "unmodified generation" checkable rather than promised.
        const body = 'export const x = 1;\n';

        expect(isUnmodifiedGeneration(stampWakeEnvelopePlant(body)), 'a stamped body is a generation').toBe(true);
        expect(isUnmodifiedGeneration(body), 'an unstamped file is nobody\'s generation').toBe(false);
        expect(
            isUnmodifiedGeneration(`${stampWakeEnvelopePlant(body)}\n// edited underneath the marker\n`),
            'marker kept, body changed: still not a generation'
        ).toBe(false);
        expect(
            isUnmodifiedGeneration(stampWakeEnvelopePlant(body).replace(body, 'export const x = 2;\n')),
            'and a forged body under a real marker does not pass either'
        ).toBe(false)
    });

    test('the boot hook carries no plant bytes — the inlined-payload shape cannot return', () => {
        // The regression guard for the shape that was removed. A base64 plant inside the hook is not
        // merely untidy: it makes every plant edit a divergence on each seat's boot hook, and it can
        // only ever be installed by a LATER process than the one that boot created.
        const home    = seatHome(),
              {files} = provision(home),
              hook    = files.find(file => file.path.endsWith('write-wake-envelope.mjs')).content,
              base64  = hook.match(/[A-Za-z0-9+/]{500,}={0,2}/);

        expect(base64, 'no base64 payload in the hook').toBeNull();
        expect(hook, 'no installer left behind in the hook').not.toContain('pluginsDir');
        expect(hook, 'and the hook no longer gates on the env var the caller omits').not.toContain('XDG_CONFIG_HOME')
    });

    test("the caller's env shape is irrelevant: neither XDG var is set, and the plant still lands in the seat's own plugins dir", () => {
        // THE arm this shape exists for. `bootstrapOpenCodeWakeRoute` runs the hook with
        // `AMBIENT_ENV_ALLOWLIST` + the credential pair and passes NEITHER `XDG_CONFIG_HOME` NOR
        // `XDG_DATA_HOME`. The previous shape installed the plant from inside that hook behind an
        // `XDG_CONFIG_HOME` guard, so on a real Fleet-managed seat the branch always skipped: the hook
        // reported nothing, the plant was never installed, and every arm that injected the variable
        // itself passed. This arm runs the emission under an env that has neither, and asserts the plant
        // is on disk — which is false for the old shape by construction, not by accident of setup.
        const home = seatHome(),
              // The caller's shape, asserted rather than assumed: a test that injects the env its own
              // code needs proves the code, not the caller.
              callerEnv = {
                NEO_AGENT_IDENTITY      : 'neo-preview',
                OPENCODE_SERVER_USERNAME: 'u',
                OPENCODE_SERVER_PASSWORD: 'p'
              };

        expect(callerEnv.XDG_CONFIG_HOME, 'the production caller really does not pass it').toBeUndefined();
        expect(callerEnv.XDG_DATA_HOME,  'nor the data home').toBeUndefined();

        const previous = {XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME};

        delete process.env.XDG_CONFIG_HOME;
        delete process.env.XDG_DATA_HOME;

        try {
            provision(home);

            expect(existsSync(plantIn(home)), 'the plant is in the seat\'s own plugins dir, with no XDG var anywhere').toBe(true)
        } finally {
            Object.assign(process.env, previous)
        }
    });

    test('an empty wakePlantPath is refused rather than silently skipped', () => {
        // The generator's contract for every optional path: a blank one is a caller bug, and a silent
        // skip would look exactly like a healthy provision — the failure this ticket exists to remove.
        expect(() => generateOpenCodeSeatConfig({...PARAMS, wakePlantPath: ''})).toThrow(/wakePlantPath/)
    });

    test('omitting wakePlantPath emits no plant, and the hook is unaffected', () => {
        const home    = seatHome(),
              {files} = generateOpenCodeSeatConfig({...PARAMS, wakeHookPath: join(home, 'write-wake-envelope.mjs')}),
              paths   = files.map(file => file.path);

        expect(paths.some(path => /plugins/.test(path)), 'no plugins path when the caller asks for none').toBe(false);
        expect(paths.some(path => path.endsWith('write-wake-envelope.mjs')), 'the hook is still emitted').toBe(true)
    });
});
