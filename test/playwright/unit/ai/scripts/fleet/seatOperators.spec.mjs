import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/**
 * @summary The seat operators' plane-local administrative path, through its real entrypoint: each run is
 * its own process over a temp Fleet root (the `fleet.dataDir` leaf's env binding), so every read is a
 * reload of the real stores. Never imported in-process: the entrypoint loads `dotenv`.
 */
test.describe('seatOperators — the plane-local administrative path', () => {
    const
        A  = 'owner:conn-1:1001',
        A2 = 'owner:conn-2:1001';

    let dir;

    const run = (...args) => {
        const result = spawnSync(process.execPath, ['ai/scripts/fleet/seatOperators.mjs', ...args], {
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
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-operators-cli-'));
        // two legacy seats, defined before the relation existed
        fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({agents: {
            ada  : {githubUsername: 'ada',   harnessType: 'claude-code', id: 'ada'},
            grace: {githubUsername: 'grace', harnessType: 'claude-code', id: 'grace'}
        }}))
    });

    test.afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true})
    });

    test('assign and transfer run from the entrypoint; without --apply nothing is written', () => {
        const dry = run('assign', '--seat', 'ada', '--seat', 'grace', '--principal', A);

        expect(dry).toMatchObject({status: 0, json: {applied: false, assigned: ['ada', 'grace'], ok: true}});
        expect(fs.existsSync(path.join(dir, 'seat-operators.json')), 'a dry run writes nothing').toBe(false);

        expect(run('assign', '--seat', 'ada', '--seat', 'grace', '--principal', A, '--apply').json).toMatchObject({applied: true, assigned: ['ada', 'grace'], ok: true});
        expect(run('assign', '--seat', 'ada', '--principal', A, '--apply').json, 'the same principal again moves nothing').toMatchObject({applied: false, assigned: [], unchanged: ['ada']});

        expect(run('transfer', '--seat', 'ada', '--from', A, '--to', A2, '--apply').json).toMatchObject({applied: true, from: A, ok: true, to: A2});

        const list = run('list');

        expect(list.json.store.operators.ada.principal).toBe(A2);
        expect(list.json.store.operators.grace.principal).toBe(A);
        expect(list.json.store.events.map(event => event.op)).toEqual(['assign', 'transfer'])
    });

    test('refusals exit non-zero and write nothing; invalid invocations never reach the stores', () => {
        expect(run('assign', '--seat', 'nobody', '--principal', A, '--apply')).toMatchObject({status: 1, json: {ok: false, refused: 'unknown-seat'}});
        expect(run('assign', '--seat', 'ada', '--principal', '@neo-opus-ada', '--apply')).toMatchObject({status: 1, json: {refused: 'no-principal'}});
        expect(run('transfer', '--seat', 'ada', '--from', A, '--to', A2, '--apply')).toMatchObject({status: 1, json: {refused: 'unowned'}});
        expect(fs.existsSync(path.join(dir, 'seat-operators.json'))).toBe(false);

        const missing = run('assign', '--seat', 'ada');

        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain('assign needs --principal');
        expect(run('transfer', '--seat', 'ada', '--seat', 'grace', '--from', A, '--to', A2).stderr).toContain('transfer needs exactly one --seat')
    })
});
