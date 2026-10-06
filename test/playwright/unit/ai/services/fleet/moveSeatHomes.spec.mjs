import {setup} from '../../../../setup.mjs';

const appName = 'MoveSeatHomesTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                 from '@playwright/test';
import Neo                            from 'neo.mjs/src/Neo.mjs';
import * as core                      from 'neo.mjs/src/core/_export.mjs';
import {execFileSync}                 from 'node:child_process';
import fs                             from 'node:fs/promises';
import os                             from 'node:os';
import path                           from 'node:path';
import FleetRegistryService           from '../../../../../../ai/services/fleet/FleetRegistryService.mjs';
import {SEAT_LEASE_FILE}              from '../../../../../../ai/services/fleet/FleetLifecycleService.mjs';
import {moveSeatHomes}                from '../../../../../../ai/services/fleet/moveSeatHomes.mjs';
import {prepareManagedAgentWorkspace} from '../../../../../../ai/services/fleet/prepareManagedAgentWorkspace.mjs';

/**
 * @summary The shell's seat-home move on real temp folders and the real registry: every row is classified
 * first, a materialized home is copied, proven and published before its binding moves, and an interrupted
 * run completes when run again.
 */

const PAT = 'ghp_fixture_only';

let root, from, to;

test.beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'move-seat-homes-')));
    from = path.join(root, 'app-data', 'agents');
    to   = path.join(root, 'neo-ai', 'agents');

    FleetRegistryService.dataDir    = path.join(root, 'fleet');
    FleetRegistryService.agentsRoot = from
});

test.afterEach(async () => {
    FleetRegistryService.dataDir    = null;
    FleetRegistryService.agentsRoot = null;
    await fs.rm(root, {recursive: true, force: true})
});

/**
 * @summary Defines a seat under the source root, and gives it files when it is materialized.
 */
async function seat(id, {materialized = true, harnessType = 'codex'} = {}) {
    FleetRegistryService.defineAgent({githubUsername: id, harnessType, credential: PAT});

    if (materialized) {
        const home = path.join(from, id);

        await fs.mkdir(path.join(home, 'harness', harnessType, 'memories'), {recursive: true});
        await fs.writeFile(path.join(home, 'harness', harnessType, 'config.toml'), `# ${id}\n`, {mode: 0o600});
        await fs.writeFile(path.join(home, '.env'), `NEO_AGENT_IDENTITY=${id}\n`, {mode: 0o600});
        await fs.symlink('harness', path.join(home, 'harness-link'))
    }

    return path.join(from, id)
}

const rowOf = (result, id) => result.rows.find(row => row.id === id);

test('every materialized home is copied, proven and published, then its binding moves; the source stays', async () => {
    const
        aliceHome = await seat('alice'),
        bobHome   = await seat('bob', {materialized: false});

    FleetRegistryService.defineAgent({githubUsername: 'carol', harnessType: 'codex', credential: PAT});
    FleetRegistryService.relocateSeatHome('carol', {from: path.join(from, 'carol'), to: path.join(root, 'elsewhere', 'carol')});

    const result = await moveSeatHomes({registry: FleetRegistryService, from, to});

    expect(result.state).toBe('moved');
    expect(rowOf(result, 'alice')).toMatchObject({state: 'moved', materialized: true, seatHome: aliceHome, destination: path.join(to, 'alice')});
    expect(rowOf(result, 'bob'), 'never materialized: only its binding moves').toMatchObject({state: 'rebound', materialized: false});
    expect(rowOf(result, 'carol')).toMatchObject({state: 'untouched', reason: `it is bound to '${path.join(root, 'elsewhere', 'carol')}', outside '${from}'`});

    expect(FleetRegistryService.getAgent('alice')).toMatchObject({seatHome: path.join(to, 'alice'), previousSeatHome: aliceHome});
    expect(FleetRegistryService.getAgent('bob')).toMatchObject({seatHome: path.join(to, 'bob'), previousSeatHome: bobHome});
    expect(await fs.readFile(path.join(to, 'alice', 'harness', 'codex', 'config.toml'), 'utf8')).toBe('# alice\n');
    expect((await fs.lstat(path.join(to, 'alice', '.env'))).mode & 0o777).toBe(0o600);
    expect(await fs.readlink(path.join(to, 'alice', 'harness-link')), 'a link is kept as written').toBe('harness');
    expect(await fs.readFile(path.join(aliceHome, '.env'), 'utf8'), 'the source is the rollback copy').toBe('NEO_AGENT_IDENTITY=alice\n');
    expect(await fs.readdir(to), 'no staging folder remains').toEqual(['alice']);

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to})).rows.map(row => row.state), 'run again, every row reads as done').toEqual(['done', 'done', 'untouched'])
});

test('a destination holding anything but a verified copy stops the move before anything changes', async () => {
    const aliceHome = await seat('alice');

    await seat('bob');
    await fs.mkdir(path.join(to, 'bob'), {recursive: true});
    await fs.writeFile(path.join(to, 'bob', '.env'), 'NEO_AGENT_IDENTITY=someone-else\n');

    const result = await moveSeatHomes({registry: FleetRegistryService, from, to});

    expect(result).toMatchObject({state: 'refused', reason: `'${path.join(to, 'bob')}' holds something other than a verified copy of seat 'bob'`});
    expect(await fs.readdir(to), 'alice was not copied either').toEqual(['bob']);
    expect(FleetRegistryService.getAgent('alice').seatHome).toBe(aliceHome);

    await fs.rm(path.join(to, 'bob'), {recursive: true});
    await fs.writeFile(path.join(to, 'bob'), 'a file');

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to})).state, 'a file in its place').toBe('refused');

    await fs.rm(path.join(to, 'bob'));
    await seat('carol', {materialized: false});
    await fs.mkdir(path.join(to, 'carol'), {recursive: true});

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to})).reason, 'a never-materialized seat does not adopt a folder')
        .toBe(`seat 'carol' was never materialized, but '${path.join(to, 'carol')}' already exists`)
});

test('a seat folder the Fleet did not provision stops the move; renamed aside, its row is rebound', async () => {
    const aliceHome = await seat('alice', {materialized: false});

    await fs.mkdir(path.join(aliceHome, 'neomjs', 'neo'), {recursive: true});

    expect(await moveSeatHomes({registry: FleetRegistryService, from, to})).toMatchObject({
        state : 'refused',
        reason: `seat 'alice' names '${aliceHome}', which holds no harness home the Fleet provisioned; rename it aside, then move again`
    });

    await fs.rename(aliceHome, `${aliceHome}.aside`);

    expect(rowOf(await moveSeatHomes({registry: FleetRegistryService, from, to}), 'alice')).toMatchObject({state: 'rebound', materialized: false})
});

test('a seat whose lease names a live process, or a lease that cannot be read, stops the move; a dead lease does not', async () => {
    const
        aliceHome = await seat('alice'),
        leasePath = path.join(aliceHome, 'harness', 'codex', SEAT_LEASE_FILE),
        lease     = pid => fs.writeFile(leasePath, JSON.stringify({version: 1, agentId: 'alice', pid})),
        reasonOf  = async () => (await moveSeatHomes({registry: FleetRegistryService, from, to})).reason;

    await lease(process.pid);

    expect(await reasonOf()).toBe(`seat 'alice' may still be running: its lease names live pid ${process.pid}. Quit it, or remove a lease you know is stale, then move again`);
    expect(await fs.stat(to).catch(error => error.code)).toBe('ENOENT');

    // evidence that cannot be read is no evidence that the seat stopped
    await fs.writeFile(leasePath, '{"version": 1, "pid": ');
    expect(await reasonOf()).toMatch(/may still be running: its lease is not valid JSON\./);

    await fs.writeFile(leasePath, JSON.stringify({version: 1}));
    expect(await reasonOf()).toMatch(/may still be running: its lease names no process\./);

    await fs.rm(leasePath);
    await fs.mkdir(leasePath);
    expect(await reasonOf()).toMatch(/may still be running: its lease cannot be read \(EISDIR\)\./);
    expect(FleetRegistryService.getAgent('alice').seatHome, 'nothing was rebound').toBe(aliceHome);

    await fs.rmdir(leasePath);
    await lease(2147483646);

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to})).state).toBe('moved')
});

test('run again after an interruption at any step, the move completes', async () => {
    await seat('alice');
    await seat('bob');
    await seat('carol');

    // alice: copied and published, binding not yet moved; bob: this move's partial staging copy; carol: already moved
    await fs.mkdir(to, {recursive: true});
    await fs.cp(path.join(from, 'alice'), path.join(to, 'alice'), {recursive: true, verbatimSymlinks: true});
    await fs.mkdir(path.join(to, '.moving-bob', 'harness'), {recursive: true});
    await fs.writeFile(path.join(to, '.moving-bob', '.env'), 'NEO_AGENT');
    await fs.writeFile(path.join(to, '.moving-bob.owner'), 'move-1');
    await fs.cp(path.join(from, 'carol'), path.join(to, 'carol'), {recursive: true, verbatimSymlinks: true});
    FleetRegistryService.relocateSeatHome('carol', {from: path.join(from, 'carol'), to: path.join(to, 'carol')});

    const plan = await moveSeatHomes({registry: FleetRegistryService, from, to, moveId: 'move-1', dryRun: true});

    expect(plan.state).toBe('planned');
    expect(plan.rows.map(row => [row.id, row.state])).toEqual([['alice', 'relocate'], ['bob', 'copy'], ['carol', 'done']]);
    expect(FleetRegistryService.getAgent('alice').seatHome, 'a dry run changes nothing').toBe(path.join(from, 'alice'));

    const result = await moveSeatHomes({registry: FleetRegistryService, from, to, moveId: 'move-1'});

    expect(result.rows.map(row => [row.id, row.state])).toEqual([['alice', 'moved'], ['bob', 'moved'], ['carol', 'done']]);
    expect(await fs.readFile(path.join(to, 'bob', '.env'), 'utf8'), 'the partial copy was discarded and copied again').toBe('NEO_AGENT_IDENTITY=bob\n');
    expect((await fs.readdir(to)).sort(), 'no stage and no marker remain').toEqual(['alice', 'bob', 'carol'])
});

test('a staging folder this move did not leave stops the move, and stays as it was', async () => {
    await seat('alice');
    await fs.mkdir(path.join(to, '.moving-alice'), {recursive: true});
    await fs.writeFile(path.join(to, '.moving-alice', 'operator-note.txt'), 'mine');

    const refusal = `'${path.join(to, '.moving-alice')}' holds something this move did not leave; remove it, then move again`;

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to})).reason, 'no move id claims it').toBe(refusal);

    await fs.writeFile(path.join(to, '.moving-alice.owner'), 'another-move');

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to, moveId: 'move-1'})).reason, 'another move\'s mark')
        .toBe(`'${path.join(to, '.moving-alice.owner')}' is not this move's marker; remove it, then move again`);
    expect(await fs.readFile(path.join(to, '.moving-alice', 'operator-note.txt'), 'utf8')).toBe('mine');
    expect(await fs.readFile(path.join(to, '.moving-alice.owner'), 'utf8')).toBe('another-move')
});

test('a marker this move did not leave stops the move untouched, a link to another file included; its own marker resumes', async () => {
    const aliceHome = await seat('alice');
    const marker    = path.join(to, '.moving-alice.owner');
    const note      = path.join(path.dirname(to), 'operator-note.txt');
    const refusal   = `'${marker}' is not this move's marker; remove it, then move again`;

    await fs.mkdir(to, {recursive: true});
    await fs.writeFile(note, 'operator bytes');
    await fs.symlink(note, marker);

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to, moveId: 'move-1'})).reason, 'a link is never followed').toBe(refusal);
    expect(await fs.readFile(note, 'utf8')).toBe('operator bytes');
    expect((await fs.lstat(marker)).isSymbolicLink()).toBe(true);

    await fs.unlink(marker);
    await fs.writeFile(marker, 'operator bytes');

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to, moveId: 'move-1'})).reason, 'a plain file of someone else\'s').toBe(refusal);
    expect(await fs.readFile(marker, 'utf8')).toBe('operator bytes');
    expect(FleetRegistryService.getAgent('alice').seatHome).toBe(aliceHome);

    // the shell went down after writing its marker, before the copy began
    await fs.writeFile(marker, 'move-1');

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to, moveId: 'move-1'})).state).toBe('moved');
    expect((await fs.readdir(to)).sort(), 'the marker went with the copy').toEqual(['alice'])
});

test('a published copy with its own marker left behind is relocated, and the marker removed; another\'s marker stops it untouched', async () => {
    const aliceHome = await seat('alice');
    const marker    = path.join(to, '.moving-alice.owner');

    // the shell went down after publishing the copy, before removing its marker
    await fs.mkdir(to, {recursive: true});
    await fs.cp(aliceHome, path.join(to, 'alice'), {recursive: true, verbatimSymlinks: true});
    await fs.writeFile(marker, 'move-0');

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to, moveId: 'move-1'})).reason).toBe(`'${marker}' is not this move's marker; remove it, then move again`);
    expect(await fs.readFile(marker, 'utf8')).toBe('move-0');

    await fs.writeFile(marker, 'move-1');

    expect(rowOf(await moveSeatHomes({registry: FleetRegistryService, from, to, moveId: 'move-1'}), 'alice').state).toBe('moved');
    expect((await fs.readdir(to)).sort()).toEqual(['alice'])
});

test('roots that resolve to the same folder, or one inside the other, refuse before anything is written', async () => {
    await seat('alice');
    await fs.mkdir(path.dirname(to), {recursive: true});
    await fs.symlink(from, to);

    expect(await moveSeatHomes({registry: FleetRegistryService, from, to})).toEqual({
        state : 'refused',
        reason: `'${to}' and '${from}' resolve to overlapping folders, so a copy would not be independent`,
        rows  : []
    });

    const nested = path.join(from, 'nested-root');

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to: nested})).state).toBe('refused');
    expect(await fs.readdir(from), 'nothing was staged under the source').toEqual(['alice']);
    expect(FleetRegistryService.getAgent('alice').seatHome).toBe(path.join(from, 'alice'))
});

test('a published copy whose seat folder differs in its own permissions is no verified copy; a fresh copy keeps them', async () => {
    const aliceHome = await seat('alice');

    await fs.chmod(aliceHome, 0o700);
    await fs.mkdir(to, {recursive: true});
    await fs.cp(aliceHome, path.join(to, 'alice'), {recursive: true, verbatimSymlinks: true});
    await fs.chmod(path.join(to, 'alice'), 0o777);

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to})).reason).toBe(`'${path.join(to, 'alice')}' holds something other than a verified copy of seat 'alice'`);

    await fs.rm(path.join(to, 'alice'), {recursive: true});

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to})).state).toBe('moved');
    expect((await fs.stat(path.join(to, 'alice'))).mode & 0o777).toBe(0o700)
});

test('sockets and pipes a harness left behind are not copied, and the row names them', async () => {
    const aliceHome = await seat('alice');

    execFileSync('mkfifo', [path.join(aliceHome, 'harness', 'codex', 'app.pipe')]);

    const result = await moveSeatHomes({registry: FleetRegistryService, from, to});

    expect(rowOf(result, 'alice')).toMatchObject({state: 'moved', skipped: [path.join('harness', 'codex', 'app.pipe')]});
    expect(await fs.lstat(path.join(to, 'alice', 'harness', 'codex', 'app.pipe')).catch(error => error.code)).toBe('ENOENT')
});

test('roots must be absolute and different', async () => {
    await expect(moveSeatHomes({registry: FleetRegistryService, from: 'agents', to})).rejects.toThrow("moveSeatHomes: 'from' must be an absolute agents root.");
    await expect(moveSeatHomes({registry: FleetRegistryService, from, to: from})).rejects.toThrow(`moveSeatHomes: the seats already live under '${from}'.`)
});

test('a moved Claude seat starts at its new root with its memory pin re-derived', async () => {
    const runtime = path.join(root, 'installed-neo');

    for (const relativePath of ['ai/mcp/server/memory-core/mcp-server.mjs', 'ai/mcp/server/knowledge-base/mcp-server.mjs', 'ai/mcp/server/neural-link/mcp-server.mjs', 'ai/mcp/server/github-workflow/mcp-server.mjs']) {
        await fs.mkdir(path.dirname(path.join(runtime, relativePath)), {recursive: true});
        await fs.writeFile(path.join(runtime, relativePath), '// installed canonical entrypoint\n')
    }

    FleetRegistryService.defineAgent({githubUsername: 'alice', harnessType: 'claude-code', credential: PAT});

    const prepare = (instanceRoot, previousInstanceRoot) => prepareManagedAgentWorkspace({
        agent         : FleetRegistryService.getAgent('alice'),
        targetRepoRoot: path.join(instanceRoot, 'alice', 'neomjs', 'neo'),
        instanceRoot,
        ...(previousInstanceRoot && {previousInstanceRoot}),
        agentosRuntimeRoot: runtime,
        nodePath          : process.execPath,
        hydrateWorkspace  : async ({projectRoot}) => { await fs.mkdir(projectRoot, {recursive: true}); return {hydrated: true} },
        residentMcpEnv    : Object.fromEntries(['memory-core', 'knowledge-base', 'neural-link', 'github-workflow'].map(key => [key, {NEO_PLANE_DATA_ROOT: path.join(root, 'plane')}]))
    });

    await prepare(from);

    expect((await moveSeatHomes({registry: FleetRegistryService, from, to})).state).toBe('moved');

    // Start's own derivation: the row names the home it left, under the root the harness homes live in
    const previousSeatHome = FleetRegistryService.getAgent('alice').previousSeatHome;

    await prepare(to, path.dirname(previousSeatHome));

    expect(JSON.parse(await fs.readFile(path.join(to, 'alice', 'neomjs', 'neo', '.claude', 'settings.local.json'), 'utf8')))
        .toEqual({autoMemoryDirectory: path.join(to, 'alice', 'memory')})
});
