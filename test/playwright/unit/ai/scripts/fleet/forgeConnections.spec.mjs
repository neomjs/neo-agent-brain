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

    // `env` adds the plane's own auth leaves, which a `status` reads
    const runUnder = (env, ...args) => {
        const result = spawnSync(process.execPath, ['ai/scripts/fleet/forgeConnections.mjs', ...args], {
            cwd     : repoRoot,
            encoding: 'utf-8',
            env     : {...process.env, NEO_FLEET_DATA_DIR: dir, ...env},
            timeout : 30_000
        });

        let json = null;

        try {
            json = JSON.parse(result.stdout)
        } catch {}

        return {status: result.status, json, stderr: result.stderr, stdout: result.stdout}
    };

    const run = (...args) => runUnder({}, ...args);

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

    test('status reads the forge the plane\'s auth mode declares and that endpoint\'s binding, and exits 0 over every store', () => {
        const
            github = {NEO_AUTH_MODE: 'github-pat', NEO_AUTH_GITHUB_API_BASE_URL: 'https://api.github.com'},
            status = (env = github) => runUnder(env, 'status');

        // the declaration is the API base admissions stamp, never the web origin
        expect(status()).toMatchObject({status: 0, json: {ok: true, dataDir: dir, declared: {authProvider: 'github', endpoint: 'https://api.github.com'}, declaredReason: null, state: 'absent', binding: null, tombstoned: false}});

        run('init', '--apply');

        const {connectionId} = run('register', '--provider', 'github', '--endpoint', 'https://api.github.com', '--apply').json;

        expect(status().json).toMatchObject({state: 'ok', binding: {connectionId, authProvider: 'github'}, tombstoned: false});

        // an alternate endpoint and the other forge come from their own leaves, normalized as admissions are resolved
        expect(status({NEO_AUTH_MODE: 'github-pat', NEO_AUTH_GITHUB_API_BASE_URL: 'https://GHE.example.com/api/v3/'}).json)
            .toMatchObject({declared: {authProvider: 'github', endpoint: 'https://ghe.example.com/api/v3'}, binding: null});
        expect(status({NEO_AUTH_MODE: 'gitlab-pat', NEO_AUTH_GITLAB_API_BASE_URL: 'https://gitlab.example.com'}).json)
            .toMatchObject({declared: {authProvider: 'gitlab', endpoint: 'https://gitlab.example.com'}, binding: null});

        // a mode that admits no forge PAT declares nothing, and says why
        expect(status({NEO_AUTH_MODE: 'oidc'}).json).toMatchObject({declared: null, declaredReason: 'the plane\'s auth mode \'oidc\' admits no forge PAT, so no seat can be owned on it'});

        // a detached endpoint is tombstoned; a corrupt store is the answer, never a failure
        run('detach', '--endpoint', 'https://api.github.com', '--apply');
        expect(status().json).toMatchObject({binding: null, tombstoned: true});

        fs.writeFileSync(path.join(dir, 'forge-connections.json'), '{"schema":1');
        expect(status()).toMatchObject({status: 0, json: {ok: true, state: 'corrupt', binding: null, tombstoned: false}});
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
