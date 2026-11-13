import {expect, test} from '@playwright/test';
import {createHash}   from 'node:crypto';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    acquireClaudeDesktopUpdate,
    checkClaudeDesktopUpdate,
    parseClaudeCaskRecord
} from '../../../../../../ai/services/fleet/claudeDesktopUpdate.mjs';
import {
    materializeHarnessGeneration,
    readHarnessGenerationLedger,
    selectHarnessGeneration
} from '../../../../../../ai/services/fleet/harnessGeneration.mjs';

const
    RECORD_URL = 'https://formulae.brew.sh/api/cask/claude.json',
    COMMIT     = 'ce4f8dd2e25346b37909530556abd6e2e7b00206',
    zipUrl     = version => `https://downloads.claude.ai/releases/darwin/universal/${version}/Claude-${COMMIT}.zip`,
    ZIP_URL    = zipUrl('5.11492.0');

/**
 * @summary A cask record in the shape Homebrew's API serves for `claude`, for the bytes given.
 * @param {Buffer} bytes
 * @param {Object} [overrides]
 * @returns {Object}
 */
const caskRecord = (bytes, overrides = {}) => ({
    token  : 'claude',
    version: `5.11492.0,${COMMIT}`,
    url    : ZIP_URL,
    sha256 : createHash('sha256').update(bytes).digest('hex'),
    ...overrides
});

/**
 * @summary A fetch double serving the cask record and the archive, counting archive downloads.
 * @param {Object} record
 * @param {Buffer} bytes
 * @returns {Function & {downloads: Number}}
 */
function vendorFetch(record, bytes) {
    const fetchImpl = async url => {
        if (url === RECORD_URL) return {ok: true, status: 200, text: async () => JSON.stringify(record)};
        if (url === record.url) {
            fetchImpl.downloads++;
            return new Response(bytes, {status: 200})
        }
        throw new Error(`unexpected URL ${url}`)
    };

    fetchImpl.downloads = 0;
    return fetchImpl
}

/**
 * @summary Writes a minimal `Claude.app` into `directory`: its executable, and the version its Info.plist would
 * carry in `Contents/version`.
 * @param {String} directory
 * @param {String} [version='5.11492.0']
 * @returns {String} The bundle path.
 */
function makeClaudeBundle(directory, version = '5.11492.0') {
    const bundle = path.join(directory, 'Claude.app');

    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), {recursive: true});
    fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Claude'), '#!/bin/sh\n', {mode: 0o755});
    fs.writeFileSync(path.join(bundle, 'Contents', 'version'), version);
    return bundle
}

/** @summary The version a test bundle carries. */
const bundleVersion = bundle => fs.readFileSync(path.join(bundle, 'Contents', 'version'), 'utf8');

/**
 * @summary The real admission, with host seams that read each copy's own version (its cdhash follows it)
 * instead of touching codesign, Gatekeeper or a probe.
 */
const claudeAdmission = options => materializeHarnessGeneration({
    ...options,
    seams: {
        copyBundle      : (src, target) => fs.cpSync(src, target, {recursive: true}),
        readBundleInfo  : bundle => ({bundleId: 'com.anthropic.claudefordesktop', shortVersion: bundleVersion(bundle), buildVersion: bundleVersion(bundle), executable: 'Claude'}),
        inspectSignature: bundle => ({verified: true, teamId: 'Q6L2SF6YDW', cdhash: createHash('sha256').update(bundleVersion(bundle)).digest('hex')}),
        assessGatekeeper: () => true,
        probe           : async () => ({available: true, reason: null})
    }
});

test.describe('claudeDesktopUpdate', () => {
    let root;

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-claude-update-'))
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    /**
     * @summary Seeds a selected generation at `seeded`, then acquires twice from a record advertising
     * `advertised` for a zip whose bundle carries `actual`.
     */
    async function acquireOverSeed({seeded, advertised, actual}) {
        const
            store     = path.join(root, 'generations'),
            bytes     = Buffer.from(`claude-${actual}-zip`),
            fetchImpl = vendorFetch(caskRecord(bytes, {version: `${advertised},${COMMIT}`, url: zipUrl(advertised)}), bytes),
            acquire   = () => acquireClaudeDesktopUpdate({
                root                 : store,
                fetchImpl,
                extractArchive       : (_archivePath, destinationDir) => makeClaudeBundle(destinationDir, actual),
                materializeGeneration: claudeAdmission
            });

        const seed = await claudeAdmission({root: store, family: 'claude-desktop', sourceBundle: makeClaudeBundle(path.join(root, 'seed'), seeded)});

        expect(seed.admitted, 'the seeded generation is selected').toBe(true);

        return {first: await acquire(), second: await acquire(), fetchImpl, store}
    }

    test('reads the candidate a well-formed record names, its digest in lowercase hex', () => {
        const digest = 'D43FCE37CEA2366581D5126FE07322F15C3A32C4C30E626DBD9FD54145ED39B1';

        expect(parseClaudeCaskRecord(caskRecord(Buffer.alloc(0), {sha256: digest}))).toEqual({
            version   : '5.11492.0',
            commit    : COMMIT,
            archiveUrl: ZIP_URL,
            sha256    : digest.toLowerCase()
        })
    });

    test('a record whose URL is not the vendor zip for its own version and commit, or whose digest is not a SHA-256, refuses by name', () => {
        const refusals = {
            'record-version-invalid': [{version: '5.11492.0'}, {version: 'latest'}, {version: undefined}],
            'record-url-invalid'    : [
                {url: ZIP_URL.replace('downloads.claude.ai', 'downloads.claude.ai.example.com')},
                {url: ZIP_URL.replace('https:', 'http:')},
                {url: ZIP_URL.replace('/universal/', '/arm64/')},
                {url: `${ZIP_URL}?mirror=1`}
            ],
            'record-url-mismatch'   : [
                {url: ZIP_URL.replace('/5.11492.0/', '/5.1231.0/')},
                {url: ZIP_URL.replace(COMMIT, 'f'.repeat(40))}
            ],
            'record-digest-invalid' : [{sha256: undefined}, {sha256: 'no_check'}, {sha256: 'a'.repeat(63)}]
        };

        const refusalOf = record => {
            try {
                parseClaudeCaskRecord(record)
            } catch (error) {
                return error.code
            }
            return null
        };

        for (const [code, overrides] of Object.entries(refusals)) {
            for (const override of overrides) {
                expect(refusalOf(caskRecord(Buffer.alloc(0), override)), JSON.stringify(override)).toBe(code)
            }
        }
    });

    test('a candidate counts as an update only when it is newer than the selected generation, else the installed bundle, and not admitted yet', async () => {
        const
            fetchImpl  = vendorFetch(caskRecord(Buffer.from('zip')), Buffer.from('zip')),
            emptyStore = {readLedger: () => ({admitted: []}), select: () => null},
            check      = overrides => checkClaudeDesktopUpdate({root, fetchImpl, readBundleInfo: () => ({shortVersion: '5.1231.0'}), ...emptyStore, ...overrides});

        expect(await check()).toMatchObject({updateAvailable: true, currentVersion: '5.1231.0', candidate: {version: '5.11492.0'}});
        expect(await check({select: () => ({id: 'g'.repeat(64), shortVersion: '5.11492.0'})}), 'the selected generation wins over the installed bundle')
            .toMatchObject({updateAvailable: false, currentVersion: '5.11492.0', selectedGenerationId: 'g'.repeat(64)});
        expect(await check({readLedger: () => ({admitted: [{shortVersion: '5.11492.0'}]})})).toMatchObject({updateAvailable: false, alreadyAdmitted: true});
        expect(await check({readBundleInfo: () => { throw new Error('no bundle') }}), 'a host with neither takes the candidate')
            .toMatchObject({updateAvailable: true, currentVersion: null});
        expect(fetchImpl.downloads, 'a check never downloads the archive').toBe(0)
    });

    test('acquires a newer build: the zip is verified, extracted and admitted, and the store selects it with the zip URL as its source', async () => {
        const
            bytes     = Buffer.from('claude-5.11492.0-zip'),
            fetchImpl = vendorFetch(caskRecord(bytes), bytes),
            installed = makeClaudeBundle(path.join(root, 'installed')),
            store     = path.join(root, 'generations');

        const result = await acquireClaudeDesktopUpdate({
            root          : store,
            appBundle     : installed,
            fetchImpl,
            readBundleInfo: () => ({shortVersion: '5.1231.0'}),
            extractArchive: (archivePath, destinationDir) => {
                expect(fs.readFileSync(archivePath)).toEqual(bytes);
                makeClaudeBundle(destinationDir)
            },
            materializeGeneration: claudeAdmission
        });

        expect(result).toMatchObject({status: 'admitted', check: {candidate: {version: '5.11492.0'}}, generation: {admitted: true}});
        expect(selectHarnessGeneration({root: store, family: 'claude-desktop'})).toMatchObject({id: result.generation.id, shortVersion: '5.11492.0'});
        expect(readHarnessGenerationLedger({root: store, family: 'claude-desktop'}).admitted.at(-1)).toMatchObject({source: ZIP_URL, teamId: 'Q6L2SF6YDW'});

        const again = await acquireClaudeDesktopUpdate({root: store, appBundle: installed, fetchImpl});

        expect(again).toMatchObject({status: 'up-to-date', generation: null});
        expect(fetchImpl.downloads, 'the admitted build is never downloaded twice').toBe(1)
    });

    test('a record naming a version its bundle does not carry changes nothing: rejected before publication, the selection stays, the zip is not fetched again', async () => {
        const
            {first, second, fetchImpl, store} = await acquireOverSeed({seeded: '2.0.0', advertised: '3.0.0', actual: '1.0.0'}),
            ledger = readHarnessGenerationLedger({root: store, family: 'claude-desktop'});

        expect(first).toMatchObject({status: 'rejected', reason: 'bundle-version-mismatch'});
        expect(ledger.admitted.map(generation => generation.shortVersion)).toEqual(['2.0.0']);
        expect(ledger.rejected.at(-1)).toMatchObject({shortVersion: '1.0.0', source: zipUrl('3.0.0'), reason: 'bundle-version-mismatch'});
        expect(selectHarnessGeneration({root: store, family: 'claude-desktop'}).shortVersion).toBe('2.0.0');
        expect(second).toMatchObject({status: 'already-rejected'});
        expect(fetchImpl.downloads).toBe(1)
    });

    test('the same record over a bundle that carries its version is admitted, selected and fetched once', async () => {
        const {first, second, fetchImpl, store} = await acquireOverSeed({seeded: '2.0.0', advertised: '3.0.0', actual: '3.0.0'});

        expect(first).toMatchObject({status: 'admitted'});
        expect(selectHarnessGeneration({root: store, family: 'claude-desktop'}).shortVersion).toBe('3.0.0');
        expect(second).toMatchObject({status: 'up-to-date'});
        expect(fetchImpl.downloads).toBe(1)
    });

    test('bytes that do not match the record\'s SHA-256 are never extracted or admitted', async () => {
        const reached = [];

        await expect(acquireClaudeDesktopUpdate({
            root                 : path.join(root, 'generations'),
            fetchImpl            : vendorFetch(caskRecord(Buffer.from('the build the record names')), Buffer.from('other bytes')),
            readBundleInfo       : () => ({shortVersion: '5.1231.0'}),
            extractArchive       : () => reached.push('extract'),
            materializeGeneration: async () => reached.push('materialize')
        })).rejects.toMatchObject({code: 'digest-mismatch'});

        expect(reached).toEqual([])
    });

    test('a record that cannot be read fetches nothing, and a relative store root refuses', async () => {
        await expect(acquireClaudeDesktopUpdate({root: path.join(root, 'generations'), fetchImpl: async () => ({ok: false, status: 503})}))
            .rejects.toMatchObject({code: 'record-fetch-failed'});
        await expect(acquireClaudeDesktopUpdate({root: path.join(root, 'generations'), fetchImpl: async () => ({ok: true, status: 200, text: async () => '<html>'})}))
            .rejects.toMatchObject({code: 'record-invalid'});
        await expect(acquireClaudeDesktopUpdate({root: 'relative/store'})).rejects.toMatchObject({code: 'invalid-root'})
    });
});
