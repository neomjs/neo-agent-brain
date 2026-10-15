import {EventEmitter}             from 'node:events';
import {constants as fsConstants} from 'node:fs';
import {pathToFileURL}            from 'node:url';
import {expect, test}             from '@playwright/test';
import {
    AntigravityProjectBindingRefusal,
    bindAntigravityProject,
    proveRegisteredAntigravityProject,
    readAntigravityProjectRecord
} from '../../../../../../ai/services/fleet/antigravityProjectBinding.mjs';
import {classifyAntigravityRuntimeFingerprint} from '../../../../../../ai/services/fleet/probeAntigravityRuntime.mjs';

const
    PROFILE  = '/private/tmp/antigravity-project-binding/profile',
    PORTFILE = `${PROFILE}/DevToolsActivePort`,
    BROWSER  = '/devtools/browser/01234567-89ab-cdef-0123-456789abcdef',
    PROJECT  = {id: 'project-a', name: 'Neo Brain', root: '/private/tmp/antigravity-project-binding/repo'},
    OWNER    = {pid: 4321, startedAt: '2026-10-14T09:00:00.000Z'},
    PRODUCT  = 'Chrome/128.0.0.0';

const
    projectUri    = pathToFileURL(PROJECT.root).href,
    projectRecord = {id: PROJECT.id, name: PROJECT.name, folderUris: [projectUri]};

/** @summary A hermetic DevTools peer that answers only the CDP methods exercised by the binding. */
class FakeWebSocket extends EventEmitter {
    static OPEN = 1;

    constructor(url, behavior) {
        super();
        this.url       = url;
        this.behavior  = behavior;
        this.readyState = 0;
        this.commands  = [];
        this.closed    = false;
        this.currentUrl = behavior.pageUrl ?? 'https://127.0.0.1:4567/';
        behavior.sockets.push(this);
        queueMicrotask(() => {
            if (behavior.neverOpen) {
                behavior.abortBeforeOpenController?.abort();
                return
            }
            this.readyState = FakeWebSocket.OPEN;
            this.emit('open')
        })
    }

    send(raw) {
        const message = JSON.parse(raw);
        this.commands.push(message);

        if (this.behavior.abortOn === message.method) {
            this.behavior.abortController.abort();
            return
        }
        if (this.behavior.noResponseOn === message.method) return;

        let result = {};
        switch (message.method) {
            case 'Browser.getVersion':
                result = {product: this.behavior.product ?? PRODUCT};
                break;
            case 'Target.getTargets':
                this.behavior.targetReadCount = (this.behavior.targetReadCount ?? 0) + 1;
                result = {targetInfos: this.behavior.targetReadCount <= (this.behavior.rendererUnpublishedReads ?? 0)
                    ? []
                    : this.behavior.targets ?? [{targetId: 'page-a', type: 'page', url: this.currentUrl}]};
                break;
            case 'Target.attachToTarget':
                result = {sessionId: 'session-a'};
                break;
            case 'Page.navigate':
                if (this.behavior.navigationError) {
                    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
                        id       : message.id,
                        sessionId: message.sessionId,
                        error    : {message: 'navigation refused'}
                    }))));
                    return
                }
                this.currentUrl = this.behavior.observedUrl ?? message.params.url;
                break;
            case 'Page.getFrameTree':
                result = {frameTree: {frame: {url: this.currentUrl}}};
                break;
            case 'Accessibility.getFullAXTree':
                result = {nodes: this.behavior.axNodes ?? [{
                    ignored: false,
                    role   : {value: 'button'},
                    name   : {value: this.behavior.marker ?? `Select project, current: ${PROJECT.name}`}
                }]};
                if (this.behavior.urlAfterMarker) this.currentUrl = this.behavior.urlAfterMarker;
                break;
        }

        queueMicrotask(() => {
            this.emit('message', Buffer.from(JSON.stringify({id: message.id, sessionId: message.sessionId, result})));
            if (message.method === 'Page.navigate' && !this.behavior.suppressLoadEvent) {
                this.emit('message', Buffer.from(JSON.stringify({
                    method   : 'Page.loadEventFired',
                    sessionId: message.sessionId,
                    params   : {timestamp: 1}
                })))
            }
        })
    }

    close() {
        this.closed = true;
        this.readyState = 3;
        this.emit('close')
    }

    terminate() {
        this.closed = true;
        this.readyState = 3;
        this.emit('close')
    }
}

/** @summary Bind fake profile/filesystem inputs to the same strict proof callback shape as Start. */
function harness(options = {}) {
    const behavior   = {sockets: [], ...options.behavior};
    const observed   = {portStatReads:0, portReads:0, listenerChecks:0, listenerOwners:[]};
    const fileSystem = {
        lstat: async file => file === PROFILE
            ? {isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false}
            : file === PROJECT.root
                ? {isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false}
            : file === PORTFILE
                ? (() => {
                    observed.portStatReads++;
                    if (observed.portStatReads <= (options.portFileMissingReads ?? 0)) {
                        options.abortOnPortStat?.abort();
                        throw Object.assign(new Error('not ready'), {code:'ENOENT'})
                    }
                    return {isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false}
                })()
            : Object.assign(new Error('missing fixture'), {code: 'ENOENT'}),
        realpath: async file => file === PROFILE || file === PROJECT.root
            ? file
            : Object.assign(new Error('missing fixture'), {code: 'ENOENT'}),
        readFile: async file => file === PORTFILE
            ? (observed.portReads++, options.activePortText ?? `9222\n${BROWSER}\n`)
            : Object.assign(new Error('missing fixture'), {code: 'ENOENT'})
    };
    const readRegisteredProject = options.readRegisteredProject ?? (async input => {
        expect(input.profileDirectory).toBe(PROFILE);
        expect(input.projectId).toBe(PROJECT.id);
        return projectRecord
    });
    const verifyProfileListener = options.verifyProfileListener ?? (async input => {
        observed.listenerChecks++;
        observed.listenerOwners.push(input.expectedProcess);
        return observed.listenerChecks <= (options.listenerUnreadyReads ?? 0)
            ? {verified:false}
            : {
                verified           : true,
                processTreeVerified: true,
                profileDirectory   : input.profileDirectory,
                port               : input.port,
                browserPath        : input.browserPath,
                pid                : input.expectedProcess.pid,
                startedAt          : input.expectedProcess.startedAt
            }
    });
    const verifyNativeCapability = options.verifyNativeCapability ?? (async input => ({
        verified         : true,
        projectId        : input.project.id,
        projectName      : input.project.name,
        projectRoot      : input.project.root,
        browserProduct   : input.browserProduct,
        capabilityVersion: '2.23-section-route'
    }));

    return {
        behavior,
        observed,
        run: overrides => bindAntigravityProject({
            profileDirectory: PROFILE,
            project         : PROJECT,
            expectedProcess : OWNER,
            readRegisteredProject,
            verifyProfileListener,
            verifyNativeCapability,
            fileSystem,
            WebSocketCtor   : class extends FakeWebSocket {
                constructor(url) { super(url, behavior) }
            },
            timeoutMs: 500,
            ...overrides
        })
    }
}

test.describe('bindAntigravityProject', () => {
    test('reads only the profile endpoint, proves ownership/capability, routes one renderer and confirms its native marker', async () => {
        const fixture = harness(), result = await fixture.run(), socket = fixture.behavior.sockets[0];

        expect(result).toEqual({
            browserProduct        : PRODUCT,
            capabilityVersion     : '2.23-section-route',
            projectId             : PROJECT.id,
            projectRoot           : PROJECT.root,
            registeredProjectProof: {
                verified        : true,
                profileDirectory: PROFILE,
                projectId       : PROJECT.id,
                projectName     : PROJECT.name,
                projectRoot     : PROJECT.root
            },
            rendererUrl: 'https://127.0.0.1:4567/?section=project-a'
        });
        expect(socket.url).toBe(`ws://127.0.0.1:9222${BROWSER}`);
        expect(socket.commands.find(({method}) => method === 'Page.navigate')?.params.url)
            .toBe('https://127.0.0.1:4567/?section=project-a');
        expect(socket.closed).toBe(true)
    });

    test('requires both lifecycle ownership and native capability verifiers', async () => {
        const fixture = harness();

        await expect(fixture.run({verifyProfileListener: undefined})).rejects.toMatchObject({code: 'verifier-required'});
        await expect(fixture.run({verifyNativeCapability: undefined})).rejects.toMatchObject({code: 'verifier-required'});
        expect(fixture.behavior.sockets).toHaveLength(0)
    });

    test('rejects a stale or malformed profile endpoint before opening a socket', async () => {
        const fixture = harness({activePortText: 'not-a-port\n/devtools/page/not-a-browser\n'});

        await expect(fixture.run()).rejects.toMatchObject({code: 'stale-endpoint'});
        expect(fixture.behavior.sockets).toHaveLength(0)
    });

    test('waits for the profile endpoint, its original Start listener, and the unique app renderer', async () => {
        const fixture = harness({
            portFileMissingReads:2,
            listenerUnreadyReads:2,
            readRegisteredProject:async () => projectRecord,
            behavior:{rendererUnpublishedReads:3}
        });

        const result = await fixture.run({timeoutMs:2500});

        expect(result.projectId).toBe(PROJECT.id);
        expect(fixture.observed.portStatReads).toBeGreaterThan(2);
        expect(fixture.observed.portReads).toBeGreaterThan(0);
        expect(fixture.observed.listenerChecks).toBe(3);
        expect(fixture.observed.listenerOwners.length).toBe(3);
        expect(fixture.observed.listenerOwners.every(owner => owner.pid === OWNER.pid && owner.startedAt === OWNER.startedAt)).toBe(true);
        expect(fixture.behavior.targetReadCount).toBe(4)
    });

    test('keeps a missing profile endpoint within the bounded Start timeout', async () => {
        const fixture = harness({portFileMissingReads:100});

        await expect(fixture.run({timeoutMs:180})).rejects.toMatchObject({code:'stale-endpoint'});
        expect(fixture.observed.listenerChecks).toBe(0);
        expect(fixture.behavior.sockets).toHaveLength(0)
    });

    test('reports the last observed refusal when the deadline lands on the final inter-poll sleep or an in-flight poll step', async () => {
        const makeFinalSleepClock = isSecondPollComplete => {
            let sleepStartedAt = null;

            return () => {
                if (!isSecondPollComplete()) return 1_000;
                if (sleepStartedAt === null) {
                    sleepStartedAt = Date.now();
                    return 1_160
                }
                // A synchronous second read (such as a competing deadline timer) sees 15 ms remaining
                // against the 20 ms sleep; once the sleep timer fires, the clock reaches the 1_180 deadline.
                return Date.now() - sleepStartedAt < 10 ? 1_165 : 1_180
            }
        };

        const missingPort = harness({portFileMissingReads: 10});

        await expect(missingPort.run({
            timeoutMs: 180,
            now      : makeFinalSleepClock(() => missingPort.observed.portStatReads >= 2)
        })).rejects.toMatchObject({code: 'stale-endpoint'});
        expect(missingPort.observed.portStatReads).toBe(2);

        const unreadyListener = harness({listenerUnreadyReads: 10});

        await expect(unreadyListener.run({
            timeoutMs: 180,
            now      : makeFinalSleepClock(() => unreadyListener.observed.listenerChecks >= 2)
        })).rejects.toMatchObject({code: 'listener-unproven'});
        expect(unreadyListener.observed.listenerChecks).toBe(2);

        let   inFlightClock = 1_000;
        const stuckStep     = harness({
            verifyProfileListener: async () => {
                if (stuckStep.observed.portReads === 1) return {verified: false};
                inFlightClock = 1_180;
                return new Promise(() => {})
            }
        });

        await expect(stuckStep.run({
            timeoutMs: 180,
            now      : () => inFlightClock
        })).rejects.toMatchObject({code: 'listener-unproven'})
    });

    test('Start cancellation during profile readiness or the inter-poll sleep stops polling before a socket is opened', async () => {
        const controller = new AbortController(),
              fixture    = harness({portFileMissingReads:10, abortOnPortStat:controller});

        await expect(fixture.run({signal:controller.signal, timeoutMs:1000})).rejects.toMatchObject({code:'canceled'});
        expect(fixture.observed.portStatReads).toBe(1);
        expect(fixture.behavior.sockets).toHaveLength(0);

        const sleepAbortController = new AbortController(),
              sleepFixture         = harness({
                  portFileMissingReads : 10,
                  verifyProfileListener: async () => {
                      setTimeout(() => sleepAbortController.abort(), 10);
                      return {verified: false}
                  }
              });
        sleepFixture.observed.portStatReads = 10;

        await expect(sleepFixture.run({signal: sleepAbortController.signal, timeoutMs: 1000}))
            .rejects.toMatchObject({code: 'canceled'});
        expect(sleepFixture.observed.portReads).toBe(1);
        expect(sleepFixture.behavior.sockets).toHaveLength(0)
    });

    test('rejects a listener whose PID does not match the lifecycle-owned process birth', async () => {
        const fixture = harness({verifyProfileListener: async input => ({
            verified        : true, processTreeVerified: true,
            profileDirectory: input.profileDirectory, port: input.port, browserPath: input.browserPath,
            pid             : input.expectedProcess.pid + 1, startedAt: input.expectedProcess.startedAt
        })});

        await expect(fixture.run()).rejects.toMatchObject({code: 'listener-pid-mismatch'});
        expect(fixture.behavior.sockets).toHaveLength(0)
    });

    test('rejects an endpoint receipt for another browser id even when its port matches', async () => {
        const fixture = harness({verifyProfileListener: async input => ({
            verified        : true, processTreeVerified: true,
            profileDirectory: input.profileDirectory, port: input.port,
            browserPath     : '/devtools/browser/another-browser',
            pid             : input.expectedProcess.pid, startedAt: input.expectedProcess.startedAt
        })});

        await expect(fixture.run()).rejects.toMatchObject({code: 'stale-endpoint'});
        expect(fixture.behavior.sockets).toHaveLength(0)
    });

    test('rejects a runtime that changed during Start before attaching or navigating', async () => {
        const fixture = harness({verifyNativeCapability: async () => ({verified: false, reason: 'runtime-changed-during-start'})});

        await expect(fixture.run()).rejects.toMatchObject({code: 'runtime-changed-during-start'});
        expect(fixture.behavior.sockets[0].commands.some(({method}) => method === 'Target.attachToTarget' || method === 'Page.navigate')).toBe(false)
    });

    test('rejects project metadata that no longer binds the id to the registered repository root', async () => {
        const fixture = harness({verifyNativeCapability: async input => ({
            verified         : true,
            projectId        : input.project.id,
            projectName      : input.project.name,
            projectRoot      : '/private/tmp/another-repository',
            browserProduct   : input.browserProduct,
            capabilityVersion: '2.23-section-route'
        })});

        await expect(fixture.run()).rejects.toMatchObject({code: 'native-capability-unproven'});
        expect(fixture.behavior.sockets[0].commands.some(({method}) => method === 'Target.attachToTarget' || method === 'Page.navigate')).toBe(false)
    });

    test('rejects a non-loopback renderer rather than attaching to another page', async () => {
        const fixture = harness({behavior: {targets: [{targetId: 'foreign', type: 'page', url: 'https://example.test/'}]}});

        await expect(fixture.run()).rejects.toMatchObject({code: 'renderer-unproven'});
        expect(fixture.behavior.sockets[0].commands.some(({method}) => method === 'Target.attachToTarget')).toBe(false)
    });

    test('refuses an ambiguous renderer set instead of choosing the first page', async () => {
        const fixture = harness({behavior: {targets: [
            {targetId: 'page-a', type: 'page', url: 'https://127.0.0.1:4567/'},
            {targetId: 'page-b', type: 'page', url: 'https://127.0.0.1:4568/'}
        ]}});

        await expect(fixture.run()).rejects.toMatchObject({code: 'renderer-ambiguous'});
        expect(fixture.behavior.sockets[0].commands.some(({method}) => method === 'Target.attachToTarget')).toBe(false)
    });

    test('cancellation during target discovery closes the socket and refuses the operation', async () => {
        const controller = new AbortController(),
              fixture    = harness({behavior: {abortOn: 'Target.getTargets', abortController: controller}});

        await expect(fixture.run({signal: controller.signal})).rejects.toBeInstanceOf(AntigravityProjectBindingRefusal);
        await expect(fixture.run({signal: AbortSignal.abort()})).rejects.toMatchObject({code: 'canceled'});
        expect(fixture.behavior.sockets[0].closed).toBe(true)
    });

    test('cancellation before socket open terminates the client and clears all listeners', async () => {
        const controller = new AbortController(),
              fixture    = harness({behavior: {neverOpen: true, abortBeforeOpenController: controller}});

        await expect(fixture.run({signal: controller.signal})).rejects.toMatchObject({code: 'canceled'});

        const socket = fixture.behavior.sockets[0];
        expect(socket.closed).toBe(true);
        expect(['open', 'error', 'close', 'message'].map(event => socket.listenerCount(event))).toEqual([0, 0, 0, 0])
    });

    test('navigation error settles and cleans the load waiter without an unhandled rejection', async () => {
        const fixture = harness({behavior: {navigationError: true}});

        await expect(fixture.run()).rejects.toMatchObject({code: 'route-refused'});
        const socket = fixture.behavior.sockets[0];
        expect(socket.closed).toBe(true);
        expect(socket.listenerCount('message')).toBe(0)
    });

    test('project selector proof ignores hidden nodes and rejects duplicate visible selectors', async () => {
        const hidden = harness({behavior: {axNodes: [{
            ignored: true, role: {value: 'button'}, name: {value: `Select project, current: ${PROJECT.name}`}
        }]}}),
              duplicate = harness({behavior: {axNodes: [0, 1].map(() => ({
                  ignored: false, role: {value: 'combobox'}, name: {value: `Select project, current: ${PROJECT.name}`}
              }))}});

        await expect(hidden.run({timeoutMs: 150})).rejects.toMatchObject({code: 'marker-mismatch'});
        await expect(duplicate.run()).rejects.toMatchObject({code: 'marker-ambiguous'});
    });

    test('rechecks the main frame route after the project marker appears', async () => {
        const fixture = harness({behavior: {urlAfterMarker: 'https://127.0.0.1:4567/?section=other'}});

        await expect(fixture.run()).rejects.toMatchObject({code: 'route-mismatch'});
    });

    test('an accepted future build still refuses route mismatch and a missing project-selector marker', async () => {
        const runtime = classifyAntigravityRuntimeFingerprint({
            platform     : 'darwin', architecture: 'arm64', bundleId: 'com.google.antigravity',
            shortVersion : '9.0.0', buildVersion: 'future-build',
            appAsarSha256: 'c'.repeat(64), languageServerSha256: 'd'.repeat(64)
        });
        expect(runtime).toEqual({available: true, reason: null});

        const verifyNativeCapability = async ({registeredProjectProof, browserProduct}) => ({
                  ...registeredProjectProof, verified: runtime.available, browserProduct, capabilityVersion: '9.0.0'
              }),
              wrongRoute = harness({verifyNativeCapability, behavior: {observedUrl: 'https://127.0.0.1:4567/?section=other'}}),
              wrongMarker = harness({verifyNativeCapability, behavior: {marker: 'Select project, current: Another Project'}});

        await expect(wrongRoute.run()).rejects.toMatchObject({code: 'route-mismatch'});
        await expect(wrongMarker.run({timeoutMs: 150})).rejects.toMatchObject({code: 'marker-mismatch'});
        expect(wrongMarker.behavior.sockets[0].closed).toBe(true)
    });
});

test.describe('proveRegisteredAntigravityProject', () => {
    const options = overrides => ({
        profileDirectory     : PROFILE,
        projectId            : PROJECT.id,
        projectName          : PROJECT.name,
        projectRoot          : PROJECT.root,
        readRegisteredProject: async () => projectRecord,
        fileSystem           : {
            lstat: async file => file === PROFILE || file === PROJECT.root
                ? {isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false}
                : Object.assign(new Error('missing fixture'), {code: 'ENOENT'}),
            realpath: async file => file === PROFILE || file === PROJECT.root
                ? file
                : Object.assign(new Error('missing fixture'), {code: 'ENOENT'})
        },
        timeoutMs: 500,
        ...overrides
    });

    test('binds the exact profile, project ID/name, and one real folder root', async () => {
        await expect(proveRegisteredAntigravityProject(options())).resolves.toEqual({
            verified        : true,
            profileDirectory: PROFILE,
            projectId       : PROJECT.id,
            projectName     : PROJECT.name,
            projectRoot     : PROJECT.root
        })
    });

    test('requires an injected registry reader and does not infer selection metadata', async () => {
        const fixture = options({readRegisteredProject: undefined});

        await expect(proveRegisteredAntigravityProject(fixture)).rejects.toMatchObject({code: 'project-registry-reader-required'})
    });

    test('rejects a different registered ID or display name', async () => {
        const wrongId   = options({readRegisteredProject: async () => ({...projectRecord, id: 'other'})}),
              wrongName = options({readRegisteredProject: async () => ({...projectRecord, name: 'Other'})});

        await expect(proveRegisteredAntigravityProject(wrongId)).rejects.toMatchObject({code: 'project-registry-mismatch'});
        await expect(proveRegisteredAntigravityProject(wrongName)).rejects.toMatchObject({code: 'project-registry-mismatch'})
    });

    test('rejects multiple folders and a folder URI outside the exact checkout', async () => {
        const multiple = options({readRegisteredProject: async () => ({...projectRecord, folderUris: [projectUri, 'file:///private/tmp/foreign']})}),
              foreign  = options({readRegisteredProject: async () => ({...projectRecord, folderUris: ['file:///private/tmp/foreign']})});

        await expect(proveRegisteredAntigravityProject(multiple)).rejects.toMatchObject({code: 'project-registry-mismatch'});
        await expect(proveRegisteredAntigravityProject(foreign)).rejects.toMatchObject({code: 'project-folder-mismatch'})
    });

    test('rejects a symlinked checkout root even when its real target is a directory', async () => {
        const fixture = options({fileSystem: {
            lstat: async file => file === PROFILE
                ? {isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false}
                : {isDirectory: () => true, isFile: () => false, isSymbolicLink: () => file === PROJECT.root},
            realpath: async file => file === PROFILE ? file : '/private/tmp/other-repository'
        }});

        await expect(proveRegisteredAntigravityProject(fixture)).rejects.toMatchObject({code: 'project-folder-unproven'})
    });

    test('reads only the explicit UUID project file and returns binding fields without touching grants/settings', async () => {
        const registryDirectory = '/private/tmp/antigravity-project-binding/profile/config/projects',
              projectId         = '154e7ad7-ab8c-4445-bd6b-9ac6bdddcd0f',
              document          = {
                  id              : projectId,
                  name            : PROJECT.name,
                  projectResources: {resources: [{gitFolder: {folderUri: projectUri}}]},
                  permissionGrants: {permissionGrants: {allow: ['mcp(sensitive-fixture/*)']}},
                  settings        : {opaque: true},
                  isWorkspaceOnly : false
              },
              opened = [],
              fileSystem = {
                  lstat: async file => file === registryDirectory
                      ? {isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false}
                      : Object.assign(new Error('missing fixture'), {code: 'ENOENT'}),
                  realpath: async file => file,
                  open    : async (file, flags) => {
                      opened.push({file, flags});
                      return {
                          stat    : async () => ({isFile: () => true, size: 512}),
                          readFile: async () => JSON.stringify(document),
                          close   : async () => {}
                      }
                  }
              };

        await expect(readAntigravityProjectRecord({registryDirectory, projectId, fileSystem})).resolves.toEqual({
            id        : projectId,
            name      : PROJECT.name,
            folderUris: [projectUri]
        });
        expect(opened).toHaveLength(1);
        expect(opened[0].file).toBe(`${registryDirectory}/${projectId}.json`);
        expect(opened[0].flags & fsConstants.O_NOFOLLOW).not.toBe(0)
    });

    test('refuses unsafe IDs and unknown or multiple native resource records', async () => {
        const registryDirectory = '/private/tmp/antigravity-project-binding/profile/config/projects',
              projectId         = '154e7ad7-ab8c-4445-bd6b-9ac6bdddcd0f',
              base              = {id: projectId, name: PROJECT.name, projectResources: {resources: [{folderUri: projectUri}]}},
              makeFs            = document => ({
                  lstat   : async () => ({isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false}),
                  realpath: async file => file,
                  open    : async () => ({
                      stat    : async () => ({isFile: () => true, size: 512}),
                      readFile: async () => JSON.stringify(document),
                      close   : async () => {}
                  })
              });

        await expect(readAntigravityProjectRecord({registryDirectory, projectId: '../foreign', fileSystem: makeFs(base)}))
            .rejects.toMatchObject({code: 'project-id-invalid'});
        await expect(readAntigravityProjectRecord({registryDirectory, projectId, fileSystem: makeFs({
            ...base, projectResources: {resources: [{unknownProvider: {folderUri: projectUri}}]}
        })})).rejects.toMatchObject({code: 'project-resource-unsupported'});
        await expect(readAntigravityProjectRecord({registryDirectory, projectId, fileSystem: makeFs({
            ...base, projectResources: {resources: [base.projectResources.resources[0], base.projectResources.resources[0]]}
        })})).rejects.toMatchObject({code: 'project-record-invalid'})
    });

    test('closes a registry descriptor that opens after timeout', async () => {
        const registryDirectory = '/private/tmp/antigravity-project-binding/profile/config/projects',
              projectId         = '154e7ad7-ab8c-4445-bd6b-9ac6bdddcd0f';
        let resolveOpen, closes = 0, stats = 0;
        const fileSystem = {
            lstat   : async () => ({isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false}),
            realpath: async file => file,
            open    : () => new Promise(resolve => {resolveOpen = resolve})
        };

        await expect(readAntigravityProjectRecord({registryDirectory, projectId, fileSystem, timeoutMs: 100}))
            .rejects.toMatchObject({code: 'timeout'});
        resolveOpen({
            stat    : async () => {stats++; return {isFile: () => true, size: 1}},
            readFile: async () => '{}',
            close   : async () => {closes++}
        });
        await new Promise(resolve => setImmediate(resolve));

        expect(stats).toBe(0);
        expect(closes).toBe(1)
    });
});
