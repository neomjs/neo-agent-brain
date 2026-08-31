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
import {execFileSync, spawnSync} from 'node:child_process';
import fs               from 'node:fs';
import os               from 'node:os';
import path             from 'node:path';
import {
    assertRuntimeRoot,
    checkProjection,
    declaredHookCommands,
    enumerateConfigs,
    enumerateHooks,
    enumerateProjection,
    findOrphans,
    main,
    projectHooks,
    reconcileClaudeEvents,
    renderProjection,
    rewriteSpecifiers,
    writeLocalExclude
} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';

const
    REPO_ROOT        = path.resolve(process.cwd()),
    PROJECTOR_SCRIPT = path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/projectSeatHooks.mjs');

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
    });

    test('rewrites a relative literal only in ESM specifier position, never elsewhere', () => {
        // The discrimination the previous quote-only matcher could not make. Every literal below is
        // a `'../…'` string in one file; only the first three are module bindings.
        const
            root   = runtimeRoot({claude: {'a.mjs':
                "import {substrate} from '../../../../lib/substrate.mjs';\n" +
                "const engine = await import('../../../../lib/substrate.mjs');\n" +
                "import '../../../../lib/substrate.mjs';\n" +
                "const CHECKOUT_ROOT = path.resolve(import.meta.dirname, '../..');\n" +
                "const contextUrl = new URL('../CODEX.md', import.meta.url);\n"
            }}),
            source = path.join(root, 'ai/scripts/lifecycle/hooks/claude/a.mjs'),
            result = rewriteSpecifiers(fs.readFileSync(source, 'utf8'), source, root);

        // Static, dynamic and side-effect forms are all specifier position — all three bind.
        expect(result.rewritten).toBe(3);

        // The operational paths belong to the TARGET seat and are correct only while relative.
        expect(result.contents).toContain("path.resolve(import.meta.dirname, '../..')");
        expect(result.contents).toContain("new URL('../CODEX.md', import.meta.url)")
    })
});

test.describe('projectSeatHooks — the real corpus, rendered', () => {
    // The tests above drive authored fixtures, which is right for the projector's logic and wrong
    // for this question: whether the REAL seven hooks survive projection with working paths. The
    // previous rewriter passed every fixture assertion and still rendered two corrupted artifacts,
    // because no fixture happened to hold a relative literal outside specifier position. The real
    // corpus does, in two files. Found by @neo-gpt-emmy reviewing #250.
    const rendered = suffix => {
        const hook = enumerateHooks(REPO_ROOT).find(entry => entry.source.endsWith(suffix));

        expect(hook, `${suffix} is missing from the real corpus`).toBeTruthy();
        return renderProjection(hook.source, REPO_ROOT).contents
    };

    test('MUTANT — the Kimi seat keeps the target checkout root it reads .env from', () => {
        const contents = rendered('kimi-code/wakeEnvelopeHook.mjs');

        // Rewritten, this resolved to <runtimeRoot>/ai/scripts/lifecycle — the Brain's own tree — so
        // every projected Kimi seat read another repository's state, and reported no problem doing it.
        expect(contents).toContain("path.resolve(import.meta.dirname, '../..')");
        expect(contents).not.toContain(path.join(REPO_ROOT, 'ai/scripts/lifecycle') + "')")
    });

    test('MUTANT — the Codex seat keeps the relative URL of its own CODEX.md', () => {
        const contents = rendered('codex/codex-context.mjs');

        expect(contents).toContain("new URL('../CODEX.md', import.meta.url)");
        expect(contents).not.toContain(path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/CODEX.md'))
    });

    test('CONTROL — the same two files still get their module specifiers bound', () => {
        // Without this, both mutants above are satisfied by a rewriter that does nothing at all.
        ['kimi-code/wakeEnvelopeHook.mjs', 'codex/codex-context.mjs'].forEach(suffix => {
            const contents = rendered(suffix);

            expect(contents, `${suffix} bound no Brain specifier`).toContain(`from '${path.join(REPO_ROOT, 'ai')}`);
            expect(contents, `${suffix} left a relative Brain import`).not.toMatch(/\bfrom\s+'\.\.\//)
        })
    })
});

test.describe('projectSeatHooks — runtime-root identity', () => {
    // `requireRoot` proves a root was bound and exists. Neither fact says it is the RIGHT root, and
    // an empty population trivially satisfies every condition `--check` audits — so both arms
    // reported success on a wrong binding, the write arm after mutating the target's exclude file.
    // Found by @neo-gpt-emmy reviewing #250.
    test('MUTANT — a directory that is not a hook source reds both arms and mutates nothing', () => {
        const
            root        = scratch('not-an-agentos-root'),
            target      = targetRepo(),
            argv        = [`--runtime-root=${root}`, `--target-root=${target}`],
            excludeFile = path.join(target, '.git/info/exclude'),
            // `git init` writes this file, so its EXISTENCE proves nothing. Its bytes do.
            before      = {exclude: fs.readFileSync(excludeFile, 'utf8'), tree: fs.readdirSync(target).sort()};

        expect(() => projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target}))
            .toThrow(/not an Agent OS hook source/);
        expect(() => checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}))
            .toThrow(/not an Agent OS hook source/);

        // The exit code is what a provisioning caller reads, and it comes from the entrypoint guard
        // rather than from `main()` — so it is asserted by running the real script as a real process
        // instead of inferred from the throw.
        [argv, [...argv, '--check']].forEach(args => {
            const run = spawnSync(process.execPath, [PROJECTOR_SCRIPT, ...args], {encoding: 'utf8'});

            expect(run.status, `${args.join(' ')} did not exit 1`).toBe(1);
            expect(run.stderr).toMatch(/not an Agent OS hook source/)
        });

        // Zero mutation. The write arm previously ran to completion on this binding and rewrote the
        // exclude block, having read no source and written no hook.
        expect(fs.readdirSync(target).sort()).toEqual(before.tree);
        expect(fs.readFileSync(excludeFile, 'utf8')).toBe(before.exclude)
    });

    test('MUTANT — a hook source tree holding no declared harness is refused, not reported empty', () => {
        // The second condition, which the first does not imply: the directory is there and the
        // population is still zero. A renamed or half-deleted tree lands exactly here.
        const
            root   = scratch('empty-hook-source'),
            target = targetRepo();

        fs.mkdirSync(path.join(root, 'ai/scripts/lifecycle/hooks'), {recursive: true});

        expect(() => projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target}))
            .toThrow(/declares no projectable hook or config/);
        expect(() => checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}))
            .toThrow(/declares no projectable hook or config/)
    });

    test('CONTROL — the real runtime root passes the same assertion', () => {
        // Without this, both mutants are satisfied by a guard that refuses everything.
        expect(() => assertRuntimeRoot(REPO_ROOT)).not.toThrow()
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

/**
 * A Codex seat config shaped like the recovered original: the command interpolates the checkout
 * root, so what the harness executes is a repository-relative path the projector must have placed.
 * @param {String} script Repository-relative script the config declares.
 * @returns {String}
 */
function codexConfig(script) {
    return JSON.stringify({
        hooks: {
            SessionStart: [{
                hooks: [{
                    command: `/usr/bin/env node "$(git rev-parse --show-toplevel)/${script}" --session-start`,
                    type   : 'command'
                }]
            }]
        }
    }, null, 2) + '\n'
}

/** A Kimi seat config that also interpolates `.env`, exactly as the recovered original does. */
const KIMI_CONFIG = '[[hooks]]\nevent = "Stop"\ncommand = \'node ' +
    '--env-file-if-exists="$(git rev-parse --show-toplevel)/.env" ' +
    '"$(git rev-parse --show-toplevel)/.kimi-code/hooks/turnPresenceHook.mjs"\'\ntimeout = 5\n';

test.describe('projectSeatHooks — the deleted config artifacts (#250 census kind 2)', () => {
    test('the real census is 7 executables + 2 config artifacts, and never re-conflates them', () => {
        const
            configs    = enumerateConfigs(REPO_ROOT),
            projection = enumerateProjection(REPO_ROOT);

        // The counts are the ticket's own, asserted so a re-read cannot silently merge the kinds.
        expect(enumerateHooks(REPO_ROOT).length).toBe(7);
        expect(configs.length).toBe(2);
        expect(projection.length).toBe(9);

        expect(configs.map(entry => entry.target).sort())
            .toEqual(['.codex/hooks.json', '.kimi-code/hooks/turn-presence.example.toml']);

        // Claude's surviving surface is the Engine's settings.template.json — not a write this
        // repository may make. Its absence here is the carve-out, not an oversight.
        expect(configs.some(entry => entry.harness === 'claude')).toBe(false);

        configs.forEach(entry => {
            expect(fs.existsSync(entry.source)).toBe(true);
            expect(entry.executable).toBe(false)
        })
    });

    test('projects the config artifacts beside the executables, each in its own shape', () => {
        const
            root = runtimeRoot({
                codex      : {'codex-context.mjs': HOOK_SOURCE, 'hooks.json': codexConfig('.codex/hooks/codex-context.mjs')},
                'kimi-code': {'turnPresenceHook.mjs': HOOK_SOURCE, 'turn-presence.example.toml': KIMI_CONFIG}
            }),
            target = targetRepo(),
            {written} = projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(written.sort()).toEqual([
            '.codex/hooks.json',
            '.codex/hooks/codex-context.mjs',
            '.kimi-code/hooks/turn-presence.example.toml',
            '.kimi-code/hooks/turnPresenceHook.mjs'
        ]);

        const
            json = fs.readFileSync(path.join(target, '.codex/hooks.json'), 'utf8'),
            toml = fs.readFileSync(path.join(target, '.kimi-code/hooks/turn-presence.example.toml'), 'utf8');

        // JSON has no comment syntax, so a banner would make the config unparseable to the very
        // harness that has to read it. This is the assertion that keeps the banner out.
        expect(() => JSON.parse(json)).not.toThrow();
        expect(json).not.toContain('GENERATED');

        // TOML does have one, so the marking obligation is met where the format permits it.
        expect(toml.startsWith('# GENERATED by')).toBe(true);

        // A config is read, never run. Marking it executable would misdescribe it.
        expect(fs.statSync(path.join(target, '.codex/hooks.json')).mode & 0o111).toBe(0);
        expect(fs.statSync(path.join(target, '.codex/hooks/codex-context.mjs')).mode & 0o111).not.toBe(0);

        // Two roots, one projection: the seat must still be clean once both kinds have landed.
        expect(execFileSync('git', ['status', '--porcelain'], {cwd: target, encoding: 'utf8'}).trim()).toBe('')
    });

    test('a config artifact is never run through the specifier rewriter', () => {
        // `../` inside a config is a *string value*, not a module specifier. Rewriting it would
        // point the harness at an absolute path to a file that does not exist.
        const
            root = runtimeRoot({codex: {'hooks.json': codexConfig('../escaped/thing.mjs')}}),
            target = targetRepo();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(fs.readFileSync(path.join(target, '.codex/hooks.json'), 'utf8'))
            .toContain('../escaped/thing.mjs')
    })
});

test.describe('projectSeatHooks — AC-5: every declared command resolves to something placed', () => {
    /**
     * @summary Projects a two-harness seat and hands back the roots.
     * @param {String} codexScript What the Codex config declares.
     * @returns {Object}
     */
    function projected(codexScript = '.codex/hooks/codex-context.mjs') {
        const
            root = runtimeRoot({
                codex      : {'codex-context.mjs': HOOK_SOURCE, 'hooks.json': codexConfig(codexScript)},
                'kimi-code': {'turnPresenceHook.mjs': HOOK_SOURCE, 'turn-presence.example.toml': KIMI_CONFIG}
            }),
            target = targetRepo();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});
        return {root, target}
    }

    test('reads the declared commands back per harness, not inferred from one', () => {
        const {root, target} = projected();

        // Asserted per harness, per the AC — a single merged list would let one correct surface
        // vouch for another that names nothing at all.
        expect(declaredHookCommands(root, target)).toEqual({
            codex      : ['.codex/hooks/codex-context.mjs'],
            'kimi-code': ['.kimi-code/hooks/turnPresenceHook.mjs']
        });

        expect(checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}).ok).toBe(true)
    });

    test('CONTROL — the interpolated .env is not counted as an unplaced command', () => {
        // The Kimi commands also interpolate `$(git rev-parse --show-toplevel)/.env`, which is seat
        // identity state provisioned elsewhere. Collecting it would red every correct seat, so this
        // is the control that would fire if the extraction were widened past `.mjs`.
        const {root, target} = projected();

        expect(declaredHookCommands(root, target)['kimi-code']).not.toContain('.env');
        expect(checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}).unplacedCommands).toEqual([])
    });

    test('MUTANT — a seat config declares a script the projector did not place', () => {
        // This is the #250 symptom itself: a seat born pointing at a file no repository contains,
        // with the harness reporting nothing when it silently runs none of it.
        const {root, target} = projected('.codex/hooks/never-placed.mjs');

        const report = checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(report.ok).toBe(false);
        expect(report.unplacedCommands).toEqual([{harness: 'codex', target: '.codex/hooks/never-placed.mjs'}]);

        // It must be this condition and not a bystander — the files themselves are all present.
        expect(report.missing).toEqual([]);
        expect(report.stale).toEqual([]);
        expect(report.orphans).toEqual([])
    });

    test('MUTANT — the same condition on the KIMI surface, asserted rather than inferred', () => {
        // AC-5 says "asserted per harness, not inferred from one", and it is right to insist. The
        // codex arm above proves the mechanism works where the config is an enumerated artifact the
        // projector generates. Kimi's config is a different FORMAT (TOML), reached by the same
        // extraction — a regression narrowing that extraction to JSON would leave this arm as the
        // only thing that noticed.
        //
        // Built directly rather than through `projected()`, which only parameterizes the codex
        // script — passing it a kimi path would have been silently ignored and this would have been
        // the codex arm wearing a different name.
        const
            root = runtimeRoot({
                'kimi-code': {
                    'turnPresenceHook.mjs'      : HOOK_SOURCE,
                    'turn-presence.example.toml': KIMI_CONFIG.replace('turnPresenceHook.mjs', 'never-placed.mjs')
                }
            }),
            target = targetRepo();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        const report = checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(report.ok).toBe(false);
        expect(report.unplacedCommands)
            .toEqual([{harness: 'kimi-code', target: '.kimi-code/hooks/never-placed.mjs'}])
    });

    test('MUTANT — the same condition on the CLAUDE surface, which is not an enumerated config', () => {
        // The third harness, and structurally the one most likely to be missed: Claude's
        // `.claude/settings.json` is reconciled into rather than generated, so it is absent from
        // HARNESS_CONFIGS and the config-enumerating sweep cannot see it at all. An unplaced Claude
        // command was therefore invisible to the check whose entire job is unplaced commands.
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            target = targetRepo(),
            ours   = '/usr/bin/env node "$(git rev-parse --show-toplevel)/.claude/hooks/never-placed.mjs"';

        fs.mkdirSync(path.join(target, '.claude'), {recursive: true});
        fs.writeFileSync(path.join(target, '.claude/settings.json'), `${JSON.stringify({
            hooks: {Stop: [{hooks: [{command: ours, type: 'command'}]}]}
        }, null, 2)}\n`, 'utf8');

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        // Re-declare it after projection: reconciliation retires our stale entries, which is correct,
        // so the drift being tested is a settings file that acquires an unplaced command afterwards.
        const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'));

        settings.hooks.Stop = [{hooks: [{command: ours, type: 'command'}]}];
        fs.writeFileSync(path.join(target, '.claude/settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

        expect(declaredHookCommands(root, target).claude).toContain('.claude/hooks/never-placed.mjs');
        expect(checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}).unplacedCommands)
            .toEqual([{harness: 'claude', target: '.claude/hooks/never-placed.mjs'}])
    });

    test('CONTROL — the Engine\'s TRACKED guard is never reported as an unplaced command', () => {
        // The boundary of the arm above. `rgReplaceGuardHook` is declared in the same file, in the
        // same directory, in the same command shape — and the projector does not place it, because
        // the Engine tracks it. Collecting it would make `--check` red on a correct seat, which is
        // the previous failure one step removed rather than a fix.
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            target = targetRepo(),
            guard  = '/usr/bin/env node "$(git rev-parse --show-toplevel)/.claude/hooks/rgReplaceGuardHook.mjs"';

        fs.mkdirSync(path.join(target, '.claude/hooks'), {recursive: true});
        fs.writeFileSync(path.join(target, '.claude/hooks/rgReplaceGuardHook.mjs'), '// engine\n', 'utf8');
        execFileSync('git', ['add', '-f', '.claude/hooks/rgReplaceGuardHook.mjs'], {cwd: target});
        execFileSync('git', ['commit', '-qm', 'engine guard'], {cwd: target});

        fs.writeFileSync(path.join(target, '.claude/settings.json'), `${JSON.stringify({
            hooks: {PreToolUse: [{matcher: 'Bash', hooks: [{command: guard, type: 'command'}]}]}
        }, null, 2)}\n`, 'utf8');

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(declaredHookCommands(root, target).claude ?? []).not.toContain('.claude/hooks/rgReplaceGuardHook.mjs');
        expect(checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}).unplacedCommands).toEqual([])
    });

    test('MUTANT — a retired .toml left in an owned directory is pruned, not left executing', () => {
        // Before the manifest drove the sweep, orphan detection was hardcoded to `.mjs`, so a
        // retired config artifact would have stayed behind and kept being read forever.
        const {root, target} = projected(),
            stale = path.join(target, '.kimi-code/hooks/retired.example.toml');

        fs.writeFileSync(stale, '# left over\n', 'utf8');

        expect(findOrphans(root, target)).toContain('.kimi-code/hooks/retired.example.toml');

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});
        expect(fs.existsSync(stale)).toBe(false)
    });

    test('never sweeps a directory it does not own, even for an extension it projects', () => {
        // The projector owns the three hooks directories outright. It does NOT own `.codex/`, where
        // its config lands beside content that is none of its business — deleting an unclaimed file
        // there would be destroying somebody else's work to tidy our own.
        const {root, target} = projected(),
            bystander = path.join(target, '.codex/config.json');

        fs.writeFileSync(bystander, '{"unrelated": true}\n', 'utf8');

        expect(findOrphans(root, target)).not.toContain('.codex/config.json');

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});
        expect(fs.existsSync(bystander)).toBe(true)
    })
});

/**
 * The Claude seat is the one surface #250 reconciles rather than generates, so it is the one place
 * the projector can destroy somebody else's work. Every test below is shaped around that: the
 * question is never "did our four events land" alone, but "did they land *without* taking anything
 * with them".
 *
 * The Engine's `PreToolUse → rgReplaceGuardHook` is the positive control throughout. It sits in a
 * projector-owned directory with a projector-shaped command, so the only thing distinguishing it
 * from something we may retire is that the target tracks it. A fixture that forgot to `git add` it
 * would pass these tests for the wrong reason — which is exactly what the first fixture I wrote did.
 */
test.describe('projectSeatHooks — Claude settings reconciliation (ADR 0040 §2.7 shared custody)', () => {
    const
        ENGINE_GUARD  = '/usr/bin/env node "$(git rev-parse --show-toplevel)/.claude/hooks/rgReplaceGuardHook.mjs"',
        OPERATOR_HOOK = 'echo operator-owned',
        RETIRED       = '/usr/bin/env node "$(git rev-parse --show-toplevel)/.claude/hooks/laneStateStopHook.mjs"',
        MANIFEST      = {
            events: {
                SessionStart: [{hooks: [{command: `/usr/bin/env node "$(git rev-parse --show-toplevel)/.claude/hooks/a.mjs"`, timeout: 15, type: 'command'}]}],
                Stop        : [{hooks: [{command: `/usr/bin/env node "$(git rev-parse --show-toplevel)/.claude/hooks/a.mjs" stop`, timeout: 10, type: 'command'}]}]
            }
        };

    /**
     * @summary A runtime root carrying a Claude event manifest beside a projectable hook.
     * @param {Object} [manifest]
     * @returns {String}
     */
    function runtimeWithManifest(manifest = MANIFEST) {
        const root = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}});

        fs.writeFileSync(
            path.join(root, 'ai/scripts/lifecycle/hooks/claude/events.manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'
        );

        return root
    }

    /**
     * @summary A target whose settings the Engine has already hydrated.
     *
     * `tracked` is the whole point: the guard is committed, so it is the Engine's. Without the
     * commit it would be indistinguishable from a retired hook of ours.
     * @param {Object} [options]
     * @param {Boolean} [options.hydrated=true] Write a settings file at all.
     * @param {Boolean} [options.tracked=true] Commit the Engine guard so it reads as authored.
     * @returns {String}
     */
    function hydratedTarget({hydrated = true, tracked = true} = {}) {
        const
            root  = targetRepo(),
            hooks = path.join(root, '.claude/hooks');

        fs.mkdirSync(hooks, {recursive: true});
        fs.writeFileSync(path.join(hooks, 'rgReplaceGuardHook.mjs'), '// engine-owned\n', 'utf8');

        if (tracked) {
            execFileSync('git', ['add', '-f', '.claude/hooks/rgReplaceGuardHook.mjs'], {cwd: root});
            execFileSync('git', ['commit', '-qm', 'engine guard'], {cwd: root})
        }

        if (hydrated) {
            fs.writeFileSync(path.join(root, '.claude/settings.json'), `${JSON.stringify({
                model: 'opus',
                hooks: {
                    PreToolUse  : [{matcher: 'Bash', hooks: [{command: ENGINE_GUARD,  type: 'command'}]}],
                    SessionStart: [{hooks: [{command: OPERATOR_HOOK, type: 'command'}]}],
                    Stop        : [{hooks: [{command: RETIRED,       type: 'command'}]}]
                }
            }, null, 2)}\n`, 'utf8')
        }

        return root
    }

    /**
     * @summary Reads the reconciled settings back off disk.
     * @param {String} target
     * @returns {Object}
     */
    const settingsOf = target => JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'));

    /**
     * @summary Runs the projector as a real process and returns its exit code.
     *
     * The entrypoint guard maps a thrown refusal to `process.exit(1)`; `main()` itself throws. Only
     * running it as a process observes the code a setup script or CI step actually branches on.
     * @param {String} root
     * @param {String} target
     * @returns {Number}
     */
    function cliExitCode(root, target) {
        try {
            execFileSync(process.execPath, [
                path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/projectSeatHooks.mjs'),
                `--runtime-root=${root}`, `--target-root=${target}`
            ], {stdio: 'ignore'});

            return 0
        } catch (error) {
            return error.status ?? 1
        }
    }

    /** @summary Every command string in an event bucket, flattened. */
    const commandsFor = (settings, event) =>
        (settings.hooks[event] || []).flatMap(bucket => (bucket.hooks || []).map(entry => entry.command));

    test('retires our stale command while the tracked Engine entry survives untouched', () => {
        const
            root   = runtimeWithManifest(),
            target = hydratedTarget(),
            {reconciled} = projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target}),
            settings     = settingsOf(target);

        expect(reconciled.reason).toBeNull();
        expect(reconciled.removed).toBe(1);

        // The retired Stop command is gone, replaced rather than accumulated.
        expect(commandsFor(settings, 'Stop')).toHaveLength(1);
        expect(commandsFor(settings, 'Stop')[0]).not.toBe(RETIRED);

        // POSITIVE CONTROL. Same directory, same command shape, tracked — therefore preserved.
        expect(commandsFor(settings, 'PreToolUse')).toEqual([ENGINE_GUARD]);
    });

    test('an untracked guard at the same path IS retired — proving the control is the tracked bit', () => {
        // Non-vacuity for the test above. If the guard survived regardless of tracking, that
        // assertion would be measuring the directory, not the ownership predicate, and the whole
        // custody model would be decorative.
        const
            root   = runtimeWithManifest(),
            target = hydratedTarget({tracked: false});

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(commandsFor(settingsOf(target), 'PreToolUse')).toEqual([])
    });

    test('preserves an operator hook on an event the manifest also declares', () => {
        // The case a `{...active, ...manifest}` spread loses silently: SessionStart exists on both
        // sides, so a shallow merge would drop the operator's entry while reporting success.
        const
            root   = runtimeWithManifest(),
            target = hydratedTarget();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(commandsFor(settingsOf(target), 'SessionStart')).toContain(OPERATOR_HOOK)
    });

    test('leaves every non-hook setting alone', () => {
        const
            root   = runtimeWithManifest(),
            target = hydratedTarget();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(settingsOf(target).model).toBe('opus')
    });

    test('deletes a bucket emptied by retirement instead of leaving []', () => {
        // An empty array is not equivalent to an absent key: it is a declaration that the event is
        // wired to nothing, and it accumulates one entry per retirement cycle.
        const
            root   = runtimeWithManifest({events: {SessionStart: MANIFEST.events.SessionStart}}),
            target = hydratedTarget();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        // Stop held only our retired command and the manifest no longer declares it.
        expect('Stop' in settingsOf(target).hooks).toBe(false)
    });

    test('re-running is byte-identical — the second projection changes nothing', () => {
        const
            root   = runtimeWithManifest(),
            target = hydratedTarget();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        const first = fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'),
              {reconciled} = projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(reconciled.changed).toBe(false);
        expect(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')).toBe(first)
    });

    /**
     * A declared manifest that cannot be reconciled is a FAILED projection, not a partial one.
     *
     * The write arm used to return normally in both cases below, and `main()` exited 0 after
     * printing "NOT reconciled" — so a seat left holding nine hook files that nothing invokes was
     * indistinguishable, to any caller checking an exit code, from a correctly wired one. That is
     * the silently-dead-hook failure the module header opens with, reproduced one layer up.
     *
     * Found by @neo-gpt-emmy reviewing #250. Both arms assert the refusal AND that nothing was
     * written: "it threw" is not the property that matters if it threw after writing eight files.
     */
    test('declared manifest + absent settings: refuses, writes nothing, exits nonzero', () => {
        const
            root   = runtimeWithManifest(),
            target = hydratedTarget({hydrated: false});

        expect(() => projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target}))
            .toThrow(/cannot wire the Claude seat.*absent/s);

        // Zero projected mutation — the hooks and the settings that invoke them land together.
        expect(fs.existsSync(path.join(target, '.claude/hooks/a.mjs'))).toBe(false);
        expect(fs.existsSync(path.join(target, '.claude/settings.json'))).toBe(false);

        // The exit code an actual caller sees. Asserted by running the CLI as a process rather than
        // by reading `main()`'s return value: `main()` throws and the entrypoint guard maps that to
        // exit 1, so a return-value assertion would be testing my model of the CLI instead of the
        // surface a setup script or CI step reads.
        expect(cliExitCode(root, target)).not.toBe(0)
    });

    test('declared manifest + invalid JSON: refuses, writes nothing, leaves the file untouched', () => {
        const
            root     = runtimeWithManifest(),
            target   = hydratedTarget(),
            settings = path.join(target, '.claude/settings.json'),
            corrupt  = '{ mid-edit, not json';

        fs.writeFileSync(settings, corrupt, 'utf8');

        expect(() => projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target}))
            .toThrow(/cannot wire the Claude seat.*not valid JSON/s);

        expect(fs.existsSync(path.join(target, '.claude/hooks/a.mjs'))).toBe(false);
        // Reconstructing a file an operator may be mid-edit on destroys real work to satisfy a check.
        expect(fs.readFileSync(settings, 'utf8')).toBe(corrupt);

        expect(cliExitCode(root, target)).not.toBe(0)
    });

    test('an absent manifest still projects — the no-op stays coherent', () => {
        // The boundary of the refusal above. A runtime root declaring no Claude events must not be
        // dragged into failing just because the target has no settings file to reconcile into.
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE}}),
            target = targetRepo();

        expect(() => projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target})).not.toThrow();
        expect(fs.existsSync(path.join(target, '.claude/hooks/a.mjs'))).toBe(true)
    });

    test('--check reds on settings drift and greens again after re-projecting', () => {
        const
            root   = runtimeWithManifest(),
            target = hydratedTarget(),
            argv   = [`--runtime-root=${root}`, `--target-root=${target}`];

        expect(silentMain(argv)).toBe(0);
        expect(silentMain([...argv, '--check'])).toBe(0);

        // Re-introduce a command we retired — the drift a live seat actually suffers.
        const settings = settingsOf(target);

        settings.hooks.Stop.push({hooks: [{command: RETIRED, type: 'command'}]});
        fs.writeFileSync(path.join(target, '.claude/settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

        const report = checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(report.ok).toBe(false);
        expect(report.unreconciledEvents).toHaveLength(1);
        expect(silentMain([...argv, '--check'])).toBe(1);

        expect(silentMain(argv)).toBe(0);
        expect(silentMain([...argv, '--check'])).toBe(0)
    });

    test('--check stays green when the manifest is absent rather than failing every seat', () => {
        // A runtime root with no Claude manifest declares no Claude events. That is a coherent
        // state — not every deployment wires the Claude seat — and reporting it as drift would make
        // `--check` red for every target that legitimately has nothing to reconcile.
        const
            root   = runtimeRoot({codex: {'b.mjs': HOOK_SOURCE}}),
            target = targetRepo();

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        const report = checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target});

        expect(report.unreconciledEvents).toEqual([]);
        expect(report.ok).toBe(true)
    })
});

/**
 * ADR 0040 §2.5's re-materialization covenant: a seat provisioned by an EARLIER revision has to be
 * brought current by re-running the projector, and that has to be demonstrated by reading the seat
 * back — not inferred from the sources being correct now.
 *
 * The distinction is the whole acceptance criterion. A corrected template proves the next FRESH
 * provision is right and says nothing about the seats already out there, which are the ones actually
 * running hooks. Every failure mode here is silent from inside the seat: stale bytes still execute,
 * a retired hook still executes, and a settings entry pointing at a deleted file executes nothing
 * while reporting nothing.
 */
test.describe('projectSeatHooks — re-materializing an already-provisioned seat (ADR 0040 §2.5)', () => {
    test('a seat provisioned at an earlier revision is brought fully current', () => {
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE, 'retired.mjs': HOOK_SOURCE}}),
            target = targetRepo(),
            manifestPath = path.join(root, 'ai/scripts/lifecycle/hooks/claude/events.manifest.json'),
            command      = name => `/usr/bin/env node "$(git rev-parse --show-toplevel)/.claude/hooks/${name}"`;

        // ---- revision A: provision the seat -------------------------------------------------
        fs.writeFileSync(manifestPath, `${JSON.stringify({
            events: {Stop: [{hooks: [{command: command('retired.mjs'), timeout: 10, type: 'command'}]}]}
        }, null, 2)}\n`, 'utf8');

        fs.mkdirSync(path.join(target, '.claude'), {recursive: true});
        fs.writeFileSync(path.join(target, '.claude/settings.json'), `${JSON.stringify({model: 'opus'}, null, 2)}\n`, 'utf8');

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        const provisioned = {
            aBytes  : fs.readFileSync(path.join(target, '.claude/hooks/a.mjs'), 'utf8'),
            settings: fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')
        };

        expect(provisioned.settings).toContain('retired.mjs');
        expect(fs.existsSync(path.join(target, '.claude/hooks/retired.mjs'))).toBe(true);

        // ---- revision B: the substrate moves on --------------------------------------------
        // A hook's contents change, a hook is retired outright, a new hook appears, and the manifest
        // re-points. All four are things a real revision does, and all four are invisible to a seat
        // that is never re-materialized.
        fs.writeFileSync(
            path.join(root, 'ai/scripts/lifecycle/hooks/claude/a.mjs'),
            `${HOOK_SOURCE}export const revision = 'B';\n`, 'utf8'
        );
        fs.rmSync(path.join(root, 'ai/scripts/lifecycle/hooks/claude/retired.mjs'));
        fs.writeFileSync(path.join(root, 'ai/scripts/lifecycle/hooks/claude/added.mjs'), HOOK_SOURCE, 'utf8');
        fs.writeFileSync(manifestPath, `${JSON.stringify({
            events: {Stop: [{hooks: [{command: command('a.mjs'), timeout: 10, type: 'command'}]}]}
        }, null, 2)}\n`, 'utf8');

        // Before re-materializing, --check must SAY the seat is behind. A projector that could bring
        // a seat current but not report that it needed it leaves the operator with no way to know.
        expect(checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}).ok).toBe(false);

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        // ---- read the seat back -------------------------------------------------------------
        const settings = fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8');

        // Stale bytes replaced, not merely present.
        expect(fs.readFileSync(path.join(target, '.claude/hooks/a.mjs'), 'utf8')).not.toBe(provisioned.aBytes);
        expect(fs.readFileSync(path.join(target, '.claude/hooks/a.mjs'), 'utf8')).toContain("revision = 'B'");

        // The retired hook is GONE from disk — a leftover executable keeps running.
        expect(fs.existsSync(path.join(target, '.claude/hooks/retired.mjs'))).toBe(false);

        // And gone from the config, which is the half that would otherwise point at a deleted file.
        expect(settings).not.toContain('retired.mjs');
        expect(settings).toContain('a.mjs');

        // The new hook arrived.
        expect(fs.existsSync(path.join(target, '.claude/hooks/added.mjs'))).toBe(true);

        // Operator-owned state carried through both provisions.
        expect(JSON.parse(settings).model).toBe('opus');

        // And the seat now reports current — read back through the same instrument an operator uses.
        expect(checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}).ok).toBe(true)
    });

    test('re-materialization is what fixes it — corrected sources alone do not', () => {
        // The negative control for the covenant, and the reason AC-7 says "a corrected template alone
        // is not migration evidence". Same revision-A seat, same revision-B sources, and NO second
        // projection: the seat keeps executing the old bytes and the retired hook, and `--check`
        // still reds. Nothing about correct sources reaches a provisioned seat on its own.
        const
            root   = runtimeRoot({claude: {'a.mjs': HOOK_SOURCE, 'retired.mjs': HOOK_SOURCE}}),
            target = targetRepo();

        fs.mkdirSync(path.join(target, '.claude'), {recursive: true});
        fs.writeFileSync(path.join(target, '.claude/settings.json'), `${JSON.stringify({model: 'opus'}, null, 2)}\n`, 'utf8');

        projectHooks({agentosRuntimeRoot: root, targetRepoRoot: target});

        fs.writeFileSync(
            path.join(root, 'ai/scripts/lifecycle/hooks/claude/a.mjs'),
            `${HOOK_SOURCE}export const revision = 'B';\n`, 'utf8'
        );
        fs.rmSync(path.join(root, 'ai/scripts/lifecycle/hooks/claude/retired.mjs'));

        expect(fs.readFileSync(path.join(target, '.claude/hooks/a.mjs'), 'utf8')).not.toContain("revision = 'B'");
        expect(fs.existsSync(path.join(target, '.claude/hooks/retired.mjs'))).toBe(true);
        expect(checkProjection({agentosRuntimeRoot: root, targetRepoRoot: target}).ok).toBe(false)
    })
});

test.describe('the real Claude manifest — contract properties of the shipped file', () => {
    const
        MANIFEST_PATH = path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/claude/events.manifest.json'),
        manifest      = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

    test('wakeArmingHook\'s HOOK_TIMEOUT_MS equals the timeout it is registered with', async () => {
        // The parity `wakeArmingHook.mjs` asserted in prose for months without any spec behind it —
        // `git grep HOOK_TIMEOUT_MS test/` returned nothing. The hook derives its MCP connect and
        // list budgets from this constant, so a manifest registering less does not merely mismatch:
        // it kills the process AFTER reading subscriptions and BEFORE publishing, which is the one
        // moment where stopping loses work rather than deferring it.
        //
        // Found by @neo-gpt-emmy in peer review of #250.
        const
            {HOOK_TIMEOUT_MS} = await import('../../../../../../../ai/scripts/lifecycle/hooks/claude/wakeArmingHook.mjs'),
            registered        = manifest.events.SessionStart[0].hooks[0].timeout;

        expect(registered, 'SessionStart carries no timeout — the hook would inherit a default it does not know')
            .toBeGreaterThan(0);

        expect(HOOK_TIMEOUT_MS).toBe(registered * 1000)
    });

    test('every declared command targets a hook this repository actually ships', () => {
        // A manifest entry naming a file that does not exist wires the seat to nothing and reports
        // no error at any layer: the harness runs the command, node fails to resolve, the hook is
        // simply silent. Checked against the sources rather than a projection, because the manifest
        // is source data and this must hold before anything is materialized.
        const commands = Object.values(manifest.events)
            .flatMap(buckets => buckets.flatMap(bucket => bucket.hooks.map(entry => entry.command)));

        expect(commands.length).toBeGreaterThan(0);

        commands.forEach(command => {
            const match = command.match(/\.claude\/hooks\/([\w.-]+\.mjs)/);

            expect(match, `command declares no .claude/hooks target: ${command}`).not.toBeNull();
            expect(
                fs.existsSync(path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/claude', match[1])),
                `${match[1]} is declared by the manifest but not shipped in hooks/claude/`
            ).toBe(true)
        })
    });

    test('the decision core runs with no repository, no filesystem, and no git', () => {
        // The evidence for the word "pure" in reconcileClaudeEvents' JSDoc. Its first draft claimed
        // purity while reaching isProjectorOwnedCommand -> tracked() -> execFileSync('git'), and
        // @neo-gpt-emmy caught the claim in review. Injecting the predicate made the claim true;
        // this test is what keeps it true, because a doc asserting an untested property is the same
        // defect in a different file — which is precisely what wakeArmingHook's "a spec asserts it"
        // turned out to be.
        //
        // Every path here is fictional. If anything in the core touched disk or git, this throws.
        const
            seen  = [],
            owned = '/usr/bin/env node "/nowhere/.claude/hooks/ours.mjs"',
            alien = 'echo not-ours',
            {added, removed, settings} = reconcileClaudeEvents({
                isOwned : command => {seen.push(command); return command === owned},
                manifest: {events: {Stop: [{hooks: [{command: 'fresh', type: 'command'}]}]}},
                settings: {
                    model: 'kept',
                    hooks: {
                        Stop        : [{hooks: [{command: owned, type: 'command'}]}],
                        SessionStart: [{hooks: [{command: alien, type: 'command'}]}]
                    }
                }
            });

        expect(seen).toEqual([owned, alien]);   // the core asked, and asked about everything
        expect(removed).toBe(1);
        expect(added).toBe(1);
        expect(settings.model).toBe('kept');
        expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(alien);
        expect(settings.hooks.Stop).toEqual([{hooks: [{command: 'fresh', type: 'command'}]}])
    });

    test('does NOT declare the Engine-owned PreToolUse guard', () => {
        // The custody line, asserted rather than trusted to a comment. Restating the Engine's tracked
        // entry here would make this repository the second author of it, and the two would drift with
        // no arbiter — the reversal @neo-gpt-emmy rejected when deciding this fork.
        expect('PreToolUse' in manifest.events).toBe(false);
        expect(JSON.stringify(manifest.events)).not.toContain('rgReplaceGuardHook')
    })
});
