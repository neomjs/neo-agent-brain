import {test, expect} from '@playwright/test';
import path           from 'path';
import {
    deriveAgentInstanceHome,
    deriveAgentMemoryDir
} from '../../../../../../ai/services/fleet/deriveAgentInstanceHome.mjs';
import {deriveAgentRepoPath} from '../../../../../../ai/services/fleet/deriveAgentRepoPath.mjs';

// Pure function — imported directly (no fs / git / Neo runtime), so the suite has no host-runtime
// side effects and each case is fully isolated. Mirrors deriveAgentRepoPath.spec.

const ROOT = path.resolve('/srv/agents');

test.describe('deriveAgentInstanceHome (Fleet Manager harness instance-home derivation)', () => {
    test('derives <root>/<agentId>/harness/<harnessType>, beside the agent\'s clones', () => {
        expect(deriveAgentInstanceHome({instanceRoot: '/srv/agents', agentId: 'neo-fable-clio', harnessType: 'claude-desktop'}))
            .toBe(path.join(ROOT, 'neo-fable-clio', 'harness', 'claude-desktop'));

        // one agent folder holds both: the clone and the harness home share the <agentId> parent
        const
            home  = deriveAgentInstanceHome({instanceRoot: '/srv/agents', agentId: 'neo-gpt', harnessType: 'codex'}),
            clone = deriveAgentRepoPath({managedRoot: '/srv/agents', agentId: 'neo-gpt', repoSlug: 'neomjs/neo'});

        expect(path.dirname(path.dirname(home))).toBe(path.join(ROOT, 'neo-gpt'));
        expect(path.dirname(path.dirname(clone))).toBe(path.join(ROOT, 'neo-gpt'))
    });

    test('is stable — identical inputs always map to the identical home (harness auth/state is home-keyed)', () => {
        const args = {instanceRoot: '/srv/agents', agentId: 'neo-gpt', harnessType: 'codex'};
        expect(deriveAgentInstanceHome(args)).toBe(deriveAgentInstanceHome(args));
    });

    test('is collision-free across distinct agents and distinct harness families', () => {
        const
            a = deriveAgentInstanceHome({instanceRoot: '/srv/agents', agentId: 'alice', harnessType: 'codex'}),
            b = deriveAgentInstanceHome({instanceRoot: '/srv/agents', agentId: 'bob',   harnessType: 'codex'}),
            c = deriveAgentInstanceHome({instanceRoot: '/srv/agents', agentId: 'alice', harnessType: 'claude-code'});

        expect(a).not.toBe(b); // distinct agents
        expect(a).not.toBe(c); // distinct harness families
    });

    test('two DISTINCT fleet agent ids sharing one githubUsername get distinct, restart-stable homes (keyed by agent id, NEVER githubUsername)', () => {
        // The function takes the fleet agent id ONLY — githubUsername is not an input by design, so
        // two agents sharing one GitHub identity can never collapse onto one auth/session home.
        const
            first  = {instanceRoot: '/srv/agents', agentId: 'neo-fable',      harnessType: 'codex'},
            second = {instanceRoot: '/srv/agents', agentId: 'neo-fable-clio', harnessType: 'codex'};

        expect(deriveAgentInstanceHome(first)).not.toBe(deriveAgentInstanceHome(second)); // distinct homes
        expect(deriveAgentInstanceHome(first)).toBe(deriveAgentInstanceHome(first));      // restart-stable
        expect(deriveAgentInstanceHome(second)).toBe(deriveAgentInstanceHome(second));    // restart-stable
    });

    test('refuses every value it would otherwise have to rewrite — nothing is sanitized', () => {
        for (const agentId of ['..', '.', 'a/b', '../../etc/passwd', '-rf', '', 'Ada', 42]) {
            expect(() => deriveAgentInstanceHome({instanceRoot: '/srv/agents', agentId, harnessType: 'codex'})).toThrow(/'agentId'/);
        }

        for (const harnessType of ['..', '../../../root', 'Codex', '']) {
            expect(() => deriveAgentInstanceHome({instanceRoot: '/srv/agents', agentId: 'a', harnessType})).toThrow(/'harnessType'/);
        }
    });

    test('the instance root is honored verbatim, and only an absolute one is accepted', () => {
        expect(deriveAgentInstanceHome({instanceRoot: '/data/agents', agentId: 'x', harnessType: 'codex'}))
            .toBe(path.join(path.resolve('/data/agents'), 'x', 'harness', 'codex'));

        expect(() => deriveAgentInstanceHome({instanceRoot: '../../etc',    agentId: 'a', harnessType: 'codex'})).toThrow(/absolute/);
        expect(() => deriveAgentInstanceHome({instanceRoot: '',             agentId: 'a', harnessType: 'codex'})).toThrow(/instanceRoot/);
        expect(() => deriveAgentInstanceHome({})).toThrow(/instanceRoot/);
    });
});

test.describe('deriveAgentMemoryDir (a seat\'s memory, whichever checkout it opens)', () => {
    test('derives <root>/<agentId>/memory, beside the agent\'s clones and harness homes', () => {
        const
            memory = deriveAgentMemoryDir({instanceRoot: '/srv/agents', agentId: 'neo-opus-ada'}),
            home   = deriveAgentInstanceHome({instanceRoot: '/srv/agents', agentId: 'neo-opus-ada', harnessType: 'claude-desktop'}),
            clone  = deriveAgentRepoPath({managedRoot: '/srv/agents', agentId: 'neo-opus-ada', repoSlug: 'neomjs/neo'});

        expect(memory).toBe(path.join(ROOT, 'neo-opus-ada', 'memory'));
        expect(path.dirname(memory)).toBe(path.dirname(path.dirname(home)));
        expect(path.dirname(memory)).toBe(path.dirname(path.dirname(clone)));
        expect(deriveAgentMemoryDir({instanceRoot: '/srv/agents', agentId: 'neo-opus-ada'})).toBe(memory)
    });

    test('distinct agents never share a memory, and no checkout can land in one', () => {
        expect(deriveAgentMemoryDir({instanceRoot: '/srv/agents', agentId: 'neo-fable'}))
            .not.toBe(deriveAgentMemoryDir({instanceRoot: '/srv/agents', agentId: 'neo-fable-clio'}));
        expect(() => deriveAgentRepoPath({managedRoot: '/srv/agents', agentId: 'neo-fable', repoSlug: 'memory/notes'})).toThrow(/reserved/)
    });

    test('refuses an invalid agent id or a relative root', () => {
        for (const agentId of ['..', '.', 'a/b', 'Ada', '', 42]) {
            expect(() => deriveAgentMemoryDir({instanceRoot: '/srv/agents', agentId})).toThrow(/'agentId'/);
        }

        expect(() => deriveAgentMemoryDir({instanceRoot: '../agents', agentId: 'a'})).toThrow(/absolute/);
        expect(() => deriveAgentMemoryDir({})).toThrow(/instanceRoot/)
    });
});
