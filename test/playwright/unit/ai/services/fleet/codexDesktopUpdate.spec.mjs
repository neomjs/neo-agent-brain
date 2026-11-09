import {test, expect}              from '@playwright/test';
import {generateKeyPairSync, sign} from 'node:crypto';
import fs                          from 'node:fs';
import os                          from 'node:os';
import path                        from 'node:path';
import {
    acquireCodexDesktopUpdate,
    parseCodexSparkleAppcast,
    readCodexSparkleConfig,
    verifySparkleEdSignature
} from '../../../../../../ai/services/fleet/codexDesktopUpdate.mjs';
import {
    materializeHarnessGeneration,
    readHarnessGenerationLedger,
    selectHarnessGeneration
} from '../../../../../../ai/services/fleet/harnessGeneration.mjs';

const
    CODEX_BUNDLE_ID = 'com.openai.codex',
    CODEX_TEAM_ID   = '2DC432GLL2',
    FEED_URL        = 'https://persistent.oaistatic.com/codex-app-prod/appcast.xml';

/** @summary Generates an Ed25519 keypair and returns the 32-byte raw public key in base64 (`SUPublicEDKey`). */
function makeEd25519Keys() {
    const {publicKey, privateKey} = generateKeyPairSync('ed25519');
    const spkiDer                 = publicKey.export({format: 'der', type: 'spki'});
    const rawPub                  = spkiDer.subarray(spkiDer.length - 32).toString('base64');
    return {
        publicKeyBase64: rawPub,
        signBytes      : buffer => sign(null, buffer, privateKey).toString('base64')
    };
}

/** @summary Builds a minimal Electron ASAR archive containing `package.json`. */
function makeAsarWithPackageJson(pkgObject) {
    const
        payload    = Buffer.from(JSON.stringify(pkgObject), 'utf8'),
        headerJson = JSON.stringify({
            files: {
                'package.json': {
                    size  : payload.length,
                    offset: '0'
                }
            }
        }),
        headerBytes = Buffer.from(headerJson, 'utf8'),
        alignedLen  = Math.ceil(headerBytes.length / 4) * 4,
        preamble    = Buffer.alloc(16 + alignedLen);

    preamble.writeUInt32LE(4, 0);
    preamble.writeUInt32LE(8 + alignedLen, 4);
    preamble.writeUInt32LE(4 + alignedLen, 8);
    preamble.writeUInt32LE(headerBytes.length, 12);
    headerBytes.copy(preamble, 16);

    return Buffer.concat([preamble, payload]);
}

/** @summary Creates a synthetic `ChatGPT.app` bundle with `app.asar` and main executable. */
function makeCodexBundle(roots, {
    feedUrl = FEED_URL,
    publicKey = 'mNfr1v9t63BfgDtlw4C8lRvSY6uMggIXABDOCi3tS6k=',
    shortVersion = '26.1103.60933',
    buildVersion = '25894'
} = {}) {
    const
        parent    = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bundle-')),
        appBundle = path.join(parent, 'ChatGPT.app'),
        mainBin   = path.join(appBundle, 'Contents', 'MacOS', 'ChatGPT'),
        appAsar   = path.join(appBundle, 'Contents', 'Resources', 'app.asar');

    fs.mkdirSync(path.dirname(mainBin), {recursive: true});
    fs.mkdirSync(path.dirname(appAsar), {recursive: true});
    fs.writeFileSync(mainBin, '#!/bin/sh\n', {mode: 0o755});
    fs.writeFileSync(appAsar, makeAsarWithPackageJson({
        name                 : 'codex-desktop',
        version              : shortVersion,
        codexBuildNumber     : buildVersion,
        codexSparkleFeedUrl  : feedUrl,
        codexSparklePublicKey: publicKey
    }));

    roots.push(parent);
    return appBundle;
}

/** @summary Builds a realistic Sparkle 2 appcast XML with nested `<sparkle:deltas>`. */
function makeAppcastXml({
    shortVersion = '26.1110.10000',
    buildVersion = '26000',
    minimumSystemVersion = '13.0',
    archiveUrl = 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1110.10000.zip',
    length = 128,
    edSignature = Buffer.alloc(64, 7).toString('base64')
} = {}) {
    return `<?xml version='1.0' encoding='utf-8'?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>Codex</title>
        <item>
            <title>26.1103.41825</title>
            <pubDate>Sat, 07 Nov 2026 03:53:39 +0000</pubDate>
            <sparkle:version>25679</sparkle:version>
            <sparkle:shortVersionString>26.1103.41825</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1103.41825.zip" length="815395836" type="application/octet-stream" sparkle:edSignature="${Buffer.alloc(64, 1).toString('base64')}" />
        </item>
        <item>
            <title>${shortVersion}</title>
            <pubDate>Mon, 09 Nov 2026 19:00:00 +0000</pubDate>
            <sparkle:version>${buildVersion}</sparkle:version>
            <sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>${minimumSystemVersion}</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <sparkle:deltas>
                <enclosure url="https://persistent.oaistatic.com/codex-app-prod/ChatGPT${buildVersion}-25894-arm64.delta" sparkle:deltaFrom="25894" length="7506786" type="application/octet-stream" sparkle:edSignature="${Buffer.alloc(64, 9).toString('base64')}" />
            </sparkle:deltas>
            <enclosure url="${archiveUrl}" length="${length}" type="application/octet-stream" sparkle:edSignature="${edSignature}" />
        </item>
    </channel>
</rss>`;
}

/** @summary Host seams for `materializeHarnessGeneration` in tests. */
function makeMaterializeSeams({
    shortVersion = '26.1110.10000',
    buildVersion = '26000',
    cdhash = 'b'.repeat(64),
    available = true,
    reason = null
} = {}) {
    return {
        copyBundle      : (source, target) => fs.cpSync(source, target, {recursive: true}),
        readBundleInfo  : () => ({bundleId: CODEX_BUNDLE_ID, shortVersion, buildVersion, executable: 'ChatGPT'}),
        inspectSignature: () => ({verified: true, teamId: CODEX_TEAM_ID, cdhash}),
        assessGatekeeper: () => true,
        probe           : () => ({available, reason})
    };
}

test.describe('codexDesktopUpdate', () => {
    const roots = [];
    let   root;

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-update-store-'));
        roots.push(root);
    });

    test.afterEach(() => {
        for (const dir of roots.splice(0)) {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    });

    test('readCodexSparkleConfig reads feedUrl, publicKey, and versions from Info.plist + app.asar and refuses mismatches', () => {
        const publicKey = 'mNfr1v9t63BfgDtlw4C8lRvSY6uMggIXABDOCi3tS6k=';
        const appBundle = makeCodexBundle(roots, {publicKey});

        const config = readCodexSparkleConfig({
            appBundle,
            readPlist: () => ({
                bundleId    : CODEX_BUNDLE_ID,
                shortVersion: '26.1103.60933',
                buildVersion: '25894',
                publicKey
            })
        });

        expect(config).toEqual({
            bundleId    : CODEX_BUNDLE_ID,
            shortVersion: '26.1103.60933',
            buildVersion: '25894',
            feedUrl     : FEED_URL,
            publicKey
        });

        expect(() => readCodexSparkleConfig({
            appBundle,
            readPlist: () => ({
                bundleId    : CODEX_BUNDLE_ID,
                shortVersion: '26.1103.60933',
                buildVersion: '25894',
                publicKey   : Buffer.alloc(32, 3).toString('base64')
            })
        })).toThrow(/sparkle-public-key-mismatch/);

        const httpBundle = makeCodexBundle(roots, {feedUrl: 'http://insecure.example.com/appcast.xml'});
        expect(() => readCodexSparkleConfig({
            appBundle: httpBundle,
            readPlist: () => ({
                bundleId    : CODEX_BUNDLE_ID,
                shortVersion: '26.1103.60933',
                buildVersion: '25894',
                publicKey
            })
        })).toThrow(/feed-url-must-be-https/);
    });

    test('parseCodexSparkleAppcast ignores delta enclosures, filters architecture and minimumSystemVersion, and orders newest buildVersion first', () => {
        const xml      = makeAppcastXml({shortVersion: '26.1110.10000', buildVersion: '26000', minimumSystemVersion: '15.2'});
        const releases = parseCodexSparkleAppcast(xml, {hostSystemVersion: '15.4.1'});

        expect(releases).toHaveLength(2);
        expect(releases[0]).toMatchObject({
            shortVersion        : '26.1110.10000',
            buildVersion        : '26000',
            minimumSystemVersion: '15.2',
            archiveUrl          : 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1110.10000.zip',
            length              : 128
        });
        expect(releases[1].buildVersion).toBe('25679');

        // When hostSystemVersion is older than 26000's minimumSystemVersion (15.2) but >= 25679's (13.0),
        // 26000 is skipped and 25679 is selected as the newest compatible release.
        const olderHostReleases = parseCodexSparkleAppcast(xml, {hostSystemVersion: '14.6'});
        expect(olderHostReleases).toHaveLength(1);
        expect(olderHostReleases[0].buildVersion).toBe('25679');

        expect(() => parseCodexSparkleAppcast(xml, {hostSystemVersion: '12.0'})).toThrow(/no-compatible-release/);
        expect(() => parseCodexSparkleAppcast(xml, {hardwareRequirements: 'x86_64'})).toThrow(/no-compatible-release/);
    });

    test('verifySparkleEdSignature verifies a valid Ed25519 signature and rejects tampered bytes, wrong keys, or length mismatches', () => {
        const keys        = makeEd25519Keys();
        const archivePath = path.join(root, 'ChatGPT.zip');
        const payload     = Buffer.from('verified-codex-zip-archive-bytes');
        fs.writeFileSync(archivePath, payload);

        const signature = keys.signBytes(payload);

        expect(verifySparkleEdSignature({
            archivePath,
            edSignature: signature,
            publicKey  : keys.publicKeyBase64,
            length     : payload.length
        })).toEqual({verified: true, reason: null});

        expect(verifySparkleEdSignature({
            archivePath,
            edSignature: signature,
            publicKey  : keys.publicKeyBase64,
            length     : payload.length + 1
        })).toEqual({verified: false, reason: 'archive-length-mismatch'});

        const otherKeys = makeEd25519Keys();
        expect(verifySparkleEdSignature({
            archivePath,
            edSignature: signature,
            publicKey  : otherKeys.publicKeyBase64,
            length     : payload.length
        })).toEqual({verified: false, reason: 'sparkle-signature-invalid'});

        fs.writeFileSync(archivePath, Buffer.from('tampered-codex-zip-archive-bytes'));
        expect(verifySparkleEdSignature({
            archivePath,
            edSignature: signature,
            publicKey  : keys.publicKeyBase64,
            length     : payload.length
        })).toEqual({verified: false, reason: 'sparkle-signature-invalid'});
    });

    test('acquireCodexDesktopUpdate admits a verified release, short-circuits up-to-date and same-admitter rejections, and retries when admitting code changes', async () => {
        const keys          = makeEd25519Keys();
        const initialBundle = makeCodexBundle(roots, {publicKey: keys.publicKeyBase64});

        await materializeHarnessGeneration({
            root,
            family      : 'codex-desktop',
            sourceBundle: initialBundle,
            seams       : makeMaterializeSeams({shortVersion: '26.1103.60933', buildVersion: '25894', cdhash: 'a'.repeat(64)})
        });

        expect(readHarnessGenerationLedger({root, family: 'codex-desktop'}).admitted).toHaveLength(1);

        const archivePayload = Buffer.from('codex-26.1110.10000-zip-payload');
        const validSignature = keys.signBytes(archivePayload);
        const appcastXml     = makeAppcastXml({
            shortVersion: '26.1110.10000',
            buildVersion: '26000',
            length      : archivePayload.length,
            edSignature : validSignature
        });

        const baseSeams = {
            readConfig  : () => ({
                bundleId    : CODEX_BUNDLE_ID,
                shortVersion: '26.1103.60933',
                buildVersion: '25894',
                feedUrl     : FEED_URL,
                publicKey   : keys.publicKeyBase64
            }),
            fetchAppcast: async () => appcastXml
        };

        // 1. checkOnly reports update-available without downloading.
        let   downloaded  = 0;
        const checkResult = await acquireCodexDesktopUpdate({
            root,
            checkOnly: true,
            seams    : {
                ...baseSeams,
                downloadArchive: async () => { downloaded++; }
            }
        });
        expect(checkResult.status).toBe('update-available');
        expect(checkResult.admitted).toBe(false);
        expect(downloaded).toBe(0);

        // 2. Tampered archive bytes fail signature verification before extraction runs.
        let   extracted      = 0;
        const tamperedResult = await acquireCodexDesktopUpdate({
            root,
            seams: {
                ...baseSeams,
                downloadArchive: async ({destination}) => {
                    fs.writeFileSync(destination, Buffer.from('corrupted-zip-payload-same-len!'));
                },
                extractArchive : async () => { extracted++; }
            }
        });
        expect(tamperedResult).toMatchObject({
            status  : 'rejected',
            admitted: false,
            reason  : 'sparkle-signature-invalid'
        });
        expect(extracted).toBe(0);

        // 3. Valid signature extracts ChatGPT.app and admits the new generation.
        const admittedResult = await acquireCodexDesktopUpdate({
            root,
            seams: {
                ...baseSeams,
                downloadArchive: async ({destination}) => {
                    fs.writeFileSync(destination, archivePayload);
                },
                extractArchive : async ({extractDir}) => {
                    extracted++;
                    const extractedMain = path.join(extractDir, 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT');
                    fs.mkdirSync(path.dirname(extractedMain), {recursive: true});
                    fs.writeFileSync(extractedMain, '#!/bin/sh\n', {mode: 0o755});
                },
                materialize    : options => materializeHarnessGeneration({
                    ...options,
                    seams: makeMaterializeSeams({shortVersion: '26.1110.10000', buildVersion: '26000', cdhash: 'b'.repeat(64)})
                })
            }
        });

        expect(admittedResult.status).toBe('admitted');
        expect(admittedResult.admitted).toBe(true);
        expect(extracted).toBe(1);
        expect(selectHarnessGeneration({root, family: 'codex-desktop'})).toMatchObject({
            shortVersion: '26.1110.10000',
            buildVersion: '26000'
        });
        expect(fs.readdirSync(path.join(root, 'codex-desktop')).filter(entry => entry.startsWith('.acquire-'))).toEqual([]);

        // 4. Subsequent check for the same build short-circuits with up-to-date and zero downloads.
        downloaded = 0;
        const upToDateResult = await acquireCodexDesktopUpdate({
            root,
            seams: {
                ...baseSeams,
                downloadArchive: async () => { downloaded++; }
            }
        });
        expect(upToDateResult.status).toBe('up-to-date');
        expect(downloaded).toBe(0);

        // 5. A build rejected by the current admitterId is skipped on repeat polls with the same admitterId,
        //    but automatically retried and admitted when the admitting code (admitterId) changes.
        const brokenXml = makeAppcastXml({
            shortVersion: '26.1120.1',
            buildVersion: '27000',
            length      : archivePayload.length,
            edSignature : validSignature
        });

        const firstBroken = await acquireCodexDesktopUpdate({
            root,
            seams: {
                ...baseSeams,
                admitterId     : 'probe-pre-1533',
                fetchAppcast   : async () => brokenXml,
                downloadArchive: async ({destination}) => fs.writeFileSync(destination, archivePayload),
                extractArchive : async ({extractDir}) => {
                    const extractedMain = path.join(extractDir, 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT');
                    fs.mkdirSync(path.dirname(extractedMain), {recursive: true});
                    fs.writeFileSync(extractedMain, '#!/bin/sh\n', {mode: 0o755});
                },
                materialize    : options => materializeHarnessGeneration({
                    ...options,
                    seams: makeMaterializeSeams({
                        shortVersion: '26.1120.1',
                        buildVersion: '27000',
                        cdhash      : 'c'.repeat(64),
                        available   : false,
                        reason      : 'updater-disable-predicate-missing'
                    })
                })
            }
        });
        expect(firstBroken).toMatchObject({
            status  : 'rejected',
            admitted: false,
            reason  : 'probe-refused:updater-disable-predicate-missing'
        });

        downloaded = 0;
        const skippedSameAdmitter = await acquireCodexDesktopUpdate({
            root,
            seams: {
                ...baseSeams,
                admitterId     : 'probe-pre-1533',
                fetchAppcast   : async () => brokenXml,
                downloadArchive: async () => { downloaded++; }
            }
        });
        expect(skippedSameAdmitter).toMatchObject({
            status  : 'already-rejected',
            admitted: false,
            reason  : 'probe-refused:updater-disable-predicate-missing'
        });
        expect(downloaded).toBe(0);

        // Once the admitting code changes (probe-post-1533), the prior rejection in ledger.rejected
        // does not block retrying and admitting build 27000.
        const recoveredAfterFix = await acquireCodexDesktopUpdate({
            root,
            seams: {
                ...baseSeams,
                admitterId     : 'probe-post-1533',
                fetchAppcast   : async () => brokenXml,
                downloadArchive: async ({destination}) => {
                    downloaded++;
                    fs.writeFileSync(destination, archivePayload);
                },
                extractArchive : async ({extractDir}) => {
                    const extractedMain = path.join(extractDir, 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT');
                    fs.mkdirSync(path.dirname(extractedMain), {recursive: true});
                    fs.writeFileSync(extractedMain, '#!/bin/sh\n', {mode: 0o755});
                },
                materialize    : options => materializeHarnessGeneration({
                    ...options,
                    seams: makeMaterializeSeams({
                        shortVersion: '26.1120.1',
                        buildVersion: '27000',
                        cdhash      : 'c'.repeat(64),
                        available   : true,
                        reason      : null
                    })
                })
            }
        });
        expect(recoveredAfterFix).toMatchObject({
            status  : 'admitted',
            admitted: true
        });
        expect(downloaded).toBe(1);
    });
});
