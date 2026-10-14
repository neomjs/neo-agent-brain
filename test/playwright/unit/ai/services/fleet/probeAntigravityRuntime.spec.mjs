import {expect, test} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    ANTIGRAVITY_RUNTIME_FINGERPRINT,
    classifyAntigravityRuntimeFingerprint,
    probeAntigravityRuntime,
    verifyAntigravityProfileListener
} from '../../../../../../ai/services/fleet/probeAntigravityRuntime.mjs';

const
    OWNER = {pid:100, startedAt:'Wed Oct 14 14:00:00 2026'},
    PROFILE_PORT = 9222,
    PROFILE_BROWSER_PATH = '/devtools/browser/profile-browser-id';

function makeBundle(root) {
    const
        appBundle = path.join(root, 'Antigravity.app'),
        contents = path.join(appBundle, 'Contents'),
        binary = path.join(contents, 'MacOS', 'Antigravity'),
        infoPlist = path.join(contents, 'Info.plist'),
        appAsar = path.join(contents, 'Resources', 'app.asar'),
        languageServer = path.join(contents, 'Resources', 'bin', 'language_server');

    for (const file of [binary, infoPlist, appAsar, languageServer]) {
        fs.mkdirSync(path.dirname(file), {recursive:true});
        fs.writeFileSync(file, 'fixture-bytes', {mode:file === binary || file === languageServer ? 0o755 : 0o644});
    }

    return {appBundle, binary, infoPlist, appAsar, languageServer}
}

function supportedMetadata() {
    return {
        bundleId:ANTIGRAVITY_RUNTIME_FINGERPRINT.bundleId,
        shortVersion:ANTIGRAVITY_RUNTIME_FINGERPRINT.shortVersion,
        buildVersion:ANTIGRAVITY_RUNTIME_FINGERPRINT.buildVersion
    }
}

function makeProfile(root) {
    const profileDirectory = path.join(root, 'profile');
    fs.mkdirSync(profileDirectory, {recursive:true});
    fs.writeFileSync(path.join(profileDirectory, 'DevToolsActivePort'), `${PROFILE_PORT}\n${PROFILE_BROWSER_PATH}`);
    return profileDirectory
}

function processInspector({listenerPid = 300, processRows, lsofRows = [`p${listenerPid}\nf30`], onPs} = {}) {
    const lsofCalls = [], psCalls = [];
    const execFileImpl = (file, args, options) => {
        if (file === '/usr/sbin/lsof') {
            lsofCalls.push({args, options});
            return lsofRows[lsofCalls.length - 1] ?? lsofRows.at(-1) ?? ''
        }
        if (file === '/bin/ps') {
            psCalls.push({args, options});
            const pid = Number(args[1]), row = onPs?.(pid, psCalls.length) ?? processRows.get(pid);
            if (!row) throw Object.assign(new Error('no such process'), {status:1});
            return `${row.parentPid} ${row.state ?? 'S'} ${row.startedAt}\n`
        }
        throw new Error('unexpected process inspection command')
    };

    return {execFileImpl, lsofCalls, psCalls}
}

test.describe('probeAntigravityRuntime', () => {
    let root;

    test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-runtime-probe-')) });
    test.afterEach(() => fs.rmSync(root, {recursive:true, force:true}));

    test('measures the selected bundle files and admits only the exact native-proven fingerprint', async () => {
        const fixture = makeBundle(root), hashedPaths = [], metadataPaths = [];
        const result = await probeAntigravityRuntime({
            selectedBinaryPath:fixture.binary,
            fsImpl:fs,
            platform:'darwin',
            architecture:'arm64',
            readBundleMetadata:file => { metadataPaths.push(file); return supportedMetadata() },
            hashFile:async file => {
                hashedPaths.push(file);
                return file === fs.realpathSync(fixture.appAsar)
                    ? ANTIGRAVITY_RUNTIME_FINGERPRINT.appAsarSha256
                    : ANTIGRAVITY_RUNTIME_FINGERPRINT.languageServerSha256
            }
        });

        expect(result).toMatchObject({available:true, reason:null,
            binaryPath:fs.realpathSync(fixture.binary), appBundle:fs.realpathSync(fixture.appBundle)});
        expect(result.appAsar).toBe(fs.realpathSync(fixture.appAsar));
        expect(result.languageServer).toBe(fs.realpathSync(fixture.languageServer));
        expect(metadataPaths).toEqual([fs.realpathSync(fixture.infoPlist)]);
        expect(hashedPaths).toEqual([fs.realpathSync(fixture.appAsar), fs.realpathSync(fixture.languageServer)]);
    });

    test('a changed language-server hash refuses the selected bundle', async () => {
        const fixture = makeBundle(root);
        const result = await probeAntigravityRuntime({
            selectedBinaryPath:fixture.binary,
            fsImpl:fs,
            platform:'darwin',
            architecture:'arm64',
            readBundleMetadata:supportedMetadata,
            hashFile:async file => file === fs.realpathSync(fixture.appAsar)
                ? ANTIGRAVITY_RUNTIME_FINGERPRINT.appAsarSha256
                : '0'.repeat(64)
        });

        expect(result).toMatchObject({available:false, reason:'language-server-fingerprint-mismatch'});
    });

    test('missing packaged runtime resource refuses before any capability claim', async () => {
        const fixture = makeBundle(root);
        fs.unlinkSync(fixture.languageServer);

        const result = await probeAntigravityRuntime({
            selectedBinaryPath:fixture.binary,
            fsImpl:fs,
            platform:'darwin',
            architecture:'arm64',
            readBundleMetadata:supportedMetadata,
            hashFile:async () => ANTIGRAVITY_RUNTIME_FINGERPRINT.appAsarSha256
        });

        expect(result).toMatchObject({available:false, reason:'required-app-resource-or-fingerprint-unavailable'});
    });

    test('unknown app identity, version, build, platform and architecture all fail closed', () => {
        const base = {
            ...ANTIGRAVITY_RUNTIME_FINGERPRINT,
            bundleId:ANTIGRAVITY_RUNTIME_FINGERPRINT.bundleId,
            shortVersion:ANTIGRAVITY_RUNTIME_FINGERPRINT.shortVersion,
            buildVersion:ANTIGRAVITY_RUNTIME_FINGERPRINT.buildVersion
        };

        expect(classifyAntigravityRuntimeFingerprint({...base, bundleId:'com.example.other'}).reason).toBe('unsupported-bundle-identity');
        expect(classifyAntigravityRuntimeFingerprint({...base, shortVersion:'2.24.0'}).reason).toBe('unsupported-app-version');
        expect(classifyAntigravityRuntimeFingerprint({...base, buildVersion:'2.23.1'}).reason).toBe('unsupported-app-version');
        expect(classifyAntigravityRuntimeFingerprint({...base, platform:'linux'}).reason).toBe('unsupported-platform-or-architecture');
        expect(classifyAntigravityRuntimeFingerprint({...base, architecture:'x64'}).reason).toBe('unsupported-platform-or-architecture');
    });

    test('an alternate executable path cannot borrow the selected bundle fingerprint', async () => {
        const fixture = makeBundle(root), standalone = path.join(root, 'Antigravity');
        fs.writeFileSync(standalone, 'not-an-app-bundle-main', {mode:0o755});

        const result = await probeAntigravityRuntime({
            selectedBinaryPath:standalone,
            fsImpl:fs,
            platform:'darwin',
            architecture:'arm64'
        });

        expect(result).toMatchObject({available:false, reason:'selected-binary-is-not-antigravity-app-main'});
        expect(result.binaryPath).toBe(fs.realpathSync(standalone));
        expect(fixture.binary).not.toBe(result.binaryPath);
    });

    test('profile listener is proven only through a stable PID/birth chain to the original Start', () => {
        const
            profileDirectory = makeProfile(root),
            processRows = new Map([
                [300, {parentPid:200, startedAt:'Wed Oct 14 14:01:00 2026'}],
                [200, {parentPid:100, startedAt:'Wed Oct 14 14:00:30 2026'}],
                [100, {parentPid:1, startedAt:OWNER.startedAt}]
            ]),
            inspector = processInspector({processRows}),
            proof = verifyAntigravityProfileListener({
                profileDirectory, port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
                expectedProcess:OWNER, fileSystem:fs, execFileImpl:inspector.execFileImpl
            });

        expect(proof).toEqual({
            verified:true, processTreeVerified:true,
            profileDirectory:path.resolve(profileDirectory),
            port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
            pid:OWNER.pid, startedAt:OWNER.startedAt
        });
        expect(inspector.lsofCalls).toHaveLength(2);
        expect(inspector.lsofCalls.every(({args}) => args.filter(arg => arg.startsWith('-iTCP:')).length === 1 && args.includes(`-iTCP:${PROFILE_PORT}`))).toBe(true);
        expect(inspector.psCalls.map(({args}) => Number(args[1]))).toEqual([300, 200, 100, 300, 200, 100]);
        expect(inspector.psCalls.every(({args, options}) =>
            args.includes('ppid=') && args.includes('stat=') && args.includes('lstart=') && !args.includes('command=') &&
            options.env.LC_ALL === 'C' && options.env.TZ === 'UTC' &&
            Object.keys(options.env).sort().join(',') === 'LC_ALL,PATH,TZ'
        )).toBe(true);
    });

    test('normalizes ps lstart spacing for a single-digit calendar day like the lifecycle lease', () => {
        const
            profileDirectory = makeProfile(root),
            singleDigitOwner = {pid:100, startedAt:'Sun Sep 6 09:00:00 2026'},
            processRows = new Map([
                [300, {parentPid:200, startedAt:'Sun Sep  6 09:01:00 2026'}],
                [200, {parentPid:100, startedAt:'Sun Sep  6 09:00:30 2026'}],
                [100, {parentPid:1, startedAt:'Sun Sep  6 09:00:00 2026'}]
            ]),
            inspector = processInspector({processRows}),
            proof = verifyAntigravityProfileListener({
                profileDirectory, port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
                expectedProcess:singleDigitOwner, fileSystem:fs, execFileImpl:inspector.execFileImpl
            });

        expect(proof).toMatchObject({verified:true, processTreeVerified:true, pid:100, startedAt:singleDigitOwner.startedAt});
    });

    test('accepts native lsof PID records followed by their numeric descriptor field', () => {
        const
            profileDirectory = makeProfile(root),
            owner = {pid:94667, startedAt:'Wed Oct 14 12:46:13 2026'},
            inspector = processInspector({
                listenerPid:94667,
                lsofRows:['p94667\nf30\n', 'p94667\nf30\n'],
                processRows:new Map([[94667, {parentPid:1, startedAt:owner.startedAt}]])
            }),
            proof = verifyAntigravityProfileListener({
                profileDirectory, port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
                expectedProcess:owner, fileSystem:fs, execFileImpl:inspector.execFileImpl
            });

        expect(proof).toMatchObject({verified:true, processTreeVerified:true, pid:94667, startedAt:owner.startedAt});
        expect(inspector.lsofCalls).toHaveLength(2)
    });

    test('an unrelated listener or a reused Start PID cannot prove profile ownership', () => {
        const profileDirectory = makeProfile(root), outOfTree = processInspector({
            processRows:new Map([
                [300, {parentPid:1, startedAt:'Wed Oct 14 14:01:00 2026'}],
                [100, {parentPid:1, startedAt:OWNER.startedAt}]
            ])
        });
        const unrelated = verifyAntigravityProfileListener({
            profileDirectory, port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
            expectedProcess:OWNER, fileSystem:fs, execFileImpl:outOfTree.execFileImpl
        });
        expect(unrelated).toMatchObject({verified:false, processTreeVerified:false});

        const reusedStart = processInspector({processRows:new Map([
            [300, {parentPid:100, startedAt:'Wed Oct 14 14:01:00 2026'}],
            [100, {parentPid:1, startedAt:'Wed Oct 14 15:00:00 2026'}]
        ])});
        const stale = verifyAntigravityProfileListener({
            profileDirectory, port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
            expectedProcess:OWNER, fileSystem:fs, execFileImpl:reusedStart.execFileImpl
        });
        expect(stale).toMatchObject({verified:false, processTreeVerified:false});
    });

    test('ambiguous listeners, a changed ancestry, and a stale profile port all refuse', () => {
        const profileDirectory = makeProfile(root), processRows = new Map([
            [300, {parentPid:200, startedAt:'Wed Oct 14 14:01:00 2026'}],
            [200, {parentPid:100, startedAt:'Wed Oct 14 14:00:30 2026'}],
            [100, {parentPid:1, startedAt:OWNER.startedAt}]
        ]);
        const multipleListeners = processInspector({processRows, lsofRows:['p300\nf30\np301\nf31','p300\nf30\np301\nf31']});
        expect(verifyAntigravityProfileListener({
            profileDirectory, port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
            expectedProcess:OWNER, fileSystem:fs, execFileImpl:multipleListeners.execFileImpl
        })).toMatchObject({verified:false});

        const malformedListenerRecords = processInspector({processRows, lsofRows:['f30\np300','f30\np300']});
        expect(verifyAntigravityProfileListener({
            profileDirectory, port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
            expectedProcess:OWNER, fileSystem:fs, execFileImpl:malformedListenerRecords.execFileImpl
        })).toMatchObject({verified:false});

        const changingTree = processInspector({processRows, onPs:(pid, call) => {
            if (pid === 200 && call > 3) return {parentPid:1, startedAt:'Wed Oct 14 14:00:30 2026'};
            return processRows.get(pid)
        }});
        expect(verifyAntigravityProfileListener({
            profileDirectory, port:PROFILE_PORT, browserPath:PROFILE_BROWSER_PATH,
            expectedProcess:OWNER, fileSystem:fs, execFileImpl:changingTree.execFileImpl
        })).toMatchObject({verified:false});

        expect(verifyAntigravityProfileListener({
            profileDirectory, port:PROFILE_PORT + 1, browserPath:PROFILE_BROWSER_PATH,
            expectedProcess:OWNER, fileSystem:fs, execFileImpl:processInspector({processRows}).execFileImpl
        })).toMatchObject({verified:false});
    });
});
