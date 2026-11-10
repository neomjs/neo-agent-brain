import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    harnessGenerationId,
    listHarnessGenerations,
    materializeHarnessGeneration,
    selectHarnessGeneration
} from '../../../../../../ai/services/fleet/harnessGeneration.mjs';

const CODEX = {bundleId: 'com.openai.codex', teamId: '2DC432GLL2'};

/** @summary A source `.app` with a main executable; its plist and signature come from the seams. */
function makeSource(roots, name = 'ChatGPT') {
    const
        parent    = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-source-')),
        appBundle = path.join(parent, `${name}.app`),
        main      = path.join(appBundle, 'Contents', 'MacOS', name);

    fs.mkdirSync(path.dirname(main), {recursive: true});
    fs.writeFileSync(main, '#!/bin/sh\n', {mode: 0o755});
    roots.push(parent);
    return appBundle
}

/** @summary Host-tool seams describing one vendor build; every field can be overridden per test. */
function build({
    bundleId = CODEX.bundleId, teamId = CODEX.teamId, shortVersion = '26.1103.60933', buildVersion = '25894',
    cdhash = 'a'.repeat(64), verified = true, gatekeeper = true, executable = 'ChatGPT',
    probe = () => ({available: true, reason: null}), inspectSignature
} = {}) {
    return {
        copyBundle      : (source, target) => fs.cpSync(source, target, {recursive: true}),
        readBundleInfo  : () => ({bundleId, shortVersion, buildVersion, executable}),
        inspectSignature: inspectSignature ?? (() => ({verified, teamId, cdhash})),
        assessGatekeeper: () => gatekeeper,
        probe
    }
}

test.describe('harnessGeneration', () => {
    const roots = [];
    let   root;

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-generations-'));
        roots.push(root)
    });

    test.afterEach(() => {
        for (const directory of roots.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
    });

    const familyDir = () => path.join(root, 'codex-desktop');
    const staging   = () => fs.readdirSync(familyDir()).filter(entry => entry.startsWith('.staging-'));
    const ledger    = () => JSON.parse(fs.readFileSync(path.join(familyDir(), 'ledger.json'), 'utf8'));

    test('identity is location-free and moves with version, build and cdhash', () => {
        const identity = {bundleId: CODEX.bundleId, shortVersion: '1.0', buildVersion: '7', cdhash: 'b'.repeat(40)};
        const id       = harnessGenerationId(identity);

        expect(id).toMatch(/^[a-f0-9]{64}$/);
        expect(harnessGenerationId({...identity})).toBe(id);

        for (const change of [{shortVersion: '1.1'}, {buildVersion: '8'}, {cdhash: 'c'.repeat(40)}]) {
            expect(harnessGenerationId({...identity, ...change})).not.toBe(id)
        }

        expect(() => harnessGenerationId({...identity, cdhash: 'not-hex'})).toThrow(/identity-invalid/);
        expect(() => harnessGenerationId({...identity, buildVersion: ' '})).toThrow(/identity-invalid/)
    });

    test('admits a verified build by copying it, probes the COPY, and selects it', async () => {
        const source = makeSource(roots);
        let   probedPath;

        const result = await materializeHarnessGeneration({
            root, family: 'codex-desktop', sourceBundle: source,
            seams: build({probe: ({binaryPath}) => (probedPath = binaryPath, {available: true})})
        });

        expect(result).toMatchObject({admitted: true, reason: null});
        expect(result.appBundle).toBe(path.join(familyDir(), result.id, 'ChatGPT.app'));
        expect(fs.existsSync(result.binaryPath)).toBe(true);
        expect(probedPath.startsWith(familyDir())).toBe(true);
        expect(probedPath.startsWith(source)).toBe(false);
        expect(staging()).toEqual([]);
        expect(ledger().admitted).toHaveLength(1);
        expect(selectHarnessGeneration({root, family: 'codex-desktop'})).toEqual({
            id: result.id, appBundle: result.appBundle, binaryPath: result.binaryPath, shortVersion: '26.1103.60933', buildVersion: '25894'
        })
    });

    test('each failed check refuses by name, cleans its staging copy, and keeps the selection', async () => {
        const source  = makeSource(roots);
        const current = await materializeHarnessGeneration({root, family: 'codex-desktop', sourceBundle: source, seams: build()});
        const next    = {shortVersion: '26.1110.1', buildVersion: '26000', cdhash: 'd'.repeat(64)};

        for (const [seams, reason] of [
            [build({...next, bundleId: 'com.example.other'}),            'bundle-identity-mismatch'],
            [build({...next, verified: false}),                          'signature-invalid'],
            [build({...next, teamId: 'AAAAAAAAAA'}),                     'team-identity-mismatch'],
            [build({...next, gatekeeper: false}),                        'gatekeeper-rejected'],
            [build({...next, executable: '../escape'}),                  'bundle-metadata-invalid'],
            [build({...next, probe: () => ({available: false, reason: 'updater-disable-predicate-missing'})}),
                                                                         'probe-refused:updater-disable-predicate-missing'],
            [build({...next, probe: () => { throw new Error('boom') }}), 'probe-refused:error'],
            [{...build(next), copyBundle: () => { throw new Error('disk full') }}, 'copy-failed']
        ]) {
            const result = await materializeHarnessGeneration({root, family: 'codex-desktop', sourceBundle: source, seams});

            expect(result, reason).toMatchObject({admitted: false, appBundle: null, binaryPath: null, reason});
            expect(staging(), reason).toEqual([]);
            expect(selectHarnessGeneration({root, family: 'codex-desktop'}).id, reason).toBe(current.id)
        }

        expect(ledger().rejected.map(entry => entry.reason)).toHaveLength(8);
        expect(ledger().admitted).toHaveLength(1)
    });

    test('a family without a capability probe is refused, not admitted on its signature alone', async () => {
        const result = await materializeHarnessGeneration({
            root, family: 'claude-desktop', sourceBundle: makeSource(roots, 'Claude'),
            seams: {...build({bundleId: 'com.anthropic.claudefordesktop', teamId: 'Q6L2SF6YDW', executable: 'Claude'}), probe: undefined}
        });

        expect(result).toMatchObject({admitted: false, reason: 'family-probe-unavailable'})
    });

    test('re-admitting a known build is a no-op that never displaces a newer selection', async () => {
        const source = makeSource(roots);
        const older  = await materializeHarnessGeneration({root, family: 'codex-desktop', sourceBundle: source, seams: build()});
        const newer  = await materializeHarnessGeneration({
            root, family: 'codex-desktop', sourceBundle: source, seams: build({shortVersion: '26.1110.1', buildVersion: '26000', cdhash: 'e'.repeat(64)})
        });
        const again = await materializeHarnessGeneration({root, family: 'codex-desktop', sourceBundle: source, seams: build()});

        expect(again).toEqual(older);
        expect(ledger().admitted.map(entry => entry.id)).toEqual([older.id, newer.id]);
        expect(selectHarnessGeneration({root, family: 'codex-desktop'}).id).toBe(newer.id);
        expect(staging()).toEqual([])
    });

    test('lists every admitted generation whose copy is present, newest first; a removed copy drops out of the list and the selection', async () => {
        const source = makeSource(roots);
        const older  = await materializeHarnessGeneration({root, family: 'codex-desktop', sourceBundle: source, seams: build()});
        const newer  = await materializeHarnessGeneration({
            root, family: 'codex-desktop', sourceBundle: source, seams: build({shortVersion: '26.1110.1', buildVersion: '26000', cdhash: 'e'.repeat(64)})
        });

        expect(listHarnessGenerations({root, family: 'codex-desktop'})).toMatchObject([
            {id: newer.id, binaryPath: newer.binaryPath, shortVersion: '26.1110.1', buildVersion: '26000'},
            {id: older.id, binaryPath: older.binaryPath}
        ]);

        fs.rmSync(path.join(familyDir(), newer.id), {recursive: true, force: true});

        expect(listHarnessGenerations({root, family: 'codex-desktop'}).map(({id}) => id)).toEqual([older.id]);
        expect(selectHarnessGeneration({root, family: 'codex-desktop'}).id).toBe(older.id)
    });

    test('a published copy whose seal no longer verifies is reported, never replaced', async () => {
        const source   = makeSource(roots);
        const admitted = await materializeHarnessGeneration({root, family: 'codex-desktop', sourceBundle: source, seams: build()});
        const result   = await materializeHarnessGeneration({
            root, family: 'codex-desktop', sourceBundle: source,
            seams: build({inspectSignature: bundle => ({verified: bundle.includes('.staging-'), teamId: CODEX.teamId, cdhash: 'a'.repeat(64)})})
        });

        expect(result).toMatchObject({admitted: false, id: admitted.id, reason: 'existing-generation-invalid'});
        expect(fs.existsSync(admitted.binaryPath)).toBe(true)
    });

    test('an interrupted run leaves nothing selectable, and the next run recovers', async () => {
        const source = makeSource(roots);
        const id     = harnessGenerationId({bundleId: CODEX.bundleId, shortVersion: '26.1103.60933', buildVersion: '25894', cdhash: 'a'.repeat(64)});

        // A crash after staging, and a crash after the rename but before the ledger write.
        fs.mkdirSync(path.join(familyDir(), '.staging-crashed', 'ChatGPT.app'), {recursive: true});
        fs.cpSync(source, path.join(familyDir(), id, 'ChatGPT.app'), {recursive: true});

        expect(selectHarnessGeneration({root, family: 'codex-desktop'})).toBeNull();

        const result = await materializeHarnessGeneration({root, family: 'codex-desktop', sourceBundle: source, seams: build()});

        expect(result).toMatchObject({admitted: true, id});
        expect(staging()).toEqual([]);
        expect(selectHarnessGeneration({root, family: 'codex-desktop'}).id).toBe(id)
    });

    test('concurrent runs for one family serialize, so no verdict is lost', async () => {
        const source  = makeSource(roots);
        const results = await Promise.all(['1', '2', '3'].map(n => materializeHarnessGeneration({
            root, family: 'codex-desktop', sourceBundle: source, seams: build({buildVersion: n, cdhash: n.repeat(64)})
        })));

        expect(results.every(result => result.admitted)).toBe(true);
        expect(ledger().admitted.map(entry => entry.buildVersion)).toEqual(['1', '2', '3'])
    });

    test('invalid arguments and a malformed ledger refuse loudly', () => {
        const source = makeSource(roots);

        expect(() => materializeHarnessGeneration({root: 'relative', family: 'codex-desktop', sourceBundle: source})).toThrow(/root-must-be-absolute/);
        expect(() => materializeHarnessGeneration({root, family: 'codex', sourceBundle: source})).toThrow(/unknown-family/);
        expect(() => materializeHarnessGeneration({root, family: 'codex-desktop', sourceBundle: path.dirname(source)})).toThrow(/source-must-be-an-app-bundle/);

        fs.mkdirSync(familyDir(), {recursive: true});
        fs.writeFileSync(path.join(familyDir(), 'ledger.json'), '{not json');
        expect(() => selectHarnessGeneration({root, family: 'codex-desktop'})).toThrow(/ledger-invalid/)
    })
});
