import {test, expect}                          from '@playwright/test';
import {execFileSync}                          from 'node:child_process';
import fs                                      from 'node:fs';
import os                                      from 'node:os';
import path                                    from 'node:path';
import {ensureAgentRepo, fastForwardAgentRepo} from '../../../../ai/services/fleet/ensureAgentRepo.mjs';
import {deriveAgentRepoPath}                   from '../../../../ai/services/fleet/deriveAgentRepoPath.mjs';

// Integration coverage of the provisioning chain's DEFAULT clone seam — a real `git clone`, the
// production path the unit specs stub out (they inject `cloneRepo`). Exercises clone → reuse → conflict
// against actual git in temp dirs, offline (clones a LOCAL fixture repo, no network). Mirrors
// check-branch-discipline.spec's real-git fixture idiom (mkdtemp + git init + config + commit +
// execFileSync). Asserts the production behaviors the stub cannot: a real `.git` checkout, git creating
// the intermediate `<agent>/` leading dir, reuse not clobbering, and a fail-closed conflict.

let suiteRoot, sourceRepo;

/** Run git in a cwd, output discarded (no shell → no interpolation hazard). */
function git(cwd, ...args) {
    execFileSync('git', args, {cwd, stdio: 'ignore'});
}

/** A fresh managed root per case so the cases never alias a checkout. */
function freshManagedRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-managed-'));
}

test.beforeAll(() => {
    suiteRoot  = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-int-'));
    // A real source repo with one commit, to clone FROM — a local path keeps the suite offline + fast.
    sourceRepo = path.join(suiteRoot, 'source');
    fs.mkdirSync(sourceRepo);
    git(sourceRepo, 'init', '-q');
    git(sourceRepo, 'config', 'user.email', 'test@example.com');
    git(sourceRepo, 'config', 'user.name', 'Test User');
    fs.writeFileSync(path.join(sourceRepo, 'README.md'), '# fixture\n');
    git(sourceRepo, 'add', '.');
    git(sourceRepo, 'commit', '-q', '-m', 'init');
});

test.afterAll(() => {
    fs.rmSync(suiteRoot, {recursive: true, force: true});
});

test.describe('ensureAgentRepo — real git clone seam (integration, default un-injected cloneRepo)', () => {
    test('clones an absent repo: real .git checkout + source content, git created the leading dir, cloned:true', async () => {
        const managedRoot = freshManagedRoot();
        try {
            const result = await ensureAgentRepo({managedRoot, agentId: 'agent-a', repoSlug: 'fixture/repo', cloneUrl: sourceRepo});

            expect(result.cloned).toBe(true);
            expect(result.action).toBe('cloned');
            expect(result.repoPath.startsWith(managedRoot + path.sep)).toBe(true);
            // a real checkout: `.git` + the source content. The intermediate `<agent>/` dir (which
            // deriveAgentRepoPath's <root>/<agent>/<repo> layout implies) was created by `git clone`.
            expect(fs.existsSync(path.join(result.repoPath, '.git'))).toBe(true);
            expect(fs.readFileSync(path.join(result.repoPath, 'README.md'), 'utf8')).toContain('# fixture');
        } finally {
            fs.rmSync(managedRoot, {recursive: true, force: true});
        }
    });

    test('re-running over the cloned checkout reuses it — no re-clone clobber', async () => {
        const managedRoot = freshManagedRoot();
        try {
            const first = await ensureAgentRepo({managedRoot, agentId: 'agent-b', repoSlug: 'fixture/repo', cloneUrl: sourceRepo});
            expect(first.cloned).toBe(true);

            // a marker that only survives if the SAME checkout is reused (not re-cloned over)
            const marker = path.join(first.repoPath, '.reuse-marker');
            fs.writeFileSync(marker, 'x');

            const second = await ensureAgentRepo({managedRoot, agentId: 'agent-b', repoSlug: 'fixture/repo', cloneUrl: sourceRepo});
            expect(second.cloned).toBe(false);
            expect(second.action).toBe('reused');
            expect(second.repoPath).toBe(first.repoPath);
            expect(fs.existsSync(marker)).toBe(true);
        } finally {
            fs.rmSync(managedRoot, {recursive: true, force: true});
        }
    });

    test('a foreign occupant at the derived path is a conflict — fail-closed, never clobbered', async () => {
        const managedRoot = freshManagedRoot();
        try {
            const repoPath = deriveAgentRepoPath({managedRoot, agentId: 'agent-c', repoSlug: 'fixture/repo'});
            fs.mkdirSync(repoPath, {recursive: true});
            fs.writeFileSync(path.join(repoPath, 'foreign.txt'), 'do not clobber');

            await expect(ensureAgentRepo({managedRoot, agentId: 'agent-c', repoSlug: 'fixture/repo', cloneUrl: sourceRepo}))
                .rejects.toThrow();

            // the foreign content survived — the chain never clobbered an occupant
            expect(fs.readFileSync(path.join(repoPath, 'foreign.txt'), 'utf8')).toBe('do not clobber');
        } finally {
            fs.rmSync(managedRoot, {recursive: true, force: true});
        }
    });
});

test.describe('fastForwardAgentRepo — real git against a local remote', () => {
    // `verifyAgentRepoTrust` proves forge remotes only, so a local remote passes with the checkout's real root
    const trusted = async ({repoPath}) => ({state: 'verified', root: fs.realpathSync(repoPath)});

    let remote;

    /** Git outside the host's config, so no developer's global hooks or settings decide a case. */
    function hostless(cwd, ...args) {
        return execFileSync('git', args, {cwd, env: {...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1'}}).toString().trim()
    }

    /** Commits a new file on the remote's `dev`, the branch its clones default to. */
    function commitOnRemote(name) {
        fs.writeFileSync(path.join(remote, name), name);
        hostless(remote, 'add', name);
        hostless(remote, 'commit', '-q', '-m', name)
    }

    /** A fresh clone of the remote, which then moves one commit past it. */
    function behindCheckout() {
        const repoPath = path.join(fs.mkdtempSync(path.join(suiteRoot, 'seat-')), 'repo');

        hostless(suiteRoot, 'clone', '-q', remote, repoPath);
        hostless(repoPath, 'config', 'user.email', 'seat@example.test');
        hostless(repoPath, 'config', 'user.name', 'Seat');
        commitOnRemote(`${path.basename(path.dirname(repoPath))}.txt`);

        return repoPath
    }

    /** An executable hook that appends its name to `marker` whenever it runs. */
    function installHook(repoPath, name, marker) {
        fs.writeFileSync(path.join(repoPath, '.git', 'hooks', name), `#!/bin/sh\necho ${name} >> "${marker}"\n`, {mode: 0o755})
    }

    const head    = repoPath => hostless(repoPath, 'rev-parse', 'HEAD'),
          forward = repoPath => fastForwardAgentRepo({repoPath, cloneUrl: remote, verifyTrust: trusted});

    test.beforeAll(() => {
        remote = path.join(suiteRoot, 'remote');
        fs.mkdirSync(remote);
        hostless(remote, 'init', '-q', '-b', 'dev');
        hostless(remote, 'config', 'user.email', 'test@example.com');
        hostless(remote, 'config', 'user.name', 'Test User');
        commitOnRemote('README.md')
    });

    test('a clean checkout on its default branch moves to its remote past an untracked file, then reads up to date', async () => {
        const repoPath = behindCheckout(),
              before   = head(repoPath);

        fs.writeFileSync(path.join(repoPath, 'scratch.txt'), 'untracked, and nothing the merge brings');

        const outcome = await forward(repoPath);

        expect(outcome.state).toBe('fast-forwarded');
        expect(head(repoPath)).toBe(head(remote));
        expect(before.startsWith(outcome.from) && head(remote).startsWith(outcome.to)).toBe(true);
        expect(fs.existsSync(path.join(repoPath, 'scratch.txt'))).toBe(true);
        expect(await forward(repoPath)).toEqual({state: 'up-to-date'})
    });

    test('a tracked change, another branch or a local commit keeps the checkout where it is', async () => {
        const dirty    = behindCheckout(),
              feature  = behindCheckout(),
              diverged = behindCheckout();

        fs.appendFileSync(path.join(dirty, 'README.md'), 'an edit');
        hostless(feature, 'switch', '-q', '-c', 'feature');
        fs.writeFileSync(path.join(diverged, 'mine.txt'), 'mine');
        hostless(diverged, 'add', 'mine.txt');
        hostless(diverged, 'commit', '-q', '-m', 'mine');

        const heads = [dirty, feature, diverged].map(head);

        expect(await forward(dirty)).toEqual({state: 'skipped', reason: 'tracked files have changes'});
        expect(await forward(feature)).toEqual({state: 'skipped', reason: 'on feature, not dev'});
        expect(await forward(diverged)).toEqual({state: 'skipped', reason: '1 local commit its remote lacks'});
        expect([dirty, feature, diverged].map(head)).toEqual(heads)
    });

    test("a checkout's own hooks never run in the Fleet, though a plain merge runs them", async () => {
        const marker  = path.join(suiteRoot, 'hooks-ran.log'),
              control = behindCheckout(),
              seat    = behindCheckout();

        // the control: the same hook fires under a plain fetch and fast-forward merge
        installHook(control, 'post-merge', marker);
        hostless(control, 'fetch', '-q', 'origin');
        hostless(control, 'merge', '--ff-only', '-q', 'origin/dev');
        expect(fs.readFileSync(marker, 'utf8')).toBe('post-merge\n');
        fs.rmSync(marker);

        installHook(seat, 'post-merge', marker);
        installHook(seat, 'reference-transaction', marker);

        expect((await forward(seat)).state).toBe('fast-forwarded');
        expect(fs.existsSync(marker)).toBe(false)
    });
});
