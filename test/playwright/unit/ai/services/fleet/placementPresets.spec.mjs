import {expect, test} from '@playwright/test';
import fs             from 'node:fs';
import path           from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    CONTAINER_AUTHORITY_PROFILE,
    PLANE_PROFILE,
    chromaStoreFor,
    declaredEnvBindings,
    presetStatus,
    presets,
    reembedPath,
    unknownPresetEnvKeys
} from '../../../../../../ai/services/fleet/placementPresets.mjs';
import {GiB, fitsPreset, probePlacement} from '../../../../../../ai/services/fleet/probePlacement.mjs';

const
    REPO_ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    CONFIG_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'ai/configBase.mjs'), 'utf8'),
    byId          = id => presets.find(preset => preset.id === id);

/** The probe's fixture readers at a given host size; models are read from the preset under test, not the host. */
function hostReaders(totalGiB, {vmCapGiB = 32} = {}) {
    return {
        totalmem      : () => totalGiB * GiB,
        cores         : () => 16,
        hostUse       : () => [{name: 'os-and-harnesses', bytes: 14 * GiB, source: 'fixture'}],
        vmInfo        : () => ({backend: 'docker-desktop', capBytes: vmCapGiB * GiB, cores: 8, guestOs: 'Ubuntu 24.04.4 LTS'}),
        containerStats: () => [{name: 'chroma', bytes: 2 * GiB}, {name: 'mc-server', bytes: 0.5 * GiB}],
        vmReservation : () => 2.5 * GiB,
        loadedModels  : () => ({inventories: ['lms'], models: []}),
        swap          : () => ({swapUsedBytes: 0, compressedBytes: 1 * GiB}),
        statfs        : () => ({rootFreeBytes: 300 * GiB}),
        accelerator   : () => null,
        composeLs     : () => [],
        composePorts  : () => []
    }
}

test.describe('placementPresets — three presets as env sets over declared leaves', () => {
    test('AC-1: three presets, every contract field, the birth decision pinned per preset, workloads from the fixture plane', () => {
        expect(presets.map(preset => preset.id)).toEqual(['hosted', 'local-small', 'local-full']);

        for (const preset of presets) {
            expect(Object.keys(preset).sort()).toEqual([
                'authorityProfile', 'chatModel', 'embedder', 'env', 'id', 'inference', 'label', 'pendingBindings',
                'profile', 'qualityFloor', 'requires', 'vectorDimension', 'workload'
            ]);
            expect(preset.profile).toBe(PLANE_PROFILE.id);
            expect(preset.authorityProfile).toBe(CONTAINER_AUTHORITY_PROFILE);
            expect(preset.env.NEO_VECTOR_DIMENSION).toBe(String(preset.vectorDimension));
            expect(Object.keys(preset.workload).sort()).toEqual(['modelsBytes', 'planeIdleBytes', 'planePeakBytes', 'source', 'vmCapRecommendedBytes']);
            // the fixture plane's numbers, never the maintainer plane's 31 GB
            expect(preset.workload.planeIdleBytes).toBe(Math.round(0.39 * GiB));
            expect(preset.workload.planePeakBytes).toBe(Math.round(2.5 * GiB));
            expect(preset.workload.source).toContain('fm-fresh-small');
            expect(Object.isFrozen(preset)).toBe(true)
        }

        expect(byId('local-small')).toMatchObject({inference: 'local', vectorDimension: 1024, embedder: 'text-embedding-qwen3-embedding-0.6b', chatModel: 'google/gemma-4-26b-a4b', pendingBindings: []});
        expect(byId('local-full')).toMatchObject({inference: 'local', vectorDimension: 4096, embedder: 'text-embedding-qwen3-embedding-8b', chatModel: 'google/gemma-4-26b-a4b', pendingBindings: []});
        expect(byId('hosted')).toMatchObject({inference: 'hosted', vectorDimension: 3072, embedder: 'gemini-embedding-001', chatModel: 'gemini-3.5-flash', requires: ['providerKey', 'pat', 'repos']});
        expect(byId('hosted').pendingBindings).toEqual(['gemini.modelName', 'gemini.embeddingModel']);

        // the local presets point the plane's containers at the host's model server, as the live plane does
        for (const id of ['local-small', 'local-full']) {
            expect(byId(id).env).toMatchObject({NEO_MODEL_PROVIDER: 'openAiCompatible', NEO_EMBEDDING_PROVIDER: 'openAiCompatible', NEO_OPENAI_COMPATIBLE_HOST: 'http://host.docker.internal:1234', NEO_OPENAI_COMPATIBLE_MODEL: 'google/gemma-4-26b-a4b'});
            expect(byId(id).env.NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL).toBe(byId(id).embedder)
        }
        expect(byId('hosted').env).toEqual({NEO_MODEL_PROVIDER: 'gemini', NEO_EMBEDDING_PROVIDER: 'gemini', NEO_VECTOR_DIMENSION: '3072'});

        // the models' bytes are the loaded weights, summed once per preset; hosted carries none
        expect(byId('hosted').workload.modelsBytes).toBe(0);
        expect(byId('local-small').workload.modelsBytes).toBe(15641352350 + 640000000);
        expect(byId('local-full').workload.modelsBytes).toBe(15641352350 + 4680000000);
        expect(byId('local-full').workload.vmCapRecommendedBytes).toBe(8 * GiB);
        expect(byId('hosted').workload.vmCapRecommendedBytes).toBe(6 * GiB)
    });

    test('a preset is supported only with a recorded floor; hosted stays a candidate until its run is recorded', () => {
        expect(presetStatus(byId('local-small'))).toBe('supported');
        expect(presetStatus(byId('local-full'))).toBe('supported');
        expect(presetStatus(byId('hosted'))).toBe('candidate');
        expect(byId('local-full').qualityFloor).toMatchObject({instrument: 'tri-vector-three-documents', measuredAt: '2026-09-23', chatModel: 'google/gemma-4-26b-a4b', result: {schemaValid: true, danglingEdges: 0, ungroundedNames: 0}});
        expect(presetStatus({})).toBe('candidate')
    });

    test('AC-2: the leaf-parity lint — every preset env key is a binding ai/configBase.mjs declares; a typo fails', () => {
        const declared = declaredEnvBindings(CONFIG_SOURCE);

        // the scan sees the real tree: the provider selectors, the dimension pin, the Gemini key leaf
        expect(declared.size).toBeGreaterThan(200);
        for (const name of ['NEO_MODEL_PROVIDER', 'NEO_EMBEDDING_PROVIDER', 'NEO_VECTOR_DIMENSION', 'NEO_OPENAI_COMPATIBLE_HOST', 'NEO_OPENAI_COMPATIBLE_MODEL', 'NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL', 'GEMINI_API_KEY', 'NEO_CHROMA_DATA_DIR']) {
            expect(declared.has(name), name).toBe(true)
        }

        for (const preset of presets) {
            expect(unknownPresetEnvKeys(preset, declared), preset.id).toEqual([])
        }

        const typo = {...byId('local-full'), env: {...byId('local-full').env, NEO_OPENAI_COMPATIBLE_HSOT: 'http://host.docker.internal:1234', NEO_TYPO_PROVIDER: 'x'}};
        expect(unknownPresetEnvKeys(typo, declared)).toEqual(['NEO_OPENAI_COMPATIBLE_HSOT', 'NEO_TYPO_PROVIDER']);

        // the scan reads bindings, not names in prose: a leaf without a binding declares no env key
        expect(declaredEnvBindings("leaf('gemini-3.5-flash'),\n leaf(4096, 'NEO_X', 'number')")).toEqual(new Set(['NEO_X']));
        expect(declaredEnvBindings("leaf(path.resolve(a, 'b'), 'NEO_WITH_CALL', 'string')")).toEqual(new Set(['NEO_WITH_CALL']))
    });

    test('AC-3: reembedPath names the new store for a dimension change and is null for none; nothing re-dimensions in place', () => {
        const path = reembedPath(byId('local-small'), byId('local-full'));

        expect(path).toMatchObject({from: 1024, to: 4096, store: 'chroma/unified', env: {NEO_VECTOR_DIMENSION: '4096', NEO_CHROMA_DATA_DIR: 'chroma/unified'}});
        expect(path.steps[0]).toBe('stop the plane');
        expect(path.steps.join('\n')).toContain('the old store stays on disk, untouched');
        expect(path.steps.join('\n')).toContain('text-embedding-qwen3-embedding-8b');

        const toSmall = reembedPath(byId('local-full'), byId('local-small'));
        expect(toSmall).toMatchObject({from: 4096, to: 1024, store: 'chroma/unified-1024d', env: {NEO_CHROMA_DATA_DIR: 'chroma/unified-1024d'}});
        expect(reembedPath(byId('local-full'), byId('hosted')).store).toBe('chroma/unified-3072d');

        expect(reembedPath(byId('local-full'), byId('local-full'))).toBeNull();
        expect(reembedPath(byId('local-full'), {...byId('local-full'), embedder: 'another-4096-embedder'})).toBeNull();
        expect(() => reembedPath(byId('local-full'), {})).toThrow(/integer vectorDimension/);
        expect(chromaStoreFor(4096)).toBe('chroma/unified');
        expect(chromaStoreFor(768)).toBe('chroma/unified-768d');

        // the module exports data and pure readers only — no verb touches a store or a dimension
        expect(Object.keys(presets[0].env).some(key => /CHROMA|DATA_DIR/.test(key))).toBe(false)
    });

    test('the probe consumes the workloads: a 64 GiB host fits every preset, a 32 GiB host only the hosted one', async () => {
        const big = await probePlacement({readers: hostReaders(64)});

        for (const preset of presets) {
            expect(fitsPreset(big, preset.workload).fits, preset.id).toBe(true)
        }

        // a 32 GiB host with 14 GiB of other use and a 16 GiB VM: 15.5 GiB of host budget
        const
            small     = await probePlacement({readers: hostReaders(32, {vmCapGiB: 16})}),
            hostAvail = 15.5 * GiB;

        expect(small.host.availableBytes).toBe(hostAvail);
        // the host backs the plane's peak as well as the models: hosted keeps 13 GiB, both local presets fall short
        expect(fitsPreset(small, byId('hosted').workload)).toMatchObject({fits: true, margins: {host: hostAvail - 2.5 * GiB}});
        expect(fitsPreset(small, byId('local-full').workload)).toMatchObject({fits: false, reasons: ['the host budget falls 5.9 GiB short']});
        expect(fitsPreset(small, byId('local-small').workload)).toMatchObject({fits: false, reasons: ['the host budget falls 2.2 GiB short']});
        expect(fitsPreset(small, byId('local-small').workload).margins.host).toBe(hostAvail - byId('local-small').workload.modelsBytes - 2.5 * GiB);
        // a recommendation needs headroom on top of a bare fit — the recipe's placement step owns that rule, not this table
        expect(fitsPreset(small, undefined)).toBeNull()
    });
});
