import {expect, test} from '@playwright/test';
import fs             from 'node:fs';
import path           from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    CONTAINER_AUTHORITY_PROFILE,
    DEFAULT_CHROMA_DATABASE,
    PLANE_PROFILE,
    declaredEnvBindings,
    presetStatus,
    presets,
    profileInputs,
    reembedPath,
    unconsumedPresetEnvKeys,
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
        // AC-4: every preset names its models through declared env bindings — nothing pending since the Gemini leaves gained theirs
        for (const preset of presets) {
            expect(preset.pendingBindings, preset.id).toEqual([])
        }

        // the local presets speak the overlay's own inputs (it maps them onto the openAiCompatible leaves) and
        // point the plane's containers at the host's model server, as the live plane does
        for (const id of ['local-small', 'local-full']) {
            expect(byId(id).env).toMatchObject({NEO_MODEL_PROVIDER: 'openAiCompatible', NEO_GRAPH_PROVIDER: 'openAiCompatible', NEO_EMBEDDING_PROVIDER: 'openAiCompatible', NEO_LOCAL_AGENT_OS_PROVIDER_HOST: 'http://host.docker.internal:1234', NEO_LOCAL_AGENT_OS_MODEL: 'google/gemma-4-26b-a4b'});
            expect(byId(id).env.NEO_LOCAL_AGENT_OS_EMBEDDING_MODEL).toBe(byId(id).embedder)
        }
        expect(byId('hosted').env).toEqual({NEO_MODEL_PROVIDER: 'gemini', NEO_GRAPH_PROVIDER: 'gemini', NEO_EMBEDDING_PROVIDER: 'gemini', NEO_GEMINI_MODEL: 'gemini-3.5-flash', NEO_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001', NEO_VECTOR_DIMENSION: '3072'});
        expect(byId('hosted').env.NEO_GEMINI_MODEL).toBe(byId('hosted').chatModel);
        expect(byId('hosted').env.NEO_GEMINI_EMBEDDING_MODEL).toBe(byId('hosted').embedder);

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
        expect(byId('local-full').qualityFloor).toMatchObject({instrument: 'tri-vector-three-documents', measuredAt: '2026-10-02', chatModel: 'google/gemma-4-26b-a4b', documents: ['19339-dock-reveal-overlay-focus.md', '19354-dock-workspace-header-actions-plugin.md', '19356-grid-body-scroll-edge.md'], result: {schemaValid: true, danglingEdges: 1, groundedNodesPerDocument: '3-4', ungroundedNames: 0}});
        expect(presetStatus({})).toBe('candidate')
    });

    test('AC-2: parity with the declared leaves AND the effective profile — every preset key is an input the profile reads and lands on a declared binding', () => {
        const
            declared = declaredEnvBindings(CONFIG_SOURCE),
            profile  = profileInputs(PLANE_PROFILE.composeFiles.map(file => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));

        // the scan sees the real tree: the provider selectors, the dimension pin, the Gemini key leaf
        expect(declared.size).toBeGreaterThan(200);
        for (const name of ['NEO_MODEL_PROVIDER', 'NEO_EMBEDDING_PROVIDER', 'NEO_VECTOR_DIMENSION', 'NEO_CHROMA_DATABASE', 'NEO_OPENAI_COMPATIBLE_HOST', 'NEO_OPENAI_COMPATIBLE_MODEL', 'NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL', 'GEMINI_API_KEY']) {
            expect(declared.has(name), name).toBe(true)
        }

        // the effective profile: the overlay maps its own inputs onto the openAiCompatible leaves, lets a
        // preset choose the three providers, and forwards the dimension and the database — the two
        // inputs the review found missing: a preset's 1024 or 3072 never reached a container before
        expect(profile.mappings.get('NEO_LOCAL_AGENT_OS_MODEL')).toBe('NEO_OPENAI_COMPATIBLE_MODEL');
        expect(profile.mappings.get('NEO_LOCAL_AGENT_OS_EMBEDDING_MODEL')).toBe('NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL');
        expect(profile.mappings.get('NEO_LOCAL_AGENT_OS_PROVIDER_HOST')).toBe('NEO_OPENAI_COMPATIBLE_HOST');
        for (const name of ['NEO_MODEL_PROVIDER', 'NEO_GRAPH_PROVIDER', 'NEO_EMBEDDING_PROVIDER', 'NEO_VECTOR_DIMENSION', 'NEO_CHROMA_DATABASE', 'NEO_GEMINI_MODEL', 'NEO_GEMINI_EMBEDDING_MODEL']) {
            expect(profile.inputs.has(name), name).toBe(true)
        }

        for (const preset of presets) {
            expect(unconsumedPresetEnvKeys(preset, profile, declared), preset.id).toEqual([]);
            // the leaf-name arm stays for the keys that are leaves themselves
            expect(unknownPresetEnvKeys({...preset, env: Object.fromEntries(Object.entries(preset.env).filter(([key]) => !key.startsWith('NEO_LOCAL_AGENT_OS_')))}, declared), preset.id).toEqual([])
        }

        // the review's falsifier as an arm: the pre-repair shape named the leaves' own env names, which the
        // overlay does not read — declared in configBase, yet no container would have received them
        const leafNamed = {...byId('local-small'), env: {NEO_OPENAI_COMPATIBLE_MODEL: 'google/gemma-4-26b-a4b', NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL: 'text-embedding-qwen3-embedding-0.6b'}};
        expect(unknownPresetEnvKeys(leafNamed, declared)).toEqual([]);
        expect(unconsumedPresetEnvKeys(leafNamed, profile, declared)).toEqual([
            'NEO_OPENAI_COMPATIBLE_MODEL: not an input of the profile\'s Compose files',
            'NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL: not an input of the profile\'s Compose files'
        ]);

        const typo = {...byId('local-full'), env: {...byId('local-full').env, NEO_OPENAI_COMPATIBLE_HSOT: 'http://host.docker.internal:1234', NEO_TYPO_PROVIDER: 'x'}};
        expect(unknownPresetEnvKeys(typo, declared)).toEqual(expect.arrayContaining(['NEO_OPENAI_COMPATIBLE_HSOT', 'NEO_TYPO_PROVIDER']));
        expect(unconsumedPresetEnvKeys(typo, profile, declared)).toEqual(['NEO_OPENAI_COMPATIBLE_HSOT: not an input of the profile\'s Compose files', 'NEO_TYPO_PROVIDER: not an input of the profile\'s Compose files']);

        // an input that lands on an undeclared name is caught at the landing, not the input
        const fixture = profileInputs(['  NEO_NOT_A_LEAF: ${NEO_SOME_INPUT:-x}\n  - NEO_VECTOR_DIMENSION=${NEO_VECTOR_DIMENSION:-}\n']);
        expect(fixture.inputs).toEqual(new Set(['NEO_SOME_INPUT', 'NEO_VECTOR_DIMENSION']));
        expect(fixture.mappings.get('NEO_SOME_INPUT')).toBe('NEO_NOT_A_LEAF');
        expect(unconsumedPresetEnvKeys({env: {NEO_SOME_INPUT: '1'}}, fixture, declared)).toEqual(['NEO_SOME_INPUT: lands on NEO_NOT_A_LEAF, which configBase does not declare']);

        // the last file to feed a name wins: the overlay's anchor shadows the base's pass-through of the same
        // name, so the base's input is gone and the overlay's is what the profile reads (a bare use stays)
        const shadowed = profileInputs([
            '      - NEO_OPENAI_COMPATIBLE_MODEL=${NEO_OPENAI_COMPATIBLE_MODEL:-}\n    file: ${NEO_TOKEN_FILE:-/x}\n',
            '  NEO_OPENAI_COMPATIBLE_MODEL: ${NEO_LOCAL_AGENT_OS_MODEL:-google/gemma-4-26b-a4b}\n'
        ]);
        expect(shadowed.inputs).toEqual(new Set(['NEO_TOKEN_FILE', 'NEO_LOCAL_AGENT_OS_MODEL']));
        expect(shadowed.mappings.get('NEO_LOCAL_AGENT_OS_MODEL')).toBe('NEO_OPENAI_COMPATIBLE_MODEL');
        expect(unconsumedPresetEnvKeys({env: {NEO_OPENAI_COMPATIBLE_MODEL: 'm'}}, shadowed, declared)).toEqual(['NEO_OPENAI_COMPATIBLE_MODEL: not an input of the profile\'s Compose files']);

        // the scan reads bindings, not names in prose: a leaf without a binding declares no env key
        expect(declaredEnvBindings("leaf('gemini-3.5-flash'),\n leaf(4096, 'NEO_X', 'number')")).toEqual(new Set(['NEO_X']));
        expect(declaredEnvBindings("leaf(path.resolve(a, 'b'), 'NEO_WITH_CALL', 'string')")).toEqual(new Set(['NEO_WITH_CALL']))
    });

    test('AC-3: a dimension change needs a validated fresh database the deployment chose; the current one stays; same dimension is null', () => {
        // the existing default store as the current database: no name, the current name and the default are refused
        expect(() => reembedPath(byId('local-small'), byId('local-full'))).toThrow(/needs an explicit fresh database name/);
        expect(() => reembedPath(byId('local-small'), byId('local-full'), {freshDatabase: DEFAULT_CHROMA_DATABASE})).toThrow(/is the current or the default database/);
        expect(() => reembedPath(byId('local-small'), byId('local-full'), {currentDatabase: 'unified-1024', freshDatabase: 'unified-1024'})).toThrow(/is the current or the default database/);
        expect(() => reembedPath(byId('local-small'), byId('local-full'), {freshDatabase: 'a b'})).toThrow(/3–63 characters/);

        const up = reembedPath(byId('local-small'), byId('local-full'), {currentDatabase: 'unified-1024', freshDatabase: 'unified-4096-b'});

        expect(up).toMatchObject({from: 1024, to: 4096, database: {current: 'unified-1024', fresh: 'unified-4096-b'}, env: {NEO_VECTOR_DIMENSION: '4096', NEO_CHROMA_DATABASE: 'unified-4096-b'}});
        expect(Object.keys(up.env)).toEqual(['NEO_VECTOR_DIMENSION', 'NEO_CHROMA_DATABASE']);
        expect(up.steps[0]).toBe('stop the plane');
        expect(up.steps[1]).toMatch(/verify 'unified-4096-b' does not exist in this Chroma yet/);
        expect(up.steps.join('\n')).toContain("'unified-1024' stays in Chroma's volume, untouched");
        expect(up.steps.join('\n')).toContain('text-embedding-qwen3-embedding-8b');

        // the round trip 4096 → 1024 → 4096 never lands on the original name again: each hop needs a NEW name
        const down = reembedPath(byId('local-full'), byId('local-small'), {freshDatabase: 'unified-1024'});
        expect(down.database).toEqual({current: DEFAULT_CHROMA_DATABASE, fresh: 'unified-1024'});
        expect(() => reembedPath(byId('local-small'), byId('local-full'), {currentDatabase: 'unified-1024', freshDatabase: DEFAULT_CHROMA_DATABASE})).toThrow(/current or the default/);
        expect(reembedPath(byId('local-small'), byId('local-full'), {currentDatabase: 'unified-1024', freshDatabase: 'unified-4096-second'}).database.fresh).toBe('unified-4096-second');

        expect(reembedPath(byId('local-full'), byId('local-full'))).toBeNull();
        expect(reembedPath(byId('local-full'), {...byId('local-full'), embedder: 'another-4096-embedder'})).toBeNull();
        expect(() => reembedPath(byId('local-full'), {})).toThrow(/integer vectorDimension/);

        // the module exports data and pure readers only — no preset names a store, a data dir or a database
        expect(presets.every(preset => !Object.keys(preset.env).some(key => /CHROMA|DATA_DIR/.test(key)))).toBe(true)
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
