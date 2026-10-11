import fs                                                 from 'node:fs';
import os                                                 from 'node:os';
import path                                               from 'node:path';
import {execFile}                                         from 'node:child_process';
import {promisify}                                        from 'node:util';
import {assertContained, assertRoot, deriveAgentRepoPath} from './deriveAgentRepoPath.mjs';
import {inspectAgentRepo}                                 from './inspectAgentRepo.mjs';

const execFileAsync = promisify(execFile);

/**
 * @summary Read a path without treating unreadability as absence.
 * @param {String} target
 * @returns {fs.Stats|null}
 * @private
 */
function removalPathStat(target) {
    try {return fs.lstatSync(target)} catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error
    }
}

/**
 * @summary Refuse symlinks or non-directories at every component from the trusted root to the checkout.
 * @param {String} managedRoot
 * @param {String} repoPath
 * @private
 */
function assertRemovalPath(managedRoot, repoPath) {
    const root = assertRoot(managedRoot, 'managedRoot', 'removeAgentRepo');
    assertContained(root, repoPath, 'removeAgentRepo');
    let current = root;

    for (const segment of ['', ...path.relative(root, repoPath).split(path.sep)]) {
        current = path.join(current, segment);
        const stats = fs.lstatSync(current);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('The managed checkout path crosses a link or a non-directory.')
        }
    }
}

/**
 * @summary Read local Git state without host config, path overrides, prompts or optional index writes.
 * @param {String} repoPath
 * @param {String[]} args
 * @returns {Promise<String>}
 * @private
 */
async function readRemovalGit(repoPath, args) {
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_|^(?:SSH_)?ASKPASS$/.test(key))),
        GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'
    };
    const {stdout} = await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, '-C', repoPath, ...args],
        {env, timeout: 10000, maxBuffer: 1024 * 1024});
    return stdout
}

/**
 * @summary Inspect retained work before a caller chooses removal. Ignored files are retained too;
 * only ignored root node_modules owned by an installed Fleet receipt is disposable. Stashes have
 * their own refusal; every local ref and detached HEAD must be covered by a remote-tracking ref.
 * Submodules, retained module histories and linked worktrees refuse: their Git storage is not inspected recursively.
 * Index flags that suppress working-tree inspection also refuse; a hidden modification is not a clean tree.
 * No fetch runs, so this does not establish current remote durability. These reads do not lock out
 * an external writer or establish which folders a running harness has open.
 * @param {Object} options
 * @param {String} options.managedRoot Trusted root containing the checkout.
 * @param {String} options.repoPath Derived checkout path.
 * @param {Boolean} [options.dependenciesOwned=false] The seat receipt records this checkout installed.
 * @param {Function} [options.readGit] `(repoPath, argv) => Promise<String>`, local read seam.
 * @returns {Promise<{safe: Boolean, reason?: String}>}
 */
export async function inspectRepoRemoval({managedRoot, repoPath, dependenciesOwned = false, readGit = readRemovalGit} = {}) {
    try {
        assertRemovalPath(managedRoot, repoPath)
    } catch {
        return {safe: false, reason: 'The managed checkout path is linked, missing or unreadable; nothing was deleted.'}
    }

    try {
        const top = (await readGit(repoPath, ['rev-parse', '--show-toplevel'])).trim();
        if (fs.realpathSync(top) !== fs.realpathSync(repoPath)) {
            return {safe: false, reason: 'This folder is not the checkout root; nothing was deleted.'}
        }

        const index = (await readGit(repoPath, ['ls-files', '--stage', '-v', '-z'])).split('\0').filter(Boolean);
        if (index.some(entry => /^[a-zS] /.test(entry))) {
            return {safe: false, reason: 'Git index flags hide working-tree inspection. Clear assume-unchanged or skip-worktree flags and inspect those files before deleting.'}
        }
        if (removalPathStat(path.join(repoPath, '.gitmodules')) || index.some(entry => entry.slice(2).startsWith('160000 '))) {
            return {safe: false, reason: 'The checkout contains submodules. Preserve and remove them by hand before deleting this checkout.'}
        }
        const gitDir      = (await readGit(repoPath, ['rev-parse', '--absolute-git-dir'])).trim(),
              modulesPath = path.join(gitDir, 'modules'), modules = removalPathStat(modulesPath);
        if (modules && (!modules.isDirectory() || fs.readdirSync(modulesPath).length)) {
            return {safe: false, reason: 'The checkout retains submodule history. Preserve and remove that module storage by hand before deleting.'}
        }
        const worktrees = (await readGit(repoPath, ['worktree', 'list', '--porcelain', '-z'])).split('\0').filter(entry => entry.startsWith('worktree '));
        if (worktrees.length !== 1) {
            return {safe: false, reason: 'The checkout has linked worktrees or an unreadable worktree list. Preserve, remove and prune the worktrees before deleting.'}
        }

        const entries = (await readGit(repoPath, ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal', '--ignore-submodules=none'])).split('\0'),
              changed = new Set(), ignored = new Set();

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry) continue;
            const code = entry.slice(0, 2), name = entry.slice(3), topLevel = name.split('/')[0];
            if (entry.length < 4 || entry[2] !== ' ') throw new Error('Malformed Git status.');
            if (code === '!!') {
                if (!(dependenciesOwned && name.startsWith('node_modules/'))) ignored.add(topLevel)
            } else {
                changed.add(topLevel);
                if (/[RC]/.test(code)) i++
            }
        }

        const names = set => [...set].map(name => JSON.stringify(name)).join(', ');
        if (changed.size) return {safe: false, reason: `Keep or commit the changed or untracked files before deleting: ${names(changed)}.`};
        if (ignored.size) return {safe: false, reason: `Keep or clear the ignored files before deleting: ${names(ignored)}.`};
        if ((await readGit(repoPath, ['stash', 'list', '--format=%gd'])).trim()) {
            return {safe: false, reason: 'The checkout has stash entries. Keep or clear them before deleting.'}
        }
        if ((await readGit(repoPath, ['rev-list', '--all', 'HEAD', '--not', '--remotes', '--max-count=1'])).trim()) {
            return {safe: false, reason: 'The checkout has unpushed commits on a local ref or HEAD. Push or preserve them before deleting.'}
        }
        return {safe: true}
    } catch {
        return {safe: false, reason: 'Git could not verify the checkout safely. Inspect it before retrying; nothing was deleted.'}
    }
}

/**
 * Default destructive remove: a recursive directory removal. `force: true` makes an already-absent
 * path a no-op (defensive — the caller already gates on existence). Injectable via the `removeDir`
 * seam so the contract is unit-testable without deleting beyond a test's own temp fixtures.
 * @param {String} repoPath
 * @private
 */
function defaultRemoveDir(repoPath) {
    fs.rmSync(repoPath, {recursive: true, force: true});
}

/**
 * @summary Safely remove an agent's managed repo checkout — the cleanup counterpart to
 * {@link Neo.ai.services.fleet.ensureAgentRepo} (provision ↔ remove).
 *
 * Derives the agent's stable, contained checkout path, classifies what is on disk (via
 * {@link Neo.ai.services.fleet.inspectAgentRepo}), and removes **only what the Fleet Manager
 * provisioned** — a managed checkout, or an empty managed dir (a pre-clone shell). A **foreign
 * occupant** (a non-checkout directory, a file, a symlink → `'occupied-non-checkout'`) is **refused**,
 * never clobbered — the exact mirror of provisioning's never-clobber guarantee. An absent path is an
 * idempotent no-op.
 *
 * **Destructive + caller-driven.** Removing a checkout deletes the agent's working tree *including any
 * uncommitted work*, and the Fleet Manager's auto-memory is checkout-path-keyed — so deleting a path
 * orphans memory keyed on it. The *policy* of **when** to remove (and whether to preserve that memory)
 * is the **caller's** concern, NOT this mechanism's: this primitive is a safe, on-demand removal
 * mechanism and is deliberately **never auto-wired** into `removeAgent`. It only ever decides *what is
 * safe to remove*, never *whether removal is wanted*.
 * FleetManager.removeRepoCheckout supplies that policy through {@link inspectRepoRemoval} and its
 * current-definition check while holding the seat home. This mechanism rechecks path containment at removal.
 *
 * Pure composition over injectable seams: `inspect` (default
 * {@link Neo.ai.services.fleet.inspectAgentRepo}) + `removeDir` (default a real recursive remove) make
 * the safe/refuse/no-op contract unit-testable, mirroring the fleet services' default-real + seam idiom.
 *
 * @param {Object}    options
 * @param {String}    options.managedRoot The absolute, trusted fleet-managed checkout root.
 * @param {String}    options.agentId     The Fleet Manager agent id.
 * @param {String}    options.repoSlug    The repo identifier, e.g. `'neomjs/neo'`.
 * @param {Function} [options.inspect]    `({repoPath}) => {exists, isCheckout, state, …}` classifier;
 *                                        defaults to {@link Neo.ai.services.fleet.inspectAgentRepo}.
 * @param {Function} [options.removeDir]  `(repoPath) => void` destructive remove; defaults to a real
 *                                        recursive directory removal, injectable for tests.
 * @returns {{removed: Boolean, repoPath: String, state: (String|undefined), reason: (String|undefined)}}
 *   `removed` is `true` only when a managed checkout / empty dir was actually removed; an absent path is
 *   `{removed: false, reason: 'absent'}`.
 * @throws {Error} On invalid `managedRoot` / `agentId` / `repoSlug` (from derivation), or when the path
 *   holds a non-managed occupant (fail-closed — never remove what the Fleet Manager did not provision).
 */
export function removeAgentRepo({managedRoot, agentId, repoSlug, inspect = inspectAgentRepo, removeDir = defaultRemoveDir} = {}) {
    const
        repoPath   = deriveAgentRepoPath({managedRoot, agentId, repoSlug}),
        inspection = inspect({repoPath});

    // Idempotent: nothing on disk → nothing to remove.
    if (!inspection.exists) {
        return {removed: false, reason: 'absent', repoPath};
    }

    // Remove ONLY what the Fleet Manager provisioned: our managed checkout (`isCheckout`) or an empty
    // managed dir (`state === 'empty'`, a pre-clone shell). Everything else on an existing path is a
    // non-managed occupant — refuse, never remove.
    if (inspection.isCheckout || inspection.state === 'empty') {
        assertRemovalPath(managedRoot, repoPath);
        removeDir(repoPath);
        return {removed: true, state: inspection.state, repoPath};
    }

    throw new Error(`removeAgentRepo: refusing to remove a non-managed occupant at '${repoPath}' (state: '${inspection.state}'). Only a Fleet-Manager-provisioned checkout or empty dir is removable.`);
}
