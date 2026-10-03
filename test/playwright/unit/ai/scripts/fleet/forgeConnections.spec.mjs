import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/**
 * @summary The plane-local administrative path, through its real entrypoint: each run is its own
 * process over a temp Fleet root (the `fleet.dataDir` leaf's env binding), so every read is a reload of
 * the real store. Never imported in-process: the entrypoint loads `dotenv`.
 */
test.describe('forgeConnections — the plane-local administrative path', () => {
    let dir;

    const run = (...args) => {
        const result = spawnSync(process.execPath, ['ai/scripts/fleet/forgeConnections.mjs', ...args], {
            cwd     : repoRoot,
            encoding: 'utf-8',
            env     : {...process.env, NEO_FLEET_DATA_DIR: dir},
            timeout : 30_000
        });

        let json = null;

        try {
            json = JSON.parse(result.stdout)
        } catch {}

        return {status: result.status, json, stderr: result.stderr, stdout: result.stdout}
    };

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-connections-cli-'))
    });

    test.afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true})
    });

    test('init, register, approve-alias and detach run from the entrypoint; a mutation without --apply writes nothing', () => {
        const dry = run('init');

        expect(dry).toMatchObject({status: 0, json: {ok: true, applied: false}});
        expect(fs.readdirSync(dir)).toEqual([]);
        expect(run('init', '--apply').json).toMatchObject({ok: true, applied: true, version: 1});

        const registered = run('register', '--provider', 'github', '--endpoint', 'HTTPS://GitHub.com/', '--apply');

        expect(registered).toMatchObject({status: 0, json: {ok: true, endpoint: 'https://github.com', authProvider: 'github', applied: true}});

        const {connectionId} = registered.json;

        expect(run('approve-alias', '--connection', connectionId, '--endpoint', 'https://ghe.example.com', '--apply').json)
            .toMatchObject({ok: true, connectionId, endpoint: 'https://ghe.example.com'});
        expect(run('detach', '--endpoint', 'https://ghe.example.com', '--apply').json).toMatchObject({ok: true, connectionId});

        const list = run('list');

        expect(list.status).toBe(0);
        expect(list.json).toMatchObject({ok: true, state: 'ok', dataDir: dir});
        expect(list.json.store.bindings).toEqual({'https://github.com': connectionId});
        expect(list.json.store.tombstones).toEqual({'https://ghe.example.com': connectionId});
        expect(list.json.store.events.map(event => event.op)).toEqual(['init', 'register', 'approve-alias', 'detach'])
    });

    test('a refusal exits non-zero and writes nothing; a tombstone holds in the next process', () => {
        run('init', '--apply');

        const {connectionId} = run('register', '--provider', 'gitlab', '--endpoint', 'https://gitlab.example.com', '--apply').json;

        run('approve-alias', '--connection', connectionId, '--endpoint', 'https://git.example.org', '--apply');
        run('detach', '--endpoint', 'https://git.example.org', '--apply');

        const store = fs.readFileSync(path.join(dir, 'forge-connections.json'), 'utf8');

        expect(run('register', '--provider', 'gitlab', '--endpoint', 'https://gitlab.example.com', '--apply'))
            .toMatchObject({status: 1, json: {ok: false, refused: 'endpoint-already-bound'}});
        expect(run('approve-alias', '--connection', connectionId, '--endpoint', 'https://git.example.org', '--apply'))
            .toMatchObject({status: 1, json: {ok: false, refused: 'endpoint-tombstoned'}});
        expect(run('init', '--apply')).toMatchObject({status: 1, json: {refused: 'already-initialized'}});
        expect(fs.readFileSync(path.join(dir, 'forge-connections.json'), 'utf8')).toBe(store)
    });

    test('a corrupt store is reported, never replaced', () => {
        const corrupt = '{"schema":1';

        fs.writeFileSync(path.join(dir, 'forge-connections.json'), corrupt);

        expect(run('list')).toMatchObject({status: 1, json: {ok: false, state: 'corrupt'}});
        expect(run('init', '--apply')).toMatchObject({status: 1, json: {refused: 'store-unavailable'}});
        expect(fs.readFileSync(path.join(dir, 'forge-connections.json'), 'utf8')).toBe(corrupt)
    });

    test('an invocation it cannot run is refused before the store is touched; --help exits 0', () => {
        expect(run()).toMatchObject({status: 1});
        expect(run().stderr).toContain('the command must be one of init, register, approve-alias, detach, list');
        expect(run('register', '--endpoint', 'https://github.com').stderr).toContain('register needs --provider');
        expect(run('approve-alias', '--endpoint', 'https://github.com').stderr).toContain('approve-alias needs --connection');
        expect(fs.readdirSync(dir)).toEqual([]);

        const help = run('--help');

        expect(help.status).toBe(0);
        expect(help.stdout).toContain('forge-connections');
        expect(help.stdout).toContain('--apply')
    });
});
