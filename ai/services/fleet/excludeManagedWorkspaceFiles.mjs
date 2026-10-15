import {execFileSync}                                            from 'node:child_process';
import fs                                                        from 'node:fs';
import path                                                      from 'node:path';
import {writeLocalExclude}                                       from '../../scripts/lifecycle/hooks/projectSeatHooks.mjs';
import {ANTIGRAVITY_MEMORY_FILE, ANTIGRAVITY_MCP_WORKSPACE_FILE} from './generateAntigravityMcpFiles.mjs';

export const MANAGED_WORKSPACE_EXCLUDE_TARGETS = Object.freeze([ANTIGRAVITY_MCP_WORKSPACE_FILE, ANTIGRAVITY_MEMORY_FILE]);

const
    EXCLUDE_BLOCK_OWNER = 'fleetAntigravityWorkspace',
    EXCLUDE_BLOCK_LABEL = 'generated workspace files, do not edit inside this block',
    GIT_NULL_CONFIG     = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * @summary Exclude the fixed generated Antigravity workspace file after proving a normal managed clone.
 * The target file itself is never created here: the root binding, ordinary `.git` directory and
 * untracked target are all checked before the separate Fleet-owned block is written to local exclude.
 * @param {Object} options
 * @param {String} options.targetRepoRoot Explicit absolute managed checkout root.
 * @returns {{repoRoot: String, paths: String[], verified: Boolean, excludeFile: String}} Receipt for the exact root and generated paths.
 * @throws {Error} When the root is not the exact ordinary clone root, the target is tracked, or Git metadata is unsafe.
 */
export function excludeManagedWorkspaceFiles({targetRepoRoot} = {}) {
    if (typeof targetRepoRoot !== 'string' || !path.isAbsolute(targetRepoRoot) || targetRepoRoot.includes('\0')) {
        throw new TypeError('excludeManagedWorkspaceFiles: targetRepoRoot must be an absolute path.')
    }

    const
        rootPath    = path.resolve(targetRepoRoot),
        realRoot    = fs.realpathSync(rootPath),
        gitDir      = path.join(realRoot, '.git'),
        infoDir     = path.join(gitDir, 'info'),
        excludeFile = path.join(infoDir, 'exclude');

    if (realRoot !== rootPath) throw new Error('excludeManagedWorkspaceFiles: refusing a symlinked checkout path.');
    assertRealDirectory(realRoot, 'checkout root');
    assertRealDirectory(gitDir, 'checkout .git directory');
    assertRealDirectory(infoDir, 'checkout .git/info directory', {allowAbsent: true});
    assertRegularOrAbsent(excludeFile, 'checkout .git/info/exclude');

    const
        gitEnv         = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        isolatedGitEnv = {...gitEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG,
            GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'},
        topLevel = runGit(realRoot, ['rev-parse', '--show-toplevel'], isolatedGitEnv),
        resolvedGitDir = runGit(realRoot, ['rev-parse', '--absolute-git-dir'], isolatedGitEnv);

    if (path.resolve(topLevel) !== realRoot || path.resolve(resolvedGitDir) !== gitDir) {
        throw new Error('excludeManagedWorkspaceFiles: target is not an ordinary repository root.');
    }

    for (const target of MANAGED_WORKSPACE_EXCLUDE_TARGETS) {
        const tracked = runGit(realRoot, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', target], isolatedGitEnv, {untrackedIsNull: true});

        if (tracked !== null) throw new Error(`excludeManagedWorkspaceFiles: refusing tracked workspace artifact '${target}'.`)
    }

    const writtenExclude = writeLocalExclude({
        targetRepoRoot: realRoot,
        targets       : [...MANAGED_WORKSPACE_EXCLUDE_TARGETS],
        blockOwner    : EXCLUDE_BLOCK_OWNER,
        blockLabel    : EXCLUDE_BLOCK_LABEL,
        resolvedGitDir
    });

    if (path.resolve(writtenExclude) !== excludeFile) {
        throw new Error('excludeManagedWorkspaceFiles: local exclude writer resolved a different Git directory.')
    }
    assertRegularOrAbsent(excludeFile, 'checkout .git/info/exclude');

    for (const target of MANAGED_WORKSPACE_EXCLUDE_TARGETS) {
        runGit(realRoot, ['-c', `core.excludesFile=${GIT_NULL_CONFIG}`, 'check-ignore', '--no-index', '--quiet', '--', target], isolatedGitEnv)
    }

    return {
        repoRoot: realRoot,
        paths   : [...MANAGED_WORKSPACE_EXCLUDE_TARGETS],
        verified: true,
        excludeFile
    }
}

/** @summary Refuse a symlink or non-directory in the checkout's Git metadata chain. @private */
function assertRealDirectory(directoryPath, label, {allowAbsent = false} = {}) {
    let stat;
    try {
        stat = fs.lstatSync(directoryPath)
    } catch (error) {
        if (allowAbsent && error?.code === 'ENOENT') return;
        throw error
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`excludeManagedWorkspaceFiles: refusing unsafe ${label}.`)
}

/** @summary Refuse symlinked and non-file local exclude entries while allowing an absent file. @private */
function assertRegularOrAbsent(filePath, label) {
    let stat;
    try {
        stat = fs.lstatSync(filePath)
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error
    }

    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`excludeManagedWorkspaceFiles: refusing non-file or symlink ${label}.`)
}

/** @summary Run one shell-free Git proof with the caller's inherited Git overrides removed. @private */
function runGit(rootPath, args, env, {untrackedIsNull = false} = {}) {
    try {
        return execFileSync('git', ['-C', rootPath, '-c', 'core.fsmonitor=false', ...args], {
            encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe']
        }).trim()
    } catch (error) {
        if (untrackedIsNull && error?.status === 1) return null;
        throw new Error('excludeManagedWorkspaceFiles: Git could not prove the checkout state.')
    }
}
