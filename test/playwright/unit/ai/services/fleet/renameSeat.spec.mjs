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
import fs                                            from 'node:fs/promises';
import os                                            from 'node:os';
import path                                          from 'node:path';
import FleetRegistryService                          from '../../../../../../ai/services/fleet/FleetRegistryService.mjs';
import SeatOperatorRegistryService                   from '../../../../../../ai/services/fleet/SeatOperatorRegistryService.mjs';
import {SEAT_LEASE_FILE}                             from '../../../../../../ai/services/fleet/FleetLifecycleService.mjs';
import {deriveAgentInstanceHome}                     from '../../../../../../ai/services/fleet/deriveAgentInstanceHome.mjs';
import {renameSeat}                                  from '../../../../../../ai/services/fleet/renameSeat.mjs';
import {claudeSlug}                                  from '../../../../../../ai/services/fleet/carrySeatSessions.mjs';
import {readSeatWindowRecord, writeSeatWindowRecord} from '../../../../../../ai/services/fleet/seatWindowRect.mjs';

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
    tenants = {calls: [], renameSeatPlaneCredentials(args) { this.calls.push(args); return {status: 'renamed', endpoints: ['http://127.0.0.1:3102']} }};

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

test('a dry run plans the copy and changes nothing', async () => {
    const home = await seat('neo-gpt');

    const result = await rename('neo-gpt', 'neo-gpt-euclid', {dryRun: true});

    expect(result).toEqual({state: 'planned', plan: {id: 'neo-gpt', to: 'neo-gpt-euclid', seatHome: home, destination: path.join(agents, 'neo-gpt-euclid'), materialized: true, state: 'copy'}});
    expect(FleetRegistryService.getAgent('neo-gpt')).toMatchObject({seatHome: home});
    expect(FleetRegistryService.getAgent('neo-gpt-euclid')).toBeNull();
    expect(await fs.readdir(agents)).toEqual(['neo-gpt']);
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

    expect(result.plan.sessions).toEqual({transcripts: [`${claudeSlug(path.join(home, clone))} → ${claudeSlug(path.join(destination, clone))}`]});
    expect(await fs.readdir(path.join(homeOf('neo-gpt-euclid'), 'projects'))).toEqual([claudeSlug(path.join(destination, clone))]);
    expect(await fs.readFile(path.join(destination, clone, 'README.md'), 'utf8')).toBe('# neo-gpt\n');
    expect(await fs.readFile(path.join(home, clone, 'README.md'), 'utf8'), 'the old folder is the cold copy').toBe('# neo-gpt\n');
    expect((await fs.readdir(agents)).sort(), 'no staging folder or marker remains').toEqual(['neo-gpt', 'neo-gpt-euclid'])
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
    expect((await fs.readdir(agents)).sort()).toEqual(['neo-gemini-julia', 'neo-gemini-pro'])
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
    expect(tenants.calls).toEqual([{from: 'neo-fable', to: 'neo-fable-mnemosyne'}]);

    const second = await rename('neo-fable', 'neo-fable-mnemosyne');

    expect(second.plan).toMatchObject({state: 'done', windowRecord: 'current', sessions: {transcripts: []}});
    expect(FleetRegistryService.resolveCredential('neo-fable-mnemosyne')).toBe(PAT);
    expect(SeatOperatorRegistryService.operatorOf('neo-fable-mnemosyne').principal).toBe(OPERATOR)
});

test('a seat the registry does not know is refused', async () => {
    expect(await rename('neo-nobody', 'neo-somebody')).toEqual({state: 'refused', reason: 'no seat \'neo-nobody\' is defined', plan: {id: 'neo-nobody', to: 'neo-somebody'}})
});
