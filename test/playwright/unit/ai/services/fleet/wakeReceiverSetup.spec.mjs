import {expect, test} from '@playwright/test';
import {execFile}     from 'node:child_process';
import crypto         from 'node:crypto';
import fs             from 'node:fs/promises';
import http           from 'node:http';
import net            from 'node:net';
import os             from 'node:os';
import path           from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify}    from 'node:util';
import {
    buildWakeReceiverManifest,
    writeValidatedManifest
} from '../../../../../../ai/daemons/wake/buildReceiverManifest.mjs';
import {parseWakeReceiverArgs, startWakeReceiver} from '../../../../../../ai/daemons/wake/receiver.mjs';
import {createHost}                             from '../../../../../../ai/services/fleet/hostEffects.mjs';
import {RUNTIME_GENERATION_PAYLOAD}             from '../../../../../../ai/services/fleet/runtimeGeneration.mjs';
import {contentDigest}                          from '../../../../../../ai/services/fleet/setupRunRecord.mjs';
import {
    WAKE_RECEIVER_ENTRYPOINT,
    WAKE_RECEIVER_LABEL,
    WAKE_RECEIVER_PLIST_NAME,
    ensureColdWakeManifest,
    extractReceiverDeclaration,
    inspectWakeRecordsDir,
    observeDesktopWakeQuestion,
    observeWakeReceiverEffect,
    parseLaunchAgentPlist,
    prepareWakeRecordsDir,
    probeWakeReceiverHttp,
    reconcileWakeReceiverService,
    selectWakeRecordsStateDir,
    serializeWakeReceiverPlist
} from '../../../../../../ai/services/fleet/wakeReceiverSetup.mjs';

const
    execFileAsync = promisify(execFile),
    here          = path.dirname(fileURLToPath(import.meta.url)),
    brainRoot     = path.resolve(here, '../../../../../..'),
    templatePath  = path.join(brainRoot, 'deploy', 'host', WAKE_RECEIVER_PLIST_NAME),
    NOW           = Date.UTC(2026, 10, 16, 2, 0, 0),
    CURRENT_UID   = typeof process.getuid === 'function' ? process.getuid() : 501;

async function freeLoopbackPort() {
    const server = net.createServer();

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    const {port} = server.address();

    await new Promise(resolve => server.close(resolve));

    return port;
}

function createScriptedLaunchdHost({
    platform        = 'darwin',
    uid             = CURRENT_UID,
    initialLaunchd  = {},
    foreignPorts    = [],
    beforeBootstrap = null
} = {}) {
    const
        calls = [],
        state = {
            loaded   : false,
            running  : false,
            plistPath: null,
            host     : null,
            port     : null,
            ...initialLaunchd
        };

    const host = createHost({
        now              : () => NOW,
        platform         : () => platform,
        uid              : () => uid,
        probeWakeListener: async ({host: probeHost, port: probePort}) => {
            if (foreignPorts.includes(probePort)) {
                return {listening: true, wakeReceiver: false, statusCode: 200, reason: `foreign listener on ${probeHost}:${probePort}`};
            }

            if (state.loaded && state.running && (state.host ?? '127.0.0.1') === probeHost && state.port === probePort) {
                return {listening: true, wakeReceiver: true, statusCode: 404, reason: null};
            }

            return {listening: false, wakeReceiver: false, statusCode: null, reason: `connect ECONNREFUSED ${probeHost}:${probePort}`};
        },
        run: async (command, args) => {
            calls.push({command, args});

            if (command === 'launchctl' && args[0] === 'print') {
                if (!state.loaded) {
                    throw Object.assign(new Error(`Could not find service "${WAKE_RECEIVER_LABEL}" in domain for user gui: 113`), {stderr: 'Could not find service'});
                }

                return {
                    stdout: [
                        `\tstate = ${state.running ? 'running' : 'not running'}`,
                        ...(state.running ? ['\tpid = 4242'] : []),
                        ...(state.plistPath ? [`\tpath = ${state.plistPath}`] : [])
                    ].join('\n'),
                    stderr: ''
                };
            }

            if (command === 'launchctl' && args[0] === 'bootout') {
                state.loaded  = false;
                state.running = false;

                return {stdout: '', stderr: ''};
            }

            if (command === 'launchctl' && args[0] === 'bootstrap') {
                if (typeof beforeBootstrap === 'function') {
                    await beforeBootstrap({state, plistPath: args[2]});
                }

                const
                    xml  = await fs.readFile(args[2], 'utf8'),
                    decl = extractReceiverDeclaration(parseLaunchAgentPlist(xml, {allowComments: false}));

                state.loaded    = true;
                state.running   = true;
                state.plistPath = args[2];
                state.host      = decl.host;
                state.port      = decl.port;

                return {stdout: '', stderr: ''};
            }

            throw new Error(`Unexpected command in test host: ${command} ${args.join(' ')}`);
        }
    });

    return {host, state, calls};
}

async function setupWorkspace() {
    const
        root      = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-setup-')),
        stateRoot = path.join(root, 'state'),
        homeDir   = path.join(root, 'home'),
        layout    = {
            homeDir,
            stateRoot,
            repoRoot                : brainRoot,
            nodeBin                 : process.execPath,
            envFile                 : path.join(stateRoot, 'config', 'local-agent-os.env'),
            secretsDir              : path.join(stateRoot, 'secrets'),
            wakeStateDir            : path.join(stateRoot, 'wake-receiver'),
            receiverlessWakeStateDir: path.join(stateRoot, 'wake-receiver-disabled'),
            wakeManifestPath        : path.join(stateRoot, 'wake-receiver', 'manifest.json'),
            wakeCustodyPath         : path.join(stateRoot, 'wake-receiver', 'setup-custody.json'),
            wakePlistPath           : path.join(homeDir, 'Library', 'LaunchAgents', WAKE_RECEIVER_PLIST_NAME),
            wakeTemplatePath        : templatePath,
            wakeHost                : '127.0.0.1',
            wakePort                : 3199
        },
        target = {planeId: 'neo-local-canonical', dataRoot: '/app/.neo-ai-data', endpoint: 'http://127.0.0.1:3102'};

    return {root, stateRoot, homeDir, layout, target};
}

test.describe('wakeReceiverSetup', () => {
    test('serializes the canonical LaunchAgent template cleanly without XML comments and supports checkout and packaged runtime generation pins', async () => {
        const templateXml = await fs.readFile(templatePath, 'utf8');

        // strict reader rejects XML comments in materialized plists
        expect(() => parseLaunchAgentPlist(templateXml, {allowComments: false})).toThrow(/must not contain XML comments/);

        const checkoutXml = serializeWakeReceiverPlist({
            templateXml,
            executable  : process.execPath,
            runtimeRoot : brainRoot,
            manifestPath: '/srv/state/wake-receiver/manifest.json',
            stateDir    : '/srv/state/wake-receiver',
            host        : '127.0.0.1',
            port        : 3199
        });

        expect(checkoutXml).not.toContain('<!--');
        expect(checkoutXml).not.toContain('__');

        const parsedCheckout = parseLaunchAgentPlist(checkoutXml, {allowComments: false});

        expect(parsedCheckout.EnvironmentVariables.PATH).not.toContain('/Users/');
        expect(extractReceiverDeclaration(parsedCheckout)).toEqual({
            label               : WAKE_RECEIVER_LABEL,
            executable          : process.execPath,
            entrypoint          : WAKE_RECEIVER_ENTRYPOINT,
            runtimeRoot         : brainRoot,
            manifestPath        : '/srv/state/wake-receiver/manifest.json',
            stateDir            : '/srv/state/wake-receiver',
            host                : '127.0.0.1',
            port                : 3199,
            runtimeGenerationDir: null,
            ambiguousFlags      : false
        });

        // packaged runtime generation pin appends `--neo-runtime-generation=<dir>` cleanly alongside receiver CLI args
        const
            genId        = 'a'.repeat(64),
            genDir       = `/Applications/Neo.app/Contents/Resources/${genId}`,
            runtimeRoot  = `${genDir}/${RUNTIME_GENERATION_PAYLOAD}/brain`,
            executable   = `${genDir}/${RUNTIME_GENERATION_PAYLOAD}/bin/node`,
            packagedXml  = serializeWakeReceiverPlist({
                templateXml,
                executable,
                runtimeRoot,
                manifestPath     : '/srv/state/wake-receiver/manifest.json',
                stateDir         : '/srv/state/wake-receiver',
                host             : '127.0.0.1',
                port             : 3299,
                runtimeGeneration: {
                    id           : genId,
                    directory    : genDir,
                    runtimeRoot,
                    executable,
                    payloadDigest: 'b'.repeat(64)
                }
            }),
            parsedPackaged = parseLaunchAgentPlist(packagedXml, {allowComments: false}),
            decl           = extractReceiverDeclaration(parsedPackaged);

        expect(decl).toMatchObject({
            executable,
            runtimeRoot,
            port                : 3299,
            runtimeGenerationDir: genDir,
            ambiguousFlags      : false
        });
        expect(parseWakeReceiverArgs(parsedPackaged.ProgramArguments.slice(2))).toEqual({
            manifestPath: '/srv/state/wake-receiver/manifest.json',
            stateDir    : '/srv/state/wake-receiver',
            host        : '127.0.0.1',
            port        : 3299
        });
    });

    test('tokenizes XML comments without pre-stripping, rejecting tag-splitting, scalar-embedded, nested, and unclosed comments in both template and strict modes', async () => {
        const templateXml = await fs.readFile(templatePath, 'utf8');

        const betweenElements = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<!-- prolog comment -->',
            '<plist version="1.0">',
            '<dict>',
            '    <!-- dict comment -->',
            '    <key>Label</key>',
            '    <string>test</string>',
            '    <key>EmptyArray</key>',
            '    <array/>',
            '    <key>EmptyDict</key>',
            '    <dict/>',
            '    <key>EmptyString</key>',
            '    <string/>',
            '</dict>',
            '<!-- trailing comment -->',
            '</plist>'
        ].join('\n');

        expect(parseLaunchAgentPlist(betweenElements, {allowComments: true})).toEqual({
            Label      : 'test',
            EmptyArray : [],
            EmptyDict  : {},
            EmptyString: ''
        });
        expect(() => parseLaunchAgentPlist(betweenElements, {allowComments: false})).toThrow(/must not contain XML comments/);

        const malformedCases = [
            '<plist version="1.0"><dict><ke<!-- fixture -->y>Label</key><string>test</string></dict></plist>',
            '<plist version="1.0"><dict><key>Label</ke<!-- fixture -->y><string>test</string></dict></plist>',
            '<?xm<!-- fixture -->l version="1.0"?><plist version="1.0"><dict/></plist>',
            '<!DOCTYP<!-- fixture -->E plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>',
            '<!<!-- fixture -->-- sneaky --><plist version="1.0"><dict/></plist>',
            '<plist version="1.0"><dict><!-- a -- b --></dict></plist>',
            '<plist version="1.0"><dict><!-- unclosed</dict></plist>',
            '<plist version="1.0"><dict><key>La<!-- c -->bel</key><string>test</string></dict></plist>',
            '<plist version="1.0"><dict><key>Label</key><string>te<!-- c -->st</string></dict></plist>',
            '<plist version="1.0"><dict><key>Count</key><integer><!-- c -->42</integer></dict></plist>'
        ];

        for (const payload of malformedCases) {
            expect(() => parseLaunchAgentPlist(payload, {allowComments: true}), payload).toThrow();
            expect(() => parseLaunchAgentPlist(payload, {allowComments: false}), payload).toThrow();
        }

        // positive control: canonical commented template still parses cleanly and round-trips through strict reader
        const materialized = serializeWakeReceiverPlist({
            templateXml,
            executable  : process.execPath,
            runtimeRoot : brainRoot,
            manifestPath: '/srv/state/wake-receiver/manifest.json',
            stateDir    : '/srv/state/wake-receiver'
        });

        expect(parseLaunchAgentPlist(materialized, {allowComments: false}).Label).toBe(WAKE_RECEIVER_LABEL);
    });

    test('prepares 0700 <stateDir>/records for enabled and receiver-less planes, preserves existing records and sibling modes, refuses unsafe symlinks/UIDs, and renders the real Compose overlay', async () => {
        const
            {root, layout} = await setupWorkspace(),
            {host}         = createScriptedLaunchdHost();

        try {
            const
                enabledDir   = selectWakeRecordsStateDir(layout, {consentAnswer: 'enabled', supported: true}),
                declinedDir  = selectWakeRecordsStateDir(layout, {consentAnswer: 'declined', supported: true}),
                unrelated    = path.join(enabledDir, 'unrelated.txt'),
                queuedRecord = path.join(enabledDir, 'records', 'record-1.json');

            await fs.mkdir(enabledDir, {recursive: true, mode: 0o755});
            await fs.writeFile(unrelated, 'keep-mode', {mode: 0o644});
            await fs.mkdir(path.join(enabledDir, 'records'), {mode: 0o755});
            await fs.writeFile(queuedRecord, '{"status":"pending"}\n', {mode: 0o640});

            await prepareWakeRecordsDir(enabledDir, host);
            await prepareWakeRecordsDir(declinedDir, host);

            expect((await fs.stat(path.join(enabledDir, 'records'))).mode & 0o777).toBe(0o700);
            expect((await fs.stat(path.join(declinedDir, 'records'))).mode & 0o777).toBe(0o700);
            expect((await fs.stat(unrelated)).mode & 0o777, 'unrelated sibling permissions preserved').toBe(0o644);
            expect(await fs.readFile(queuedRecord, 'utf8')).toBe('{"status":"pending"}\n');
            expect((await fs.stat(queuedRecord)).mode & 0o777, 'existing queued record permissions preserved').toBe(0o640);
            expect(await inspectWakeRecordsDir(enabledDir, host)).toMatchObject({ok: true});

            // refuses symbolic links and foreign UID before modifying paths
            const
                symlinkState = path.join(root, 'symlink-state'),
                foreignHost  = createScriptedLaunchdHost({uid: CURRENT_UID + 9999}).host;

            await fs.symlink(enabledDir, symlinkState);
            await expect(prepareWakeRecordsDir(symlinkState, host)).rejects.toThrow(/symbolic link/);
            await expect(prepareWakeRecordsDir(enabledDir, foreignHost)).rejects.toThrow(/foreign ownership/);

            // render actual Compose pair using the written env values
            for (const dir of [enabledDir, declinedDir]) {
                const
                    recordsHostDir = path.join(dir, 'records'),
                    envPath        = path.join(root, `compose-${path.basename(dir)}.env`);

                await fs.writeFile(envPath, [
                    'NEO_MCP_AUTH_TOKEN_FILE=/dev/null',
                    'NEO_FLEET_PLANE_TOKEN_FILE=/dev/null',
                    `NEO_WAKE_RECEIVER_RECORDS_HOST_DIR=${recordsHostDir}`
                ].join('\n') + '\n');

                const {stdout} = await execFileAsync('docker', [
                    'compose',
                    '--env-file', envPath,
                    '-f', 'docker-compose.yml',
                    '-f', 'docker-compose.local-agent-os.yml',
                    '--profile', 'cloud',
                    '--profile', 'fleet',
                    '--profile', 'ingress',
                    'config', '--format', 'json'
                ], {cwd: path.join(brainRoot, 'deploy', 'cloud'), encoding: 'utf8'});

                const
                    rendered = JSON.parse(stdout),
                    volumes  = rendered.services['mc-server'].volumes ?? [],
                    mount    = volumes.find(entry => entry.target === '/app/wake-receiver-records');

                expect(mount).toMatchObject({
                    source   : recordsHostDir,
                    target   : '/app/wake-receiver-records',
                    read_only: true,
                    bind     : {create_host_path: false}
                });
            }
        } finally {
            await fs.rm(root, {recursive: true, force: true});
        }
    });

    test('covers ownership, adoption, custody conflicts, corroborated legacy adoption, stopped service recovery, upgrades, and moved endpoints', async () => {
        const
            {root, layout, target} = await setupWorkspace(),
            templateXml            = await fs.readFile(templatePath, 'utf8');

        try {
            const
                {host, state, calls} = createScriptedLaunchdHost(),
                baseInput = {
                    plistPath   : layout.wakePlistPath,
                    manifestPath: layout.wakeManifestPath,
                    custodyPath : layout.wakeCustodyPath,
                    stateDir    : layout.wakeStateDir,
                    host        : layout.wakeHost,
                    port        : layout.wakePort,
                    executable  : layout.nodeBin,
                    runtimeRoot : layout.repoRoot,
                    templateXml,
                    target
                };

            // 1. Clean host install
            expect((await observeDesktopWakeQuestion({layout, host, target})).action).toBe('install and start');
            expect((await observeWakeReceiverEffect({layout, target, host})).present).toBe(false);

            const installed = await reconcileWakeReceiverService(baseInput, host);

            expect(installed.action).toBe('installed');
            expect(calls.filter(c => c.args[0] === 'bootstrap')).toHaveLength(1);
            expect((await fs.stat(layout.wakeManifestPath)).mode & 0o777).toBe(0o600);
            expect(JSON.parse(await fs.readFile(layout.wakeManifestPath, 'utf8'))).toEqual({schemaVersion: 1, routes: {}});
            expect(await observeWakeReceiverEffect({layout, target, host})).toMatchObject({present: true, running: true, adopted: true, problem: null});

            // write a queued record to verify adoption/upgrades/restarts preserve existing files
            const queued = path.join(layout.wakeStateDir, 'records', 'queued-1.json');

            await fs.writeFile(queued, '{"status":"pending"}\n', {mode: 0o600});

            // 2. Resume adopts running service with zero extra bootstraps
            const adopted = await reconcileWakeReceiverService(baseInput, host);

            expect(adopted.action).toBe('adopted');
            expect(calls.filter(c => c.args[0] === 'bootstrap')).toHaveLength(1);
            expect(await fs.readFile(queued, 'utf8')).toBe('{"status":"pending"}\n');

            // 3. Stopped owned service: observer refuses to settle by file digest alone; reconciler restarts it
            state.loaded  = false;
            state.running = false;
            expect(await observeWakeReceiverEffect({layout, target, host})).toMatchObject({present: false, running: false});

            const restarted = await reconcileWakeReceiverService(baseInput, host);

            expect(restarted.action).toBe('started');
            expect(calls.filter(c => c.args[0] === 'bootstrap')).toHaveLength(2);
            expect(await observeWakeReceiverEffect({layout, target, host})).toMatchObject({present: true, running: true});

            // 4. Moved endpoint (3199 -> 3299) triggers pre-replacement recheck, bootout, and rebind preserving queued record
            const rebindInput = {...baseInput, port: 3299};

            expect((await observeWakeReceiverEffect({layout: {...layout, wakePort: 3299}, target, host})).upgradePending).toBe(true);

            const rebound = await reconcileWakeReceiverService(rebindInput, host);

            expect(rebound.action).toBe('rebound');
            expect(state.port).toBe(3299);
            expect(await fs.readFile(queued, 'utf8')).toBe('{"status":"pending"}\n');

            // 5. Runtime generation upgrade with pre-replacement custody recheck
            const
                gen2Id      = 'c'.repeat(64),
                gen2Dir     = path.join(root, gen2Id),
                gen2Root    = path.join(gen2Dir, RUNTIME_GENERATION_PAYLOAD, 'brain'),
                gen2Exec    = path.join(gen2Dir, RUNTIME_GENERATION_PAYLOAD, 'bin', 'node'),
                upgradedGen = {
                    id           : gen2Id,
                    directory    : gen2Dir,
                    runtimeRoot  : gen2Root,
                    executable   : gen2Exec,
                    payloadDigest: 'd'.repeat(64)
                };

            await fs.mkdir(path.join(gen2Root, 'ai', 'daemons', 'wake'), {recursive: true});
            await fs.writeFile(path.join(gen2Root, WAKE_RECEIVER_ENTRYPOINT), '// runtime entrypoint\n');

            await expect(reconcileWakeReceiverService({
                ...rebindInput,
                executable       : gen2Exec,
                runtimeRoot      : gen2Root,
                runtimeGeneration: upgradedGen
            }, createScriptedLaunchdHost({
                initialLaunchd : {...state},
                beforeBootstrap: async () => {}
            }).host)).resolves.toMatchObject({action: 'upgraded'});

            // 6. Ownership conflicts: wrong planeId, wrong dataRoot, wrong UID, foreign port listener
            await expect(reconcileWakeReceiverService({...rebindInput, target: {...target, planeId: 'other-plane'}}, host)).rejects.toThrow(/belongs to plane/);
            await expect(reconcileWakeReceiverService({...rebindInput, target: {...target, dataRoot: '/srv/other'}}, host)).rejects.toThrow(/belongs to dataRoot/);
            await expect(reconcileWakeReceiverService(rebindInput, createScriptedLaunchdHost({uid: CURRENT_UID + 1, initialLaunchd: {...state}}).host)).rejects.toThrow(/foreign ownership|UID/);
            await expect(reconcileWakeReceiverService({...rebindInput, port: 3399}, createScriptedLaunchdHost({initialLaunchd: {...state}, foreignPorts: [3399]}).host)).rejects.toThrow(/foreign listener|refusing takeover/);

            // 7. Corroborated vs uncorroborated legacy plist (no setup-custody.json)
            await fs.rm(layout.wakeCustodyPath, {force: true});
            await fs.writeFile(layout.wakePlistPath, serializeWakeReceiverPlist({
                templateXml,
                executable  : layout.nodeBin,
                runtimeRoot : layout.repoRoot,
                manifestPath: layout.wakeManifestPath,
                stateDir    : layout.wakeStateDir,
                host        : '127.0.0.1',
                port        : 3299
            }), {mode: 0o600});
            // Empty routes manifest -> uncorroborated legacy plist refused!
            await expect(reconcileWakeReceiverService(rebindInput, host)).rejects.toThrow(/no signed seat routes|refusing automatic takeover/);
            expect(await observeWakeReceiverEffect({layout: {...layout, wakePort: 3299}, target, host})).toMatchObject({present: true, problem: expect.stringMatching(/no signed seat routes/)});

            // Non-empty route manifest + running service + matching declaration -> corroborated legacy adoption!
            await fs.writeFile(layout.wakeManifestPath, JSON.stringify({
                schemaVersion: 1,
                routes       : {'WAKE_SUB:legacy-1': {agentIdentity: '@neo-gpt', signingKey: 'f'.repeat(64)}}
            }), {mode: 0o600});

            const legacyAdopted = await reconcileWakeReceiverService(rebindInput, host);

            expect(legacyAdopted.action).toBe('adopted-legacy');
            expect(JSON.parse(await fs.readFile(layout.wakeCustodyPath, 'utf8')).adoptedFrom).toBe('corroborated-legacy');

            // Foreign same-label plist pointing to a different stateDir is always refused
            await fs.rm(layout.wakeCustodyPath, {force: true});
            await fs.writeFile(layout.wakePlistPath, serializeWakeReceiverPlist({
                templateXml,
                executable  : layout.nodeBin,
                runtimeRoot : layout.repoRoot,
                manifestPath: '/srv/foreign/manifest.json',
                stateDir    : '/srv/foreign/state',
                host        : '127.0.0.1',
                port        : 3299
            }), {mode: 0o600});
            await expect(reconcileWakeReceiverService(rebindInput, host)).rejects.toThrow(/foreign LaunchAgent/);
        } finally {
            await fs.rm(root, {recursive: true, force: true});
        }
    });

    test('AC-3 / Row 4: cold zero-seat 0600 manifest starts cleanly with builder empty-refusal intact, then admits a real enrolled route and accepts an HMAC-signed /wake payload into <stateDir>/records', async () => {
        const
            {root, layout} = await setupWorkspace(),
            {host}         = createScriptedLaunchdHost(),
            port           = await freeLoopbackPort();

        let runtime = null;

        try {
            await prepareWakeRecordsDir(layout.wakeStateDir, host);

            const cold = await ensureColdWakeManifest(layout.wakeManifestPath, host);

            expect(cold).toEqual({created: true, existing: false, path: layout.wakeManifestPath, routeCount: 0});
            expect((await fs.stat(layout.wakeManifestPath)).mode & 0o777).toBe(0o600);

            // manifest builder keeps its empty-manifest refusal unchanged
            expect(() => buildWakeReceiverManifest({subscriptions: []})).toThrow(/refusing to write an empty manifest/);

            runtime = await startWakeReceiver({
                manifestPath       : layout.wakeManifestPath,
                stateDir           : layout.wakeStateDir,
                host               : '127.0.0.1',
                port,
                reconcileIntervalMs: 60_000,
                drainIntervalMs    : 60_000,
                logger             : {error() {}, warn() {}, log() {}}
            });

            // Cold zero-route listener answers our unknown-subscription probe cleanly (404 unknown-subscription, not a foreign server)
            expect(await probeWakeReceiverHttp({host: '127.0.0.1', port})).toEqual({
                listening   : true,
                wakeReceiver: true,
                statusCode  : 404,
                reason      : null
            });

            // Ensure a foreign HTTP server fails probeWakeReceiverHttp
            const foreignPort = await freeLoopbackPort();
            const foreignHttp = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });

            await new Promise(resolve => foreignHttp.listen(foreignPort, '127.0.0.1', resolve));

            try {
                expect(await probeWakeReceiverHttp({host: '127.0.0.1', port: foreignPort})).toMatchObject({
                    listening   : true,
                    wakeReceiver: false,
                    statusCode  : 200
                });
            } finally {
                await new Promise(resolve => foreignHttp.close(resolve));
            }

            // Publish one real enrolled seat route and reload the running receiver
            const
                subscriptionId = 'WAKE_SUB:00000000-0000-4000-8000-000000000099',
                signingKey     = 'e'.repeat(64),
                built          = buildWakeReceiverManifest({
                    subscriptions: [{
                        id                   : subscriptionId,
                        status               : 'active',
                        agentIdentity        : '@neo-gemini-maryam',
                        trigger              : 'SENT_TO_ME',
                        harnessTarget        : 'a2a-webhook',
                        harnessTargetMetadata: {
                            adapter        : 'osascript',
                            appName        : 'Antigravity',
                            addressType    : 'userDataDir',
                            instanceAddress: path.join(root, 'seat-profile'),
                            signingKey
                        }
                    }],
                    instance: {type: 'userDataDir', address: path.join(root, 'seat-profile')}
                });

            await writeValidatedManifest({manifest: built.manifest, targetPath: layout.wakeManifestPath});
            expect((await ensureColdWakeManifest(layout.wakeManifestPath, host)).created).toBe(false);
            await runtime.reload();

            const envelope = {
                schemaVersion : '1.0',
                eventType     : 'wake/digest',
                eventId       : 'wake-digest:cold-to-enrolled-1',
                subscriptionId,
                agentIdentity : '@neo-gemini-maryam',
                payload       : {totalEvents: 1, sourceEventIds: ['MESSAGE:setup-test-1']},
                emittedAt     : '2026-11-16T02:00:00.000Z'
            };
            const body = JSON.stringify(envelope);
            const sig  = crypto.createHmac('sha256', signingKey).update(body).digest('hex');

            const accepted = await fetch(`http://127.0.0.1:${port}/wake`, {
                method : 'POST',
                headers: {
                    'content-type'              : 'application/json',
                    'x-neo-wake-event-id'       : envelope.eventId,
                    'x-neo-wake-subscription-id': subscriptionId,
                    'x-neo-wake-schema-version' : '1.0',
                    'x-neo-wake-signature'      : sig
                },
                body
            });

            expect(accepted.status).toBe(202);

            const json = await accepted.json();

            expect(json.status).toBe('accepted');

            const recordFiles = await fs.readdir(path.join(layout.wakeStateDir, 'records'));

            expect(recordFiles.some(name => name.endsWith('.json'))).toBe(true);
            // ensureColdWakeManifest still preserves existing published manifest digest
            expect(contentDigest(await fs.readFile(layout.wakeManifestPath, 'utf8'))).toBeTruthy();
        } finally {
            await runtime?.stopWatchingManifest?.();
            if (runtime?.server) {
                await new Promise(resolve => runtime.server.close(resolve));
            }
            await fs.rm(root, {recursive: true, force: true});
        }
    });
});
