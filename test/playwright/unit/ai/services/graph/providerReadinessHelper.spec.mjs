import {setup} from '../../../../setup.mjs';

const appName = 'ProviderReadinessHelperTest';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {name: appName, isMounted: () => true, vnodeInitialising: false}
});

import {test, expect} from '@playwright/test';
import {execFile}     from 'child_process';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import os             from 'os';
import path           from 'path';
import aiConfig       from '../../../../../../ai/mcp/server/memory-core/config.template.mjs';

// Pure helper (no I/O) — imported dynamically after the Neo bootstrap (the module's import chain
// references Neo at load). It guarantees LM Studio's CLI bin dir (~/.lmstudio/bin) is on the
// execFile PATH, so the readiness probe no longer reports a healthy provider as unavailable when
// the daemon/MCP-server launch env lacks that dir (the bare-`lms` spawn ENOENT false-negative).

const LMS_BIN = path.join(os.homedir(), '.lmstudio', 'bin');
const SEP     = process.platform === 'win32' ? ';' : ':';

test.describe('lmsExecOptions — embedding-readiness PATH fix', () => {
    let fetchLmsLoadedModels, lmsExecOptions;

    test.beforeAll(async () => {
        const mod = await import('../../../../../../ai/services/graph/providerReadinessHelper.mjs');

        fetchLmsLoadedModels = mod.fetchLmsLoadedModels;
        lmsExecOptions       = mod.lmsExecOptions;
    });

    test('augments PATH with the LM Studio bin dir', () => {
        const opts = lmsExecOptions();
        expect(opts.env.PATH.split(SEP)).toContain(LMS_BIN);
    });

    test('merges extra options (e.g. timeout) alongside the augmented env', () => {
        const opts = lmsExecOptions({timeout: 5000});
        expect(opts.timeout).toBe(5000);
        expect(opts.env.PATH.split(SEP)).toContain(LMS_BIN);
    });

    test('preserves every pre-existing PATH entry', () => {
        const opts = lmsExecOptions();
        for (const entry of (process.env.PATH || '').split(SEP).filter(Boolean)) {
            expect(opts.env.PATH.split(SEP)).toContain(entry);
        }
    });

    test('is idempotent — does not duplicate the bin dir when already on PATH', () => {
        const origPath = process.env.PATH;
        try {
            process.env.PATH  = `${LMS_BIN}${SEP}/usr/bin`;
            const opts        = lmsExecOptions();
            const occurrences = opts.env.PATH.split(SEP).filter(p => p === LMS_BIN).length;
            expect(occurrences).toBe(1);
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('preserves a caller-supplied extra.env (merges, does not clobber) + augments its PATH', () => {
        const opts    = lmsExecOptions({timeout: 99, env: {FOO: 'bar', PATH: '/custom/bin'}});
        const entries = opts.env.PATH.split(SEP);
        expect(opts.timeout).toBe(99);   // extra options preserved
        expect(opts.env.FOO).toBe('bar'); // caller env preserved (not clobbered)
        expect(entries).toContain('/custom/bin'); // caller PATH preserved
        expect(entries).toContain(LMS_BIN);       // lms bin dir augmented onto the caller PATH
    });

    test('pre-aborted loaded-model probes reject before spawning a child', async () => {
        const
            controller = new AbortController(),
            reason     = new Error('cancel before provider preflight'),
            calls      = [];

        controller.abort(reason);

        let observed;
        try {
            await fetchLmsLoadedModels({
                timeoutMs : 100,
                signal    : controller.signal,
                execFileFn: (...args) => calls.push(args)
            });
        } catch (error) {
            observed = error;
        }

        expect(observed).toBe(reason);
        expect(calls).toEqual([]);
    });

    test('signal-owned loaded-model probes do not coalesce or poison sibling callers', async () => {
        const
            firstController  = new AbortController(),
            secondController = new AbortController(),
            callbacks        = [],
            signals          = [],
            execFileFn       = (file, args, options, callback) => {
                signals.push(options.signal);
                callbacks.push(callback);
            },
            firstPromise     = fetchLmsLoadedModels({
                timeoutMs: 100,
                signal   : firstController.signal,
                execFileFn
            }),
            secondPromise    = fetchLmsLoadedModels({
                timeoutMs: 100,
                signal   : secondController.signal,
                execFileFn
            }),
            reason           = new Error('cancel only the first preflight');

        expect(signals).toEqual([firstController.signal, secondController.signal]);

        firstController.abort(reason);
        callbacks[0](Object.assign(new Error('child aborted'), {name: 'AbortError'}));
        callbacks[1](null, JSON.stringify([{identifier: 'embedding-model'}]), '');

        let observed;
        try {
            await firstPromise;
        } catch (error) {
            observed = error;
        }

        expect(observed).toBe(reason);
        await expect(secondPromise).resolves.toEqual([{id: 'embedding-model'}]);
    });

    test('rejects empty, malformed, conflicting, and non-positive lms ps telemetry (#17071)', async () => {
        const invalidPayloads = [
            '',
            '{bad',
            '{}',
            JSON.stringify([{contextLength: 4096}]),
            JSON.stringify([{id: 42, contextLength: 4096}]),
            JSON.stringify([{id: 'chat-model', identifier: 'other-model', contextLength: 4096}]),
            JSON.stringify([{identifier: 'chat-model'}, {identifier: 'chat-model'}]),
            JSON.stringify([{identifier: 'chat-model', contextLength: 'many'}]),
            JSON.stringify([{identifier: 'chat-model', contextLength: 4096, context_length: 8192}]),
            JSON.stringify([{identifier: 'chat-model', contextLength: 0}]),
            JSON.stringify([{identifier: 'chat-model', parallel: 1.5}])
        ];

        for (const stdout of invalidPayloads) {
            await expect(fetchLmsLoadedModels({
                timeoutMs : 100,
                unshared  : true,
                execFileFn: (file, args, options, callback) => callback(null, stdout, '')
            })).rejects.toThrow(/lms ps --json returned/);
        }
    });

    test('accepts the live LMS identifier while preserving distinct model metadata (#17071)', async () => {
        await expect(fetchLmsLoadedModels({
            timeoutMs : 100,
            unshared  : true,
            execFileFn: (file, args, options, callback) => callback(null, JSON.stringify([{
                type                  : 'embedding',
                modelKey              : 'text-embedding-qwen3-embedding-8b',
                path                  : 'Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q4_K_M.gguf',
                indexedModelIdentifier: 'Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q4_K_M.gguf',
                identifier            : 'text-embedding-qwen3-embedding-8b',
                contextLength         : 32768,
                parallel              : null
            }]), '')
        })).resolves.toEqual([expect.objectContaining({
            id           : 'text-embedding-qwen3-embedding-8b',
            modelKey     : 'text-embedding-qwen3-embedding-8b',
            contextLength: 32768,
            parallel     : undefined
        })]);
    });
});

test.describe('LM Studio residency mutation queue (#17054)', () => {
    let ensureLmsModelsLoaded, loadLmsModel;

    test.beforeAll(async () => {
        ({ensureLmsModelsLoaded, loadLmsModel} = await import('../../../../../../ai/services/graph/providerReadinessHelper.mjs'));
    });

    test('serializes concurrent repairs without coalescing their role sets', async () => {
        let releaseFirst, signalFirstStarted, activeLoads = 0, maxActiveLoads = 0;
        const events       = [],
              firstGate    = new Promise(resolve => { releaseFirst = resolve; }),
              firstStarted = new Promise(resolve => { signalFirstStarted = resolve; }),
              createRepair = (model, waitForRelease = false) => {
                  let loaded = false;

                  return ensureLmsModelsLoaded({
                      host         : 'http://127.0.0.1:1234',
                      models       : [model],
                      attempts     : 1,
                      delayMs      : 0,
                      timeoutMs    : 10,
                      fetchModelIds: async () => {
                          events.push(`discover:${model}`);
                          return loaded ? [model] : [];
                      },
                      fetchLoadedModels: async () => loaded ? [{id: model}] : [],
                      async loadModel() {
                          events.push(`load:${model}`);
                          activeLoads += 1;
                          maxActiveLoads = Math.max(maxActiveLoads, activeLoads);

                          if (waitForRelease) {
                              signalFirstStarted();
                              await firstGate;
                          }

                          loaded = true;
                          activeLoads -= 1;
                      },
                      log        : {info() {}, warn() {}}
                  });
              },
              first = createRepair('chat-model', true);

        await firstStarted;

        const second = createRepair('embedding-model');

        await Promise.resolve();
        expect(events).toEqual(['discover:chat-model', 'load:chat-model']);

        releaseFirst();

        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(maxActiveLoads).toBe(1);
        expect(firstResult.requiredModels).toEqual(['chat-model']);
        expect(secondResult.requiredModels).toEqual(['embedding-model']);
        expect(events).toEqual([
            'discover:chat-model',
            'load:chat-model',
            'discover:chat-model',
            'discover:embedding-model',
            'load:embedding-model',
            'discover:embedding-model'
        ]);
    });

    test('releases a rejected predecessor and rechecks queued caller authority', async () => {
        let rejectFirst, signalFirstStarted, authorityHeld = true, secondDiscoveries = 0, secondLoads = 0;
        const firstGate    = new Promise((resolve, reject) => { rejectFirst = reject; }),
              firstStarted = new Promise(resolve => { signalFirstStarted = resolve; }),
              first        = ensureLmsModelsLoaded({
                  host             : 'http://127.0.0.1:1234',
                  models           : ['chat-model'],
                  attempts         : 1,
                  delayMs          : 0,
                  timeoutMs        : 10,
                  fetchModelIds    : async () => [],
                  fetchLoadedModels: async () => [],
                  async loadModel() {
                      signalFirstStarted();
                      await firstGate;
                  },
                  log        : {info() {}, warn() {}}
              });

        await firstStarted;

        const second = ensureLmsModelsLoaded({
            host         : 'http://127.0.0.1:1234',
            models       : ['embedding-model'],
            attempts     : 1,
            delayMs      : 0,
            timeoutMs    : 10,
            fetchModelIds: async () => {
                secondDiscoveries += 1;
                return [];
            },
            fetchLoadedModels: async () => [],
            async loadModel() {
                secondLoads += 1;
            },
            isAuthorityHeld: () => authorityHeld,
            log            : {info() {}, warn() {}}
        });

        authorityHeld = false;
        await Promise.resolve();
        expect(secondDiscoveries).toBe(0);

        rejectFirst(new Error('first repair failed'));

        await expect(first).rejects.toThrow('first repair failed');
        await expect(second).rejects.toMatchObject({reason: 'runtime-authority-lost'});
        expect(secondDiscoveries).toBe(1);
        expect(secondLoads).toBe(0);
    });

    test('settles a timed-out LMS child with SIGKILL before admitting the queued repair (#17071)', async () => {
        let signalSpawned;
        const events  = [],
              spawned = new Promise(resolve => { signalSpawned = resolve; });

        const first = ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['hung-model'],
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 40,
            fetchModelIds    : async () => [],
            fetchLoadedModels: async () => [],
            loadModel        : model => loadLmsModel(model, {
                timeoutMs: 40,
                execFileFn(file, args, options, callback) {
                    const child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options, callback);

                    child.once('spawn', () => {
                        events.push('first-spawn');
                        signalSpawned();
                    });
                    child.once('close', (code, signal) => events.push(`first-close:${signal}`));

                    return child;
                }
            }),
            log        : {info() {}, warn() {}}
        });

        await spawned;

        let   secondResident = false;
        const second         = ensureLmsModelsLoaded({
            host         : 'http://127.0.0.1:1234',
            models       : ['ready-model'],
            attempts     : 1,
            delayMs      : 0,
            timeoutMs    : 40,
            fetchModelIds: async () => {
                events.push('second-discover');
                return secondResident ? ['ready-model'] : [];
            },
            fetchLoadedModels: async () => secondResident ? [{id: 'ready-model'}] : [],
            async loadModel() {
                events.push('second-load');
                secondResident = true;
            },
            log        : {info() {}, warn() {}}
        });

        await expect(first).rejects.toMatchObject({killed: true, signal: 'SIGKILL'});
        await expect(second).resolves.toMatchObject({ready: true});
        expect(events[0]).toBe('first-spawn');
        expect(events[1]).toBe('first-close:SIGKILL');
        expect(events.slice(2)).toContain('second-discover');
        expect(events).toContain('second-load');
    });
});

test.describe('provider residency helpers — production mutation authority fences (#16837)', () => {
    let ensureLmsModelsLoaded, ensureOllamaModelsReady;

    test.beforeAll(async () => {
        const mod = await import('../../../../../../ai/services/graph/providerReadinessHelper.mjs');

        ensureLmsModelsLoaded   = mod.ensureLmsModelsLoaded;
        ensureOllamaModelsReady = mod.ensureOllamaModelsReady;
    });

    test('LMS rechecks authority immediately before an additive load', async () => {
        let held       = true,
            probeCount = 0;
        const loads = [];

        const repair = ensureLmsModelsLoaded({
            host         : 'http://127.0.0.1:1234',
            models       : ['chat-model'],
            attempts     : 1,
            delayMs      : 0,
            timeoutMs    : 10,
            fetchModelIds: async () => ['chat-model'],
            async fetchLoadedModels() {
                probeCount++;
                if (probeCount === 3) held = false;

                return [];
            },
            loadModel      : async model => loads.push(model),
            isAuthorityHeld: () => held,
            log            : {info() {}, warn() {}}
        });

        await expect(repair).rejects.toMatchObject({reason: 'runtime-authority-lost'});
        expect(loads).toEqual([]);
    });

    test('LMS routine repair never loads when cached absence becomes a fresh mismatch (#17079)', async () => {
        const loads     = [],
              snapshots = [
                  [],
                  [{id: 'chat-model', contextLength: 1024}]
              ];

        const result = await ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['chat-model'],
            contextLengths   : {'chat-model': 4096},
            allowPartial     : true,
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => ['chat-model'],
            fetchLoadedModels: async () => snapshots.shift() || [{id: 'chat-model', contextLength: 1024}],
            loadModel        : async model => loads.push(model),
            log              : {info() {}, warn() {}}
        });

        expect(loads).toEqual([]);
        expect(result).toMatchObject({
            ready            : false,
            degraded         : true,
            observationStatus: 'replacement-required'
        });
    });

    test('LMS reports a suffixed resident without evicting or reloading it (#17079)', async () => {
        const loads = [],
              rows  = [{id: 'chat-model'}, {id: 'chat-model:2'}];

        const result = await ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['chat-model'],
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => ['chat-model'],
            fetchLoadedModels: async () => rows,
            loadModel        : async model => loads.push(model),
            log              : {info() {}, warn() {}}
        });

        expect(loads).toEqual([]);
        expect(result).toMatchObject({
            ready              : true,
            loadedModels       : [],
            unloadedModels     : [],
            cleanupFailedModels: [],
            lmsLoadedModels    : rows
        });
    });

    test('LMS force-fresh batch refuses all mutation when one required row is unknown (#17079)', async () => {
        const loads     = [],
              snapshots = [
                  [],
                  [
                      {id: 'chat-model', contextLength: 1024},
                      {id: 'embedding-model'}
                  ]
              ];

        const result = await ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['chat-model', 'embedding-model'],
            contextLengths   : {'chat-model': 4096, 'embedding-model': 32768},
            allowPartial     : true,
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => ['chat-model', 'embedding-model'],
            fetchLoadedModels: async () => snapshots.shift() || [],
            loadModel        : async model => loads.push(model),
            log              : {info() {}, warn() {}}
        });

        expect(loads).toEqual([]);
        expect(result).toMatchObject({
            ready            : false,
            degraded         : true,
            observationStatus: 'metadata-unknown'
        });
    });

    test('LMS demand revocation immediately before an additive load prevents mutation (#17079)', async () => {
        let admitted   = true,
            probeCount = 0;
        const loads = [];

        const repair = ensureLmsModelsLoaded({
            host         : 'http://127.0.0.1:1234',
            models       : ['chat-model'],
            attempts     : 1,
            delayMs      : 0,
            timeoutMs    : 10,
            fetchModelIds: async () => ['chat-model'],
            async fetchLoadedModels() {
                probeCount++;
                if (probeCount === 3) admitted = false;

                return [];
            },
            loadModel            : async model => loads.push(model),
            isEffectStillAdmitted: () => admitted,
            log                  : {info() {}, warn() {}}
        });

        await expect(repair).rejects.toMatchObject({reason: 'runtime-effect-not-admitted'});
        expect(loads).toEqual([]);
    });

    test('LMS preserves a confirmed additive load as partial when demand changes before the next load (#17079)', async () => {
        let   admitted = true;
        const loads    = [],
              resident = new Set();

        const repair = ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['chat-model', 'embedding-model'],
            allowPartial     : true,
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => ['chat-model', 'embedding-model'],
            fetchLoadedModels: async () => [...resident].map(id => ({id})),
            async loadModel(model) {
                loads.push(model);
                resident.add(model);
                admitted = false;
            },
            isEffectStillAdmitted: () => admitted,
            log                  : {info() {}, warn() {}}
        });

        await expect(repair).rejects.toMatchObject({
            reason           : 'runtime-effect-partially-applied',
            effectDisposition: 'partial',
            providerResidency: {
                admission      : 'refused-after-partial',
                refusedModel   : 'embedding-model',
                attemptedModels: ['chat-model'],
                loadedModels   : ['chat-model'],
                failedModels   : []
            }
        });
        expect(loads).toEqual(['chat-model']);
    });

    test('LMS preserves an unknown additive load outcome when demand changes before the next load (#17079)', async () => {
        let   admitted = true;
        const loads    = [];

        const repair = ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['chat-model', 'embedding-model'],
            allowPartial     : true,
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => ['chat-model', 'embedding-model'],
            fetchLoadedModels: async () => [],
            async loadModel(model) {
                loads.push(model);
                admitted = false;
                throw new Error('load outcome unknown');
            },
            isEffectStillAdmitted: () => admitted,
            log                  : {info() {}, warn() {}}
        });

        await expect(repair).rejects.toMatchObject({
            reason           : 'runtime-effect-disposition-uncertain',
            effectDisposition: 'uncertain',
            providerResidency: {
                admission      : 'refused-after-uncertain-attempt',
                refusedModel   : 'embedding-model',
                attemptedModels: ['chat-model'],
                loadedModels   : [],
                failedModels   : [{model: 'chat-model', error: 'load outcome unknown'}]
            }
        });
        expect(loads).toEqual(['chat-model']);
    });

    test('Ollama rechecks authority between role warms instead of authorizing the loop once', async () => {
        let   held  = true;
        const warms = [];

        const repair = ensureOllamaModelsReady({
            host : 'http://127.0.0.1:11434',
            roles: [
                {role: 'chat',      providerRole: 'chat',      model: 'chat-model'},
                {role: 'embedding', providerRole: 'embedding', model: 'embed-model'}
            ],
            requireParallelModels: 2,
            attempts             : 1,
            delayMs              : 0,
            timeoutMs            : 10,
            fetchModelIds        : async () => [],
            async warmModel(role) {
                warms.push(role.role);
                held = false;
                return {};
            },
            isAuthorityHeld: () => held,
            log            : {info() {}, warn() {}}
        });

        await expect(repair).rejects.toMatchObject({reason: 'runtime-authority-lost'});
        expect(warms).toEqual(['chat']);
    });

    test('Ollama preserves allowPartial authority degradation when the demand oracle is omitted', async () => {
        let held = true;

        const result = await ensureOllamaModelsReady({
            host : 'http://127.0.0.1:11434',
            roles: [
                {role: 'chat',      providerRole: 'chat',      model: 'chat-model'},
                {role: 'embedding', providerRole: 'embedding', model: 'embed-model'}
            ],
            requireParallelModels: 2,
            attempts             : 1,
            delayMs              : 0,
            timeoutMs            : 10,
            allowPartial         : true,
            fetchModelIds        : async () => [],
            async warmModel() {
                held = false;
                return {};
            },
            isAuthorityHeld: () => held,
            log            : {info() {}, warn() {}}
        });

        expect(result).toMatchObject({
            ready          : false,
            degraded       : true,
            attemptedModels: [
                {role: 'chat', providerRole: 'chat', model: 'chat-model'},
                {role: 'embedding', providerRole: 'embedding', model: 'embed-model'}
            ],
            warmedModels: [{role: 'chat', providerRole: 'chat', model: 'chat-model'}],
            failedModels: [{role: 'embedding', providerRole: 'embedding', model: 'embed-model'}]
        });
    });

    test('Ollama refuses changed demand after the readiness probe before any role warm', async () => {
        let   admitted = true;
        const warms    = [];

        const repair = ensureOllamaModelsReady({
            host : 'http://127.0.0.1:11434',
            roles: [
                {role: 'chat', providerRole: 'chat', model: 'chat-model', contextLength: 131072}
            ],
            requireParallelModels: 1,
            attempts             : 1,
            delayMs              : 0,
            timeoutMs            : 10,
            allowPartial         : true,
            async fetchModelIds() {
                admitted = false;
                return [];
            },
            async warmModel(role, options) {
                warms.push({role, options});
                return {};
            },
            isEffectStillAdmitted: () => admitted,
            log                  : {info() {}, warn() {}}
        });

        await expect(repair).rejects.toMatchObject({
            reason: 'runtime-effect-not-admitted'
        });
        expect(warms).toEqual([]);
    });

    test('Ollama preserves an earlier role as partial when demand changes before the next warm', async () => {
        let   admitted = true;
        const warms    = [];

        const repair = ensureOllamaModelsReady({
            host : 'http://127.0.0.1:11434',
            roles: [
                {role: 'chat',      providerRole: 'chat',      model: 'chat-model',  contextLength: 131072},
                {role: 'embedding', providerRole: 'embedding', model: 'embed-model', contextLength: 32768}
            ],
            requireParallelModels: 2,
            attempts             : 1,
            delayMs              : 0,
            timeoutMs            : 10,
            allowPartial         : true,
            fetchModelIds        : async () => [],
            async warmModel(role, options) {
                warms.push({role, options});
                admitted = false;
                return {};
            },
            isEffectStillAdmitted: () => admitted,
            log                  : {info() {}, warn() {}}
        });

        await expect(repair).rejects.toMatchObject({
            reason           : 'runtime-effect-partially-applied',
            effectDisposition: 'partial',
            providerResidency: {
                admission      : 'refused-after-partial',
                refusedModel   : {role: 'embedding', providerRole: 'embedding', model: 'embed-model', contextLength: 32768},
                attemptedModels: [{role: 'chat', providerRole: 'chat', model: 'chat-model', contextLength: 131072}],
                warmedModels   : [{role: 'chat', providerRole: 'chat', model: 'chat-model', contextLength: 131072}]
            }
        });
        expect(warms).toEqual([{
            role   : {role: 'chat', providerRole: 'chat', model: 'chat-model', contextLength: 131072},
            options: {host: 'http://127.0.0.1:11434', keepAlive: undefined, timeoutMs: 10, contextLength: 131072}
        }]);
    });

    test('Ollama records a failed earlier attempt as uncertain when demand changes before the next warm', async () => {
        let   admitted = true;
        const warms    = [];

        const repair = ensureOllamaModelsReady({
            host : 'http://127.0.0.1:11434',
            roles: [
                {role: 'chat',      providerRole: 'chat',      model: 'chat-model',  contextLength: 131072},
                {role: 'embedding', providerRole: 'embedding', model: 'embed-model', contextLength: 32768}
            ],
            requireParallelModels: 2,
            attempts             : 1,
            delayMs              : 0,
            timeoutMs            : 10,
            allowPartial         : true,
            fetchModelIds        : async () => [],
            async warmModel(role) {
                warms.push(role);
                admitted = false;
                throw new TypeError('pre-dispatch validation');
            },
            isEffectStillAdmitted: () => admitted,
            log                  : {info() {}, warn() {}}
        });

        await expect(repair).rejects.toMatchObject({
            reason           : 'runtime-effect-disposition-uncertain',
            effectDisposition: 'uncertain',
            providerResidency: {
                admission      : 'refused-after-uncertain-attempt',
                refusedModel   : {role: 'embedding', providerRole: 'embedding', model: 'embed-model', contextLength: 32768},
                attemptedModels: [{role: 'chat', providerRole: 'chat', model: 'chat-model', contextLength: 131072}],
                warmedModels   : [],
                pendingModels  : [],
                failedModels   : [{role: 'chat', providerRole: 'chat', model: 'chat-model', contextLength: 131072}]
            }
        });
        expect(warms).toEqual([
            {role: 'chat', providerRole: 'chat', model: 'chat-model', contextLength: 131072}
        ]);
    });

    test('Ollama preserves the no-admission-oracle logger failure boundary', async () => {
        let warmCount = 0;

        await expect(ensureOllamaModelsReady({
            host : 'http://127.0.0.1:11434',
            roles: [
                {role: 'chat', providerRole: 'chat', model: 'chat-model', contextLength: 131072}
            ],
            requireParallelModels: 1,
            attempts             : 1,
            delayMs              : 0,
            timeoutMs            : 10,
            allowPartial         : true,
            fetchModelIds        : async () => [],
            warmModel            : async () => { warmCount += 1; },
            log                  : {
                info() {
                    throw new Error('logger exploded');
                },
                warn() {}
            }
        })).rejects.toThrow('logger exploded');
        expect(warmCount).toBe(0);
    });
});

test.describe('provider readiness follows declared lane ownership (#17021)', () => {
    let getGraphProviderReadinessTarget, probeProviderParallelModelCapacity;

    test.beforeAll(async () => {
        const mod = await import('../../../../../../ai/services/graph/providerReadinessHelper.mjs');

        getGraphProviderReadinessTarget  = mod.getGraphProviderReadinessTarget;
        probeProviderParallelModelCapacity = mod.probeProviderParallelModelCapacity;
    });

    test('an Ollama graph lane does not require the OpenAI-compatible embedding model', async () => {
        const config = {
            modelProvider    : 'ollama',
            graphProvider    : 'ollama',
            embeddingProvider: 'openAiCompatible',
            ollama           : {
                host                 : 'http://chat-model:11434',
                model                : 'gemma4:26b',
                embeddingModel       : 'must-not-cross-lanes',
                requireParallelModels: 1
            },
            openAiCompatible: {
                host          : 'http://embedding-model:1234',
                embeddingModel: 'qwen3-embedding'
            }
        };

        expect(getGraphProviderReadinessTarget(config)).toMatchObject({
            provider      : 'ollama',
            model         : 'gemma4:26b',
            embeddingModel: null,
            roles         : [{providerRole: 'graphProvider', role: 'chat', model: 'gemma4:26b'}, {
                providerRole: 'modelProvider', role: 'chat', model: 'gemma4:26b'
            }]
        });

        const result = await probeProviderParallelModelCapacity({
            config,
            timeoutMs        : 100,
            fetchOllamaModels: async () => ['gemma4:26b']
        });

        expect(result).toMatchObject({
            ready         : true,
            requiredModels: ['gemma4:26b'],
            missingModels : []
        });
    });
});

test.describe('embedding serving canary — safe-band floor (#17070)', () => {
    let checkOpenAiCompatibleEmbeddingServing,
        ensureLmsModelsLoaded,
        resolvedSafeProcessingLimitTokens;

    test.beforeAll(async () => {
        const mod = await import('../../../../../../ai/services/graph/providerReadinessHelper.mjs');

        checkOpenAiCompatibleEmbeddingServing = mod.checkOpenAiCompatibleEmbeddingServing;
        ensureLmsModelsLoaded                  = mod.ensureLmsModelsLoaded;
        resolvedSafeProcessingLimitTokens     = aiConfig.localModels.embedding.safeProcessingLimitTokens;
    });

    test('a loaded context below the safe band is NOT ready, names both numbers, and never probes', async () => {
        let probed = false;

        const result = await checkOpenAiCompatibleEmbeddingServing({
            host           : 'http://embedding-model:8080',
            model          : 'qwen3-embedding',
            input          : 'probe',
            timeoutMs      : 1000,
            lmsLoadedModels: [{
                id           : 'qwen3-embedding',
                contextLength: resolvedSafeProcessingLimitTokens - 1
            }],
            fetchFn        : async () => {
                probed = true;
                throw new Error('the floor must fire before any provider probe');
            }
        });

        expect(result.ready).toBe(false);
        expect(result.reason).toBe('embedding-context-below-safe-band');
        expect(result.warning).toContain(String(resolvedSafeProcessingLimitTokens - 1));
        expect(result.warning).toContain(String(resolvedSafeProcessingLimitTokens));
        expect(probed, 'a too-small lane must not even be probed — the tiny canary would pass it').toBe(false);
    });

    test('a compliant context proceeds to the serving probe (negative control)', async () => {
        const result = await checkOpenAiCompatibleEmbeddingServing({
            host           : 'http://embedding-model:8080',
            model          : 'qwen3-embedding',
            input          : 'probe',
            timeoutMs      : 1000,
            lmsLoadedModels: [{
                id           : 'qwen3-embedding',
                contextLength: resolvedSafeProcessingLimitTokens
            }],
            fetchFn        : async () => ({ok: true, json: async () => ({data: [{embedding: [0.1, 0.2]}]})})
        });

        expect(result).toMatchObject({ready: true, degraded: false, vectorLength: 2});
    });

    test('ensureLmsModelsLoaded propagates a metadata-only below-band result to outer readiness', async () => {
        const model = 'qwen3-embedding',
              rows  = [{id: model, contextLength: resolvedSafeProcessingLimitTokens}];
        let   loads = 0,
              servingProbeOptions,
              servingProbes = 0;

        const result = await ensureLmsModelsLoaded({
            host             : 'http://embedding-model:8080',
            models           : [model],
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 1000,
            contextLengths   : {[model]: resolvedSafeProcessingLimitTokens},
            fetchModelIds    : async () => [model],
            fetchLoadedModels: async () => rows,
            loadModel        : async () => loads++,
            embeddingServingProbe(options) {
                servingProbes++;
                servingProbeOptions = options;

                return {
                    ready   : false,
                    degraded: true,
                    reason  : 'embedding-context-below-safe-band',
                    warning : 'metadata-only embedding context is below the safe band'
                }
            },
            log: {info() {}, warn() {}}
        });

        expect(result).toMatchObject({
            ready           : false,
            degraded        : true,
            embeddingServing: {
                ready : false,
                reason: 'embedding-context-below-safe-band'
            }
        });
        expect(servingProbeOptions).toMatchObject({
            host           : 'http://embedding-model:8080',
            requiredModels : [model],
            lmsLoadedModels: rows
        });
        expect({loads, servingProbes}).toEqual({loads: 0, servingProbes: 1})
    });

    test('a lane without discovered context metadata answers the probe question only (fail-open)', async () => {
        // The floor fires on knowledge, not on doubt: this generic readiness helper preserves the
        // pre-existing serving probe. Live non-LMS lane-shape verification belongs at provider boot.
        const result = await checkOpenAiCompatibleEmbeddingServing({
            host           : 'http://embedding-model:8080',
            model          : 'qwen3-embedding',
            input          : 'probe',
            timeoutMs      : 1000,
            lmsLoadedModels: [],
            fetchFn        : async () => ({ok: true, json: async () => ({data: [{embedding: [0.3]}]})})
        });

        expect(result.ready).toBe(true);
    });
});

test.describe('#29 — an identifier collision is adopted, not retried forever', () => {
    let ensureLmsModelsLoaded, isLmsIdentifierCollision, loadLmsModel;

    // LM Studio's refusal arrives on **stderr**, not as the thrown error's own message —
    // `createLmsCliError()` folds it in as `; stderr=<text>`. Composing the message by hand would
    // test a string this spec authored rather than the one production produces, so every collision
    // below is built by driving the real `loadLmsModel()` with a stubbed `execFileFn`.
    const LMS_REFUSAL_STDERR = 'A model with identifier embedding-model already exists.\n';

    /**
     * Produces the rejection the real conduit produces: `execFileFn` error + stderr →
     * `createLmsCliError()` → the message `isLmsIdentifierCollision()` must recognize.
     */
    const viaRealConduit = (stderr, message = 'Command failed: lms load embedding-model') =>
        loadLmsModel('embedding-model', {
            identifier: 'embedding-model',
            timeoutMs : 10,
            execFileFn: (cmd, args, opts, cb) => {
                const error = new Error(message);

                error.code = 1;
                cb(error, '', stderr);
            }
        });

    test.beforeAll(async () => {
        ({ensureLmsModelsLoaded, isLmsIdentifierCollision, loadLmsModel} =
            await import('../../../../../../ai/services/graph/providerReadinessHelper.mjs'));
    });

    test('the real conduit composes a message the predicate recognizes (execFileFn → createLmsCliError → predicate)', async () => {
        // Binds the whole chain rather than asserting against a hand-written string. If
        // `createLmsCliError()` ever stops folding stderr in, or `describeLmsCliFailure()` reshapes
        // the message, this reds — which a pre-composed fixture could never do.
        const composed = await viaRealConduit(LMS_REFUSAL_STDERR).catch(error => error);

        expect(composed.message).toContain('stderr=');
        expect(isLmsIdentifierCollision(composed)).toBe(true);

        const unrelated = await viaRealConduit('', 'Command failed: lms load embedding-model: ETIMEDOUT').catch(error => error);

        expect(isLmsIdentifierCollision(unrelated)).toBe(false);
    });

    // The collision string is the whole discriminator, so it gets a truth table rather than one
    // happy case. The third row is the one that matters: a genuine failure that merely QUOTES the
    // model id must not be mistaken for a collision, or a real load failure becomes a silent adopt.
    test('isLmsIdentifierCollision matches the refusal and nothing adjacent', () => {
        expect(isLmsIdentifierCollision({message: 'A MODEL WITH IDENTIFIER x ALREADY EXISTS'})).toBe(true);
        expect(isLmsIdentifierCollision({message: 'lms load failed: no such model embedding-model'})).toBe(false);
        expect(isLmsIdentifierCollision({message: 'lms load embedding-model failed: ETIMEDOUT'})).toBe(false);
        expect(isLmsIdentifierCollision({message: ''})).toBe(false);
        expect(isLmsIdentifierCollision(undefined)).toBe(false);
    });

    // Reproduces the actual race rather than a convenient fixture: the model is ABSENT at the
    // immediate probe (so the ensure decides to load), and RESIDENT by the time the load runs —
    // which is exactly the JIT re-load that produces the collision. Making it resident from the
    // start would skip the load entirely and test nothing, which is how the first draft of these
    // specs passed vacuously.
    // `preLoadProbes` is measured, not assumed: the ensure probes residency three times before it
    // will attempt a load (immediate assessment, force-fresh preflight, and the in-loop witness).
    // Returning the resident row any earlier makes the loop conclude the model is already there
    // and skip the load entirely — which is how two earlier drafts of these specs passed while
    // never once exercising a collision. Raising it to 4 leaves the collision re-probe empty, which
    // is the absence case rather than a broken fixture.
    const runCollision = ({residentRows, requiredContext = 8192, loadError = LMS_REFUSAL_STDERR, preLoadProbes = 3}) => {
        let probes = 0;

        return ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['embedding-model'],
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            allowPartial     : true,
            contextLengths   : {'embedding-model': requiredContext},
            fetchModelIds    : async () => ['embedding-model'],
            fetchLoadedModels: async () => (probes++ < preLoadProbes ? [] : residentRows),
            // Real conduit, not a pre-composed Error: the ensure sees exactly the rejection
            // `loadLmsModel()` produces from a CLI failure plus stderr.
            loadModel: () => viaRealConduit(loadError),
            log      : {info() {}, warn() {}}
        });
    };

    test('POSITIVE: a collision over a sufficient resident instance adopts instead of failing', async () => {
        const result = await runCollision({
            residentRows: [{id: 'embedding-model', contextLength: 32768}]
        });

        expect(result.adoptedModels.map(entry => entry.model)).toEqual(['embedding-model']);
        expect(result.failedModels).toEqual([]);
        // Adopted is deliberately NOT loaded: a supervisor that cannot tell "I loaded it" from
        // "it was already there" loses the signal that would show this race recurring.
        expect(result.loadedModels).toEqual([]);
    });

    test('NEGATIVE: a collision over an INSUFFICIENT resident instance stays a failure', async () => {
        const result = await runCollision({
            residentRows: [{id: 'embedding-model', contextLength: 4096}]
        });

        // The JIT instance is resident but below the configured context gate. Adopting here would
        // green a verify the instance cannot honour — this is the mutant-killer for an adopt that
        // fires on the collision alone rather than on the classifier's answer.
        expect(result.adoptedModels).toEqual([]);
        expect(result.failedModels.map(entry => entry.model)).toEqual(['embedding-model']);
    });

    test('NEGATIVE: a collision whose re-probe finds nothing stays a failure — absence is not sufficiency', async () => {
        // One probe later than the others, so the collision re-probe itself returns empty.
        const result = await runCollision({residentRows: [], preLoadProbes: 4});

        // No row for the model means the classifier reports `missing`, not `sufficient`. An empty
        // or unreadable probe must never be read as "it is fine" — that is the fail-open shape the
        // whole guard exists to avoid.
        expect(result.adoptedModels).toEqual([]);
        expect(result.failedModels.map(entry => entry.model)).toEqual(['embedding-model']);
    });

    test('NEGATIVE: a non-collision load failure is untouched by the adopt path', async () => {
        // Sufficient resident row on purpose: if the adopt keyed on residency rather than on the
        // collision, this ETIMEDOUT would be silently adopted.
        const result = await runCollision({
            residentRows: [{id: 'embedding-model', contextLength: 32768}],
            loadError   : 'connect ECONNREFUSED 127.0.0.1:1234'
        });

        expect(result.adoptedModels).toEqual([]);
        expect(result.failedModels.map(entry => entry.model)).toEqual(['embedding-model']);
    });
});

test.describe('#305 — deterministic LMS load failures have a terminal disposition', () => {
    let createLmsLoadFailureGuard, ensureLmsModelsLoaded, getLmsSelectedRuntimeRows;

    test.beforeAll(async () => {
        ({
            createLmsLoadFailureGuard,
            ensureLmsModelsLoaded,
            getLmsSelectedRuntimeRows
        } = await import('../../../../../../ai/services/graph/providerReadinessHelper.mjs'));
    });

    test('selected runtime rows are opaque, normalized evidence rather than a vendor-table schema', () => {
        expect(getLmsSelectedRuntimeRows(`
            LLM ENGINE                                      SELECTED  MODEL FORMAT
            llama.cpp-mac-arm64-apple-metal@2.33.0             ✓       GGUF
            mlx-llm-mac-arm64-apple-metal-nax@1.11.0           ✓       MLX
            mlx-llm-mac-arm64-apple-metal-nax@1.10.1                   MLX
        `)).toEqual([
            'llama.cpp-mac-arm64-apple-metal@2.33.0 ✓ GGUF',
            'mlx-llm-mac-arm64-apple-metal-nax@1.11.0 ✓ MLX'
        ]);
        expect(() => getLmsSelectedRuntimeRows(null)).toThrow('output must be a string');
    });

    test('three equal failures open the circuit; unknown runtime stays blocked; observed change rearms', async () => {
        let   loadCalls       = 0;
        let   runtimeRows     = ['mlx-llm@1.11.0 ✓ MLX'];
        let   runtimeReadable = true;
        const guard           = createLmsLoadFailureGuard({
            maxEquivalentFailures: 3,
            halfOpenAfterMs      : 900000,
            now                  : () => 1000,
            fetchRuntimeRows     : async () => {
                if (!runtimeReadable) throw new Error('runtime table unavailable');
                return runtimeRows
            }
        });
        const run = () => ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['chat-model'],
            contextLengths   : {'chat-model': 262144},
            parallels        : {'chat-model': 1},
            allowPartial     : true,
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => ['chat-model'],
            fetchLoadedModels: async () => [],
            loadFailureGuard : guard,
            async loadModel() {
                loadCalls++;
                const error = new Error(`${os.homedir()}/private/runtime ${'x'.repeat(1200)}`);

                error.code   = 6;
                error.signal = 'SIGABRT';
                throw error
            },
            log: {info() {}, warn() {}}
        });

        await run();
        await run();
        const terminal = await run();

        expect(loadCalls).toBe(3);
        expect(terminal.loadFailureCircuits[0]).toMatchObject({
            status       : 'open',
            host         : 'http://127.0.0.1:1234',
            model        : 'chat-model',
            failureStreak: 3,
            terminal     : true,
            runtime      : {status: 'observed', selectedRows: runtimeRows}
        });
        expect(terminal.failedModels[0].error).not.toContain(os.homedir());
        expect(terminal.failedModels[0].error.length).toBeLessThanOrEqual(1000);
        expect(terminal.observationStatus).toBe('load-blocked');
        expect(terminal.operatorDiagnostic).toMatchObject({code: 'LMS_LOAD_FAILURE_CIRCUIT_OPEN'});

        runtimeReadable = false;
        const unknownRuntime = await run();

        expect(loadCalls).toBe(3);
        expect(unknownRuntime.blockedModels[0].loadFailureCircuit).toMatchObject({
            terminal          : true,
            runtime           : {status: 'observed', selectedRows: runtimeRows},
            runtimeObservation: {status: 'unknown', selectedRows: []}
        });

        runtimeReadable = true;
        runtimeRows     = ['mlx-llm@1.10.1 ✓ MLX'];
        const rearmed = await run();

        expect(loadCalls).toBe(4);
        expect(rearmed.loadFailureCircuits[0]).toMatchObject({
            failureStreak: 1,
            terminal     : false,
            runtime      : {status: 'observed', selectedRows: runtimeRows}
        });

        const otherHost = await guard.beforeAttempt({
            host         : 'http://127.0.0.1:4321',
            model        : 'chat-model',
            contextLength: 262144,
            parallel     : 1,
            identifier   : 'chat-model',
            timeoutMs    : 10
        });

        expect(otherHost.admitted).toBe(true);
    });

    test('one transient failure recovers on the next scheduled attempt and clears the guard', async () => {
        let   loadCalls = 0;
        let   resident  = false;
        const host      = 'http://127.0.0.1:1234';
        const guard     = createLmsLoadFailureGuard({
            maxEquivalentFailures: 3,
            halfOpenAfterMs      : 900000,
            fetchRuntimeRows     : async () => ['mlx-llm@1.11.0 ✓ MLX']
        });
        const run = () => ensureLmsModelsLoaded({
            host,
            models           : ['chat-model'],
            contextLengths   : {'chat-model': 262144},
            parallels        : {'chat-model': 1},
            allowPartial     : true,
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => ['chat-model'],
            fetchLoadedModels: async () => resident ? [{id: 'chat-model', contextLength: 262144, parallel: 1}] : [],
            loadFailureGuard : guard,
            async loadModel() {
                loadCalls++;
                if (loadCalls === 1) throw new Error('one transient load failure');
                resident = true
            },
            log: {info() {}, warn() {}}
        });

        const failed = await run();
        const ready  = await run();

        expect(failed).toMatchObject({ready: false, loadFailureCircuits: [{failureStreak: 1, terminal: false}]});
        expect(ready).toMatchObject({ready: true, loadedModels: ['chat-model']});
        expect(loadCalls).toBe(2);
        expect(guard.snapshot({host, model: 'chat-model'})).toBeNull();
    });

    test('a half-open admission reserves its next cooldown when the caller records no outcome', async () => {
        let   currentTime = 0;
        const guard       = createLmsLoadFailureGuard({
            maxEquivalentFailures: 1,
            halfOpenAfterMs      : 100,
            now                  : () => currentTime,
            fetchRuntimeRows     : async () => ['mlx-llm@1.11.0 ✓ MLX']
        });
        const options = {
            host         : 'http://127.0.0.1:1234',
            model        : 'chat-model',
            contextLength: 262144,
            parallel     : 1,
            identifier   : 'chat-model',
            timeoutMs    : 10
        };

        let attempt = await guard.beforeAttempt(options);

        guard.recordFailure({attempt, error: new Error('backend abort')});
        currentTime = 100;
        const simultaneous = await Promise.all([
            guard.beforeAttempt(options),
            guard.beforeAttempt(options)
        ]);
        const admitted = simultaneous.filter(item => item.admitted),
              blocked  = simultaneous.filter(item => !item.admitted);

        expect(admitted).toHaveLength(1);
        expect(admitted[0]).toMatchObject({admitted: true, halfOpen: true});
        expect(blocked).toHaveLength(1);
        expect(blocked[0]).toMatchObject({admitted: false, nextAttemptAt: 200, terminal: true});
        expect(guard.snapshot({host: options.host, model: options.model})).toMatchObject({
            nextAttemptAt: 200,
            terminal     : true
        });

        // Model a caller path which terminates without `recordFailure()` or `clear()` — for example,
        // a runtime-authority error that must escape. The guard, not every caller, owns one probe.
        expect(await guard.beforeAttempt(options)).toMatchObject({
            admitted     : false,
            nextAttemptAt: 200,
            terminal     : true
        });

        currentTime = 200;

        expect(await guard.beforeAttempt(options)).toMatchObject({admitted: true, halfOpen: true})
    });

    test('a runtime-authority escape after half-open admission still rides out the reserved cooldown', async () => {
        let   authorityHeld = true,
              currentTime   = 0,
              loadCalls     = 0;
        const host  = 'http://127.0.0.1:1234',
              model = 'chat-model',
              guard = createLmsLoadFailureGuard({
                  maxEquivalentFailures: 1,
                  halfOpenAfterMs      : 100,
                  now                  : () => currentTime,
                  fetchRuntimeRows     : async () => ['mlx-llm@1.11.0 ✓ MLX']
              });
        const loadShape = {
            host,
            model,
            contextLength: 262144,
            parallel     : 1,
            identifier   : model,
            timeoutMs    : 10
        };
        const run = () => ensureLmsModelsLoaded({
            host,
            models           : [model],
            contextLengths   : {[model]: loadShape.contextLength},
            parallels        : {[model]: loadShape.parallel},
            allowPartial     : true,
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => [model],
            fetchLoadedModels: async () => [],
            loadFailureGuard : guard,
            async loadModel() {
                loadCalls++
            },
            isAuthorityHeld: () => authorityHeld,
            log            : {info() {}, warn() {}}
        });

        const initial = await guard.beforeAttempt(loadShape);

        guard.recordFailure({attempt: initial, error: new Error('backend abort')});
        currentTime   = 100;
        authorityHeld = false;

        await expect(run()).rejects.toMatchObject({reason: 'runtime-authority-lost'});
        expect(loadCalls).toBe(0);
        expect(guard.snapshot({host, model})).toMatchObject({nextAttemptAt: 200, terminal: true});

        authorityHeld = true;
        const blocked = await run();

        expect(blocked).toMatchObject({observationStatus: 'load-blocked'});
        expect(blocked.blockedModels[0].loadFailureCircuit).toMatchObject({
            admitted     : false,
            nextAttemptAt: 200,
            terminal     : true
        });
        expect(loadCalls).toBe(0)
    });

    test('a changed failure after the half-open probe starts a new streak', async () => {
        let   currentTime = 0;
        const guard       = createLmsLoadFailureGuard({
            maxEquivalentFailures: 2,
            halfOpenAfterMs      : 100,
            now                  : () => currentTime,
            fetchRuntimeRows     : async () => ['mlx-llm@1.11.0 ✓ MLX']
        });
        const options = {
            host         : 'http://127.0.0.1:1234',
            model        : 'chat-model',
            contextLength: 262144,
            parallel     : 1,
            identifier   : 'chat-model',
            timeoutMs    : 10
        };

        let attempt = await guard.beforeAttempt(options);
        guard.recordFailure({attempt, error: new Error('backend abort A')});
        attempt = await guard.beforeAttempt(options);
        const open = guard.recordFailure({attempt, error: new Error('backend abort A')});

        expect(open).toMatchObject({terminal: true, failureStreak: 2, nextAttemptAt: 100});
        expect((await guard.beforeAttempt(options)).admitted).toBe(false);

        currentTime = 100;
        attempt = await guard.beforeAttempt(options);
        expect(attempt).toMatchObject({admitted: true, halfOpen: true});

        const changed = guard.recordFailure({attempt, error: new Error('backend abort B')});

        expect(changed).toMatchObject({terminal: false, failureStreak: 1, status: 'tracking'});

        const changedShape = await guard.beforeAttempt({...options, contextLength: 131072});

        expect(changedShape.admitted).toBe(true);
    });

    test('a sufficient identifier collision is adopted before the guard records a failure', async () => {
        const guard = createLmsLoadFailureGuard({
            maxEquivalentFailures: 2,
            halfOpenAfterMs      : 100,
            fetchRuntimeRows     : async () => ['mlx-llm@1.11.0 ✓ MLX']
        });
        let   probes = 0;
        const result = await ensureLmsModelsLoaded({
            host             : 'http://127.0.0.1:1234',
            models           : ['embedding-model'],
            contextLengths   : {'embedding-model': 32768},
            allowPartial     : true,
            attempts         : 1,
            delayMs          : 0,
            timeoutMs        : 10,
            fetchModelIds    : async () => ['embedding-model'],
            fetchLoadedModels: async () => probes++ < 3
                ? []
                : [{id: 'embedding-model', contextLength: 32768}],
            loadFailureGuard: guard,
            async loadModel() {
                throw new Error('A model with identifier embedding-model already exists.')
            },
            log: {info() {}, warn() {}}
        });

        expect(result.adoptedModels.map(item => item.model)).toEqual(['embedding-model']);
        expect(result.failedModels).toEqual([]);
        expect(guard.snapshot({host: 'http://127.0.0.1:1234', model: 'embedding-model'})).toBeNull();
    });
});
