import {setup} from '../../../../setup.mjs';

const appName = 'RenameSeatTest';

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

import {test, expect}                                from '@playwright/test';
import Neo                                           from 'neo.mjs/src/Neo.mjs';
import * as core                                     from 'neo.mjs/src/core/_export.mjs';
import {execFileSync, spawnSync}                     from 'node:child_process';
import fs                                            from 'node:fs/promises';
import os                                            from 'node:os';
import path                                          from 'node:path';
import {fileURLToPath}                               from 'node:url';
import FleetRegistryService                          from '../../../../../../ai/services/fleet/FleetRegistryService.mjs';
import SeatOperatorRegistryService                   from '../../../../../../ai/services/fleet/SeatOperatorRegistryService.mjs';
import {SEAT_LEASE_FILE}                             from '../../../../../../ai/services/fleet/FleetLifecycleService.mjs';
import {deriveAgentInstanceHome}                     from '../../../../../../ai/services/fleet/deriveAgentInstanceHome.mjs';
import {renameSeat}                                  from '../../../../../../ai/services/fleet/renameSeat.mjs';
import {claudeSlug}                                  from '../../../../../../ai/services/fleet/carrySeatSessions.mjs';
import {readSeatWindowRecord, writeSeatWindowRecord} from '../../../../../../ai/services/fleet/seatWindowRect.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/**
 * @summary A seat's Fleet id rename on real temp folders and the real registry: the folder is copied, proven and
 * published under the new name before the row is re-keyed, the PAT, the operator, the plane credentials, the window
 * record and the sessions follow the row, every refusal changes nothing, and a re-run completes an interrupted rename.
 */

const
    PAT      = 'ghp_fixture_only',
    OPERATOR = 'owner:github:tobiu',
    RECT     = {x: 10, y: 20, width: 800, height: 600};

let agents, homeDir, root, tenants;

test.beforeEach(async () => {
    root    = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rename-seat-')));
    agents  = path.join(root, 'agents');
    homeDir = path.join(root, 'home');
    tenants = {calls: [], renameSeatPlaneCredentials({dryRun = false, ...args}) { !dryRun && this.calls.push(args); return {status: dryRun ? 'planned' : 'renamed', endpoints: ['http://127.0.0.1:3102']} }};

    FleetRegistryService.dataDir        = path.join(root, 'fleet');
    FleetRegistryService.agentsRoot     = agents;
    SeatOperatorRegistryService.dataDir = path.join(root, 'fleet')
});

test.afterEach(async () => {
    FleetRegistryService.dataDir        = null;
    FleetRegistryService.agentsRoot     = null;
    SeatOperatorRegistryService.dataDir = null;
    await fs.rm(root, {recursive: true, force: true})
});

/**
 * @summary Defines a Claude Code seat with an operator, and when materialized gives it a harness home, a clone,
 * a window record and one session transcript, as the Fleet and the harness leave them.
 */
async function seat(id, {materialized = true} = {}) {
    const harnessType = 'claude-code', home = path.join(agents, id), clone = path.join(home, 'neomjs', 'neo');

    FleetRegistryService.defineAgent({githubUsername: id, harnessType, credential: PAT});
    SeatOperatorRegistryService.claim({principal: OPERATOR, seatId: id});

    if (materialized) {
        const instanceHome = deriveAgentInstanceHome({instanceRoot: agents, agentId: id, harnessType}),
              transcripts  = path.join(instanceHome, 'projects', claudeSlug(clone));

        await fs.mkdir(transcripts, {recursive: true});
        await fs.mkdir(clone, {recursive: true});
        await fs.writeFile(path.join(clone, 'README.md'), `# ${id}\n`);
        await fs.writeFile(path.join(transcripts, 'session-1.jsonl'), `${JSON.stringify({type: 'user', cwd: clone})}\n`);
        writeSeatWindowRecord({instanceHome, agentId: id, harnessType, rect: RECT, capturedAt: '2026-10-19T12:00:00.000Z'})
    }

    return home
}

const rename = (id, to, options = {}) => renameSeat({registry: FleetRegistryService, tenants, id, to, homeDir, ...options});

test('a dry run plans the copy, reports sessions, links, windowRecord, planeCredentials and retiredSeatHome, and changes nothing (#1226)', async () => {
    const
        home        = await seat('neo-gpt'),
        destination = path.join(agents, 'neo-gpt-euclid'),
        clone       = path.join('neomjs', 'neo'),
        today       = new Date().toISOString().slice(0, 10).replace(/-/g, ''),
        result      = await rename('neo-gpt', 'neo-gpt-euclid', {dryRun: true});

    expect(result).toEqual({
        state: 'planned',
        plan : {
            id              : 'neo-gpt',
            to              : 'neo-gpt-euclid',
            seatHome        : home,
            destination,
            materialized    : true,
            state           : 'copy',
            planeCredentials: ['http://127.0.0.1:3102'],
            windowRecord    : 'renamed',
            sessions        : {transcripts: [`${claudeSlug(path.join(home, clone))} → ${claudeSlug(path.join(destination, clone))}`], count: 1},
            links           : {worktrees: [], symlinks: []},
            retiredSeatHome : path.join(root, 'retired-seats', `neo-gpt.pre-rename-${today}`)
        }
    });
    expect(FleetRegistryService.getAgent('neo-gpt')).toMatchObject({seatHome: home});
    expect(FleetRegistryService.getAgent('neo-gpt-euclid')).toBeNull();
    expect(await fs.readdir(agents)).toEqual(['neo-gpt']);
    expect(await fs.readdir(path.join(root, 'retired-seats')).catch(() => [])).toEqual([]);
    expect(tenants.calls).toEqual([])
});

test('the folder is copied and published under the new name, and the row, PAT, operator, plane credentials, window record and sessions follow it', async () => {
    const
        home        = await seat('neo-gpt'),
        destination = path.join(agents, 'neo-gpt-euclid'),
        homeOf      = id => deriveAgentInstanceHome({instanceRoot: agents, agentId: id, harnessType: 'claude-code'});

    const result = await rename('neo-gpt', 'neo-gpt-euclid', {moveId: 'rename-1'});

    expect(result.state).toBe('renamed');
    expect(result.plan).toMatchObject({seatHome: home, destination, materialized: true, state: 'copy', planeCredentials: ['http://127.0.0.1:3102'], windowRecord: 'renamed'});
    expect(FleetRegistryService.getAgent('neo-gpt')).toBeNull();
    expect(FleetRegistryService.getAgent('neo-gpt-euclid')).toMatchObject({id: 'neo-gpt-euclid', seatHome: destination, previousSeatHome: home, previousId: 'neo-gpt', harnessType: 'claude-code'});
    expect(FleetRegistryService.resolveCredential('neo-gpt-euclid')).toBe(PAT);
    expect(FleetRegistryService.resolveCredential('neo-gpt'), 'the old id keeps no PAT').toBeNull();
    expect(SeatOperatorRegistryService.operatorOf('neo-gpt-euclid')).toEqual({state: 'ok', principal: OPERATOR});
    expect(SeatOperatorRegistryService.operatorOf('neo-gpt')).toEqual({state: 'ok', principal: null});
    expect(tenants.calls).toEqual([{from: 'neo-gpt', to: 'neo-gpt-euclid'}]);
    expect(readSeatWindowRecord(homeOf('neo-gpt-euclid'))).toMatchObject({agentId: 'neo-gpt-euclid', harnessType: 'claude-code', rect: RECT, capturedAt: '2026-10-19T12:00:00.000Z'});

    const clone = path.join('neomjs', 'neo');

    expect(result.plan.sessions).toEqual({transcripts: [`${claudeSlug(path.join(home, clone))} → ${claudeSlug(path.join(destination, clone))}`], count: 1});
    expect(await fs.readdir(path.join(homeOf('neo-gpt-euclid'), 'projects'))).toEqual([claudeSlug(path.join(destination, clone))]);
    expect(await fs.readFile(path.join(destination, clone, 'README.md'), 'utf8')).toBe('# neo-gpt\n');
    expect(result.plan.retiredSeatHome).toMatch(/^.*\/retired-seats\/neo-gpt\.pre-rename-\d{8}$/);
    expect(await fs.readFile(path.join(result.plan.retiredSeatHome, clone, 'README.md'), 'utf8'), 'the old folder is retired off agentsRoot').toBe('# neo-gpt\n');
    expect(await fs.readdir(agents), 'neither the old home nor any staging file remains under agentsRoot').toEqual(['neo-gpt-euclid'])
});

test('a seat never materialized keeps no folder, and only its row is re-keyed', async () => {
    await seat('neo-fable', {materialized: false});

    const result = await rename('neo-fable', 'neo-fable-mnemosyne');

    expect(result).toMatchObject({state: 'renamed', plan: {materialized: false, state: 'rebind'}});
    expect(FleetRegistryService.getAgent('neo-fable-mnemosyne')).toMatchObject({seatHome: path.join(agents, 'neo-fable-mnemosyne'), previousId: 'neo-fable'});
    expect(await fs.readdir(agents).catch(() => [])).toEqual([])
});

test('each refusal changes nothing', async () => {
    const home = await seat('neo-gpt');
    await seat('neo-gpt-euclid', {materialized: false});

    const unchanged = async () => {
        expect(FleetRegistryService.getAgent('neo-gpt')).toMatchObject({seatHome: home});
        expect(FleetRegistryService.resolveCredential('neo-gpt')).toBe(PAT);
        expect(SeatOperatorRegistryService.operatorOf('neo-gpt').principal).toBe(OPERATOR);
        expect(tenants.calls).toEqual([])
    };

    expect(await rename('neo-gpt', 'neo-gpt-euclid')).toEqual({state: 'refused', reason: '\'neo-gpt-euclid\' already names a seat', plan: {id: 'neo-gpt', to: 'neo-gpt-euclid'}});
    await unchanged();

    const leasePath = path.join(deriveAgentInstanceHome({instanceRoot: agents, agentId: 'neo-gpt', harnessType: 'claude-code'}), SEAT_LEASE_FILE);

    await fs.writeFile(leasePath, JSON.stringify({pid: process.pid}));
    expect((await rename('neo-gpt', 'neo-gpt-sophie')).reason).toBe(`seat 'neo-gpt' may still be running: its lease names live pid ${process.pid}. Quit it, or remove a lease you know is stale, then rename again`);
    await fs.rm(leasePath);
    await unchanged();

    await fs.mkdir(path.join(agents, '.moving-neo-gpt-sophie'));
    await fs.writeFile(path.join(agents, '.moving-neo-gpt-sophie.owner'), 'another-rename');
    expect((await rename('neo-gpt', 'neo-gpt-sophie', {moveId: 'rename-1'})).reason)
        .toBe(`'${path.join(agents, '.moving-neo-gpt-sophie.owner')}' is not this rename's marker; remove it, then rename again`);
    expect(await fs.readFile(path.join(agents, '.moving-neo-gpt-sophie.owner'), 'utf8')).toBe('another-rename');
    await fs.rm(path.join(agents, '.moving-neo-gpt-sophie'), {recursive: true});
    await fs.rm(path.join(agents, '.moving-neo-gpt-sophie.owner'));

    await fs.mkdir(path.join(agents, 'neo-gpt-sophie'));
    await fs.writeFile(path.join(agents, 'neo-gpt-sophie', 'notes.txt'), 'mine');
    expect((await rename('neo-gpt', 'neo-gpt-sophie')).reason).toBe(`'${path.join(agents, 'neo-gpt-sophie')}' holds something other than a verified copy of seat 'neo-gpt'`);
    expect(await fs.readFile(path.join(agents, 'neo-gpt-sophie', 'notes.txt'), 'utf8')).toBe('mine');
    await unchanged();

    FleetRegistryService.relocateSeatHome('neo-gpt', {from: home, to: path.join(root, 'elsewhere', 'neo-gpt-old')});
    expect((await rename('neo-gpt', 'neo-gpt-sophie')).reason).toBe(`seat 'neo-gpt' is bound to '${path.join(root, 'elsewhere', 'neo-gpt-old')}', a folder not named after it`)
});

test('a re-run discards its own staging folder and completes the rename', async () => {
    await seat('neo-gemini-pro');
    await fs.mkdir(path.join(agents, '.moving-neo-gemini-julia', 'harness'), {recursive: true});
    await fs.writeFile(path.join(agents, '.moving-neo-gemini-julia', 'partial'), 'cut short');
    await fs.writeFile(path.join(agents, '.moving-neo-gemini-julia.owner'), 'rename-1');

    const result = await rename('neo-gemini-pro', 'neo-gemini-julia', {moveId: 'rename-1'});

    expect(result).toMatchObject({state: 'renamed', plan: {state: 'copy'}});
    expect(await fs.readdir(path.join(agents, 'neo-gemini-julia'))).not.toContain('partial');
    expect(await fs.readdir(agents)).toEqual(['neo-gemini-julia'])
});

test('a re-run after the copy was published keeps the verified copy and re-keys the row', async () => {
    const home = await seat('neo-gemini-pro'), destination = path.join(agents, 'neo-gemini-julia');

    await fs.cp(home, destination, {recursive: true, verbatimSymlinks: true});

    expect((await rename('neo-gemini-pro', 'neo-gemini-julia', {dryRun: true})).plan.state).toBe('relocate');

    const result = await rename('neo-gemini-pro', 'neo-gemini-julia');

    expect(result).toMatchObject({state: 'renamed', plan: {state: 'relocate'}});
    expect(FleetRegistryService.getAgent('neo-gemini-julia')).toMatchObject({seatHome: destination, previousId: 'neo-gemini-pro'})
});

test('a re-run after the re-key finishes what follows it, and a further run changes nothing', async () => {
    const home = await seat('neo-fable'), destination = path.join(agents, 'neo-fable-mnemosyne');

    await fs.cp(home, destination, {recursive: true, verbatimSymlinks: true});
    // the registry write landed; the run stopped before anything that follows it
    FleetRegistryService.renameAgent('neo-fable', {to: 'neo-fable-mnemosyne', from: home, seatHome: destination});

    const first = await rename('neo-fable', 'neo-fable-mnemosyne');

    expect(first).toMatchObject({state: 'renamed', plan: {state: 'done', seatHome: home, destination, windowRecord: 'renamed'}});
    expect(first.plan.sessions.transcripts).toHaveLength(1);
    expect(first.plan.retiredSeatHome).toMatch(/^.*\/retired-seats\/neo-fable\.pre-rename-\d{8}$/);
    expect(await fs.readdir(agents)).toEqual(['neo-fable-mnemosyne']);
    expect(tenants.calls).toEqual([{from: 'neo-fable', to: 'neo-fable-mnemosyne'}]);

    const second = await rename('neo-fable', 'neo-fable-mnemosyne');

    expect(second.plan).toMatchObject({state: 'done', windowRecord: 'current', sessions: {transcripts: [], count: 0}, links: {worktrees: [], symlinks: []}, retiredSeatHome: first.plan.retiredSeatHome});
    expect(FleetRegistryService.resolveCredential('neo-fable-mnemosyne')).toBe(PAT);
    expect(SeatOperatorRegistryService.operatorOf('neo-fable-mnemosyne').principal).toBe(OPERATOR)
});

test('an existing same-day retired seat copy is preserved and the newly retired seat home takes the next -N sibling', async () => {
    await seat('neo-gpt');
    const
        today        = new Date().toISOString().slice(0, 10).replace(/-/g, ''),
        retiredRoot  = path.join(root, 'retired-seats'),
        existingCopy = path.join(retiredRoot, `neo-gpt.pre-rename-${today}`),
        secondCopy   = `${existingCopy}-2`;

    await fs.mkdir(existingCopy, {recursive: true});
    await fs.writeFile(path.join(existingCopy, 'earlier-backup.txt'), 'keep me\n');

    const first = await rename('neo-gpt', 'neo-gpt-euclid');

    expect(first.state).toBe('renamed');
    expect(first.plan.retiredSeatHome).toBe(secondCopy);
    expect(await fs.readFile(path.join(existingCopy, 'earlier-backup.txt'), 'utf8')).toBe('keep me\n');
    expect(await fs.readFile(path.join(secondCopy, 'neomjs', 'neo', 'README.md'), 'utf8')).toBe('# neo-gpt\n');

    const second = await rename('neo-gpt', 'neo-gpt-euclid');

    expect(second.state).toBe('renamed');
    expect(second.plan.retiredSeatHome).toBe(secondCopy);
    expect(await fs.readFile(path.join(existingCopy, 'earlier-backup.txt'), 'utf8')).toBe('keep me\n')
});

test('a seat the registry does not know is refused with the NEO_FLEET_DATA_DIR hint', async () => {
    expect(await rename('neo-nobody', 'neo-somebody')).toEqual({
        state : 'refused',
        reason: `no seat 'neo-nobody' is defined in '${path.join(root, 'fleet')}'; set NEO_FLEET_DATA_DIR to the Fleet Manager's fleet directory if it lives elsewhere`,
        plan  : {id: 'neo-nobody', to: 'neo-somebody'}
    })
});

test('a Claude Desktop seat whose preset target.cwd and git-worktrees.json name the old home names the new home after the rename', async () => {
    const
        home         = path.join(agents, 'neo-fable'),
        destination  = path.join(agents, 'neo-fable-mnemosyne'),
        oldClone     = path.join(home, 'neomjs', 'neo'),
        newClone     = path.join(destination, 'neomjs', 'neo'),
        instanceHome = deriveAgentInstanceHome({instanceRoot: agents, agentId: 'neo-fable', harnessType: 'claude-desktop'}),
        newHome      = deriveAgentInstanceHome({instanceRoot: agents, agentId: 'neo-fable-mnemosyne', harnessType: 'claude-desktop'});

    FleetRegistryService.defineAgent({githubUsername: 'neo-fable-mnemosyne', id: 'neo-fable', harnessType: 'claude-desktop', credential: PAT});
    await fs.mkdir(instanceHome, {recursive: true});
    await fs.mkdir(oldClone, {recursive: true});
    await fs.writeFile(path.join(instanceHome, 'ccd-session-presets.json'), JSON.stringify({
        byAccount: {account: {presets: [{name: 'neo', target: {cwd: oldClone}, seededFromDraft: true}]}}
    }, null, 2));
    await fs.writeFile(path.join(instanceHome, 'git-worktrees.json'), JSON.stringify({
        [oldClone]: {originUrl: 'https://github.com/neomjs/neo.git', gitDir: path.join(oldClone, '.git')}
    }, null, 2));

    const result = await rename('neo-fable', 'neo-fable-mnemosyne');

    expect(result).toMatchObject({state: 'renamed', plan: {sessions: {records: 2, transcripts: [], count: 0}}});
    expect(JSON.parse(await fs.readFile(path.join(newHome, 'ccd-session-presets.json'), 'utf8'))).toEqual({
        byAccount: {account: {presets: [{name: 'neo', target: {cwd: newClone}, seededFromDraft: true}]}}
    });
    expect(JSON.parse(await fs.readFile(path.join(newHome, 'git-worktrees.json'), 'utf8'))).toEqual({
        [newClone]: {originUrl: 'https://github.com/neomjs/neo.git', gitDir: path.join(newClone, '.git')}
    })
});

test('a git worktree under the seat passes git status after the rename, and symlinks into the old home resolve under the new home', async () => {
    const
        home        = await seat('neo-gemini-pro'),
        destination = path.join(agents, 'neo-gemini-julia'),
        mainRepo    = path.join(home, 'neomjs', 'neo'),
        worktree    = path.join(home, 'neomjs', 'neo-1217'),
        extRepo     = path.join(root, 'external-repo'),
        extWorktree = path.join(home, 'neomjs', 'ext-1217'),
        initRepo    = dir => {
            execFileSync('git', ['init', '-q'], {cwd: dir});
            execFileSync('git', ['config', 'user.email', 'test@neomjs.com'], {cwd: dir});
            execFileSync('git', ['config', 'user.name', 'Test'], {cwd: dir});
            execFileSync('git', ['add', '.'], {cwd: dir});
            execFileSync('git', ['commit', '-q', '-m', 'init'], {cwd: dir})
        };

    initRepo(mainRepo);
    await fs.mkdir(path.join(mainRepo, 'node_modules', 'pkg'), {recursive: true});
    await fs.writeFile(path.join(mainRepo, 'node_modules', 'pkg', 'index.js'), 'export default 1;\n');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/1217', worktree], {cwd: mainRepo});
    await fs.symlink(path.join(mainRepo, 'node_modules'), path.join(worktree, 'node_modules'));

    await fs.mkdir(extRepo, {recursive: true});
    await fs.writeFile(path.join(extRepo, 'README.md'), '# ext\n');
    initRepo(extRepo);
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/ext', extWorktree], {cwd: extRepo});
    await fs.symlink(path.join('..', '..', '..', 'neo-gemini-pro', 'neomjs', 'neo', 'README.md'), path.join(extWorktree, 'seat-readme.md'));

    const result = await rename('neo-gemini-pro', 'neo-gemini-julia');

    expect(result).toMatchObject({
        state: 'renamed',
        plan : {
            links: {
                worktrees: [path.join('neomjs', 'ext-1217'), path.join('neomjs', 'neo-1217')],
                symlinks : [path.join('neomjs', 'ext-1217', 'seat-readme.md'), path.join('neomjs', 'neo-1217', 'node_modules')]
            }
        }
    });

    const
        newWorktree    = path.join(destination, 'neomjs', 'neo-1217'),
        newExtWorktree = path.join(destination, 'neomjs', 'ext-1217');

    expect(execFileSync('git', ['-C', newWorktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {encoding: 'utf8'}).trim()).toBe('feat/1217');
    expect(execFileSync('git', ['-C', newWorktree, 'status', '--short'], {encoding: 'utf8'})).toBe('?? node_modules\n');
    expect(execFileSync('git', ['-C', newExtWorktree, 'status', '--short'], {encoding: 'utf8'})).toBe('?? seat-readme.md\n');
    expect(await fs.realpath(path.join(newWorktree, 'node_modules'))).toBe(path.join(destination, 'neomjs', 'neo', 'node_modules'));
    expect(await fs.realpath(path.join(newExtWorktree, 'seat-readme.md'))).toBe(path.join(destination, 'neomjs', 'neo', 'README.md'));

    // re-running is idempotent
    const second = await rename('neo-gemini-pro', 'neo-gemini-julia');

    expect(second).toMatchObject({
        state: 'renamed',
        plan : {links: {worktrees: [], symlinks: []}}
    });
    expect(execFileSync('git', ['-C', newWorktree, 'status', '--short'], {encoding: 'utf8'})).toBe('?? node_modules\n');
    expect(await fs.realpath(path.join(newWorktree, 'node_modules'))).toBe(path.join(destination, 'neomjs', 'neo', 'node_modules'));
    expect(await fs.realpath(path.join(newExtWorktree, 'seat-readme.md'))).toBe(path.join(destination, 'neomjs', 'neo', 'README.md'))
});

test('the CLI refuses and names NEO_FLEET_DATA_DIR with the default data dir and no such seat, and refuses when a live Fleet lease holds the registry', async () => {
    const
        home   = await seat('neo-gpt'),
        runCli = (args, env = {}) => {
            const envCopy = {...process.env, ...env};
            if (env.NEO_FLEET_DATA_DIR === undefined) delete envCopy.NEO_FLEET_DATA_DIR;

            const out = spawnSync(process.execPath, ['ai/scripts/fleet/renameSeat.mjs', ...args], {
                cwd     : repoRoot,
                encoding: 'utf8',
                env     : envCopy,
                timeout : 30_000
            });

            return {status: out.status, json: JSON.parse(out.stdout)}
        };

    const missing = runCli(['--id', 'neo-nobody', '--to', 'neo-somebody']);

    expect(missing.status).toBe(1);
    expect(missing.json.state).toBe('refused');
    expect(missing.json.reason).toContain('NEO_FLEET_DATA_DIR');

    const leasePath = path.join(root, 'fleet', 'launch-admission', 'issuer.lock');

    await fs.mkdir(path.dirname(leasePath), {recursive: true});
    await fs.writeFile(leasePath, JSON.stringify({pid: process.pid, owner: 'fleet-launch-admission', ownerToken: 't-1', startedAt: new Date().toISOString(), lastPulse: new Date().toISOString()}));

    const held = runCli(['--id', 'neo-gpt', '--to', 'neo-gpt-euclid', '--apply'], {NEO_FLEET_DATA_DIR: path.join(root, 'fleet')});

    expect(held.status).toBe(1);
    expect(held.json).toEqual({
        state : 'refused',
        reason: `the Fleet may still be running: its lease names live pid ${process.pid}. Quit the Fleet Manager, then rename again`,
        plan  : {id: 'neo-gpt', to: 'neo-gpt-euclid'}
    });
    expect(FleetRegistryService.getAgent('neo-gpt')).toMatchObject({seatHome: home})
});

test('a dry run reports the exact sessions, links, retiredSeatHome (-N sibling), windowRecord and planeCredentials that a subsequent apply produces, ignoring sibling-prefix transcripts (#1226)', async () => {
    const
        home         = path.join(agents, 'neo-fable'),
        destination  = path.join(agents, 'neo-fable-mnemosyne'),
        oldClone     = path.join(home, 'neomjs', 'neo'),
        newClone     = path.join(destination, 'neomjs', 'neo'),
        worktree     = path.join(home, 'neomjs', 'neo-1226'),
        extRepo      = path.join(root, 'external-repo'),
        extWorktree  = path.join(home, 'neomjs', 'ext-1226'),
        clioClone    = path.join(agents, 'neo-fable-clio', 'neomjs', 'neo'),
        projects     = path.join(homeDir, '.claude', 'projects'),
        instanceHome = deriveAgentInstanceHome({instanceRoot: agents, agentId: 'neo-fable', harnessType: 'claude-desktop'}),
        today        = new Date().toISOString().slice(0, 10).replace(/-/g, ''),
        retiredRoot  = path.join(root, 'retired-seats'),
        existingCopy = path.join(retiredRoot, `neo-fable.pre-rename-${today}`),
        secondCopy   = `${existingCopy}-2`,
        initRepo     = dir => {
            execFileSync('git', ['init', '-q'], {cwd: dir});
            execFileSync('git', ['config', 'user.email', 'test@neomjs.com'], {cwd: dir});
            execFileSync('git', ['config', 'user.name', 'Test'], {cwd: dir});
            execFileSync('git', ['add', '.'], {cwd: dir});
            execFileSync('git', ['commit', '-q', '-m', 'init'], {cwd: dir})
        };

    FleetRegistryService.defineAgent({githubUsername: 'neo-fable-mnemosyne', id: 'neo-fable', harnessType: 'claude-desktop', credential: PAT});
    SeatOperatorRegistryService.claim({principal: OPERATOR, seatId: 'neo-fable'});
    await fs.mkdir(instanceHome, {recursive: true});
    await fs.mkdir(oldClone, {recursive: true});
    await fs.writeFile(path.join(oldClone, 'README.md'), '# neo-fable\n');
    writeSeatWindowRecord({instanceHome, agentId: 'neo-fable', harnessType: 'claude-desktop', rect: RECT, capturedAt: '2026-10-19T12:00:00.000Z'});

    await fs.writeFile(path.join(instanceHome, 'ccd-session-presets.json'), JSON.stringify({
        byAccount: {account: {presets: [{name: 'neo', target: {cwd: oldClone}, seededFromDraft: true}]}}
    }, null, 2));
    await fs.writeFile(path.join(instanceHome, 'git-worktrees.json'), JSON.stringify({
        [oldClone]: {originUrl: 'https://github.com/neomjs/neo.git', gitDir: path.join(oldClone, '.git')}
    }, null, 2));

    await fs.mkdir(path.join(projects, claudeSlug(oldClone)), {recursive: true});
    await fs.writeFile(path.join(projects, claudeSlug(oldClone), 's-1.jsonl'), `${JSON.stringify({type: 'user', cwd: oldClone})}\n`);
    await fs.mkdir(path.join(projects, claudeSlug(clioClone)), {recursive: true});
    await fs.writeFile(path.join(projects, claudeSlug(clioClone), 's-2.jsonl'), `${JSON.stringify({type: 'user', cwd: clioClone})}\n`);

    initRepo(oldClone);
    await fs.mkdir(path.join(oldClone, 'node_modules', 'pkg'), {recursive: true});
    await fs.writeFile(path.join(oldClone, 'node_modules', 'pkg', 'index.js'), 'export default 1;\n');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/1226', worktree], {cwd: oldClone});
    await fs.symlink(path.join(oldClone, 'node_modules'), path.join(worktree, 'node_modules'));

    await fs.mkdir(extRepo, {recursive: true});
    await fs.writeFile(path.join(extRepo, 'README.md'), '# ext\n');
    initRepo(extRepo);
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/ext', extWorktree], {cwd: extRepo});
    await fs.symlink(path.join('..', '..', '..', 'neo-fable', 'neomjs', 'neo', 'README.md'), path.join(extWorktree, 'seat-readme.md'));

    await fs.mkdir(existingCopy, {recursive: true});

    const dry = await rename('neo-fable', 'neo-fable-mnemosyne', {dryRun: true});

    expect(dry).toEqual({
        state: 'planned',
        plan : {
            id              : 'neo-fable',
            to              : 'neo-fable-mnemosyne',
            seatHome        : home,
            destination,
            materialized    : true,
            state           : 'copy',
            planeCredentials: ['http://127.0.0.1:3102'],
            windowRecord    : 'renamed',
            sessions        : {
                records    : 2,
                transcripts: [`${claudeSlug(oldClone)} → ${claudeSlug(newClone)}`],
                count      : 1
            },
            links           : {
                worktrees: [path.join('neomjs', 'ext-1226'), path.join('neomjs', 'neo-1226')],
                symlinks : [path.join('neomjs', 'ext-1226', 'seat-readme.md'), path.join('neomjs', 'neo-1226', 'node_modules')]
            },
            retiredSeatHome : secondCopy
        }
    });

    // verify dryRun mutated nothing on disk, in the registry, in window records, in transcripts, or in tenants
    expect(FleetRegistryService.getAgent('neo-fable')).toMatchObject({seatHome: home});
    expect(FleetRegistryService.getAgent('neo-fable-mnemosyne')).toBeNull();
    expect(readSeatWindowRecord(instanceHome)).toMatchObject({agentId: 'neo-fable'});
    expect(JSON.parse(await fs.readFile(path.join(instanceHome, 'ccd-session-presets.json'), 'utf8')).byAccount.account.presets[0].target.cwd).toBe(oldClone);
    expect((await fs.readdir(projects)).sort()).toEqual([claudeSlug(oldClone), claudeSlug(clioClone)].sort());
    expect(await fs.readdir(retiredRoot)).toEqual([`neo-fable.pre-rename-${today}`]);
    expect(tenants.calls).toEqual([]);

    const applied = await rename('neo-fable', 'neo-fable-mnemosyne');

    expect(applied).toEqual({
        state: 'renamed',
        plan : dry.plan
    });
    expect((await fs.readdir(projects)).sort()).toEqual([claudeSlug(newClone), claudeSlug(clioClone)].sort())
});
