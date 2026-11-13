import {expect, test} from '@playwright/test';
import {createHash}   from 'node:crypto';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    acquireHarnessArchive,
    compareDottedVersions,
    serializeHarnessAcquisition
} from '../../../../../../ai/services/fleet/acquireHarnessArchive.mjs';

const ARCHIVE_URL = 'https://vendor.example/releases/2.0.0/App.zip';

/**
 * @summary A fetch double serving `bytes` in two chunks from `ARCHIVE_URL`, counting downloads.
 * @param {Buffer} bytes
 * @returns {Function & {downloads: Number}}
 */
function archiveFetch(bytes) {
    const fetchImpl = async url => {
        expect(url).toBe(ARCHIVE_URL);
        fetchImpl.downloads++;
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(bytes.subarray(0, 3));
                controller.enqueue(bytes.subarray(3));
                controller.close()
            }
        }), {status: 200})
    };

    fetchImpl.downloads = 0;
    return fetchImpl
}

/**
 * @summary Writes `names` as `.app` bundles into an extraction directory.
 * @param {String} directory
 * @param {String[]} names
 */
function makeApps(directory, names) {
    for (const name of names) fs.mkdirSync(path.join(directory, name, 'Contents', 'MacOS'), {recursive: true})
}

test.describe('acquireHarnessArchive', () => {
    let root;

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-harness-archive-'))
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    const run = (bytes, overrides = {}) => acquireHarnessArchive({
        root,
        family        : 'claude-desktop',
        version       : '2.0.0',
        archiveUrl    : ARCHIVE_URL,
        algorithm     : 'sha256',
        expectedDigest: createHash('sha256').update(bytes).digest(),
        admitterId    : 'admitter-v1',
        fetchImpl     : archiveFetch(bytes),
        ...overrides
    });

    test('checks the digest before extraction, admits the one .app with the archive URL as its source, and removes every staging, a killed run\'s included', async () => {
        const
            bytes     = Buffer.from('a vendor archive'),
            killedRun = path.join(root, 'claude-desktop', '.update-staging-killed'),
            admitted  = [];

        fs.mkdirSync(killedRun, {recursive: true});

        const result = await run(bytes, {
            extractArchive: (archivePath, destinationDir) => {
                expect(fs.existsSync(killedRun), 'a killed run\'s staging is swept first').toBe(false);
                expect(fs.readFileSync(archivePath)).toEqual(bytes);
                makeApps(destinationDir, ['App.app'])
            },
            materializeGeneration: async options => {
                admitted.push(options);
                return {admitted: true, id: 'a'.repeat(64), appBundle: null, binaryPath: null, reason: null}
            }
        });

        expect(result).toMatchObject({status: 'admitted', reason: null, verification: {byteLength: bytes.length, digest: createHash('sha256').update(bytes).digest('hex')}});
        expect(admitted).toEqual([{root, family: 'claude-desktop', sourceBundle: expect.stringMatching(/\.update-staging-[^/]+\/extracted\/App\.app$/), source: ARCHIVE_URL, expectedShortVersion: '2.0.0'}]);
        expect(fs.readdirSync(path.join(root, 'claude-desktop')).filter(name => name.startsWith('.update-staging-'))).toEqual([])
    });

    test('a wrong digest, a body over the cap and an empty body refuse before anything is extracted or admitted', async () => {
        const
            bytes   = Buffer.from('the archive the source named'),
            reached = [],
            seams   = {
                extractArchive       : () => reached.push('extract'),
                materializeGeneration: async () => reached.push('materialize')
            };

        await expect(run(Buffer.from('a different archive'), {...seams, expectedDigest: createHash('sha256').update(bytes).digest()}))
            .rejects.toMatchObject({code: 'digest-mismatch'});
        await expect(run(bytes, {...seams, maxBytes: bytes.length - 1})).rejects.toMatchObject({code: 'archive-too-large'});
        await expect(run(Buffer.alloc(0), seams)).rejects.toMatchObject({code: 'archive-empty'});

        expect(reached).toEqual([]);
        expect(fs.readdirSync(path.join(root, 'claude-desktop'))).toEqual([])
    });

    test('an extraction holding no .app or two refuses and admits nothing', async () => {
        const bytes = Buffer.from('an archive'), admitted = [];

        for (const names of [[], ['One.app', 'Two.app']]) {
            await expect(run(bytes, {
                extractArchive       : (_archivePath, destinationDir) => makeApps(destinationDir, names),
                materializeGeneration: async options => admitted.push(options)
            }), JSON.stringify(names)).rejects.toMatchObject({code: 'extracted-bundle-ambiguous'})
        }

        expect(admitted).toEqual([])
    });

    test('a build an admitter rejected is not fetched again by it, and is by a changed admitter', async () => {
        const
            bytes     = Buffer.from('a build the probe refuses'),
            fetchImpl = archiveFetch(bytes),
            seams     = {
                fetchImpl,
                extractArchive       : (_archivePath, destinationDir) => makeApps(destinationDir, ['App.app']),
                materializeGeneration: async () => ({admitted: false, id: null, appBundle: null, binaryPath: null, reason: 'probe-refused:launch'})
            };

        expect(await run(bytes, seams)).toMatchObject({status: 'rejected', reason: 'probe-refused:launch'});
        expect(await run(bytes, seams)).toEqual({status: 'already-rejected', generation: null, reason: 'probe-refused:launch'});
        expect(fetchImpl.downloads).toBe(1);

        expect(await run(bytes, {...seams, admitterId: 'admitter-v2'})).toMatchObject({status: 'rejected'});
        expect(fetchImpl.downloads).toBe(2)
    });

    test('runs for one family in one store never overlap; another family runs alongside', async () => {
        const events = [], hold = ms => new Promise(resolve => setTimeout(resolve, ms));

        await Promise.all([
            serializeHarnessAcquisition({root, family: 'claude-desktop'}, async () => { events.push('first:start'); await hold(30); events.push('first:end') }),
            serializeHarnessAcquisition({root, family: 'claude-desktop'}, async () => { events.push('second:start'); events.push('second:end') }),
            serializeHarnessAcquisition({root, family: 'antigravity'}, async () => { events.push('other:start') })
        ]);

        expect(events.indexOf('second:start')).toBeGreaterThan(events.indexOf('first:end'));
        expect(events.indexOf('other:start')).toBeLessThan(events.indexOf('first:end'))
    });

    test('compares dotted versions one numeric part at a time', () => {
        expect(compareDottedVersions('5.11492.0', '5.1231.2')).toBe(1);
        expect(compareDottedVersions('5.1231.0', '5.1231.0')).toBe(0);
        expect(compareDottedVersions('4.23118.1', '5.1231.0')).toBe(-1);
        expect(compareDottedVersions('2.31', '2.31.0')).toBe(0)
    });
});
