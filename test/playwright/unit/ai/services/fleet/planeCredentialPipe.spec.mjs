import {test, expect}  from '@playwright/test';
import {spawn}         from 'node:child_process';
import crypto          from 'node:crypto';
import fs              from 'node:fs';
import http            from 'node:http';
import net             from 'node:net';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

import {createFleetWireOffer, createFleetWireRequest} from '../../../../../../src/fleet/contract/wire.mjs';

/**
 * The fleet entry the packaged Fleet Manager spawns, run as that spawn runs it: the launcher's extra
 * `stdio` pipe on fd 3, named by `NEO_FLEET_PLANE_CREDENTIAL_FD`, against a loopback plane that admits
 * known bearers and names each one's subject.
 */
const
    BRAIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    VIEWER     = '@neo-pipe-viewer',
    BOOT       = 'ghp_pipe_boot_fixture',
    SUCCESSOR  = 'ghp_pipe_successor_fixture',
    STRANGER   = 'ghp_pipe_stranger_fixture',
    UNKNOWN    = 'ghp_pipe_unknown_fixture',
    ADMISSION  = 'pipe_admission_token_fixture',
    BEARERS    = [BOOT, SUCCESSOR, STRANGER, UNKNOWN, ADMISSION];

/**
 * @summary A loopback plane. Its MCP endpoint admits a known bearer and answers `list_permissions`
 * with that bearer's subject; its fleet surface holds one wake stream open per admitted bearer.
 * Every request is recorded with the bearer and session it carried.
 * @param {Object} identities Subject per admitted bearer
 * @returns {Promise<Object>} `{base, requests, streams, close}`
 */
async function startPlane(identities) {
    const requests = [], streams = [];

    let sessions = 0;

    const server = http.createServer((req, res) => {
        let body = '';

        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const
                bearer = (req.headers.authorization ?? '').replace(/^Bearer /, ''),
                rpc    = body ? JSON.parse(body) : null,
                {pathname} = new URL(req.url, 'http://plane');

            requests.push({method: req.method, pathname, bearer, session: req.headers['mcp-session-id'] ?? null, rpc: rpc?.method ?? null, tool: rpc?.params?.name ?? null});

            if (!identities[bearer]) return res.writeHead(401).end();

            if (pathname === '/fleet/events') {
                const stream = {bearer, open: true};

                streams.push(stream);
                res.on('close', () => stream.open = false);
                res.writeHead(200, {'content-type': 'text/event-stream'});
                return res.write(`event: state\ndata: ${JSON.stringify({armedForViewer: true})}\n\n`)
            }

            if (req.method !== 'POST') return res.writeHead(req.method === 'DELETE' ? 200 : 405).end();
            if (rpc.id === undefined)  return res.writeHead(202).end();

            const
                headers = {'content-type': 'application/json'},
                result  = rpc.method === 'initialize'
                    ? {protocolVersion: rpc.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'neo-memory-core', version: '0.0.0'}}
                    : rpc.method === 'tools/call'
                        ? {content: [{type: 'text', text: rpc.params.name === 'list_permissions' ? JSON.stringify({identity: identities[bearer]}) : '{}'}]}
                        : {};

            if (rpc.method === 'initialize') headers['mcp-session-id'] = `session-${++sessions}`;

            res.writeHead(200, headers).end(JSON.stringify({jsonrpc: '2.0', id: rpc.id, result}))
        })
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        base : `http://127.0.0.1:${server.address().port}`,
        requests,
        streams,
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
    }
}

/**
 * @summary A free loopback port.
 * @returns {Promise<Number>}
 */
function allocatePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port))
        })
    })
}

/**
 * @summary Starts a Brain entry with exactly the given env; fd 3 is the launcher's credential pipe.
 * @param {String} entry
 * @param {Object} env
 * @returns {Object} `{child, output, answers, send, log}`
 */
function startEntry(entry, env) {
    const
        output  = [],
        answers = [],
        child   = spawn(process.execPath, [path.join(BRAIN_ROOT, entry)], {cwd: BRAIN_ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe']}),
        pipe    = child.stdio[3];

    let buffered = '';

    child.stdout.on('data', chunk => output.push(String(chunk)));
    child.stderr.on('data', chunk => output.push(String(chunk)));
    pipe.on('error', () => {});
    pipe.on('data', chunk => {
        const lines = (buffered + chunk).split('\n');

        buffered = lines.pop();
        lines.forEach(line => answers.push(JSON.parse(line)))
    });

    return {
        child,
        output,
        answers,
        send: frame => pipe.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`),
        log : () => output.join('')
    }
}

/**
 * @summary Stops a child and waits for its exit.
 * @param {ChildProcess} child
 * @returns {Promise<void>}
 */
function stopChild(child) {
    return child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise(resolve => {
            child.once('exit', () => resolve());
            child.kill('SIGKILL')
        })
}

test.describe('the fleet server takes its plane bearer from the launcher\'s pipe (#1462)', () => {
    test.setTimeout(180_000);

    let root, plane, bridge, nlPort, privateKey, children = [];

    /**
     * @summary The fleet process env: an isolated plane root, the fixture plane, and the pipe on fd 3.
     * @param {Object} [overrides]
     * @returns {Promise<Object>}
     */
    async function fleetEnv(overrides = {}) {
        const dir = fs.mkdtempSync(path.join(root, 'fleet-'));

        return {
            PATH                          : process.env.PATH,
            HOME                          : process.env.HOME,
            TMPDIR                        : os.tmpdir(),
            LANG                          : 'C.UTF-8',
            UNIT_TEST_MODE                : '1',
            NEO_AI_DEPLOYMENT_MODE        : 'local',
            NEO_PLANE_DATA_ROOT           : path.join(dir, 'plane'),
            NEO_AI_DB_PATH                : path.join(dir, 'sqlite', 'memory-core-graph.sqlite'),
            NEO_MEMORY_DB_PATH_TEST       : path.join(dir, 'sqlite', 'memory-core-graph.sqlite'),
            NEO_AI_ORCHESTRATOR_DIR       : path.join(dir, 'orchestrator'),
            NEO_BACKUP_PATH               : path.join(dir, 'backups'),
            NEO_CHROMA_DATA_DIR_TEST      : path.join(dir, 'chroma'),
            NEO_REM_RUN_STATE_DIR         : path.join(dir, 'rem-runs'),
            NEO_FLEET_DATA_DIR            : path.join(dir, 'fleet'),
            NEO_FLEET_AGENTS_ROOT         : path.join(dir, 'fleet', 'agents'),
            NEO_FLEET_PORT                : String(await allocatePort()),
            NEO_FLEET_BEARER              : crypto.randomBytes(32).toString('base64url'),
            NEO_FLEET_SIGNING_KEY         : privateKey.export({type: 'pkcs8', format: 'pem'}),
            NEO_FLEET_PLANE_BASE          : plane.base,
            NEO_FLEET_PLANE_BEARER        : '',
            NEO_FLEET_PLANE_CREDENTIAL_FD : '3',
            NEO_MCP_HEALTHCHECK_TOKEN_FILE: path.join(root, 'admission-token'),
            NEO_AGENT_IDENTITY            : VIEWER,
            NEO_NL_PORT                   : String(nlPort),
            ...overrides
        }
    }

    /**
     * @summary Starts the fleet entry and remembers it for teardown.
     * @param {Object} env
     * @returns {Object}
     */
    function startFleet(env) {
        const fleet = startEntry('ai/services/fleet/devFleetServer.mjs', env);

        children.push(fleet.child);
        return fleet
    }

    /**
     * @summary Waits for the fleet's answer to frame `count`.
     * @param {Object} fleet
     * @param {Number} count
     * @returns {Promise<Object>} That answer
     */
    async function answer(fleet, count) {
        await expect.poll(() => fleet.answers.length, {timeout: 60_000, message: `answer ${count}:\n${fleet.log().slice(-3000)}`}).toBeGreaterThanOrEqual(count);
        return fleet.answers[count - 1]
    }

    test.beforeAll(async () => {
        // canonical: launch-profile custody refuses a managed root whose realpath differs (macOS tmp is a symlink)
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plane-credential-pipe-')));
        fs.writeFileSync(path.join(root, 'admission-token'), `${ADMISSION}\n`);

        plane  = await startPlane({[BOOT]: VIEWER, [SUCCESSOR]: VIEWER, [STRANGER]: '@neo-pipe-stranger', [ADMISSION]: VIEWER});
        nlPort = await allocatePort();

        const keys = crypto.generateKeyPairSync('ed25519');

        privateKey = keys.privateKey;
        // a bridge that answers, so the fleet's bridge settle never spawns one of its own
        bridge = startEntry('ai/mcp/server/neural-link/run-bridge.mjs', {
            PATH                       : process.env.PATH,
            HOME                       : process.env.HOME,
            UNIT_TEST_MODE             : '1',
            NEO_NL_PORT                : String(nlPort),
            NEO_FLEET_BRIDGE_PUBLIC_KEY: keys.publicKey.export({type: 'spki', format: 'pem'})
        })
    });

    test.afterEach(async () => {
        await Promise.allSettled(children.map(stopChild));
        children = []
    });

    test.afterAll(async () => {
        await stopChild(bridge.child);
        await plane.close();
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('boot, rotate and refuse: each frame is answered, the replaced bearer leaves every consumer, and no log line carries a bearer', async () => {
        const env   = await fleetEnv(),
              fleet = startFleet(env);

        fleet.send({bearer: BOOT, bearerClass: 'github-pat'});
        expect(await answer(fleet, 1)).toEqual({state: 'adopted', identity: VIEWER});

        // a forge PAT serves the fleet surface too: the wake stream presents it
        await expect.poll(() => plane.streams.filter(stream => stream.open).map(stream => stream.bearer)).toEqual([BOOT]);

        fleet.send({bearer: SUCCESSOR, bearerClass: 'github-pat'});
        expect(await answer(fleet, 2)).toEqual({state: 'adopted', identity: VIEWER});

        // the replaced session is closed on the plane, and the wake stream moved to the successor
        await expect.poll(() => plane.requests.some(request => request.method === 'DELETE' && request.session === 'session-1' && request.bearer === BOOT)).toBe(true);
        await expect.poll(() => plane.streams.filter(stream => stream.open).map(stream => stream.bearer)).toEqual([SUCCESSOR]);

        // the next plane read through the fleet transport rides the successor's session
        const before = plane.requests.length,
              wire   = await fetch(`http://127.0.0.1:${env.NEO_FLEET_PORT}/fleet`, {
                  method : 'POST',
                  headers: {'content-type': 'application/json', authorization: `Bearer ${env.NEO_FLEET_BEARER}`},
                  body   : JSON.stringify(createFleetWireRequest('fleetGoldenPath', {}, createFleetWireOffer()))
              });

        expect(wire.status).toBe(200);

        const reads = plane.requests.slice(before).filter(request => request.rpc === 'tools/call');

        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(request => request.bearer === SUCCESSOR && request.session === 'session-2')).toBe(true);

        // refusals keep the successor serving
        fleet.send({bearer: UNKNOWN, bearerClass: 'github-pat'});
        fleet.send({bearer: STRANGER, bearerClass: 'github-pat'});
        fleet.send({bearer: ADMISSION, bearerClass: ''});
        fleet.send(SUCCESSOR);

        const [unknown, stranger, aliased, malformed] = [await answer(fleet, 3), await answer(fleet, 4), await answer(fleet, 5), await answer(fleet, 6)];

        expect(unknown).toEqual({state: 'refused', reason: expect.stringMatching(/^plane unreachable/)});
        expect(stranger).toEqual({state: 'refused', reason: 'plane identity mismatch', resolvedIdentity: '@neo-pipe-stranger', expectedIdentity: VIEWER});
        expect(aliased).toEqual({state: 'refused', reason: expect.stringMatching(/^\[FleetServer\] the piped plane bearer resolves to the deployment's bootstrap\/healthcheck admission token/)});
        expect(malformed).toEqual({state: 'refused', reason: 'malformed credential frame: not JSON'});

        expect(plane.requests.some(request => request.bearer === ADMISSION)).toBe(false);
        expect(plane.requests.some(request => request.method === 'DELETE' && request.session === 'session-2')).toBe(false);
        expect(plane.streams.filter(stream => stream.open).map(stream => stream.bearer)).toEqual([SUCCESSOR]);

        // the launcher closing its end ends the rotations, never the server
        fleet.child.stdio[3].end();
        await expect.poll(() => fleet.log()).toContain('[fleet] the credential pipe closed; the bound plane bearer keeps serving');
        expect(fleet.child.exitCode).toBeNull();

        for (const bearer of BEARERS) {
            expect(fleet.log()).not.toContain(bearer)
        }
    });

    const twoHomes = 'fleet.planeCredentialFd and fleet.planeBearer / fleet.planeBearerFile both name the plane bearer; with the pipe set, it is the only home';

    for (const {name, env = () => ({}), frame = {bearer: BOOT, bearerClass: 'github-pat'}, refusal} of [
        {name: 'a bearer for another account', frame: {bearer: STRANGER, bearerClass: 'github-pat'}, refusal: {reason: 'plane identity mismatch', resolvedIdentity: '@neo-pipe-stranger', expectedIdentity: VIEWER}},
        {name: 'a configured bearer beside the pipe', env: () => ({NEO_FLEET_PLANE_BEARER: SUCCESSOR}), refusal: {reason: twoHomes}},
        {name: 'a configured bearer file that does not exist', env: () => ({NEO_FLEET_PLANE_BEARER_FILE: path.join(root, 'absent-bearer')}), refusal: {reason: twoHomes}},
        {name: 'a configured bearer file that is empty', env: () => ({NEO_FLEET_PLANE_BEARER_FILE: path.join(root, 'admission-token-empty')}), refusal: {reason: twoHomes}},
        {name: 'a bearer the viewer mint aliases', env: () => ({NEO_FLEET_VIEWER_MC_AUTHORIZATION: BOOT}), refusal: {reason: expect.stringMatching(/viewerMcAuthorization resolves to the same bytes as the plane-MCP bearer/)}},
        {name: 'a non-forge bearer a fleet-surface mint aliases', env: () => ({NEO_FLEET_PLANE_ADMISSION_BEARER: BOOT}), frame: {bearer: BOOT, bearerClass: ''}, refusal: {reason: expect.stringMatching(/planeAdmissionBearer resolves to the same bytes as the plane-MCP bearer/)}}
    ]) {
        test(`${name} is refused on the pipe at boot, and the process exits before its transport starts`, async () => {
            fs.writeFileSync(path.join(root, 'admission-token-empty'), '');

            const fleet = startFleet(await fleetEnv(env()));

            fleet.send(frame);

            expect(await answer(fleet, 1)).toEqual({state: 'refused', ...refusal});
            await expect.poll(() => fleet.child.exitCode).toBe(1);
            expect(fleet.answers).toHaveLength(1);
            expect(fleet.log()).not.toContain('[fleet] boot phase transport');

            for (const bearer of BEARERS) {
                expect(fleet.log()).not.toContain(bearer)
            }
        })
    }

    test('with the fd unset, the configured bearer boots plane mode as before', async () => {
        const fleet = startFleet(await fleetEnv({NEO_FLEET_PLANE_CREDENTIAL_FD: '', NEO_FLEET_PLANE_BEARER: BOOT}));

        await expect.poll(() => fleet.log(), {timeout: 60_000}).toContain(`[fleet] mailbox/compose/catch-up seams bound to the containerized plane at ${plane.base} (viewer ${VIEWER} verified plane-side`);
        expect(fleet.answers).toEqual([]);
        expect(plane.requests.some(request => request.tool === 'list_permissions' && request.bearer === BOOT)).toBe(true)
    });
});
