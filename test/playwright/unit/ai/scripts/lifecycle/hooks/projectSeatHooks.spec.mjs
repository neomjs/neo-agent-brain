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
    declaredHookCommands,
    enumerateConfigs,
    enumerateHooks,
    enumerateProjection,
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
