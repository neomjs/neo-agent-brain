import {test, expect}                                 from '@playwright/test';
import {execFileSync}                                 from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir}                                       from 'node:os';
import path                                           from 'node:path';

import {dispatchLocalWake, OPENCODE_SEAT_ENVELOPE_FIELDS} from '../../../../../../ai/daemons/wake/localWakeAdapters.mjs';
import {generateOpenCodeSeatConfig}                   from '../../../../../../ai/services/fleet/generateOpenCodeSeatConfig.mjs';
import {NeoWakeEnvelope}                              from '../../../../../../ai/services/fleet/opencodeWakeEnvelopePlugin.mjs';

/**
 * The opencode-server route's "two producers, one contract" (`ai/daemons/wake/daemon.mjs`): the
 * seat-config boot hook and the OpenCode plant both write the seat envelope, and last-writer-wins is a
 * no-op only while both write what the reader admits. Every arm runs a producer's REAL output through
 * the REAL reader and owner guard (`dispatchLocalWake`), never a fixture shaped like the contract.
 */
const
    SEAT    = '@neo-gpt',
    SESSION = 'ses_own',
    PORT    = 63181;

const route = () => ({
    recordKey     : 'b'.repeat(64),
    subscriptionId: 'WAKE_SUB:parity',
    envelope      : {
        agentIdentity: SEAT,
        payload      : {totalEvents: 1, sourceEventIds: ['MESSAGE:1'], breakdown: {sent_to_me: {count: 1, latest: {from: '@neo-opus-ada', priority: 'high', subject: 'parity'}}}}
    },
    route: {agentIdentity: SEAT, harnessTargetMetadata: {adapter: 'opencode-server'}, adapterConfig: {attemptTimeoutMs: 100}}
});

/**
 * Hands an envelope's text to the real opencode-server adapter, the way the receiver would.
 */
async function deliver(envelopeText) {
    let posted = null;

    const outcome = await dispatchLocalWake(route(), {
        homedir: () => '/home/seat',
        fs     : {readFile: async () => envelopeText},
        fetch  : async url => { posted = url; return {status: 204} }
    });

    return {outcome, posted}
}

/**
 * Runs the plant as OpenCode would: its env (the seat's spawn env), a `session.created` event for a
 * top-level session, and a server that answers the plant's own post-write probe.
 */
async function runPlant({dataHome, env = {}}) {
    const
        saved      = {...process.env},
        savedFetch = globalThis.fetch,
        logs       = [];

    delete process.env.NEO_AGENT_IDENTITY;
    Object.assign(process.env, {XDG_DATA_HOME: dataHome, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: 'secret'}, env);
    globalThis.fetch = async () => ({status: 200, json: async () => ({id: SESSION})});

    try {
        const hooks = await NeoWakeEnvelope({
            client   : {app: {log: async ({body}) => { logs.push(body) }}},
            directory: '/seat',
            project  : {id: 'proj'},
            serverUrl: `http://127.0.0.1:${PORT}`
        });

        await hooks.event({event: {type: 'session.created', properties: {info: {id: SESSION}}}})
    } finally {
        globalThis.fetch = savedFetch;

        for (const key of Object.keys(process.env)) {
            if (!(key in saved)) delete process.env[key]
        }

        Object.assign(process.env, saved)
    }

    const file = path.join(dataHome, 'opencode', 'wake-envelope.json');

    return {file, logs, text: existsSync(file) ? readFileSync(file, 'utf8') : null}
}

const dataHome = () => mkdtempSync(path.join(tmpdir(), 'opencode-seat-'));

test.describe('ai/daemons/wake — the opencode-server seat envelope, one contract for both producers', () => {
    test('the plant\'s envelope is admitted by the reader for its own seat', async () => {
        const {text} = await runPlant({dataHome: dataHome(), env: {NEO_AGENT_IDENTITY: 'neo-gpt'}});

        expect(text, 'the plant wrote an envelope').not.toBeNull();
        expect(JSON.parse(text).agentIdentity, 'a bare handle is stamped in the wire\'s @ spelling').toBe(SEAT);

        const {outcome, posted} = await deliver(text);

        expect(outcome).toBe('delivered');
        expect(posted).toContain(`/session/${SESSION}/prompt_async`)
    });

    test('launched without its identity, the plant keeps the identity of the envelope it replaces', async () => {
        const home = dataHome();

        mkdirSync(path.join(home, 'opencode'), {recursive: true});
        writeFileSync(path.join(home, 'opencode', 'wake-envelope.json'), JSON.stringify({agentIdentity: SEAT, hostname: '127.0.0.1', port: 50000, sessionId: 'ses_old'}));

        const {text} = await runPlant({dataHome: home});

        expect(JSON.parse(text)).toMatchObject({agentIdentity: SEAT, port: PORT, sessionId: SESSION});
        expect((await deliver(text)).outcome).toBe('delivered')
    });

    test('with no identity anywhere, the plant writes nothing and says why', async () => {
        const {logs, text} = await runPlant({dataHome: dataHome()});

        expect(text, 'no envelope the reader must refuse').toBeNull();
        expect(logs.some(({level, message}) => level === 'error' && /identity/.test(message))).toBe(true)
    });

    test('the boot hook\'s envelope is admitted by the same reader', async () => {
        const
            home     = dataHome(),
            hookPath = path.join(home, 'write-wake-envelope.mjs'),
            {files}  = generateOpenCodeSeatConfig({
                agentosRuntimeRoot: '/runtime',
                memoryDir         : '/seat/memory',
                nodeBinary        : process.execPath,
                seatEnvFile       : '/seat/.env',
                targetRepoRoot    : '/seat',
                wakeHookPath      : hookPath
            });

        writeFileSync(hookPath, files.find(file => file.path === hookPath).content);
        execFileSync(process.execPath, [hookPath, '--data-home', home, '--port', String(PORT), '--session-id', SESSION, '--project-id', 'proj', '--directory', '/seat'], {
            env  : {NEO_AGENT_IDENTITY: 'neo-gpt', OPENCODE_SERVER_PASSWORD: 'secret', OPENCODE_SERVER_USERNAME: 'opencode', PATH: process.env.PATH},
            stdio: 'ignore'
        });

        expect((await deliver(readFileSync(path.join(home, 'opencode', 'wake-envelope.json'), 'utf8'))).outcome).toBe('delivered')
    });

    test('both producers write every field the reader declares', async () => {
        const plant = JSON.parse((await runPlant({dataHome: dataHome(), env: {NEO_AGENT_IDENTITY: SEAT}})).text);

        for (const field of OPENCODE_SEAT_ENVELOPE_FIELDS) {
            expect(typeof plant[field], field).toBe('string');
            expect(plant[field].length, field).toBeGreaterThan(0)
        }
    })
});
