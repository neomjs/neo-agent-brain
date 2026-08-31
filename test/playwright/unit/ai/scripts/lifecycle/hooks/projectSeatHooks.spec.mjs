import {setup} from '../../../../../setup.mjs';

const appName = 'ProjectSeatHooksTest';

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

import {test, expect}   from '@playwright/test';
import Neo              from 'neo.mjs/src/Neo.mjs';
import * as core        from 'neo.mjs/src/core/_export.mjs';
import {execFileSync}   from 'node:child_process';
import fs               from 'node:fs';
import os               from 'node:os';
import path             from 'node:path';
import {
    checkProjection,
    enumerateHooks,
    findOrphans,
    main,
    projectHooks,
    rewriteSpecifiers,
    writeLocalExclude
} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';

const REPO_ROOT = path.resolve(process.cwd());

let scratchDirs = [];

/**
 * @summary Creates a throwaway directory that is removed when the file finishes.
 * @param {String} prefix
 * @returns {String} Absolute path.
 */
function scratch(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

    scratchDirs.push(dir);
    return fs.realpathSync(dir)
}

/**
 * @summary Builds a synthetic runtime root holding controllable hook sources.
 *
 * The spec drives the projector's logic against sources it authors, so a change to a real hook can
 * never turn a projection assertion red for a reason that has nothing to do with projection. The
 * real population is asserted separately, in the census test.
 * @param {Object} [sources] `{harness: {filename: contents}}`
 * @returns {String} Absolute runtime root.
 */
function runtimeRoot(sources = {}) {
    const root = scratch('agentos-runtime');

    fs.mkdirSync(path.join(root, 'ai/lib'), {recursive: true});
    fs.writeFileSync(path.join(root, 'ai/lib/substrate.mjs'), 'export const substrate = 1;\n', 'utf8');

    Object.entries(sources).forEach(([harness, files]) => {
        const dir = path.join(root, 'ai/scripts/lifecycle/hooks', harness);

        fs.mkdirSync(dir, {recursive: true});
        Object.entries(files).forEach(([name, contents]) => fs.writeFileSync(path.join(dir, name), contents, 'utf8'))
    });

    return root
}

/**
 * @summary Builds a throwaway git repository to project into.
 * @returns {String} Absolute target repository root.
 */
function targetRepo() {
    const root = scratch('target-seat');

    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['config', 'user.email', 'spec@neomjs.test'], {cwd: root});
    execFileSync('git', ['config', 'user.name', 'spec'], {cwd: root});
    fs.writeFileSync(path.join(root, 'README.md'), 'target\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], {cwd: root});
    execFileSync('git', ['commit', '-qm', 'init'], {cwd: root});

    return root
}

/** A hook that reaches for Brain substrate the way the real ones do. */
const HOOK_SOURCE = "#!/usr/bin/env node\nimport {substrate} from '../../../../lib/substrate.mjs';\n" +
                    "const engine = await import('neo.mjs/src/Neo.mjs');\nexport {substrate, engine};\n";

/**
 * @summary Runs `main()` with console output captured, returning the exit code.
 * @param {String[]} argv
 * @returns {Number}
 */
function silentMain(argv) {
    const {error, log} = console;

    console.error = () => {};
    console.log   = () => {};

    try {
        return main(argv)
    } finally {
        console.error = error;
        console.log   = log
    }
}

test.afterAll(() => {
    scratchDirs.forEach(dir => fs.rmSync(dir, {force: true, recursive: true}));
    scratchDirs = []
});

test.describe('projectSeatHooks — the census of the real population', () => {
    test('enumerates exactly the seven Agent-OS-owned hooks, split 3/2/2', () => {
        const hooks = enumerateHooks(REPO_ROOT);

        // #250 asserts the count so a future re-read cannot silently re-conflate the executables
        // with the config artifacts that leaf 6 also removed.
        expect(hooks.length).toBe(7);

        expect(hooks.filter(hook => hook.harness === 'claude').length).toBe(3);
        expect(hooks.filter(hook => hook.harness === 'codex').length).toBe(2);
        expect(hooks.filter(hook => hook.harness === 'kimi-code').length).toBe(2);

        hooks.forEach(hook => expect(fs.existsSync(hook.source)).toBe(true))
    });

    test('every real hook renders without escaping the runtime root', () => {
        // An escaped specifier means the projection cannot bind a dependency, so the census must be
        // clean before any of the mutant assertions below mean anything.
        const report = checkProjection({agentosRuntimeRoot: REPO_ROOT, targetRepoRoot: targetRepo()});

        expect(report.escapedSpecifiers).toEqual([])
    })
});

test.describe('projectSeatHooks — specifier rewriting', () => {
    test('rewrites Brain-relative specifiers to absolute paths and leaves package specifiers alone', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            source = path.join(root, 'ai/scripts/lifecycle/hooks/claude/a.mjs'),
            result = rewriteSpecifiers(fs.readFileSync(source, 'utf8'), source, root);

        expect(result.rewritten).toBe(1);
        expect(result.escaped).toEqual([]);
        expect(result.contents).toContain(path.join(root, 'ai/lib/substrate.mjs'));
        // §2.3: the Agent OS consumes the PUBLISHED Engine, so this specifier must survive untouched.
        expect(result.contents).toContain("'neo.mjs/src/Neo.mjs'");
        expect(result.contents).not.toContain("'../../../../lib/substrate.mjs'")
    });

    test('reports a specifier that escapes the runtime root instead of inventing a dependency', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': "import x from '../../../../../../outside.mjs';\n"}}),
            source = path.join(root, 'ai/scripts/lifecycle/hooks/claude/a.mjs'),
            result = rewriteSpecifiers(fs.readFileSync(source, 'utf8'), source, root);

        expect(result.rewritten).toBe(0);
        expect(result.escaped.length).toBe(1);
        // Unchanged: silently re-pointing it would fabricate a dependency the source never declared.
        expect(result.contents).toContain('../../../../../../outside.mjs')
    })
});

test.describe('projectSeatHooks — projection', () => {
    test('materializes hooks, marks them generated, and leaves git status clean', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}, codex: {'b.mjs': HOOK_SOURCE}}),
            target = targetRepo(),
            result = projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(result.written).toEqual(['.claude/hooks/a.mjs', '.codex/hooks/b.mjs']);

        const projected = fs.readFileSync(path.join(target, '.claude/hooks/a.mjs'), 'utf8');

        // A shebang must survive on line 1 or the harness cannot execute the file.
        expect(projected.startsWith('#!/usr/bin/env node\n')).toBe(true);
        expect(projected.split('\n')[1]).toContain('GENERATED by');

        // Untracked is not ignored: acceptance for #250 is a clean status, not merely untracked files.
        expect(execFileSync('git', ['status', '--porcelain'], {cwd: target, encoding: 'utf8'}).trim()).toBe('')
    });

    test('rewriting the exclude block is idempotent rather than accumulating', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            target = targetRepo();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});
        const excludeFile = projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target}).excludeFile;

        const contents = fs.readFileSync(excludeFile, 'utf8');

        expect(contents.match(/BEGIN projectSeatHooks/g).length).toBe(1);
        expect(contents.match(/\/\.claude\/hooks\/a\.mjs/g).length).toBe(1)
    });

    test('preserves pre-existing exclude entries it did not write', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            target = targetRepo(),
            gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {cwd: target, encoding: 'utf8'}).trim(),
            file   = path.join(gitDir, 'info', 'exclude');

        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, '# someone else\n/scratch-notes.md\n', 'utf8');

        writeLocalExclude({targetRepoRoot: target, targets: ['.claude/hooks/a.mjs']});

        expect(fs.readFileSync(file, 'utf8')).toContain('/scratch-notes.md')
    });

    test('refuses the whole run when a tracked file occupies a projection path', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}, codex: {'b.mjs': HOOK_SOURCE}}),
            target = targetRepo();

        fs.mkdirSync(path.join(target, '.claude/hooks'), {recursive: true});
        fs.writeFileSync(path.join(target, '.claude/hooks/a.mjs'), '// authored, not ours\n', 'utf8');
        execFileSync('git', ['add', '-f', '.claude/hooks/a.mjs'], {cwd: target});
        execFileSync('git', ['commit', '-qm', 'authored hook'], {cwd: target});

        expect(() => projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target}))
            .toThrow(/refusing to overwrite tracked path/);

        // Refusal is all-or-nothing: the untracked sibling must NOT have been written first.
        expect(fs.existsSync(path.join(target, '.codex/hooks/b.mjs'))).toBe(false);
        expect(fs.readFileSync(path.join(target, '.claude/hooks/a.mjs'), 'utf8')).toBe('// authored, not ours\n')
    });

    test('refuses to project a source that escapes the runtime root', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': "import x from '../../../../../../outside.mjs';\n"}}),
            target = targetRepo();

        expect(() => projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target}))
            .toThrow(/reach outside the runtime root/)
    });

    test('prunes a projection the manifest no longer declares', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            target = targetRepo();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});
        fs.writeFileSync(path.join(target, '.claude/hooks/retired.mjs'), '// left behind\n', 'utf8');

        const result = projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(result.pruned).toEqual(['.claude/hooks/retired.mjs']);
        expect(fs.existsSync(path.join(target, '.claude/hooks/retired.mjs'))).toBe(false)
    });

    test('never treats a tracked file as an orphan to prune', () => {
        // The Engine-only guard carve-out of ADR 0040 §2.7 lives at exactly such a path.
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            target = targetRepo();

        fs.mkdirSync(path.join(target, '.claude/hooks'), {recursive: true});
        fs.writeFileSync(path.join(target, '.claude/hooks/engineGuard.mjs'), '// Engine-owned\n', 'utf8');
        execFileSync('git', ['add', '-f', '.claude/hooks/engineGuard.mjs'], {cwd: target});
        execFileSync('git', ['commit', '-qm', 'engine guard'], {cwd: target});

        expect(findOrphans(root, target)).toEqual([]);

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});
        expect(fs.existsSync(path.join(target, '.claude/hooks/engineGuard.mjs'))).toBe(true)
    })
});

test.describe('projectSeatHooks --check — every #250 mutant drives it red', () => {
    /**
     * @summary Projects a clean tree, applies one mutation, and returns the resulting report.
     * @param {Function} mutate Receives `{root, target}`.
     * @returns {Object}
     */
    function afterMutation(mutate) {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}, codex: {'b.mjs': HOOK_SOURCE}}),
            target = targetRepo();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});
        expect(checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}).ok).toBe(true);

        const swapped = mutate({root, target});

        return checkProjection({
            agentosRuntimeRoot: swapped?.root || root,
            targetRepoRoot    : target
        })
    }

    test('a clean projection is green', () => {
        const report = afterMutation(() => {});

        expect(report.ok).toBe(true);
        expect(report.missing).toEqual([]);
        expect(report.orphans).toEqual([]);
        expect(report.stale).toEqual([])
    });

    test('MUTANT — dangling target: the seat declares a hook whose file is gone', () => {
        const report = afterMutation(({target}) => fs.rmSync(path.join(target, '.claude/hooks/a.mjs')));

        expect(report.ok).toBe(false);
        expect(report.missing).toEqual(['.claude/hooks/a.mjs'])
    });

    test('MUTANT — a stale entry the manifest no longer projects', () => {
        const report = afterMutation(({target}) =>
            fs.writeFileSync(path.join(target, '.claude/hooks/retired.mjs'), '// still executing\n', 'utf8'));

        expect(report.ok).toBe(false);
        expect(report.orphans).toEqual(['.claude/hooks/retired.mjs']);
        // A source-driven sweep cannot see this one, so it must not be conflated with `missing`.
        expect(report.missing).toEqual([])
    });

    test('MUTANT — a tracked file occupies a projection path', () => {
        const report = afterMutation(({target}) => {
            execFileSync('git', ['add', '-f', '.claude/hooks/a.mjs'], {cwd: target});
            execFileSync('git', ['commit', '-qm', 'squat'], {cwd: target})
        });

        expect(report.ok).toBe(false);
        expect(report.trackedConflicts).toEqual(['.claude/hooks/a.mjs'])
    });

    test('MUTANT — the projection points at the wrong runtime root', () => {
        const report = afterMutation(() => ({
            // Same hook names, different root: the rewritten specifiers are absolute, so every
            // projected file's bytes disagree with what this root renders.
            root: runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}, codex: {'b.mjs': HOOK_SOURCE}})
        }));

        expect(report.ok).toBe(false);
        expect(report.stale).toEqual(['.claude/hooks/a.mjs', '.codex/hooks/b.mjs'])
    });

    test('MUTANT — a projected hook drifts from its source', () => {
        const report = afterMutation(({target}) =>
            fs.appendFileSync(path.join(target, '.codex/hooks/b.mjs'), '// edited in place\n'));

        expect(report.ok).toBe(false);
        expect(report.stale).toEqual(['.codex/hooks/b.mjs'])
    })
});

test.describe('projectSeatHooks — CLI root binding', () => {
    test('fails loud when a root is absent rather than defaulting to cwd', () => {
        // ADR 0040 §2.5: a defaulted root would project a full hook set into whatever directory the
        // process happened to start in, and report success doing it.
        expect(() => main([])).toThrow(/missing required root/);
        expect(() => main([`--runtime-root=${REPO_ROOT}`])).toThrow(/AGENTOS_TARGET_REPO_ROOT/)
    });

    test('fails loud when a root is bound to a path that does not exist', () => {
        expect(() => main([`--runtime-root=${path.join(os.tmpdir(), 'no-such-runtime-root')}`,
                           `--target-root=${REPO_ROOT}`])).toThrow(/does not exist/)
    });

    test('--check exits 0 on a projected tree and 1 once it is broken', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            target = targetRepo(),
            argv   = [`--runtime-root=${root}`, `--target-root=${target}`];

        expect(silentMain(argv)).toBe(0);
        expect(silentMain([...argv, '--check'])).toBe(0);

        fs.rmSync(path.join(target, '.claude/hooks/a.mjs'));
        expect(silentMain([...argv, '--check'])).toBe(1);

        // The check arm audits without writing, so the break must survive it.
        expect(fs.existsSync(path.join(target, '.claude/hooks/a.mjs'))).toBe(false)
    })
});
