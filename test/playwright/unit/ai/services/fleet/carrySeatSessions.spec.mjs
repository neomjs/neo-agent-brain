import {setup} from '../../../../setup.mjs';

const appName = 'CarrySeatSessionsTest';

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

import {test, expect}                              from '@playwright/test';
import Neo                                         from 'neo.mjs/src/Neo.mjs';
import * as core                                   from 'neo.mjs/src/core/_export.mjs';
import Database                                    from 'better-sqlite3';
import fs                                          from 'node:fs/promises';
import os                                          from 'node:os';
import path                                        from 'node:path';
import {pathToFileURL}                             from 'node:url';
import {registerAntigravityProject}                from '../../../../../../ai/services/fleet/antigravityProjectRegistry.mjs';
import {carrySeatSessions, claudeSlug, rehomePath} from '../../../../../../ai/services/fleet/carrySeatSessions.mjs';
import {MCP_SERVERS}                               from '../../../../../../src/fleet/contract/mcpServers.mjs';

/**
 * @summary A renamed seat resumes the very same sessions: each harness's own session index, in the shape measured
 * on the plane host, points at the seat's new folder after the rename, a sibling seat whose name extends the old id
 * is never touched, history stays as it was written, and a re-run changes nothing.
 */

let root, agents, homeDir;

test.beforeEach(async () => {
    root    = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'carry-seat-sessions-')));
    agents  = path.join(root, 'agents');
    homeDir = path.join(root, 'home')
});

test.afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true})
});

/** @summary Writes `content` (an object as JSON) at `file`, creating its folder. */
async function put(file, content, {mode = 0o644, indent} = {}) {
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, indent), {mode})
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('a value is re-pointed only when it is the folder or a path inside it', () => {
    const from = '/agents/neo-gpt', to = '/agents/neo-gpt-euclid';

    expect(rehomePath(from, from, to)).toBe(to);
    expect(rehomePath(`${from}/neomjs/neo`, from, to)).toBe(`${to}/neomjs/neo`);
    expect(rehomePath(`local:${from}/harness`, from, to), 'Codex Desktop\'s host key').toBe(`local:${to}/harness`);
    expect(rehomePath(`file://${from}/neomjs/neo`, from, to)).toBe(`file://${to}/neomjs/neo`);
    expect(rehomePath('/agents/neo-gpt-emmy/neomjs', from, to), 'a sibling whose name extends the id').toBe('/agents/neo-gpt-emmy/neomjs');
    expect(rehomePath(`see ${from}/neomjs`, from, to), 'text that mentions the folder').toBe(`see ${from}/neomjs`);
    expect(rehomePath(`${to}/neomjs`, from, to), 'an already carried value').toBe(`${to}/neomjs`);
    expect(rehomePath(42, from, to)).toBe(42)
});

test('Claude Desktop: its session records and new-session folder point at the new folder, and the transcripts follow by their own cwd', async () => {
    const
        from         = path.join(agents, 'neo-fable'),
        to           = path.join(agents, 'neo-fable-mnemosyne'),
        clio         = path.join(agents, 'neo-fable-clio', 'neomjs', 'neo'),
        instanceHome = path.join(to, 'harness', 'claude-desktop'),
        record       = path.join(instanceHome, 'claude-code-sessions', 'account', 'org', 'local_1.json'),
        presets      = path.join(instanceHome, 'ccd-session-presets.json'),
        worktrees    = path.join(instanceHome, 'git-worktrees.json'),
        projects     = path.join(homeDir, '.claude', 'projects'),
        clone        = dir => path.join(dir, 'neomjs', 'neo'),
        stage        = dir => path.join(dir, 'neomjs', 'neo-stage');

    await put(record, {cliSessionId: 's-1', cwd: clone(from), originCwd: clone(from), gitAnchors: [{gitRoot: clone(from), commonDir: path.join(clone(from), '.git')}], title: `Work in ${clone(from)}`});
    await put(presets, {byAccount: {account: {presets: [{target: {cwd: clone(from)}}]}}}, {indent: 2});
    await put(worktrees, {[clone(from)]: {originUrl: 'https://github.com/neomjs/neo.git', gitDir: path.join(clone(from), '.git')}, [clio]: {originUrl: 'https://github.com/neomjs/neo.git'}}, {indent: 2});
    await put(path.join(projects, claudeSlug(clone(from)), 's-1.jsonl'), `${JSON.stringify({type: 'summary'})}\n${JSON.stringify({type: 'user', cwd: clone(from)})}\n`);
    // the slug of neo-fable-clio/neomjs/neo extends the old one, but its transcripts ran in another seat
    await put(path.join(projects, claudeSlug(clio), 's-2.jsonl'), `${JSON.stringify({type: 'user', cwd: clio})}\n`);
    // a folder whose new name is already taken stays as it is, and the result says so
    await put(path.join(projects, claudeSlug(stage(from)), 's-3.jsonl'), `${JSON.stringify({cwd: stage(from)})}\n`);
    await fs.mkdir(path.join(projects, claudeSlug(stage(to))), {recursive: true});

    const carry  = () => carrySeatSessions({harnessType: 'claude-desktop', instanceHome, from, to, previousId: 'neo-fable', id: 'neo-fable-mnemosyne', homeDir}),
          kept   = `${claudeSlug(stage(from))} → kept: ${claudeSlug(stage(to))} exists`,
          result = await carry();

    expect(result).toEqual({records: 3, transcripts: [`${claudeSlug(clone(from))} → ${claudeSlug(clone(to))}`, kept]});
    expect(await readJson(record)).toEqual({cliSessionId: 's-1', cwd: clone(to), originCwd: clone(to), gitAnchors: [{gitRoot: clone(to), commonDir: path.join(clone(to), '.git')}], title: `Work in ${clone(from)}`});
    expect(await readJson(presets)).toEqual({byAccount: {account: {presets: [{target: {cwd: clone(to)}}]}}});
    expect(await readJson(worktrees)).toEqual({[clone(to)]: {originUrl: 'https://github.com/neomjs/neo.git', gitDir: path.join(clone(to), '.git')}, [clio]: {originUrl: 'https://github.com/neomjs/neo.git'}});
    expect(await fs.readFile(presets, 'utf8'), 'its indentation is kept').toContain('\n  "byAccount"');
    expect((await fs.readdir(projects)).sort()).toEqual([claudeSlug(clone(to)), claudeSlug(clio), claudeSlug(stage(from)), claudeSlug(stage(to))].sort());
    expect(await fs.readFile(path.join(projects, claudeSlug(clone(to)), 's-1.jsonl'), 'utf8'), 'a transcript is history, kept as written').toContain(`"cwd":"${clone(from)}"`);

    expect(await carry(), 'a re-run moves nothing, and still reports the kept folder').toEqual({records: 0, transcripts: [kept]})
});

test('Claude Code: the transcripts in its own config home follow', async () => {
    const
        from         = path.join(agents, 'neo-opus'),
        to           = path.join(agents, 'neo-opus-vega'),
        instanceHome = path.join(to, 'harness', 'claude-code'),
        cwd          = path.join(from, 'neomjs', 'neo');

    await put(path.join(instanceHome, 'projects', claudeSlug(cwd), 's.jsonl'), `${JSON.stringify({cwd})}\n`);

    expect(await carrySeatSessions({harnessType: 'claude-code', instanceHome, from, to, previousId: 'neo-opus', id: 'neo-opus-vega', homeDir}))
        .toEqual({transcripts: [`${claudeSlug(cwd)} → ${claudeSlug(path.join(to, 'neomjs', 'neo'))}`]})
});

test('Codex Desktop: its threads, projects, host keys and config point at the new folder; its rollouts stay byte-identical', async () => {
    const
        from         = path.join(agents, 'neo-gpt'),
        to           = path.join(agents, 'neo-gpt-euclid'),
        emmy         = path.join(agents, 'neo-gpt-emmy', 'neomjs', 'neo'),
        instanceHome = path.join(to, 'harness', 'codex-desktop'),
        codexHome    = path.join(instanceHome, 'codex-home'),
        oldCodexHome = path.join(from, 'harness', 'codex-desktop', 'codex-home'),
        clone        = dir => path.join(dir, 'neomjs', 'neo'),
        rollout      = path.join(codexHome, 'sessions', '2026', '10', '19', 'rollout-1.jsonl'),
        rolloutText  = `${JSON.stringify({type: 'session_meta', payload: {cwd: clone(from)}})}\n${JSON.stringify({type: 'turn_context', payload: {cwd: clone(from)}})}\n`;

    await put(rollout, rolloutText);

    const db = new Database(path.join(codexHome, 'state_5.sqlite'));

    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL)');
    db.exec('CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position))');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('t-1', path.join(oldCodexHome, 'sessions', '2026', '10', '19', 'rollout-1.jsonl'), clone(from), `Review ${clone(from)}`);
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('t-2', path.join(root, 'elsewhere', 'rollout-2.jsonl'), emmy, 'Elsewhere');
    db.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run('p-1', 0, clone(from));
    db.close();

    const globalState = {
        'local-projects'                                    : {'p-1': {id: 'p-1', name: 'neo', rootPaths: [clone(from)]}},
        'app-server-project-id-by-legacy-project-id-by-host': {[`local:${oldCodexHome}`]: {'p-1': 'p-1'}},
        'electron-persisted-atom-state'                     : {draft: `read ${clone(from)}/README.md`},
        'sibling'                                           : emmy
    };

    await put(path.join(codexHome, '.codex-global-state.json'), globalState);
    await put(path.join(codexHome, '.codex-global-state.json.bak'), globalState);
    await put(path.join(codexHome, 'config.toml'), [
        `notify = ["${oldCodexHome}/computer-use/Client", "turn-ended"]`,
        `[projects."${clone(from)}"]`,
        'trust_level = "trusted"',
        '[mcp_servers.node_repl.env]',
        `TRUSTED = "${oldCodexHome}:/Applications/Codex.app"`,
        `[projects."${emmy}"]`,
        ''
    ].join('\n'), {mode: 0o600});

    const carry  = () => carrySeatSessions({harnessType: 'codex-desktop', instanceHome, from, to, previousId: 'neo-gpt', id: 'neo-gpt-euclid', homeDir}),
          result = await carry();

    expect(result).toEqual({threads: 3, files: ['.codex-global-state.json', '.codex-global-state.json.bak', 'config.toml']});

    const state = new Database(path.join(codexHome, 'state_5.sqlite'), {readonly: true});

    expect(state.prepare('SELECT id, rollout_path, cwd, title FROM threads ORDER BY id').all()).toEqual([
        {id: 't-1', rollout_path: rollout, cwd: clone(to), title: `Review ${clone(from)}`},
        {id: 't-2', rollout_path: path.join(root, 'elsewhere', 'rollout-2.jsonl'), cwd: emmy, title: 'Elsewhere'}
    ]);
    expect(state.prepare('SELECT path FROM project_roots').all()).toEqual([{path: clone(to)}]);
    state.close();

    const newCodexHome = path.join(to, 'harness', 'codex-desktop', 'codex-home');

    expect(await readJson(path.join(codexHome, '.codex-global-state.json'))).toEqual({
        'local-projects'                                    : {'p-1': {id: 'p-1', name: 'neo', rootPaths: [clone(to)]}},
        'app-server-project-id-by-legacy-project-id-by-host': {[`local:${newCodexHome}`]: {'p-1': 'p-1'}},
        'electron-persisted-atom-state'                     : {draft: `read ${clone(from)}/README.md`},
        'sibling'                                           : emmy
    });
    expect(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).toBe([
        `notify = ["${newCodexHome}/computer-use/Client", "turn-ended"]`,
        `[projects."${clone(to)}"]`,
        'trust_level = "trusted"',
        '[mcp_servers.node_repl.env]',
        `TRUSTED = "${newCodexHome}:/Applications/Codex.app"`,
        `[projects."${emmy}"]`,
        ''
    ].join('\n'));
    expect((await fs.stat(path.join(codexHome, 'config.toml'))).mode & 0o777, 'its mode is kept').toBe(0o600);
    expect(await fs.readFile(rollout, 'utf8'), 'its thread history indexes the rollout by byte offset').toBe(rolloutText);

    expect(await carry(), 'a re-run changes nothing').toEqual({threads: 0, files: []})
});

test('Antigravity: the project keeps its id under the new name and folder, and the next Start verifies that same project', async () => {
    const
        from         = path.join(agents, 'neo-gemini-pro'),
        to           = path.join(agents, 'neo-gemini-julia'),
        instanceHome = path.join(to, 'harness', 'antigravity'),
        registry     = path.join(homeDir, '.gemini', 'config', 'projects'),
        projectId    = 'a413c2d0-4a50-464e-a961-f5f36cd86a67',
        receiptPath  = path.join(instanceHome, '.neo-fleet-project-binding.json'),
        projectPath  = path.join(registry, `${projectId}.json`),
        rules        = MCP_SERVERS.map(({key}) => `mcp(neo-mjs-${key}/*)`),
        grants       = {permissionGrants: {allow: rules}, v2Migrated: true};

    await put(receiptPath, {version: 1, projectId, projectName: 'neo-gemini-pro', projectRoot: path.join(from, 'neomjs', 'neo')}, {mode: 0o600, indent: 2});
    // the shape Julia's project file has on the plane host: a git folder resource
    await put(projectPath, {id: projectId, name: 'neo-gemini-pro', projectResources: {resources: [{gitFolder: {folderUri: pathToFileURL(path.join(from, 'neomjs', 'neo')).href}}]}, permissionGrants: grants, settings: {}, isWorkspaceOnly: false});
    await fs.mkdir(path.join(to, 'neomjs', 'neo'), {recursive: true});

    const
        carry         = () => carrySeatSessions({harnessType: 'antigravity', instanceHome, from, to, previousId: 'neo-gemini-pro', id: 'neo-gemini-julia', homeDir}),
        conversations = 'kept: ~/.gemini/antigravity/conversations protobufs keep the old workspace URI; start a new conversation';

    expect(await carry()).toEqual({receipt: 'repointed', project: 'repointed', conversations});
    expect(await readJson(receiptPath)).toEqual({version: 1, projectId, projectName: 'neo-gemini-julia', projectRoot: path.join(to, 'neomjs', 'neo')});
    expect((await fs.stat(receiptPath)).mode & 0o777, 'the receipt stays private').toBe(0o600);
    expect(await readJson(projectPath)).toEqual({id: projectId, name: 'neo-gemini-julia', projectResources: {resources: [{gitFolder: {folderUri: pathToFileURL(path.join(to, 'neomjs', 'neo')).href}}]}, permissionGrants: grants, settings: {}, isWorkspaceOnly: false});

    const registered = await registerAntigravityProject({registryDirectory: registry, profileDirectory: instanceHome, projectRoot: path.join(to, 'neomjs', 'neo'), name: 'neo-gemini-julia', projectMcpAllowRules: rules});

    expect(registered, 'no new project: the conversations stay with this one').toMatchObject({verified: true, created: false, projectId});
    expect(await carry(), 'a re-run changes nothing').toEqual({receipt: 'current', project: 'current', conversations})
});

test('a seat without a project receipt, or a harness whose sessions the Fleet does not know, carries nothing', async () => {
    const from = path.join(agents, 'neo-x'), to = path.join(agents, 'neo-y');

    expect(await carrySeatSessions({harnessType: 'antigravity', instanceHome: path.join(to, 'harness', 'antigravity'), from, to, previousId: 'neo-x', id: 'neo-y', homeDir}))
        .toEqual({receipt: 'absent', project: 'absent'});
    expect(await carrySeatSessions({harnessType: 'kimi-code', instanceHome: path.join(to, 'harness', 'kimi-code'), from, to, previousId: 'neo-x', id: 'neo-y', homeDir})).toBeNull()
});
