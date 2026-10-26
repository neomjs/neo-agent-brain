import {test, expect}                                from '@playwright/test';
import {spawn}                                       from 'node:child_process';
import {EventEmitter, once}                          from 'node:events';
import fs                                            from 'node:fs';
import os                                            from 'node:os';
import path                                          from 'node:path';
import {fileURLToPath}                               from 'node:url';
import {WebSocketServer}                             from 'ws';
import {createBridgeInfoPayload}                     from '../../../../../../../ai/mcp/server/neural-link/BridgeProtocol.mjs';
import {launch, standalonePlacement, superviseChild} from '../../../../../../../ai/mcp/server/neural-link/standalone.mjs';

const
    STANDALONE_BIN = fileURLToPath(new URL('../../../../../../../ai/mcp/server/neural-link/standalone.mjs', import.meta.url)),
    MCP_SERVER_BIN = fileURLToPath(new URL('../../../../../../../ai/mcp/server/neural-link/mcp-server.mjs', import.meta.url)),
    REPO_ROOT      = path.resolve(path.dirname(STANDALONE_BIN), '../../../..');

/**
 * @summary Starts a loopback Bridge WebSocketServer that sends the freshness handshake and tracks connected agent sockets.
 * @returns {Promise<{close: Function, connections: Set<import('ws').WebSocket>, port: Number, server: WebSocketServer}>}
 */
async function startLoopbackBridge() {
    const
        connections = new Set(),
        server      = new WebSocketServer({host: '127.0.0.1', port: 0});

    server.on('connection', socket => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
        socket.send(JSON.stringify(createBridgeInfoPayload()))
    });

    await once(server, 'listening');

    return {
        connections,
        port: server.address().port,
        server,
        async close() {
            for (const socket of connections) {
                socket.terminate()
            }
            await new Promise(resolve => server.close(() => resolve()))
        }
    }
}

/**
 * The standalone launcher declares the plane's placement and the Bridge's `--cwd`; nothing else.
 * Both are checked through an injected spawn, so no process starts.
 */
test.describe('ai/mcp/server/neural-link/standalone', () => {
    test('the placement puts the plane and its one member beneath one per-user root', () => {
        expect(standalonePlacement({homedir: '/home/dev'})).toEqual({
            NEO_NL_LOG_PATH    : path.join('/home/dev', '.neo-ai', 'neural-link', 'logs'),
            NEO_PLANE_DATA_ROOT: path.join('/home/dev', '.neo-ai', 'neural-link')
        });
    });

    test('launch starts the packaged server with the package root as --cwd and the placement env', () => {
        const calls = [];

        launch({
            argv   : ['--debug'],
            env    : {NEO_NL_PORT: '18181', NEO_PLANE_DATA_ROOT: '/somewhere/else/.neo-ai-data', PATH: '/usr/bin'},
            homedir: '/home/dev',
            root   : '/pkg',
            spawnFn: (command, args, options) => {calls.push({args, command, options}); return {}}
        });

        expect(calls).toHaveLength(1);

        const [{args, command, options}] = calls;

        expect(command).toBe(process.execPath);
        expect(args).toEqual([path.join('/pkg', 'ai/mcp/server/neural-link/mcp-server.mjs'), '--cwd', '/pkg', '--debug']);
        expect(options.stdio).toBe('inherit');

        // The standalone plane is its own: another deployment's exported root cannot redirect it.
        expect(options.env.NEO_PLANE_DATA_ROOT).toBe(path.join('/home/dev', '.neo-ai', 'neural-link'));
        expect(options.env.NEO_NL_LOG_PATH).toBe(path.join('/home/dev', '.neo-ai', 'neural-link', 'logs'));
        // Everything else passes through, the Bridge port included.
        expect(options.env.NEO_NL_PORT).toBe('18181');
        expect(options.env.PATH).toBe('/usr/bin');
    });

    test('superviseChild forwards termination signals and kills the child when its parent process disappears (#1302)', async () => {
        const
            child   = new EventEmitter(),
            proc    = new EventEmitter(),
            signals = [],
            exits   = [];

        child.kill = signal => signals.push(signal);
        proc.ppid  = 4242;
        proc.kill  = () => true;
        proc.exit  = code => exits.push(code);

        const dispose = superviseChild(child, {pollIntervalMs: 20, proc});

        try {
            proc.emit('SIGTERM');
            expect(signals).toEqual(['SIGTERM']);

            // Reset with a fresh supervised child to test parent-orphan detection when `/bin/sh` dies without signaling.
            dispose();
            signals.length = 0;

            const orphanChild = new EventEmitter();
            orphanChild.kill  = signal => signals.push(signal);

            superviseChild(orphanChild, {pollIntervalMs: 20, proc});
            proc.ppid = 1;

            await expect.poll(() => signals.includes('SIGTERM'), {timeout: 500}).toBe(true);

            orphanChild.emit('exit', 0, null);
            expect(exits).toEqual([0]);
        } finally {
            dispose()
        }
    });

    test('closing the MCP server stdin ends the server process even while connected to a live Bridge (#1302)', async () => {
        const
            bridge  = await startLoopbackBridge(),
            homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-stdio-eof-')),
            child   = spawn(process.execPath, [MCP_SERVER_BIN, '--cwd', REPO_ROOT], {
                env: {
                    ...process.env,
                    ...standalonePlacement({homedir}),
                    NEO_NL_AUTO_CONNECT: 'true',
                    NEO_NL_PORT        : String(bridge.port),
                    UNIT_TEST_MODE     : 'true'
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });

        try {
            await expect.poll(() => bridge.connections.size, {timeout: 8000}).toBe(1);
            expect(child.exitCode).toBeNull();

            const exitPromise = once(child, 'exit');

            child.stdin.end();

            const [code] = await Promise.race([
                exitPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('MCP server did not exit after stdin closed')), 5000))
            ]);

            expect(code).toBe(0);
            await expect.poll(() => bridge.connections.size, {timeout: 2000}).toBe(0);
        } finally {
            try { child.kill('SIGKILL') } catch {}
            await bridge.close();
            fs.rmSync(homedir, {force: true, recursive: true})
        }
    });

    test('SIGTERM to the npx process ends both the standalone launcher and the MCP server process (#1302)', async () => {
        const
            bridge  = await startLoopbackBridge(),
            workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-npx-sigterm-')),
            binDir  = path.join(workDir, 'node_modules', '.bin'),
            npxCmd  = process.platform === 'win32' ? 'npx.cmd' : 'npx';

        fs.mkdirSync(binDir, {recursive: true});
        fs.symlinkSync(STANDALONE_BIN, path.join(binDir, 'neo-neural-link'));
        fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({name: 'nl-npx-consumer', private: true}));

        const npxChild = spawn(npxCmd, ['--no-install', 'neo-neural-link'], {
            cwd: workDir,
            env: {
                ...process.env,
                HOME               : workDir,
                NEO_NL_AUTO_CONNECT: 'true',
                NEO_NL_PORT        : String(bridge.port),
                UNIT_TEST_MODE     : 'true'
            },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        try {
            await expect.poll(() => bridge.connections.size, {timeout: 10000}).toBe(1);

            const
                [bridgeSocket] = [...bridge.connections],
                socketClosed   = once(bridgeSocket, 'close'),
                npxExited      = once(npxChild, 'exit');

            npxChild.kill('SIGTERM');

            await Promise.race([
                Promise.all([npxExited, socketClosed]),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('MCP server or npx launcher remained alive after SIGTERM to npx')),
                    5000
                ))
            ]);

            expect(bridge.connections.size, 'the MCP server process disconnected from the Bridge on exit').toBe(0);
        } finally {
            try { npxChild.kill('SIGKILL') } catch {}
            await bridge.close();
            fs.rmSync(workDir, {force: true, recursive: true})
        }
    });

    // The cloud-walk shape: a parent that dies on SIGTERM without forwarding it. `; true` keeps `sh` from
    // exec-ing node, and the test keeps holding stdin's write end, so only a parent-death check can end the server.
    test('SIGTERM to a parent shell that does not forward it still ends the MCP server (#1302)', async () => {
        const
            bridge  = await startLoopbackBridge(),
            homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-sh-parent-')),
            shChild = spawn('/bin/sh', ['-c', `"${process.execPath}" "${STANDALONE_BIN}"; true`], {
                env: {
                    ...process.env,
                    HOME               : homedir,
                    NEO_NL_AUTO_CONNECT: 'true',
                    NEO_NL_PORT        : String(bridge.port),
                    UNIT_TEST_MODE     : 'true'
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });

        try {
            await expect.poll(() => bridge.connections.size, {timeout: 10000}).toBe(1);

            const
                [bridgeSocket] = [...bridge.connections],
                socketClosed   = once(bridgeSocket, 'close');

            shChild.kill('SIGTERM');

            await Promise.race([
                socketClosed,
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('MCP server remained alive after its parent shell died')),
                    5000
                ))
            ]);

            expect(bridge.connections.size).toBe(0);
        } finally {
            try { shChild.kill('SIGKILL') } catch {}
            await bridge.close();
            fs.rmSync(homedir, {force: true, recursive: true})
        }
    });
});
