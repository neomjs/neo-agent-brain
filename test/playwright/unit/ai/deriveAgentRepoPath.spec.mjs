import {test, expect}        from '@playwright/test';
import path                  from 'path';
import {deriveAgentRepoPath} from '../../../../ai/services/fleet/deriveAgentRepoPath.mjs';

// Pure function — imported directly (no fs / git / Neo runtime), so the suite has no host-runtime
// side effects and each case is fully isolated. Mirrors resolveCallTarget.spec / LockRegistry.spec.

const ROOT = path.resolve('/srv/agents');

test.describe('deriveAgentRepoPath (Fleet Manager repo-provisioning path derivation)', () => {
    test('derives <root>/<agentId>/<owner>/<repo>, the layout a person would make', () => {
        expect(deriveAgentRepoPath({managedRoot: '/srv/agents', agentId: 'neo-fable-clio', repoSlug: 'neomjs/neo'}))
            .toBe(path.join(ROOT, 'neo-fable-clio', 'neomjs', 'neo'));

        // an org's profile repo keeps its leading dot
        expect(deriveAgentRepoPath({managedRoot: '/srv/agents', agentId: 'neo-gpt', repoSlug: 'neomjs/.github'}))
            .toBe(path.join(ROOT, 'neo-gpt', 'neomjs', '.github'));
    });

    test('is stable — identical inputs always map to the identical path (memory is path-keyed)', () => {
        const args = {managedRoot: '/srv/agents', agentId: 'neo-gpt', repoSlug: 'neomjs/neo'};
        expect(deriveAgentRepoPath(args)).toBe(deriveAgentRepoPath(args));
    });

    test('is collision-free across distinct agents, owners and repos: each segment is the raw value', () => {
        const paths = [
            {agentId: 'alice', repoSlug: 'neomjs/neo'},
            {agentId: 'bob',   repoSlug: 'neomjs/neo'},
            {agentId: 'alice', repoSlug: 'neomjs/other'},
            {agentId: 'alice', repoSlug: 'other/neo'}
        ].map(args => deriveAgentRepoPath({managedRoot: '/srv/agents', ...args}));

        expect(new Set(paths).size).toBe(paths.length)
    });

    test('refuses every value it would otherwise have to rewrite — nothing is sanitized', () => {
        const refuse = (agentId, repoSlug, name) =>
            expect(() => deriveAgentRepoPath({managedRoot: '/srv/agents', agentId, repoSlug})).toThrow(name);

        // traversal, separators, a leading '-' and the empty value never become a segment
        for (const agentId of ['..', '.', 'a/b', '../../etc/passwd', '-rf', '', 'a b', 'a\\b']) {
            refuse(agentId, 'neomjs/neo', /'agentId'/)
        }

        // lowercase only: the default macOS volume is case-insensitive, `Ada` and `ada` would share a folder
        refuse('Ada', 'neomjs/neo', /'agentId'/);
        refuse('ada', 'Neomjs/neo', /'owner'/);
        refuse('ada', 'neomjs/Neo', /'repo'/);

        // a segment longer than 100 characters
        refuse('a'.repeat(101), 'neomjs/neo', /'agentId'/);
    });

    test('the slug is exactly <owner>/<repo>, and the owners `harness` and `memory` are reserved for the seat', () => {
        for (const repoSlug of ['neo', 'neomjs/neo/extra', '/neo', 'neomjs/', '../../root', undefined]) {
            expect(() => deriveAgentRepoPath({managedRoot: '/srv/agents', agentId: 'ada', repoSlug})).toThrow();
        }

        expect(() => deriveAgentRepoPath({managedRoot: '/srv/agents', agentId: 'ada', repoSlug: 'harness/codex'}))
            .toThrow(/'harness' is reserved for an agent's harness homes/);
        expect(() => deriveAgentRepoPath({managedRoot: '/srv/agents', agentId: 'ada', repoSlug: 'memory/notes'}))
            .toThrow(/'memory' is reserved for an agent's memory/);
    });

    test('the managed root is honored verbatim — same agent/repo under different roots diverges', () => {
        const
            a = deriveAgentRepoPath({managedRoot: '/srv/agents',  agentId: 'x', repoSlug: 'o/r'}),
            b = deriveAgentRepoPath({managedRoot: '/data/agents', agentId: 'x', repoSlug: 'o/r'});

        expect(a).toBe(path.join(path.resolve('/srv/agents'),  'x', 'o', 'r'));
        expect(b).toBe(path.join(path.resolve('/data/agents'), 'x', 'o', 'r'));
    });

    test('fails loud on a missing or relative root (no silent default path)', () => {
        expect(() => deriveAgentRepoPath({managedRoot: '',             agentId: 'a', repoSlug: 'o/r'})).toThrow(/managedRoot/);
        expect(() => deriveAgentRepoPath({managedRoot: 'relative/dir', agentId: 'a', repoSlug: 'o/r'})).toThrow(/absolute/);
        expect(() => deriveAgentRepoPath({})).toThrow(/managedRoot/);
    });
});
