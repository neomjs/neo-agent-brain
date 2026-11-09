import {expect, test} from '@playwright/test';
import {createHash}   from 'node:crypto';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    acquireAntigravityUpdate,
    compareDottedVersions,
    parseAntigravityUpdateManifest,
    readAntigravityUpdateConfig,
    verifyAntigravityArchive
} from '../../../../../../ai/services/fleet/antigravityUpdate.mjs';
import {
    materializeHarnessGeneration,
    readHarnessGenerationLedger,
    selectHarnessGeneration
} from '../../../../../../ai/services/fleet/harnessGeneration.mjs';

const
    FEED_BASE_URL = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/',
    MANIFEST_URL  = `${FEED_BASE_URL}latest-arm64-mac.yml`,
    ARCHIVE_URL   = 'https://storage.googleapis.com/antigravity-public/antigravity-hub/2.30.0-9999999999999999/darwin-arm/Antigravity.zip';

/**
 * @summary Create a synthetic Antigravity.app bundle on disk with `app-update.yml`, `app.asar`, and `language_server`.
 * @param {String} dir
 * @param {Object} [options]
 * @returns {String}
 */
function makeAntigravityBundle(dir, {
    shortVersion = '2.29.1',
    buildVersion = '2.29.1',
    provider = 'generic',
    feedUrl = FEED_BASE_URL
} = {}) {
    const
        bundle    = path.join(dir, 'Antigravity.app'),
        macos     = path.join(bundle, 'Contents', 'MacOS'),
        resources = path.join(bundle, 'Contents', 'Resources'),
        binDir    = path.join(resources, 'bin');

    fs.mkdirSync(macos, {recursive: true});
    fs.mkdirSync(binDir, {recursive: true});

    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), JSON.stringify({
        CFBundleIdentifier        : 'com.google.antigravity',
        CFBundleShortVersionString: shortVersion,
        CFBundleVersion           : buildVersion,
        CFBundleExecutable        : 'Antigravity'
    }));
    fs.writeFileSync(path.join(macos, 'Antigravity'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    fs.writeFileSync(path.join(resources, 'app.asar'), 'antigravity-app-asar-payload', {mode: 0o644});
    fs.writeFileSync(path.join(binDir, 'language_server'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    fs.writeFileSync(path.join(resources, 'app-update.yml'), [
        `provider: ${provider}`,
        `url: ${feedUrl}`,
        'updaterCacheDirName: com.google.antigravity',
        ''
    ].join('\n'));

    return bundle
}

/**
 * @summary Read synthetic JSON Info.plist keys in unit tests without spawning PlistBuddy.
 * @param {String} plistPath
 * @param {String} key
 * @returns {String}
 */
function readFakePlistKey(plistPath, key) {
    const data = JSON.parse(fs.readFileSync(plistPath, 'utf8'));
    if (!(key in data)) throw new Error(`missing key ${key}`);
    return String(data[key])
}

/**
 * @summary Build a synthetic `latest-arm64-mac.yml` YAML string.
 * @param {Object} options
 * @returns {String}
 */
function buildManifestYaml({
    version = '2.30.0',
    archiveUrl = ARCHIVE_URL,
    sha512,
    size,
    releaseDate = '2026-11-09T19:00:00.000Z'
}) {
    return [
        `version: ${version}`,
        'files:',
        `  - url: ${archiveUrl}`,
        `    sha512: ${sha512}`,
        `    size: ${size}`,
        'path: Antigravity.zip',
        `sha512: ${sha512}`,
        `releaseDate: '${releaseDate}'`,
        ''
    ].join('\n')
}

test.describe('antigravityUpdate', () => {
    let root;

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-antigravity-update-'))
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('reads app-update.yml and derives arch-qualified manifestUrl while rejecting non-HTTPS feeds', () => {
        const
            bundle = makeAntigravityBundle(root),
            config = readAntigravityUpdateConfig(bundle, {architecture: 'arm64', readPlistKey: readFakePlistKey});

        expect(config).toEqual({
            appBundle          : bundle,
            bundleId           : 'com.google.antigravity',
            shortVersion       : '2.29.1',
            buildVersion       : '2.29.1',
            provider           : 'generic',
            baseUrl            : FEED_BASE_URL,
            channel            : 'latest-arm64',
            manifestUrl        : MANIFEST_URL,
            updaterCacheDirName: 'com.google.antigravity'
        });

        const insecureBundle = makeAntigravityBundle(path.join(root, 'insecure'), {
            feedUrl: 'http://antigravity-hub-auto-updater.example.com/manifest/'
        });
        expect(() => readAntigravityUpdateConfig(insecureBundle, {architecture: 'arm64', readPlistKey: readFakePlistKey}))
            .toThrow(/update-url-insecure/)
    });

    test('parses electron-updater YAML manifest and refuses stub or malformed manifests', () => {
        const
            payload = Buffer.from('antigravity-2.30.0-archive-bytes'),
            sha512  = createHash('sha512').update(payload).digest('base64'),
            yaml    = buildManifestYaml({version: '2.30.0', sha512, size: payload.length}),
            parsed  = parseAntigravityUpdateManifest(yaml, {manifestUrl: MANIFEST_URL});

        expect(parsed).toEqual({
            version    : '2.30.0',
            archiveUrl : ARCHIVE_URL,
            sha512,
            size       : payload.length,
            releaseDate: '2026-11-09T19:00:00.000Z'
        });

        expect(() => parseAntigravityUpdateManifest('version: 2.29.1\n', {manifestUrl: MANIFEST_URL}))
            .toThrow(/manifest-files-missing/);
        expect(() => parseAntigravityUpdateManifest(buildManifestYaml({
            version   : '2.30.0',
            archiveUrl: 'http://storage.googleapis.com/insecure.zip',
            sha512,
            size      : payload.length
        }))).toThrow(/manifest-url-insecure/);
        expect(() => parseAntigravityUpdateManifest(buildManifestYaml({
            version: '2.30.0',
            sha512 : Buffer.from('short').toString('base64'),
            size   : payload.length
        }))).toThrow(/manifest-sha512-invalid/)
    });

    test('verifies SHA-512 digest and byte length before extraction and rejects tampered or truncated archives', () => {
        const
            payload = Buffer.from('antigravity-2.30.0-verified-payload'),
            sha512  = createHash('sha512').update(payload).digest('base64'),
            proof   = verifyAntigravityArchive(payload, {expectedSha512: sha512, expectedSize: payload.length});

        expect(proof).toEqual({
            verified  : true,
            sha512,
            byteLength: payload.length
        });

        expect(() => verifyAntigravityArchive(Buffer.from('wrong-size'), {
            expectedSha512: sha512,
            expectedSize  : payload.length
        })).toThrow(/archive-size-mismatch/);

        const tampered = Buffer.from('antigravity-2.30.0-tampered-payload');
        expect(() => verifyAntigravityArchive(tampered, {
            expectedSha512: sha512,
            expectedSize  : tampered.length
        })).toThrow(/sha512-mismatch/)
    });

    test('checks feed and short-circuits when version is already admitted', async () => {
        const
            storeRoot = path.join(root, 'generations'),
            installed = makeAntigravityBundle(path.join(root, 'installed'), {
                shortVersion: '2.29.1',
                buildVersion: '2.29.1'
            }),
            payload   = Buffer.from('antigravity-2.29.1-archive'),
            sha512    = createHash('sha512').update(payload).digest('base64'),
            yaml      = buildManifestYaml({version: '2.29.1', sha512, size: payload.length});

        await materializeHarnessGeneration({
            root        : storeRoot,
            family      : 'antigravity',
            sourceBundle: installed,
            seams       : {
                copyBundle      : (source, target) => fs.cpSync(source, target, {recursive: true}),
                readBundleInfo  : () => ({
                    bundleId    : 'com.google.antigravity',
                    shortVersion: '2.29.1',
                    buildVersion: '2.29.1',
                    executable  : 'Antigravity'
                }),
                inspectSignature: () => ({verified: true, teamId: 'EQHXZ8M8AV', cdhash: 'a'.repeat(64)}),
                assessGatekeeper: () => true,
                probe           : async () => ({available: true, reason: null})
            }
        });

        expect(readHarnessGenerationLedger({root: storeRoot, family: 'antigravity'}).admitted).toHaveLength(1);

        const observedCalls = [];
        const fetchImpl     = async (url, options) => {
            observedCalls.push({url, headers: options?.headers});
            return {ok: true, status: 200, text: async () => yaml}
        };

        const result = await acquireAntigravityUpdate({
            root        : storeRoot,
            appBundle   : installed,
            fetchImpl,
            architecture: 'arm64',
            readPlistKey: readFakePlistKey
        });

        expect(result.status).toBe('up-to-date');
        expect(result.check.alreadyAdmitted).toBe(true);
        expect(result.check.updateAvailable).toBe(false);
        expect(observedCalls).toEqual([{
            url    : MANIFEST_URL,
            headers: {
                'Accept': 'text/yaml, text/plain, */*'
            }
        }])
    });

    test('streams archive to disk, verifies SHA-512, extracts, admits a new Antigravity generation, and cleans staging', async () => {
        const
            storeRoot = path.join(root, 'generations'),
            installed = makeAntigravityBundle(path.join(root, 'installed'), {
                shortVersion: '2.29.1',
                buildVersion: '2.29.1'
            }),
            archiveBytes = Buffer.from('antigravity-2.30.0-zip-payload'),
            sha512       = createHash('sha512').update(archiveBytes).digest('base64'),
            yaml         = buildManifestYaml({version: '2.30.0', sha512, size: archiveBytes.length});

        const fetchImpl = async url => {
            if (url === MANIFEST_URL) {
                return {ok: true, status: 200, text: async () => yaml}
            }
            if (url === ARCHIVE_URL) {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(archiveBytes.subarray(0, 14));
                        controller.enqueue(archiveBytes.subarray(14));
                        controller.close()
                    }
                }), {status: 200})
            }
            throw new Error(`unexpected URL ${url}`)
        };

        const result = await acquireAntigravityUpdate({
            root          : storeRoot,
            appBundle     : installed,
            fetchImpl,
            architecture  : 'arm64',
            readPlistKey  : readFakePlistKey,
            extractArchive: (archivePath, destinationDir) => {
                expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
                makeAntigravityBundle(destinationDir, {
                    shortVersion: '2.30.0',
                    buildVersion: '2.30.0'
                })
            },
            materializeGeneration: ({root: r, family, sourceBundle, source}) =>
                materializeHarnessGeneration({
                    root : r,
                    family,
                    sourceBundle,
                    source,
                    seams: {
                        copyBundle      : (src, target) => fs.cpSync(src, target, {recursive: true}),
                        readBundleInfo  : () => ({
                            bundleId    : 'com.google.antigravity',
                            shortVersion: '2.30.0',
                            buildVersion: '2.30.0',
                            executable  : 'Antigravity'
                        }),
                        inspectSignature: () => ({verified: true, teamId: 'EQHXZ8M8AV', cdhash: 'b'.repeat(64)}),
                        assessGatekeeper: () => true,
                        probe           : async () => ({available: true, reason: null})
                    }
                })
        });

        expect(result.status).toBe('admitted');
        expect(result.generation.admitted).toBe(true);

        const
            selected      = selectHarnessGeneration({root: storeRoot, family: 'antigravity'}),
            familyEntries = fs.readdirSync(path.join(storeRoot, 'antigravity'));

        expect(selected).toMatchObject({
            id          : result.generation.id,
            shortVersion: '2.30.0',
            buildVersion: '2.30.0'
        });
        expect(familyEntries.some(name => name.startsWith('.update-staging-'))).toBe(false)
    });

    test('skips same-admitter rejected builds and retries when admitting code changes, and refuses tampered archives before extraction', async () => {
        const
            storeRoot  = path.join(root, 'generations'),
            installed  = makeAntigravityBundle(path.join(root, 'installed')),
            validBytes = Buffer.from('antigravity-2.30.0-valid-archive'),
            tampered   = Buffer.from('antigravity-2.30.0-wrong-archive'),
            sha512     = createHash('sha512').update(validBytes).digest('base64'),
            yaml       = buildManifestYaml({version: '2.30.0', sha512, size: validBytes.length});

        let extractCalled     = false,
            materializeCalled = false;

        await expect(acquireAntigravityUpdate({
            root        : storeRoot,
            appBundle   : installed,
            architecture: 'arm64',
            readPlistKey: readFakePlistKey,
            fetchImpl   : async url => url === MANIFEST_URL
                ? {ok: true, status: 200, text: async () => yaml}
                : {
                    ok         : true,
                    status     : 200,
                    arrayBuffer: async () => tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.byteLength)
                },
            extractArchive       : () => { extractCalled = true },
            materializeGeneration: async () => { materializeCalled = true }
        })).rejects.toMatchObject({code: 'sha512-mismatch'});

        expect(extractCalled).toBe(false);
        expect(materializeCalled).toBe(false);

        let streamCancelled = false;
        await expect(acquireAntigravityUpdate({
            root        : storeRoot,
            appBundle   : installed,
            architecture: 'arm64',
            readPlistKey: readFakePlistKey,
            fetchImpl   : async url => {
                if (url === MANIFEST_URL) {
                    return {ok: true, status: 200, text: async () => yaml}
                }
                return new Response(new ReadableStream({
                     pull(controller) {
                        controller.enqueue(Buffer.alloc(validBytes.length + 1, 0x41))
                    },
                    cancel() {
                        streamCancelled = true
                    }
                }), {status: 200})
            },
            extractArchive       : () => { extractCalled = true },
            materializeGeneration: async () => { materializeCalled = true }
        })).rejects.toMatchObject({code: 'archive-size-mismatch'});

        expect(streamCancelled).toBe(true);
        expect(extractCalled).toBe(false);
        expect(materializeCalled).toBe(false);

        let   archiveDownloads = 0;
        const validFetch       = async url => url === MANIFEST_URL
            ? {ok: true, status: 200, text: async () => yaml}
            : {
                ok         : true,
                status     : 200,
                arrayBuffer: async () => {
                    archiveDownloads++;
                    return validBytes.buffer.slice(validBytes.byteOffset, validBytes.byteOffset + validBytes.byteLength)
                }
            };

        const rejectedRun = await acquireAntigravityUpdate({
            root                 : storeRoot,
            appBundle            : installed,
            architecture         : 'arm64',
            readPlistKey         : readFakePlistKey,
            admitterId           : 'probe-v1',
            fetchImpl            : validFetch,
            extractArchive       : (_archivePath, destinationDir) => makeAntigravityBundle(destinationDir, {shortVersion: '2.30.0', buildVersion: '2.30.0'}),
            materializeGeneration: async () => ({admitted: false, id: null, appBundle: null, binaryPath: null, reason: 'probe-refused:runtime-metadata-invalid'})
        });
        expect(rejectedRun.status).toBe('rejected');
        expect(archiveDownloads).toBe(1);

        const skippedSameAdmitter = await acquireAntigravityUpdate({
            root        : storeRoot,
            appBundle   : installed,
            architecture: 'arm64',
            readPlistKey: readFakePlistKey,
            admitterId  : 'probe-v1',
            fetchImpl   : validFetch
        });
        expect(skippedSameAdmitter).toMatchObject({
            status: 'already-rejected',
            reason: 'probe-refused:runtime-metadata-invalid'
        });
        expect(archiveDownloads).toBe(1);

        const recoveredOnNewAdmitter = await acquireAntigravityUpdate({
            root                 : storeRoot,
            appBundle            : installed,
            architecture         : 'arm64',
            readPlistKey         : readFakePlistKey,
            admitterId           : 'probe-v2',
            fetchImpl            : validFetch,
            extractArchive       : (_archivePath, destinationDir) => makeAntigravityBundle(destinationDir, {shortVersion: '2.30.0', buildVersion: '2.30.0'}),
            materializeGeneration: async () => ({admitted: true, id: 'c'.repeat(64), appBundle: installed, binaryPath: installed, reason: null})
        });
        expect(recoveredOnNewAdmitter.status).toBe('admitted');
        expect(archiveDownloads).toBe(2);

        expect(compareDottedVersions('2.30.0', '2.29.1')).toBe(1);
        expect(compareDottedVersions('2.29.1', '2.29.1')).toBe(0);
        expect(compareDottedVersions('2.28.9', '2.29.1')).toBe(-1)
    });
});
