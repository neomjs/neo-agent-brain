import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'ProbeAntigravityRuntimeTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {expect, test}                           from '@playwright/test';
import fs                                       from 'node:fs';
import os                                       from 'node:os';
import path                                     from 'node:path';
import Neo                                      from 'neo.mjs/src/Neo.mjs';
import * as core                                from 'neo.mjs/src/core/_export.mjs';
import FleetLifecycleService, {SEAT_LEASE_FILE} from '../../../../../../ai/services/fleet/FleetLifecycleService.mjs';
import {deriveAgentInstanceHome}                from '../../../../../../ai/services/fleet/deriveAgentInstanceHome.mjs';
import {resolveAntigravitySidecarAncestor}      from '../../../../../../ai/daemons/wake/antigravityWakeSidecar.mjs';
import {
    classifyAntigravityRuntimeFingerprint,
    probeAntigravityRuntime,
    verifyAntigravityProfileListener
} from '../../../../../../ai/services/fleet/probeAntigravityRuntime.mjs';

const
    RUNTIME_FIXTURE = Object.freeze({
        platform            : 'darwin',
        architecture        : 'arm64',
        bundleId            : 'com.google.antigravity',
        shortVersion        : '2.24.1',
        buildVersion        : '2.24.1',
        appAsarSha256       : 'a'.repeat(64),
        languageServerSha256: 'b'.repeat(64)
    }),
    OWNER = {pid:100, startedAt:'Wed Oct 14 14:00:00 2026'},
    PROFILE_PORT = 9222,
    PROFILE_BROWSER_PATH = '/devtools/browser/profile-browser-id',
    REQUIRED_ASAR_MARKERS = ['remote-debugging-port', 'DevToolsActivePort', 'AGY_BROWSER_ACTIVE_PORT_FILE'];

function makeBundle(root, {asarMarkers = REQUIRED_ASAR_MARKERS} = {}) {
    const
        appBundle      = path.join(root, 'Antigravity.app'),
        contents       = path.join(appBundle, 'Contents'),
        binary         = path.join(contents, 'MacOS', 'Antigravity'),
        infoPlist      = path.join(contents, 'Info.plist'),
        appAsar        = path.join(contents, 'Resources', 'app.asar'),
        languageServer = path.join(contents, 'Resources', 'bin', 'language_server');

    for (const file of [binary, infoPlist, appAsar, languageServer]) {
        fs.mkdirSync(path.dirname(file), {recursive:true});
        fs.writeFileSync(file, file === appAsar ? asarMarkers.join('\n') : 'fixture-bytes',
            {mode:file === binary || file === languageServer ? 0o755 : 0o644});
    }

    return {appBundle, binary, infoPlist, appAsar, languageServer}
}

function supportedMetadata() {
    return {
        bundleId:RUNTIME_FIXTURE.bundleId,
        shortVersion:RUNTIME_FIXTURE.shortVersion,
        buildVersion:RUNTIME_FIXTURE.buildVersion
    }
}

function makeProfile(root) {
    const profileDirectory = path.join(root, 'profile');
    fs.mkdirSync(profileDirectory, {recursive:true});
    fs.writeFileSync(path.join(profileDirectory, 'DevToolsActivePort'), `${PROFILE_PORT}\n${PROFILE_BROWSER_PATH}`);
    return profileDirectory
}

function processInspector({listenerPid = 300, processRows, lsofRows = [`p${listenerPid}\nf30`], onPs} = {}) {
    const lsofCalls    = [], psCalls = [];
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

    test('measures the selected bundle files and admits a future runtime identity with well-formed hashes', async () => {
        const fixture = makeBundle(root), hashedPaths = [], metadataPaths = [];
        const result  = await probeAntigravityRuntime({
            selectedBinaryPath:fixture.binary,
            fsImpl:fs,
            platform:'darwin',
            architecture:'arm64',
            readBundleMetadata:file => { metadataPaths.push(file); return supportedMetadata() },
            hashFile:async file => {
                hashedPaths.push(file);
                return file === fs.realpathSync(fixture.appAsar)
                    ? RUNTIME_FIXTURE.appAsarSha256
                    : RUNTIME_FIXTURE.languageServerSha256
            }
        });

        expect(result).toMatchObject({available:true, reason:null,
            binaryPath:fs.realpathSync(fixture.binary), appBundle:fs.realpathSync(fixture.appBundle)});
        expect(result.appAsar).toBe(fs.realpathSync(fixture.appAsar));
        expect(result.languageServer).toBe(fs.realpathSync(fixture.languageServer));
        expect(result.fingerprints).toMatchObject(RUNTIME_FIXTURE);
        expect(metadataPaths).toEqual([fs.realpathSync(fixture.infoPlist)]);
        expect(hashedPaths).toEqual([fs.realpathSync(fixture.appAsar), fs.realpathSync(fixture.languageServer)]);
    });

    test('a newer version with changed app and language-server hashes remains eligible', async () => {
        const fixture = makeBundle(root);
        const result  = await probeAntigravityRuntime({
            selectedBinaryPath:fixture.binary,
            fsImpl:fs,
            platform:'darwin',
            architecture:'arm64',
            readBundleMetadata:() => ({bundleId: RUNTIME_FIXTURE.bundleId, shortVersion: '8.4.2', buildVersion: '8.4.2'}),
            hashFile:async file => file === fs.realpathSync(fixture.appAsar)
                ? 'c'.repeat(64)
                : 'd'.repeat(64)
        });

        expect(result).toMatchObject({available: true, reason: null, fingerprints: {
            shortVersion: '8.4.2', buildVersion: '8.4.2', appAsarSha256: 'c'.repeat(64), languageServerSha256: 'd'.repeat(64)
        }});
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
            hashFile:async () => RUNTIME_FIXTURE.appAsarSha256
        });

        expect(result).toMatchObject({available:false, reason:'required-app-resource-or-fingerprint-unavailable'});
    });

    test('accepts changed versions/hashes but still rejects wrong app identity and platform', () => {
        expect(classifyAntigravityRuntimeFingerprint({...RUNTIME_FIXTURE, shortVersion: '99.1.0', buildVersion: 'future-build', appAsarSha256: 'e'.repeat(64), languageServerSha256: 'f'.repeat(64)}))
            .toEqual({available: true, reason: null});
        expect(classifyAntigravityRuntimeFingerprint({...RUNTIME_FIXTURE, bundleId:'com.example.other'}).reason).toBe('unsupported-bundle-identity');
        expect(classifyAntigravityRuntimeFingerprint({...RUNTIME_FIXTURE, platform:'linux'}).reason).toBe('unsupported-platform-or-architecture');
        expect(classifyAntigravityRuntimeFingerprint({...RUNTIME_FIXTURE, architecture:'x64'}).reason).toBe('unsupported-platform-or-architecture');
        expect(classifyAntigravityRuntimeFingerprint({...RUNTIME_FIXTURE, shortVersion: ''}).reason).toBe('runtime-metadata-invalid');
        expect(classifyAntigravityRuntimeFingerprint({...RUNTIME_FIXTURE, appAsarSha256: 'not-a-sha256'}).reason).toBe('runtime-metadata-invalid')
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
            processRows      = new Map([
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
            processRows      = new Map([
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
            owner            = {pid:94667, startedAt:'Wed Oct 14 12:46:13 2026'},
            inspector        = processInspector({
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

    test('missing app.asar remote-debugging or active-port marker refuses at admission', async () => {
        for (const omitted of REQUIRED_ASAR_MARKERS) {
            const
                fixture = makeBundle(path.join(root, omitted), {asarMarkers: REQUIRED_ASAR_MARKERS.filter(marker => marker !== omitted)}),
                result  = await probeAntigravityRuntime({
                    selectedBinaryPath:fixture.binary,
                    fsImpl:fs,
                    platform:'darwin',
                    architecture:'arm64',
                    readBundleMetadata:supportedMetadata,
                    hashFile:async () => RUNTIME_FIXTURE.appAsarSha256
                });

            expect(result, omitted).toEqual({
                available : false,
                reason    : `app-contract-marker-missing:${omitted}`,
                binaryPath: fs.realpathSync(fixture.binary),
                appBundle : fs.realpathSync(fixture.appBundle)
            });
        }

        const
            multiMissing = makeBundle(path.join(root, 'multi'), {asarMarkers: ['remote-debugging-port']}),
            multiResult  = await probeAntigravityRuntime({
                selectedBinaryPath:multiMissing.binary,
                fsImpl:fs,
                platform:'darwin',
                architecture:'arm64',
                readBundleMetadata:supportedMetadata,
                hashFile:async () => RUNTIME_FIXTURE.appAsarSha256
            });

        expect(multiResult).toMatchObject({
            available: false,
            reason   : 'app-contract-marker-missing:DevToolsActivePort,AGY_BROWSER_ACTIVE_PORT_FILE'
        });
    });

    test('running 2.32.2 seats launched without --remote-debugging-port=0 stay recognised alongside 2.33.0 seats', () => {
        const
            gen2322      = makeBundle(path.join(root, 'gen-2.32.2')),
            gen2330      = makeBundle(path.join(root, 'gen-2.33.0')),
            gen2322Bin   = fs.realpathSync(gen2322.binary),
            gen2330Bin   = fs.realpathSync(gen2330.binary),
            gen2322App   = fs.realpathSync(gen2322.appBundle),
            gen2330App   = fs.realpathSync(gen2330.appBundle),
            genId2322    = '2322'.repeat(16),
            instanceRoot = path.join(root, 'agents'),
            checkout     = path.join(root, 'checkout'),
            agent        = {id: 'neo-gemini-julia', githubUsername: 'neo-gemini-julia', harnessType: 'antigravity'},
            home         = deriveAgentInstanceHome({instanceRoot, agentId: agent.id, harnessType: 'antigravity'}),
            cmd2322      = `${gen2322Bin} --user-data-dir=${home}`,
            cmd2330      = `${gen2330Bin} --user-data-dir=${home} --remote-debugging-port=0`,
            originals    = {
                registry              : FleetLifecycleService.registry,
                instanceRoot          : FleetLifecycleService.instanceRoot,
                harnessBinaryPaths    : FleetLifecycleService.harnessBinaryPaths,
                harnessGenerationRoot : FleetLifecycleService.harnessGenerationRoot,
                harnessGenerationStore: FleetLifecycleService.harnessGenerationStore,
                processListFn         : FleetLifecycleService.processListFn,
                processInspectFn      : FleetLifecycleService.processInspectFn,
                processSignalFn       : FleetLifecycleService.processSignalFn,
                leasesAdopted         : FleetLifecycleService.leasesAdopted
            };

        fs.mkdirSync(home, {recursive: true});
        fs.mkdirSync(checkout, {recursive: true});

        try {
            FleetLifecycleService.processes.delete(agent.id);
            FleetLifecycleService.leasesAdopted          = false;
            FleetLifecycleService.registry               = {listAgents: () => [{id: agent.id}], getDefinition: id => id === agent.id ? agent : null};
            FleetLifecycleService.instanceRoot           = instanceRoot;
            FleetLifecycleService.harnessBinaryPaths     = {antigravity: gen2330Bin};
            FleetLifecycleService.harnessGenerationRoot  = path.join(root, 'generations');
            FleetLifecycleService.harnessGenerationStore = {
                list: () => [{id: genId2322, appBundle: gen2322App, binaryPath: gen2322Bin, shortVersion: '2.32.2', buildVersion: '2.32.2'}]
            };

            for (const [lines, expected] of [
                [[cmd2322], true],
                [[cmd2330], true],
                [[`${gen2322App}/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=renderer --user-data-dir=${home}`], false],
                [[`${gen2330Bin} --user-data-dir=${home}-other --remote-debugging-port=0`], false]
            ]) {
                FleetLifecycleService.processListFn = () => lines;
                expect(FleetLifecycleService.desktopProfileInUse(agent), JSON.stringify(lines)).toBe(expected);
            }

            fs.writeFileSync(path.join(home, SEAT_LEASE_FILE), JSON.stringify({
                agentId            : agent.id,
                pid                : 4242,
                pidStartedAt       : OWNER.startedAt,
                startedAt          : '2026-11-19T13:10:00.000Z',
                cwd                : checkout,
                harnessGenerationId: genId2322
            }));
            FleetLifecycleService.processSignalFn  = (pid, signal) => { expect([pid, signal]).toEqual([4242, 0]) };
            FleetLifecycleService.processInspectFn = pid => pid === 4242 ? {startedAt: OWNER.startedAt, exited: false, command: cmd2322} : null;

            expect(FleetLifecycleService.status(agent.id)).toMatchObject({
                id               : agent.id,
                state            : 'running',
                running          : true,
                adopted          : true,
                pid              : 4242,
                launchCommand    : gen2322Bin,
                harnessGeneration: {family: 'antigravity', generationId: genId2322, shortVersion: '2.32.2', buildVersion: '2.32.2'}
            });

            for (const [appBundle, command] of [[gen2322App, cmd2322], [gen2330App, cmd2330]]) {
                expect(resolveAntigravitySidecarAncestor({
                    sidecarPid: 9000,
                    rows      : [
                        {pid: 9000, ppid: 5000, startedAt: OWNER.startedAt, command: 'node antigravityWakeSidecar.mjs'},
                        {pid: 5000, ppid: 4242, startedAt: OWNER.startedAt, command: `${appBundle}/Contents/Resources/bin/language_server`},
                        {pid: 4242, ppid: 1,    startedAt: OWNER.startedAt, command}
                    ]
                })).toEqual({
                    appPid      : 4242,
                    appStart    : OWNER.startedAt,
                    appBundle,
                    instanceHome: home
                });
            }
        } finally {
            FleetLifecycleService.processes.delete(agent.id);
            Object.assign(FleetLifecycleService, originals);
        }
    });
});
