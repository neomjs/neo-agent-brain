import {test, expect}        from '@playwright/test';
import fs                    from 'fs';
import os                    from 'os';
import path                  from 'path';
import {deriveAgentRepoPath} from '../../../../ai/services/fleet/deriveAgentRepoPath.mjs';
import {ensureAgentRepo}     from '../../../../ai/services/fleet/ensureAgentRepo.mjs';

// Integration of the provisioning trio (derive → inspect → provision) over real temp-dir fixtures, with
// the clone executor injected as a recording stub (no git binary) — inspectAgentRepo.spec's temp-dir
// pattern + provisionAgentRepo.spec's clone stub, composed.

let suiteRoot;

test.beforeAll(() => { suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-agent-repo-')); });
test.afterAll(()  => { fs.rmSync(suiteRoot, {recursive: true, force: true}); });

const makeCloneStub = () => {
    const calls = [];
    const fn    = async (cloneUrl, repoPath, {credential} = {}) => { calls.push({cloneUrl, repoPath, credential}) };
    fn.calls = calls;
    return fn
};

// the path the orchestrator will resolve — so a fixture can be staged at it before the call
const pathFor = (managedRoot, agentId, repoSlug) => deriveAgentRepoPath({managedRoot, agentId, repoSlug});

const URL = 'https://example.test/neomjs/neo.git';

test.describe('ensureAgentRepo (Fleet Manager derive → inspect → provision orchestrator)', () => {
    test('absent path → clones into the derived path and reports cloned', async () => {
        const clone = makeCloneStub(),
              args  = {managedRoot: suiteRoot, agentId: 'agent-absent', repoSlug: 'neomjs/neo'},
              want  = pathFor(args.managedRoot, args.agentId, args.repoSlug),
              r     = await ensureAgentRepo({...args, cloneUrl: URL, credential: 'ghp_seat', cloneRepo: clone});

        expect(r).toEqual({repoPath: want, state: 'absent', action: 'cloned', cloned: true});
        expect(clone.calls, "the seat's credential rides to the clone").toEqual([{cloneUrl: URL, repoPath: want, credential: 'ghp_seat'}])
    });

    test('existing checkout → reuses it, never invoking the clone executor', async () => {
        const clone = makeCloneStub(),
              args  = {managedRoot: suiteRoot, agentId: 'agent-checkout', repoSlug: 'neomjs/neo'},
              want  = pathFor(args.managedRoot, args.agentId, args.repoSlug);

        fs.mkdirSync(path.join(want, '.git'), {recursive: true}); // stage a valid checkout

        const r = await ensureAgentRepo({...args, cloneUrl: URL, cloneRepo: clone});

        expect(r).toEqual({repoPath: want, state: 'checkout', action: 'reused', cloned: false});
        expect(clone.calls).toHaveLength(0)
    });

    test('foreign occupant → throws (conflict), never invoking the clone executor', async () => {
        const clone = makeCloneStub(),
              args  = {managedRoot: suiteRoot, agentId: 'agent-occupied', repoSlug: 'neomjs/neo'},
              want  = pathFor(args.managedRoot, args.agentId, args.repoSlug);

        fs.mkdirSync(want, {recursive: true});
        fs.writeFileSync(path.join(want, 'README.md'), '# not ours\n'); // non-checkout occupant

        await expect(ensureAgentRepo({...args, cloneUrl: URL, cloneRepo: clone})).rejects.toThrow(/conflict/i);
        expect(clone.calls).toHaveLength(0)
    });

    test('a clone is required but cloneUrl is missing → fails closed (from the provision step)', async () => {
        const clone = makeCloneStub(),
              args  = {managedRoot: suiteRoot, agentId: 'agent-nourl', repoSlug: 'neomjs/neo'};

        await expect(ensureAgentRepo({...args, cloneRepo: clone})).rejects.toThrow(/cloneUrl/);
        expect(clone.calls).toHaveLength(0)
    });

    test('invalid inputs throw from the derivation step (contract inherited)', async () => {
        await expect(ensureAgentRepo({managedRoot: '',           agentId: 'a', repoSlug: 'r'})).rejects.toThrow(/managedRoot/);
        await expect(ensureAgentRepo({managedRoot: 'relative/x', agentId: 'a', repoSlug: 'r'})).rejects.toThrow(/absolute/);
        await expect(ensureAgentRepo({managedRoot: suiteRoot,    agentId: '',  repoSlug: 'r'})).rejects.toThrow(/agentId/)
    });

    test('a missing managed root is created owner-only before the clone; its new ancestors keep the default mode', async () => {
        const
            parent  = path.join(suiteRoot, 'fresh'),
            root    = path.join(parent, 'agents'),
            probe   = path.join(suiteRoot, 'default-mode-probe'),
            modes   = [],
            clone   = async () => { modes.push(fs.statSync(root).mode & 0o777) };

        fs.mkdirSync(probe);

        await ensureAgentRepo({managedRoot: root, agentId: 'agent-fresh', repoSlug: 'neomjs/neo', cloneUrl: URL, cloneRepo: clone});

        expect(modes, 'the root is owner-only when the clone runs').toEqual([0o700]);
        expect(fs.statSync(parent).mode & 0o777).toBe(fs.statSync(probe).mode & 0o777)
    });

    test('an existing root open to group or other is narrowed to owner-only; one that is not a directory fails closed', async () => {
        const
            root  = path.join(suiteRoot, 'shared-agents'),
            file  = path.join(suiteRoot, 'agents-file'),
            clone = makeCloneStub();

        fs.mkdirSync(root);
        fs.chmodSync(root, 0o755);
        fs.writeFileSync(file, '');

        await ensureAgentRepo({managedRoot: root, agentId: 'agent-shared', repoSlug: 'neomjs/neo', cloneUrl: URL, cloneRepo: clone});

        expect(fs.statSync(root).mode & 0o777).toBe(0o700);
        await expect(ensureAgentRepo({managedRoot: file, agentId: 'agent-file', repoSlug: 'neomjs/neo', cloneUrl: URL, cloneRepo: clone}))
            .rejects.toThrow(/is not a directory/);
        expect(clone.calls).toHaveLength(1)
    });

    test('the root the clone uses is the one made owner-only, whichever directory a symlink before `..` reaches', async () => {
        const
            base     = path.join(suiteRoot, 'spelling'),
            lexical  = path.join(base, 'lexical'),
            physical = path.join(base, 'physical'),
            spelled  = `${lexical}/link/../agents`, // the filesystem reads this as physical/agents
            modes    = [],
            clone    = async () => { modes.push(fs.statSync(path.join(lexical, 'agents')).mode & 0o777) };

        fs.mkdirSync(path.join(physical, 'child'), {recursive: true});
        fs.mkdirSync(lexical);
        fs.symlinkSync(path.join(physical, 'child'), path.join(lexical, 'link'));

        await ensureAgentRepo({managedRoot: spelled, agentId: 'agent-spelled', repoSlug: 'neomjs/neo', cloneUrl: URL, cloneRepo: clone});

        expect(modes, 'the clone root is owner-only when the clone runs').toEqual([0o700]);
        expect(fs.existsSync(path.join(physical, 'agents')), 'the directory the raw spelling names is untouched').toBe(false)
    });

    test('two distinct agents ensure into distinct checkouts (no cross-contamination)', async () => {
        const clone = makeCloneStub(),
              ra    = await ensureAgentRepo({managedRoot: suiteRoot, agentId: 'agent-x', repoSlug: 'neomjs/neo', cloneUrl: URL, cloneRepo: clone}),
              rb    = await ensureAgentRepo({managedRoot: suiteRoot, agentId: 'agent-y', repoSlug: 'neomjs/neo', cloneUrl: URL, cloneRepo: clone});

        expect(ra.repoPath).not.toBe(rb.repoPath);
        expect(clone.calls).toHaveLength(2) // both absent → both cloned, into distinct paths
    });
});
