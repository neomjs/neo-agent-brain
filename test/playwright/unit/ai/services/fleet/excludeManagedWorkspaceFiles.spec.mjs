import {test, expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    excludeManagedWorkspaceFiles,
    MANAGED_WORKSPACE_EXCLUDE_TARGETS
} from '../../../../../../ai/services/fleet/excludeManagedWorkspaceFiles.mjs';
import {writeLocalExclude} from '../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';

const GIT_ENV = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL  : process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1'
};
const GIT_NULL_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';

let root;

test.beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-antigravity-exclude-')))
});

test.afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

function initRepo(name='repo', {emptyTemplate = false} = {}) {
    const repo = path.join(root, name);
    fs.mkdirSync(repo, {recursive: true});
    execFileSync('git', [...(emptyTemplate ? ['-c', 'init.templateDir='] : []), 'init', '-q'], {cwd: repo, env: GIT_ENV});
    return repo
}

function git(repo, args) {
    return execFileSync('git', ['-C', repo, '-c', `core.excludesFile=${GIT_NULL_CONFIG}`, ...args], {
        cwd: repo, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
}

test.describe('excludeManagedWorkspaceFiles', () => {
    test('writes a distinct anchored block, preserves hook exclusions across rewrites, and proves Git ignores the target', () => {
        const repo = initRepo();
        writeLocalExclude({targetRepoRoot: repo, targets: ['.claude/hooks/first.mjs']});
        const foreign = '# BEGIN fleetAntigravityWorkspaceExtra — another owner\n/keep-me.md\n# END fleetAntigravityWorkspaceExtra\n';
        fs.appendFileSync(path.join(repo, '.git/info/exclude'), foreign);
        const result = excludeManagedWorkspaceFiles({targetRepoRoot: repo});

        expect(result).toMatchObject({
            repoRoot: repo,
            paths: ['.agents/mcp_config.json'],
            verified: true,
            excludeFile: path.join(repo, '.git/info/exclude'),
        });
        expect(MANAGED_WORKSPACE_EXCLUDE_TARGETS).toEqual(['.agents/mcp_config.json']);
        expect(Object.isFrozen(MANAGED_WORKSPACE_EXCLUDE_TARGETS)).toBe(true);
        expect(fs.existsSync(path.join(repo, '.agents/mcp_config.json'))).toBe(false);

        const beforeHookRewrite = fs.readFileSync(result.excludeFile, 'utf8');
        expect(beforeHookRewrite).toContain('/.claude/hooks/first.mjs');
        expect(beforeHookRewrite).toContain(foreign);
        expect(beforeHookRewrite).toContain('# BEGIN fleetAntigravityWorkspace — generated workspace files, do not edit inside this block');
        expect(git(repo, ['check-ignore', '--no-index', '-v', '--', '.agents/mcp_config.json']))
            .toContain('/.agents/mcp_config.json');

        writeLocalExclude({targetRepoRoot: repo, targets: ['.claude/hooks/second.mjs']});
        const afterHookRewrite = fs.readFileSync(result.excludeFile, 'utf8');
        expect(afterHookRewrite).not.toContain('/.claude/hooks/first.mjs');
        expect(afterHookRewrite).toContain('/.claude/hooks/second.mjs');
        expect(afterHookRewrite).toContain(foreign);
        expect(afterHookRewrite).toContain('/.agents/mcp_config.json');
        expect(git(repo, ['status', '--short', '--untracked-files=all'])).toBe('');
    });

    test('refuses a tracked target before changing the local exclude file', () => {
        const
            repo = initRepo(),
            target = path.join(repo, '.agents/mcp_config.json');
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, '{}\n');
        execFileSync('git', ['-C', repo, 'add', '--', '.agents/mcp_config.json'], {env: GIT_ENV});
        const excludeFile = path.join(repo, '.git/info/exclude'), before = fs.readFileSync(excludeFile, 'utf8');

        expect(() => excludeManagedWorkspaceFiles({targetRepoRoot: repo})).toThrow(/refusing tracked workspace artifact/);
        expect(fs.readFileSync(excludeFile, 'utf8')).toBe(before);
    });

    test('empty-template init creates missing info only after proving the workspace target untracked', () => {
        const
            repo = initRepo('empty-template', {emptyTemplate: true}),
            infoDir = path.join(repo, '.git/info');
        expect(fs.existsSync(infoDir)).toBe(false);

        const receipt = excludeManagedWorkspaceFiles({targetRepoRoot: repo});
        expect(receipt.verified).toBe(true);
        expect(fs.statSync(infoDir).isDirectory()).toBe(true);
        expect(git(repo, ['check-ignore', '--no-index', '--quiet', '--', '.agents/mcp_config.json'])).toBe('');

        const tracked = initRepo('empty-template-tracked', {emptyTemplate: true}),
            target = path.join(tracked, '.agents/mcp_config.json');
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, '{}\n');
        execFileSync('git', ['-C', tracked, 'add', '--', '.agents/mcp_config.json'], {env: GIT_ENV});

        expect(() => excludeManagedWorkspaceFiles({targetRepoRoot: tracked})).toThrow(/refusing tracked workspace artifact/);
        expect(fs.existsSync(path.join(tracked, '.git/info'))).toBe(false);
    });

    test('refuses symlinked Git metadata and leaves its target untouched', () => {
        const
            repo = initRepo('repo'),
            other = initRepo('other'),
            outside = path.join(root, 'outside-exclude');
        fs.writeFileSync(outside, 'operator bytes\n');
        fs.rmSync(path.join(repo, '.git'), {recursive: true});
        fs.symlinkSync(path.join(other, '.git'), path.join(repo, '.git'), 'dir');

        expect(() => excludeManagedWorkspaceFiles({targetRepoRoot: repo})).toThrow(/unsafe checkout \.git directory/);
        expect(fs.readFileSync(outside, 'utf8')).toBe('operator bytes\n');
    });

    test('refuses an exclude symlink and malformed owned block without overwriting bytes', () => {
        const
            repo = initRepo('repo'),
            other = initRepo('other'),
            excludeFile = path.join(repo, '.git/info/exclude'),
            outside = path.join(root, 'outside-exclude');

        fs.writeFileSync(outside, 'operator bytes\n');
        fs.rmSync(excludeFile);
        fs.symlinkSync(outside, excludeFile);
        expect(() => excludeManagedWorkspaceFiles({targetRepoRoot: repo})).toThrow(/non-file or symlink/);
        expect(fs.readFileSync(outside, 'utf8')).toBe('operator bytes\n');

        fs.rmSync(excludeFile);
        fs.mkdirSync(excludeFile);
        expect(() => excludeManagedWorkspaceFiles({targetRepoRoot: repo})).toThrow(/non-file or symlink/);
        fs.rmSync(excludeFile, {recursive: true});

        fs.writeFileSync(excludeFile, '# BEGIN fleetAntigravityWorkspace — partial\n');
        const malformed = fs.readFileSync(excludeFile, 'utf8');
        expect(() => excludeManagedWorkspaceFiles({targetRepoRoot: repo})).toThrow(/malformed managed block/);
        expect(fs.readFileSync(excludeFile, 'utf8')).toBe(malformed);
        expect(fs.existsSync(path.join(other, '.git'))).toBe(true);
    });

    test('requires the explicit path to be the exact non-symlink repository root', () => {
        const repo = initRepo();

        expect(() => excludeManagedWorkspaceFiles({targetRepoRoot: path.join(repo, 'nested')})).toThrow(/ENOENT/);
        const alias = path.join(root, 'alias');
        fs.symlinkSync(repo, alias, 'dir');
        expect(() => excludeManagedWorkspaceFiles({targetRepoRoot: alias})).toThrow(/symlinked checkout path/);
    });
});
