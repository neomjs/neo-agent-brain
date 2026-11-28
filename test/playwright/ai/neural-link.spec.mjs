import {test, expect}         from '@playwright/test';
import {Client}               from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile}             from 'node:fs/promises';
import {createServer}         from 'node:http';
import path                   from 'node:path';
import {resolveFreePortSync}  from '../resolveFreePort.mjs';

const brainRoot  = path.resolve(import.meta.dirname, '../../..'),
      engineRoot = process.env.NEO_TEST_ENGINE_ROOT,
      engineTest = engineRoot ? test : test.skip,
      serverPath = path.join(brainRoot, 'ai/mcp/server/neural-link/mcp-server.mjs'),
      configPath = path.join(brainRoot, 'test/playwright/configTemplateResolver.mjs'),
      helixApp   = 'Neo.examples.component.helix',
      helixPath  = '/examples/component/helix',
      mediaTypes = {
          '.css' : 'text/css',
          '.html': 'text/html',
          '.json': 'application/json',
          '.mjs' : 'text/javascript'
      };

/**
 * @summary Serves a built Engine checkout for the opted-in public MCP replay witness.
 * @param {String} directory Absolute Engine root.
 * @returns {Promise<import('node:http').Server>}
 */
async function serveEngine(directory) {
    const server = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname,
              filename = path.resolve(directory, `.${pathname}`);

        if (!filename.startsWith(`${directory}${path.sep}`)) {
            response.writeHead(404).end();
            return
        }

        try {
            const body = await readFile(filename);
            response.writeHead(200, {'Content-Type': mediaTypes[path.extname(filename)] ?? 'application/octet-stream'}).end(body)
        } catch {
            response.writeHead(404).end()
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve)
    });

    return server
}

/**
 * @summary Opens a real public stdio MCP client on the test's disposable Bridge port.
 * @param {Number} port Local Bridge port.
 * @param {String} name MCP client name.
 * @returns {Promise<Object>}
 */
async function connectMcp(port, name) {
    const client    = new Client({name, version: '1.0.0'}),
          transport = new StdioClientTransport({
              args   : ['--import', configPath, serverPath, '--cwd', brainRoot],
              command: process.execPath,
              cwd    : brainRoot,
              env    : {
                  NEO_NL_ACTION_LOGGING: 'false',
                  NEO_NL_AUTO_CONNECT  : 'false',
                  NEO_NL_PORT          : String(port)
              }
          });

    await client.connect(transport);
    return {client, call: (name, args = {}) => client.callTool({name, arguments: args})}
}

/**
 * @summary Verifies that a real Engine refusal stays typed across public MCP.
 * @param {Object} result MCP tool result.
 * @param {String} provider Requested provider.
 * @param {String} code Expected Engine error code.
 */
function expectReplayRefusal(result, provider, code) {
    expect(result).toMatchObject({
        isError: true,
        structuredContent: {
            error  : 'Gesture replay failed',
            receipt: {error: {code}, observationAvailable: true, observed: [], provider, success: false, terminal: 'none', trusted: null}
        }
    })
}

/**
 * @summary Holds a contact through a separate MCP writer and observes cancellation on its departure.
 * @param {Object} options Writer port, live touch input reader, target and contender call.
 * @returns {Promise<Object[]>}
 */
async function proveWriterDeparture({args, at, call, input, port}) {
    const owner = await connectMcp(port, 'gesture-owner-test'),
          down  = {type: 'touchstart', trusted: false};

    try {
        expect(await owner.call('manage_connection', {action: 'start'})).toMatchObject({isError: false});

        const ownerHealth = (await owner.call('healthcheck')).structuredContent,
              peerHealth  = (await call('healthcheck')).structuredContent;

        expect(ownerHealth.bridge.agentId).not.toBe(peerHealth.bridge.agentId);

        const {frames, ...target} = args,
              held = owner.call('drive_gesture', {...target, preset: {kind: 'hold', at, durationMs: 15000}});

        // A departing client cannot receive the result of its interrupted call.
        void held.catch(() => {});
        await expect.poll(input).toEqual([down]);
        expectReplayRefusal(await call('drive_gesture', args), 'engine', 'GESTURE_WRITE_DENIED');
        expect(await input()).toEqual([down]);
        await owner.client.close();

        const contacts = [down, {type: 'touchcancel', trusted: false}];
        await expect.poll(input).toEqual(contacts);
        return contacts
    } finally {
        await owner.client.close()
    }
}

test.describe('Neural Link MCP', () => {
    let port, publicMcp;

    test.use({hasTouch: true, serviceWorkers: 'block', viewport: {width: 1280, height: 800}});

    test.beforeAll(async () => {
        port      = resolveFreePortSync();
        publicMcp = await connectMcp(port, 'gesture-public-test');

        const start = await publicMcp.call('manage_connection', {action: 'start'});
        expect(start).toMatchObject({isError: false, structuredContent: {message: expect.stringContaining('started and connected')}})
    });

    test.afterAll(async () => {
        if (publicMcp) {
            try {
                await publicMcp.call('manage_connection', {action: 'stop'})
            } finally {
                await publicMcp.client.close()
            }
        }
    });

    test('advertises the public gesture tool and its provider limits', async () => {
        const {tools} = await publicMcp.client.listTools();

        expect(tools.find(tool => tool.name === 'drive_gesture')).toMatchObject({
            inputSchema: {required: expect.arrayContaining(['provider', 'sessionId', 'target', 'windowId'])}
        });

        const handbook = await publicMcp.call('get_mcp_tool_handbook', {toolId: 'drive_gesture'});

        expect(handbook).toMatchObject({
            isError: false,
            structuredContent: {found: true, toolId: 'drive_gesture'}
        });
        expect(handbook.structuredContent.handbook).toContain('BROWSER_PROVIDER_UNAVAILABLE');

        const coldTree = await publicMcp.call('get_component_tree');
        expect(coldTree).toMatchObject({
            isError: true,
            content: [expect.objectContaining({text: expect.stringMatching(/session/i)})]
        })
    });

    // Run with NEO_TEST_ENGINE_ROOT=/absolute/engine npx playwright test test/playwright/ai/neural-link.spec.mjs --workers=1.
    engineTest('replays staggered lift, cancellation and restart through public MCP on Helix', async ({page}) => {
        test.setTimeout(45000);

        const server = await serveEngine(path.resolve(engineRoot));

        try {
            const {call} = publicMcp;

            await page.route(`**${helixPath}/neo-config.json`, async route => {
                const response = await route.fetch();
                await route.fulfill({
                    response,
                    json: {
                        ...await response.json(),
                        neuralLinkUrl   : `ws://127.0.0.1:${port}`,
                        useAiClient     : true,
                        useServiceWorker: false
                    }
                })
            });
            await page.goto(`http://127.0.0.1:${server.address().port}${helixPath}/index.html`);

            const helix = page.locator('.neo-helix');
            await expect(helix.locator('.neo-helix-item').first()).toBeVisible();
            await expect.poll(async () => (await call('healthcheck')).structuredContent?.sessions?.map(({appName}) => appName))
                .toContain(helixApp);

            const {sessions} = (await call('healthcheck')).structuredContent,
                  {id: sessionId} = sessions.find(({appName}) => appName === helixApp),
                  located         = await call('query_component', {
                      returnProperties: ['mounted', 'windowId'],
                      selector        : {ntype: 'helix'},
                      sessionId
                  });

            expect(sessions).toHaveLength(1);
            expect(located).toMatchObject({
                isError: false,
                structuredContent: {components: [expect.objectContaining({
                    id: expect.any(String), properties: {mounted: true, windowId: expect.any(String)}
                })]}
            });

            const [{id: target, properties: {windowId}}] = located.structuredContent.components,
                  appWorker = page.workers().find(worker => worker.url().endsWith('/App.mjs'));

            await expect.poll(() => appWorker.evaluate(id => {
                const component = Neo.getComponent(id);
                return component?.mounted && component[Symbol.for('lockWheel')] === false
            }, target)).toBe(true);

            // Start inside the range controls' bounds so the real geometry has room to move.
            await appWorker.evaluate(async id => {
                const component = Neo.getComponent(id);
                component.set({rotationAngle: 0, translateZ: -1500});
                await component.refresh()
            }, target);

            const geometry = () => appWorker.evaluate(id => {
                      const {rotationAngle, translateZ, mouseWheelDeltaX} = Neo.getComponent(id);
                      return {rotationAngle, translateZ, mouseWheelDeltaX}
                  }, target),
                  initial         = await geometry(),
                  {width, height} = await helix.boundingBox(),
                  contact         = (id, x, y) => ({id, x: Math.round(width * x), y: Math.round(height * y)}),
                  frame           = (t, state, point) => ({t, contacts: [{...point, state}]}),
                  a               = contact('A', 0.35, 0.5),
                  b               = contact('B', 0.55, 0.55),
                  c               = contact('C', 0.42, 0.53),
                  movedA          = {...a, x: a.x + 16},
                  movedC          = {...c, x: c.x + 28},
                  frames          = [
                      frame(0, 'down', a),    frame(20, 'down', b),
                      frame(40, 'up', b),     frame(60, 'move', movedA),
                      frame(80, 'cancel', movedA),
                      frame(100, 'down', c),  frame(120, 'move', movedC),
                      frame(140, 'up', movedC)
                  ],
                  args = {frames, provider: 'engine', sessionId, target, windowId};

            await helix.evaluate(node => {
                window.replayedHelixContacts = [];

                for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
                    document.addEventListener(type, event => {
                        if (node.contains(event.target)) {
                            window.replayedHelixContacts.push({type, trusted: event.isTrusted})
                        }
                    }, {capture: true, passive: true})
                }
            });
            const input = () => page.evaluate(() => window.replayedHelixContacts);

            for (const [request, code] of [
                [{...args, provider: 'browser'}, 'BROWSER_PROVIDER_UNAVAILABLE'],
                [{...args, frames: [frame(0, 'move', a)]}, 'INVALID_GESTURE_TRACE']
            ]) {
                expectReplayRefusal(await call('drive_gesture', request), request.provider, code);
                expect(await input()).toEqual([]);
                expect(await geometry()).toEqual(initial)
            }

            const noSession = await call('drive_gesture', {...args, sessionId: ''});
            expect(noSession).toMatchObject({
                isError: true,
                content: [expect.objectContaining({text: expect.stringContaining('An explicit App Worker sessionId is required')})]
            });
            expect(await input()).toEqual([]);
            expect(await geometry()).toEqual(initial);

            const {x, y} = a,
                  departingContacts = await proveWriterDeparture({args, at: {x, y}, call, input, port});
            expect(await geometry()).toEqual(initial);

            let result;
            await expect.poll(async () => {
                result = await call('drive_gesture', args);
                if (result.isError) expectReplayRefusal(result, 'engine', 'GESTURE_WRITE_DENIED');
                return result.isError
            }).toBe(false);
            expect(result).toMatchObject({
                isError: false,
                structuredContent: {
                    observationAvailable: true, provider: 'engine', sequences: ['cancel', 'end'],
                    success: true, terminal: 'end', trusted: false
                }
            });

            const events = result.structuredContent.observed.flatMap(({events}) => events);
            expect(events.map(({type, active, changed}) => [type, active.map(({id}) => id), changed.map(({id}) => id)])).toEqual([
                ['touchstart', ['A'], ['A']],
                ['touchstart', ['A', 'B'], ['B']],
                ['touchend', ['A'], ['B']],
                ['touchmove', ['A'], ['A']],
                ['touchcancel', [], ['A']],
                ['touchstart', ['C'], ['C']],
                ['touchmove', ['C'], ['C']],
                ['touchend', [], ['C']]
            ]);
            expect(await input()).toEqual([...departingContacts, ...events.map(({type}) => ({type, trusted: false}))]);

            const gain       = 1.5 * initial.mouseWheelDeltaX,
                  freshAngle = initial.rotationAngle + 28 * gain;

            await expect.poll(async () => (await geometry()).rotationAngle).toBeGreaterThanOrEqual(freshAngle);

            const final = await geometry();
            expect([freshAngle, freshAngle + 16 * gain]).toContain(final.rotationAngle);
            expect(final.translateZ).toBe(initial.translateZ);

            const durationMs = 10250,
                  longHold   = await call('drive_gesture', {
                      provider: 'engine', sessionId, target, windowId,
                      preset: {kind: 'hold', at: {x, y}, durationMs}
                  });

            expect(longHold).toMatchObject({
                isError: false,
                structuredContent: {provider: 'engine', success: true, terminal: 'end', sequences: ['end'], trusted: false}
            });

            const held = longHold.structuredContent.observed.flatMap(({events}) => events);
            expect(held.map(({type}) => type)).toEqual(['touchstart', 'touchend']);
            expect(held[1].elapsedMs - held[0].elapsedMs).toBeGreaterThanOrEqual(durationMs - 20);
            expect(await geometry()).toEqual(final)
        } finally {
            await page.close();
            await new Promise(resolve => server.close(resolve))
        }
    });
});
