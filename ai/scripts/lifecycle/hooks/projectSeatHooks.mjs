#!/usr/bin/env node
/**
 * @module ai/scripts/lifecycle/hooks/projectSeatHooks
 * @summary Materializes the Agent-OS-owned seat hooks into a target checkout as generated-not-tracked artifacts.
 *
 * Seat hooks are Agent OS substrate that must *execute* inside an arbitrary target repository. The
 * sources live here; the target gets generated copies whose Brain-substrate specifiers are rewritten
 * to absolute paths beneath the runtime root. That rewrite is the whole reason these are generated
 * rather than copied verbatim: a relative specifier resolved from the target would climb out of a
 * tree that does not contain this repository.
 *
 * **Why copies and not symlinks — measured, not assumed.** Symlinking is the transport the sibling
 * skills materializer uses, and for skills it is correct: those are data files, read and never run.
 * Hooks are executables, and every one of them gates `main()` on
 * `import.meta.url === pathToFileURL(process.argv[1]).href`. Through a symlink `argv[1]` keeps the
 * link path while `import.meta.url` resolves to the realpath, so the guard is false: the module
 * loads, `main()` never runs, the process exits 0, and nothing anywhere reports a problem. A
 * silently dead hook is the exact failure this projection exists to end, so the transport that
 * produces one is unavailable regardless of how convenient it is.
 *
 * Two roots, never conflated (ADR 0040 §2.5): `agentosRuntimeRoot` is where the sources live and
 * what rewritten specifiers point at; `targetRepoRoot` is the destination only. Neither defaults to
 * `process.cwd()` — an absent binding fails loud rather than silently projecting into whatever
 * directory the process happened to start in.
 */
import {execFileSync}                      from 'node:child_process';
import fs                                  from 'node:fs';
import path                                from 'node:path';
import {fileURLToPath, pathToFileURL}      from 'node:url';

const
    dirname = path.dirname(fileURLToPath(import.meta.url)),
    /**
     * The one path under a runtime root that holds every harness's hook sources.
     *
     * Written once rather than inlined at each enumerator, because {@link assertRuntimeRoot} has to
     * check the *same* directory the enumerators read. A guard that validated a path the readers do
     * not use would pass while they still found nothing — which is precisely the false green it
     * exists to close.
     */
    HOOK_SOURCE_DIR = 'ai/scripts/lifecycle/hooks',
    /**
     * Source directory → target directory, per harness. The target segments are dot-prefixed by the
     * harnesses themselves; the source segments are not, because a dotted source directory is
     * hostile to tooling and to diffing a projection against its origin.
     */
    HARNESS_TARGETS = Object.freeze({
        'claude'   : '.claude/hooks',
        'codex'    : '.codex/hooks',
        'kimi-code': '.kimi-code/hooks'
    }),
    /**
     * The census's **deleted config artifacts**, enumerated one by one rather than swept.
     *
     * #250 classifies the leaf-6 removal into three kinds, and they take three dispositions:
     * executables move and have their imports rewritten, deleted config artifacts are regenerated
     * by this projector, and the target's active `.claude/settings.json` is reconciled in place.
     * These are the second kind. Without them the Codex seat declares nothing at all — leaf 6 took
     * `hooks.json` and nothing put it back — so the restored executables sit in the checkout with
     * no surface naming them.
     *
     * Each target is written out rather than derived from {@link HARNESS_TARGETS}, because they do
     * not follow it: Codex's config sits *beside* its hooks directory, not inside it. ADR 0040 §2.7
     * wants a disposition stated for every file, and a mapping rule that happens to be wrong for
     * half its entries is not a census.
     *
     * Claude is deliberately absent, and not for want of permission: we do reconcile the target's
     * active `.claude/settings.json`. It is absent because that file is not one we *generate* — the
     * Engine hydrates it from `.claude/settings.template.json` (`initServerConfigs.mjs` resolves
     * that template from `engineRoot`), and we hold one custody share of the result.
     * {@link CLAUDE_SETTINGS} states that split; this table is only for configs written out whole.
     */
    HARNESS_CONFIGS = Object.freeze({
        'codex'    : Object.freeze([{source: 'hooks.json', target: '.codex/hooks.json'}]),
        'kimi-code': Object.freeze([
            {source: 'turn-presence.example.toml', target: '.kimi-code/hooks/turn-presence.example.toml'}
        ])
    }),
    /**
     * The Claude seat's two halves, which live in different repositories on purpose.
     *
     * `CLAUDE_EVENT_MANIFEST` is ours: the declaration of which events the Agent OS wires and with
     * what commands. `CLAUDE_SETTINGS` is the target's active file, hydrated from the *Engine's*
     * `settings.template.json` before we ever see it. We reconcile into it; we never author it and
     * never replace it. That asymmetry is why Claude is absent from {@link HARNESS_CONFIGS} — it is
     * not a config we generate, it is a config we hold one custody share of.
     */
    CLAUDE_EVENT_MANIFEST = 'ai/scripts/lifecycle/hooks/claude/events.manifest.json',
    CLAUDE_SETTINGS       = '.claude/settings.json',
    /**
     * Marks a generated artifact so a reader never mistakes a projection for an authored file,
     * keyed by the comment syntax each format actually has.
     *
     * `.json` is absent on purpose: JSON has no comment syntax, and inventing a `_generated` key
     * would put a value into a config we do not own the schema of, to be parsed by a harness that
     * never agreed to it. Its generated-ness is carried where it is verifiable instead — the
     * `.git/info/exclude` block and `--check`'s byte comparison — rather than by a banner that
     * would have to be a lie about the format.
     */
    GENERATED_BANNERS = Object.freeze({
        '.mjs' : '// GENERATED by ai/scripts/lifecycle/hooks/projectSeatHooks.mjs — do not edit.\n' +
                 '// Source of truth: <agentosRuntimeRoot>/ai/scripts/lifecycle/hooks/\n',
        '.toml': '# GENERATED by ai/scripts/lifecycle/hooks/projectSeatHooks.mjs — do not edit.\n' +
                 '# Source of truth: <agentosRuntimeRoot>/ai/scripts/lifecycle/hooks/\n'
    });

/**
 * @summary Is a path tracked by the target's git? A tracked path is authored content, not projection.
 * @param {String} root Target repository root.
 * @param {String} relPath Repository-relative path.
 * @returns {Boolean}
 */
export function tracked(root, relPath) {
    try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {cwd: root, stdio: 'ignore'});
        return true
    } catch {
        return false
    }
}

/**
 * @summary Enumerates every projectable hook as `{harness, source, target}` triples.
 * @param {String} runtimeRoot Absolute AgentOS runtime root.
 * @returns {Object[]}
 */
export function enumerateHooks(runtimeRoot) {
    const hooks = [];

    Object.entries(HARNESS_TARGETS).forEach(([harness, targetDir]) => {
        const sourceDir = path.join(runtimeRoot, HOOK_SOURCE_DIR, harness);

        if (!fs.existsSync(sourceDir)) return;

        fs.readdirSync(sourceDir)
            .filter(name => name.endsWith('.mjs'))
            .sort()
            .forEach(name => hooks.push({
                executable: true,
                harness,
                source: path.join(sourceDir, name),
                target: path.posix.join(targetDir, name)
            }))
    });

    return hooks
}

/**
 * @summary Enumerates the census's deleted config artifacts as the same `{harness, source, target}`
 * triples the executables produce.
 *
 * Enumerated from {@link HARNESS_CONFIGS} rather than by reading the directory, because these are a
 * named census of two files, not a population that grows when somebody drops a file in. A `.json`
 * appearing beside a hook source should not silently become a projected seat config.
 * @param {String} runtimeRoot Absolute AgentOS runtime root.
 * @returns {Object[]}
 */
export function enumerateConfigs(runtimeRoot) {
    const configs = [];

    Object.entries(HARNESS_CONFIGS).forEach(([harness, entries]) => {
        entries.forEach(({source, target}) => {
            const absSource = path.join(runtimeRoot, HOOK_SOURCE_DIR, harness, source);

            if (fs.existsSync(absSource)) configs.push({executable: false, harness, source: absSource, target})
        })
    });

    return configs
}

/**
 * @summary The whole projection — executables and config artifacts — as one manifest.
 *
 * Every consumer takes this rather than {@link enumerateHooks}, so a kind cannot be projected by
 * the write arm and then be invisible to `--check`, which is exactly how a surface drifts unnoticed.
 * @param {String} runtimeRoot Absolute AgentOS runtime root.
 * @returns {Object[]}
 */
export function enumerateProjection(runtimeRoot) {
    return [...enumerateHooks(runtimeRoot), ...enumerateConfigs(runtimeRoot)]
}

/**
 * @summary Proves the bound runtime root is an Agent OS hook source before either arm may report on it.
 *
 * `requireRoot` establishes that a root was *bound* and that the path exists. Neither fact says the
 * path is the right one, and existence is the weaker half by far: any directory that happens to be
 * there satisfies it. Bound to an empty or swapped root the enumerators found nothing, so the write
 * arm reported `projected 0 hook(s)` and exited 0, and `--check` reported `OK — every declared hook
 * is projected and current` and exited 0. An empty population trivially satisfies every condition
 * `--check` audits; a zero-artifact projection is indistinguishable from a complete one when the
 * only question asked is whether anything is missing.
 *
 * So identity is asserted rather than inferred from a clean audit, and it is asserted *before any
 * target mutation* — the write arm previously reached `writeLocalExclude` and rewrote the target's
 * `.git/info/exclude` on a wrong root, which is a mutation performed on the strength of a binding
 * that was never valid.
 *
 * Both conditions are required and neither implies the other: the directory can exist while holding
 * no harness the manifest declares (a partial or renamed tree), and a population can only be counted
 * once there is a directory to count it in.
 *
 * Found by @neo-gpt-emmy reviewing #250, whose swapped-root probe drove both arms green.
 * @param {String} runtimeRoot Absolute AgentOS runtime root.
 * @throws {Error} If the root is not a hook source, or declares no projectable artifact at all.
 */
export function assertRuntimeRoot(runtimeRoot) {
    const hookSourceRoot = path.join(runtimeRoot, HOOK_SOURCE_DIR);

    if (!fs.existsSync(hookSourceRoot)) {
        throw new Error(
            `runtime root is not an Agent OS hook source: ${runtimeRoot} has no ${HOOK_SOURCE_DIR}. ` +
            'Nothing was read and nothing was written — bind --runtime-root to the Brain checkout.'
        )
    }

    if (enumerateProjection(runtimeRoot).length === 0) {
        throw new Error(
            `runtime root declares no projectable hook or config: ${hookSourceRoot} holds none of ` +
            `${Object.keys(HARNESS_TARGETS).join(', ')}. Refusing to report a zero-artifact ` +
            'projection as a complete one.'
        )
    }
}

/**
 * A relative string in ESM **specifier position**, and nowhere else.
 *
 * The three prefixes are the only syntactic places a module specifier can appear: `from '…'` covers
 * every static `import`/`export … from` including the multi-line forms this corpus uses, `import(…)`
 * covers the dynamic form, and a bare `import '…'` covers the side-effect form.
 *
 * The narrowness is the point. A quote-only matcher — `/(['"])(\.\.?\/[^'"]+)\1/g`, the previous
 * implementation — cannot tell a module binding from an operational path, and both appear as
 * `'../…'` literals in these hooks. See {@link rewriteSpecifiers} for what that cost.
 */
const ESM_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]+)\2/g;

/**
 * @summary Rewrites Brain-substrate **module specifiers** to absolute paths beneath the runtime root.
 *
 * Only `../`-relative specifiers are touched, only in ESM specifier position, and only those that
 * resolve inside the runtime root. Package specifiers (`neo.mjs/src/**`) are deliberately left
 * alone: they resolve through the target's own `node_modules` against the published Engine, which is
 * the §2.3 dependency direction. A specifier that resolves OUTSIDE the runtime root is returned
 * unchanged and reported, because silently rewriting it would invent a dependency the source never
 * declared.
 *
 * That §2.3 reasoning holds for every target except the one where the dependency direction
 * degenerates — the seat that *is* the package. {@link rewriteSelfPackageSpecifiers} handles that
 * case separately rather than weakening the rule here.
 *
 * **Why position and not merely shape.** Rewriting is correct for exactly one category: a binding
 * the *Brain runtime* must resolve, which cannot survive being read from a tree that does not
 * contain this repository. A hook's other relative literals are the opposite category — they are
 * operational paths the *target seat* must resolve, and they are correct only while they stay
 * relative to the projected artifact. The two are indistinguishable by shape, so position is the
 * only honest discriminator:
 *
 * - `kimi-code/wakeEnvelopeHook.mjs`: `path.resolve(import.meta.dirname, '../..')` is the target
 *   checkout root the seat reads its `.env` from. Rewritten, the seat read the Brain runtime's
 *   `ai/scripts/lifecycle` instead — a projected hook resolving another repository's state.
 * - `codex/codex-context.mjs`: `new URL('../CODEX.md', import.meta.url)` is the target's own context
 *   file. Rewritten, every seat was handed the Brain's copy.
 *
 * Both hooks projected, both ran, neither reported a problem — the failure mode was a *wrong* answer
 * rather than a missing one, which no presence check can see. Found by @neo-gpt-emmy reviewing #250,
 * rendering the real corpus rather than the spec's authored fixtures.
 * @param {String} contents Source text.
 * @param {String} sourceFile Absolute path of the source module.
 * @param {String} runtimeRoot Absolute AgentOS runtime root.
 * @returns {{contents: String, rewritten: Number, escaped: String[]}}
 */
export function rewriteSpecifiers(contents, sourceFile, runtimeRoot) {
    const
        sourceDir = path.dirname(sourceFile),
        escaped   = [];

    let rewritten = 0;

    const next = contents.replace(ESM_SPECIFIER, (match, prefix, quote, specifier) => {
        const resolved = path.resolve(sourceDir, specifier);

        if (!resolved.startsWith(runtimeRoot + path.sep)) {
            escaped.push(specifier);
            return match
        }

        rewritten++;
        return `${prefix}${quote}${resolved}${quote}`
    });

    return {contents: next, escaped, rewritten}
}

/**
 * @summary Reads a target checkout's own package manifest, or `null` when it has none.
 *
 * A target without a manifest, or with one Node itself would reject, is not an error here: it is a
 * seat that simply cannot be the degenerate case below, and it takes the untouched path.
 * @param {String} targetRepoRoot Absolute target repository root.
 * @returns {Object|null}
 */
function readTargetManifest(targetRepoRoot) {
    const manifest = path.join(targetRepoRoot, 'package.json');

    if (!fs.existsSync(manifest)) return null;

    try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8'))
    } catch {
        return null
    }
}

/**
 * @summary Resolves a package specifier inside the target when the target **is** that package.
 *
 * {@link rewriteSpecifiers} leaves package specifiers alone on purpose, and that is right for every
 * seat but one. `await import('neo.mjs/src/Neo.mjs')` resolves from the importing file upward —
 * `<engine>/.claude/hooks/` → `<engine>/node_modules/neo.mjs` — and the Engine checkout *is*
 * `neo.mjs`, so that directory cannot exist: a package does not carry itself in its own
 * `node_modules`. The specifier is not wrong and the rewriter is not at fault; the projector simply
 * had no notion of the one target where §2.3's dependency direction degenerates into self-reference.
 *
 * Measured on `neomjs/neo-agent-brain#79`: all three Claude hooks threw
 * `Cannot find package 'neo.mjs'` in the Engine seat and **exited 0**, so the fleet's only
 * wake-arming path had been dead since 2026-08-24 with every surface green. Brain- and
 * institution-resident seats carry `node_modules/neo.mjs` and were never affected — one `ls`
 * discriminates, which is why this is target-aware rather than a change to the rule.
 *
 * **Why the `exports` refusal.** Without an `exports` map a subpath specifier *is* a file path
 * beneath the package root, so `<name>/src/Neo.mjs` → `<targetRoot>/src/Neo.mjs` is the identical
 * resolution. With one, the package chooses its own mapping and this rewrite would fabricate a path
 * that merely looks plausible. Such a specifier is reported through the same `escaped` channel a
 * runtime-root escapee uses — same meaning (the projection cannot bind it), same refusal in
 * {@link projectHooks} — rather than being written out as a wrong answer nobody can see.
 * @param {String} contents Source text, already relative-rewritten.
 * @param {String} [targetRepoRoot] Absolute target repository root. Absent → no-op.
 * @returns {{contents: String, escaped: String[], rewritten: Number}}
 */
export function rewriteSelfPackageSpecifiers(contents, targetRepoRoot) {
    const manifest = targetRepoRoot ? readTargetManifest(targetRepoRoot) : null;

    if (!manifest?.name) return {contents, escaped: [], rewritten: 0};

    const
        escaped = [],
        mapped  = Boolean(manifest.exports),
        pattern = new RegExp(
            '(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)([\'"])' +
            manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '\\/([^\'"]+)\\2',
            'g'
        );

    let rewritten = 0;

    const next = contents.replace(pattern, (match, prefix, quote, subpath) => {
        if (mapped) {
            escaped.push(`${manifest.name}/${subpath}`);
            return match
        }

        rewritten++;
        return `${prefix}${quote}${path.join(targetRepoRoot, subpath)}${quote}`
    });

    return {contents: next, escaped, rewritten}
}

/**
 * @summary Finds projected-looking files the manifest no longer claims.
 *
 * The other conditions all start from a source and ask what happened to it. This one runs the
 * other way — it starts from what is *on disk* in a projection directory — because a hook that
 * was renamed or retired leaves a file behind that no enumeration will ever visit again. That
 * leftover keeps executing in every seat, and it is the one failure mode a source-driven sweep
 * structurally cannot see.
 *
 * Tracked files are never orphans: an authored file that happens to sit in a projection directory
 * (the Engine-only `rgReplaceGuardHook.mjs` carve-out of ADR 0040 §2.7 is exactly this) is
 * somebody's content, not our leftover.
 * @param {String} runtimeRoot Absolute AgentOS runtime root.
 * @param {String} targetRepoRoot Absolute target repository root.
 * @returns {String[]} Repository-relative paths.
 */
export function findOrphans(runtimeRoot, targetRepoRoot) {
    const
        projection = enumerateProjection(runtimeRoot),
        claimed    = new Set(projection.map(entry => entry.target)),
        orphans    = [],
        // Which extensions does the manifest actually place into each owned directory? Sweeping a
        // fixed `.mjs` would leave a retired `.toml` executing forever; sweeping *everything* would
        // claim file types the projector never places.
        extensions = new Map(Object.values(HARNESS_TARGETS).map(dir => [dir, new Set()]));

    projection.forEach(({target}) => {
        const dir = path.posix.dirname(target);

        if (extensions.has(dir)) extensions.get(dir).add(path.posix.extname(target))
    });

    // Only the three hooks directories are swept. The projector owns those outright, but it does
    // NOT own `.codex/`, where the Codex config artifact lands beside content that is none of its
    // business — so an unclaimed file there is somebody else's file, not our leftover. Config
    // artifacts outside an owned directory are reconciled by exact target only.
    extensions.forEach((allowed, targetDir) => {
        const absDir = path.join(targetRepoRoot, targetDir);

        if (!fs.existsSync(absDir) || !allowed.size) return;

        fs.readdirSync(absDir)
            .filter(name => allowed.has(path.posix.extname(name)))
            .sort()
            .forEach(name => {
                const relPath = path.posix.join(targetDir, name);

                if (!claimed.has(relPath) && !tracked(targetRepoRoot, relPath)) orphans.push(relPath)
            })
    });

    return orphans
}

/**
 * @summary Reads back each projected seat config and reports the scripts it declares.
 *
 * This runs the acceptance direction the rest of the projector cannot: every other condition starts
 * from a source and asks where it landed. This one starts from what the *harness will actually
 * execute* and asks whether anything placed it. That is the failure #250 was filed for — a seat
 * config naming `.kimi-code/hooks/turnPresenceHook.mjs` while no repository contained the file, and
 * the harness reporting nothing at all when it silently ran none of it.
 *
 * Only `.mjs` references are collected. The commands also interpolate the checkout's `.env`, which
 * is seat identity state, provisioned elsewhere and never a projection target — counting it would
 * make every correct seat fail.
 * @param {String} runtimeRoot Absolute AgentOS runtime root.
 * @param {String} targetRepoRoot Absolute target repository root.
 * @returns {Object<String, String[]>} Harness → repository-relative script paths it declares.
 */
export function declaredHookCommands(runtimeRoot, targetRepoRoot) {
    const
        declared = {},
        pattern  = /\$\(git rev-parse --show-toplevel\)\/([^"'\\\s]+\.mjs)/g;

    enumerateConfigs(runtimeRoot).forEach(({harness, target}) => {
        const absTarget = path.join(targetRepoRoot, target);

        if (!fs.existsSync(absTarget)) return;

        const paths = [...fs.readFileSync(absTarget, 'utf8').matchAll(pattern)].map(match => match[1]);

        declared[harness] = [...new Set([...(declared[harness] ?? []), ...paths])].sort()
    });

    // Claude's surface is not an enumerated config — we reconcile into it rather than generating it
    // — so the loop above cannot see it, and an unplaced Claude command would be invisible to the
    // very check that exists to catch unplaced commands. Read separately, from the target.
    //
    // Filtered to commands we own: the Engine's tracked `rgReplaceGuardHook` and any operator hook
    // are declared here too, and neither is ours to place. Reporting them as unplaced would make
    // `--check` red on a correct seat, which is the failure mode one step removed.
    const claudeSettings = path.join(targetRepoRoot, CLAUDE_SETTINGS);

    if (fs.existsSync(claudeSettings)) {
        let settings;

        try {
            settings = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'))
        } catch {
            // Unparseable settings are reported by the reconciliation check, which says so precisely.
            // Guessing at the contents here would produce a second, vaguer complaint about one file.
            settings = null
        }

        const paths = Object.values(settings?.hooks ?? {})
            .flatMap(buckets => buckets.flatMap(bucket => (bucket.hooks ?? []).map(entry => String(entry.command ?? ''))))
            .filter(command => isProjectorOwnedCommand(command, targetRepoRoot))
            .flatMap(command => [...command.matchAll(pattern)].map(match => match[1]));

        if (paths.length) {
            declared.claude = [...new Set([...(declared.claude ?? []), ...paths])].sort()
        }
    }

    return declared
}

/**
 * @summary Compares what is projected against what should be, without writing anything.
 *
 * Reports five independent conditions, because they need different answers and different repairs.
 * Each maps to one #250 acceptance mutant:
 *
 * | field | AC mutant | meaning |
 * |---|---|---|
 * | `missing` | dangling target | the seat declares a hook whose file is absent — it silently runs nothing |
 * | `stale` | wrong root, or an outdated copy | projected bytes differ from what this runtime root renders |
 * | `orphans` | a stale entry the manifest no longer projects | a leftover still executing after a rename or retirement |
 * | `trackedConflicts` | a tracked projection path | authored content occupies the path; never overwrite it |
 * | `escapedSpecifiers` | — | a source reaches outside the runtime root and the projection cannot bind it |
 * | `unplacedCommands` | a seat config names a script nothing placed | read back from the projected config, per harness |
 *
 * A projection built against the wrong runtime root lands in `stale` rather than in a field of its
 * own: the rewritten specifiers are absolute, so a different root produces different bytes. That is
 * the same signal as an outdated copy and wants the same repair — re-project from the right root.
 * @param {Object} options
 * @param {String} options.agentosRuntimeRoot
 * @param {String} options.targetRepoRoot
 * @returns {{escapedSpecifiers: Object[], missing: String[], ok: Boolean, orphans: String[], stale: String[], trackedConflicts: String[], unplacedCommands: Object[]}}
 */
export function checkProjection({agentosRuntimeRoot, targetRepoRoot}) {
    assertRuntimeRoot(agentosRuntimeRoot);

    const
        escapedSpecifiers = [],
        missing           = [],
        stale             = [],
        trackedConflicts  = [];

    enumerateProjection(agentosRuntimeRoot).forEach(({source, target}) => {
        const
            absTarget = path.join(targetRepoRoot, target),
            expected  = renderProjection(source, agentosRuntimeRoot, targetRepoRoot);

        if (expected.escaped.length) escapedSpecifiers.push({escaped: expected.escaped, target});

        if (tracked(targetRepoRoot, target)) {
            trackedConflicts.push(target);
            return
        }

        if (!fs.existsSync(absTarget)) {
            missing.push(target);
            return
        }

        if (fs.readFileSync(absTarget, 'utf8') !== expected.contents) stale.push(target)
    });

    const
        claimed          = new Set(enumerateProjection(agentosRuntimeRoot).map(entry => entry.target)),
        declared         = declaredHookCommands(agentosRuntimeRoot, targetRepoRoot),
        orphans          = findOrphans(agentosRuntimeRoot, targetRepoRoot),
        unplacedCommands = [];

    Object.entries(declared).forEach(([harness, paths]) => {
        paths.filter(relPath => !claimed.has(relPath))
             .forEach(relPath => unplacedCommands.push({harness, target: relPath}))
    });

    // Dry-run of the same reconciliation the write arm performs, so `--check` fails on exactly what
    // re-projecting would change. A separate "does settings look right" heuristic would be a second
    // model of the same decision, and the two would drift.
    const
        reconciliation      = reconcileClaudeSettings({agentosRuntimeRoot, targetRepoRoot, write: false}),
        unreconciledEvents  = [];

    if (!reconciliation.declared) {
        // Nothing declared, nothing to drift from.
    } else if (reconciliation.reason) {
        unreconciledEvents.push({harness: 'claude', target: reconciliation.reason})
    } else if (reconciliation.changed) {
        unreconciledEvents.push({
            harness: 'claude',
            target : `${CLAUDE_SETTINGS} drifted — ${reconciliation.removed} retired entr(ies), ` +
                     `${reconciliation.added} declared entr(ies) to (re)apply`
        })
    }

    return {
        escapedSpecifiers,
        missing,
        ok: !missing.length && !stale.length && !orphans.length && !trackedConflicts.length &&
            !escapedSpecifiers.length && !unplacedCommands.length && !unreconciledEvents.length,
        orphans,
        stale,
        trackedConflicts,
        unplacedCommands,
        unreconciledEvents
    }
}

/**
 * @summary Produces the exact bytes a projected hook must contain.
 *
 * Two rewrites, in order and never merged: {@link rewriteSpecifiers} binds Brain substrate to the
 * runtime root, then {@link rewriteSelfPackageSpecifiers} resolves the target's *own* package
 * specifiers against the target. They answer different questions about different roots, and the
 * second is a no-op for every seat that is not the package it imports.
 * @param {String} source Absolute source path.
 * @param {String} runtimeRoot Absolute AgentOS runtime root.
 * @param {String} [targetRepoRoot] Absolute target repository root. Absent → self-package pass skipped.
 * @returns {{contents: String, escaped: String[], rewritten: Number}}
 */
export function renderProjection(source, runtimeRoot, targetRepoRoot) {
    const
        extension = path.extname(source),
        raw       = fs.readFileSync(source, 'utf8'),
        banner    = GENERATED_BANNERS[extension] ?? '',
        // Only executables carry module specifiers. Running the rewriter over a config artifact
        // would rewrite any `../`-shaped *string value* it happened to contain — a path in a hook
        // command, say — into an absolute path to a file that does not exist.
        bound     = extension === '.mjs'
            ? rewriteSpecifiers(raw, source, runtimeRoot)
            : {contents: raw, escaped: [], rewritten: 0},
        self      = extension === '.mjs'
            ? rewriteSelfPackageSpecifiers(bound.contents, targetRepoRoot)
            : {contents: bound.contents, escaped: [], rewritten: 0},
        result    = {
            contents : self.contents,
            escaped  : [...bound.escaped, ...self.escaped],
            rewritten: bound.rewritten + self.rewritten
        };

    if (!banner) return result;

    // A shebang must stay on line 1, so the banner follows it rather than displacing it.
    return {
        ...result,
        contents: raw.startsWith('#!')
            ? result.contents.replace(/^(#![^\n]*\n)/, `$1${banner}`)
            : banner + result.contents
    }
}

/**
 * @summary Is this settings command owned by the projector — i.e. does it invoke an untracked hook
 * in a projector-owned directory?
 *
 * Deliberately the **same ownership predicate** `findOrphans` uses, applied to a command string
 * rather than a file: projector-owned means "lives in one of our target directories and is not
 * tracked by the target". Reusing it means configuration reconciliation and file projection cannot
 * disagree about what we own — a second boundary is how a command survives the retirement of the
 * file it invokes.
 *
 * The tracked test is what protects the Engine's `rgReplaceGuardHook` entry: same directory, same
 * shape, but tracked in the target, so it is somebody else's and is preserved untouched.
 * @param {String} command Command string from a settings hook entry.
 * @param {String} targetRepoRoot Absolute target repository root.
 * @returns {Boolean}
 */
export function isProjectorOwnedCommand(command, targetRepoRoot) {
    const dirs = Object.values(HARNESS_TARGETS);

    return dirs.some(dir => {
        // A command embeds its target as a path fragment (`…/.claude/hooks/x.mjs"` possibly followed
        // by arguments), so the reference is matched rather than parsed — the command grammar is the
        // harness's, not ours, and parsing it would couple us to a format we do not own.
        const
            escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            match   = command.match(new RegExp(`${escaped}/([\\w.-]+\\.mjs)`));

        if (!match) return false;

        return !tracked(targetRepoRoot, path.posix.join(dir, match[1]))
    })
}

/**
 * @summary Reconciles the Brain's Claude event manifest into an already-hydrated settings object.
 *
 * Entry-level, never event replacement. `{...active.hooks, ...manifest.hooks}` would discard an
 * operator's hook on an event we also declare, and would leave a retired command in place on an
 * event we no longer declare — both silent. So each event bucket is filtered and rebuilt:
 *
 * - commands invoking projector-owned untracked hooks are **removed** (retirement);
 * - commands invoking **tracked** targets survive — the Engine's `PreToolUse → rgReplaceGuardHook`
 *   is the positive control, and it is hydrated by the Engine template, never restated by us;
 * - commands outside projector-owned directories survive — operator hooks are not ours to retire;
 * - every non-hook setting is untouched;
 * - current manifest entries are appended;
 * - buckets left empty by retirement are deleted rather than kept as `[]`.
 *
 * Genuinely pure: ownership arrives as an injected predicate rather than being derived here, so this
 * layer never learns what git is. The first draft called {@link isProjectorOwnedCommand} directly
 * and documented itself as pure anyway — which was false, since that reaches `tracked()` and shells
 * out. Injection makes the claim true instead of retracting it, and lets a test drive the ownership
 * decision without a repository while the real-git fixtures still cover the wiring.
 * @param {Object} options
 * @param {Function} options.isOwned `(command: String) => Boolean` — is this command ours to retire?
 * @param {Object} options.manifest Parsed Brain event manifest (`{events: {...}}`).
 * @param {Object} options.settings Active settings object (already Engine-hydrated).
 * @returns {{added: Number, removed: Number, settings: Object}}
 */
export function reconcileClaudeEvents({isOwned, manifest, settings}) {
    const
        next   = {...settings, hooks: {...(settings?.hooks || {})}},
        events = manifest?.events || {};

    let added = 0, removed = 0;

    // Retire ours everywhere first — including events the manifest no longer declares, which is the
    // case a manifest-driven merge cannot see at all.
    Object.keys(next.hooks).forEach(event => {
        const kept = (next.hooks[event] || []).map(bucket => {
            const hooks = (bucket.hooks || []).filter(entry => {
                const owned = isOwned(String(entry.command || ''));

                if (owned) removed++;

                return !owned
            });

            return {...bucket, hooks}
        }).filter(bucket => bucket.hooks.length > 0);

        if (kept.length) next.hooks[event] = kept;
        else delete next.hooks[event]
    });

    Object.entries(events).forEach(([event, buckets]) => {
        const incoming = JSON.parse(JSON.stringify(buckets));

        incoming.forEach(bucket => {added += (bucket.hooks || []).length});

        next.hooks[event] = [...(next.hooks[event] || []), ...incoming]
    });

    return {added, removed, settings: next}
}

/**
 * @summary Applies {@link reconcileClaudeEvents} to the target's real settings file.
 *
 * The filesystem half, kept separate from the pure reconciliation so the decision logic stays
 * testable without a checkout, and so this half can be read for exactly what it does to disk.
 *
 * **Absent settings are not reconciled into existence.** The active file is the Engine's to create —
 * `initClaudeSettings` hydrates it from `settings.template.json`, and that template carries Engine
 * entries this repository has no business inventing. Writing a settings file containing only our
 * four events would look like a successful reconciliation while having silently dropped every
 * Engine hook, so an absent file is reported as a condition to repair, not filled in.
 *
 * Re-serialized with two-space indent and a trailing newline — the shape the Engine template already
 * uses, so a reconciliation that changes nothing semantically also changes nothing textually and
 * `git diff` stays a signal.
 * @param {Object} options
 * @param {String} options.agentosRuntimeRoot
 * @param {String} options.targetRepoRoot
 * @param {Boolean} [options.write=true] When false, computes the reconciliation without writing.
 * @returns {{added: Number, changed: Boolean, path: String, reason: String|null, removed: Number}}
 */
export function reconcileClaudeSettings({agentosRuntimeRoot, targetRepoRoot, write = true}) {
    const
        manifestPath = path.join(agentosRuntimeRoot, CLAUDE_EVENT_MANIFEST),
        settingsPath = path.join(targetRepoRoot, CLAUDE_SETTINGS),
        absent       = {added: 0, changed: false, declared: true, path: settingsPath, removed: 0};

    // No manifest is not drift. A runtime root that declares no Claude events is a coherent
    // deployment — not every one wires this seat — and treating its absence as a fault would make
    // `--check` red for every target that correctly has nothing to reconcile. `declared: false` is
    // what lets the caller tell "nothing to do" apart from "something is wrong".
    if (!fs.existsSync(manifestPath)) {
        return {...absent, declared: false, reason: null}
    }

    if (!fs.existsSync(settingsPath)) {
        return {...absent, reason: `${CLAUDE_SETTINGS} absent — the Engine hydrates it; run its seat init first`}
    }

    const raw = fs.readFileSync(settingsPath, 'utf8');

    let settings;

    try {
        settings = JSON.parse(raw)
    } catch (error) {
        // Refuse rather than repair. A settings file we cannot parse may still be one an operator is
        // mid-edit on, and overwriting it with a reconstruction would destroy work to satisfy a check.
        return {...absent, reason: `${CLAUDE_SETTINGS} is not valid JSON (${error.message}) — refusing to rewrite it`}
    }

    const
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        // The impure half lives here, in the function that already owns a filesystem and a target
        // repository. The decision core receives a yes/no and stays ignorant of both.
        isOwned  = command => isProjectorOwnedCommand(command, targetRepoRoot),
        result   = reconcileClaudeEvents({isOwned, manifest, settings}),
        next     = `${JSON.stringify(result.settings, null, 2)}\n`,
        changed  = next !== raw;

    if (changed && write) fs.writeFileSync(settingsPath, next, 'utf8');

    return {added: result.added, changed, declared: true, path: settingsPath, reason: null, removed: result.removed}
}

/**
 * @summary Writes the projected paths into the target's `.git/info/exclude`, inside a managed block.
 *
 * ADR 0040 §2.7 gives the Engine's tracked ignore rules authority over these paths, and a companion
 * leaf (neomjs/neo#17892) adds them there. This is the *general* case underneath that: a target may
 * be any tenant repository whose `.gitignore` we have no right to edit. `.git/info/exclude` is
 * per-checkout and untracked, so the projector can own it outright.
 *
 * **Untracked is not ignored.** Without these patterns `git status` reports every projection in
 * every seat forever, and a permanently dirty tree trains people to stop reading it — which is how
 * a real stray file goes unnoticed. Acceptance for #250 is a clean `git status`, not merely
 * untracked artifacts.
 *
 * Exact paths, not directory globs: a glob would also hide a genuinely new authored file dropped
 * into a hooks directory, and tracked carve-outs like the Engine-only guard must stay visible. The
 * block is delimited and rewritten whole, so retiring a hook removes its line instead of
 * accumulating one.
 * @param {Object} options
 * @param {String[]} options.targets Repository-relative projected paths.
 * @param {String} options.targetRepoRoot Absolute target repository root.
 * @returns {String} Absolute path of the exclude file written.
 */
export function writeLocalExclude({targetRepoRoot, targets}) {
    const
        gitDir      = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {cwd: targetRepoRoot, encoding: 'utf8'}).trim(),
        excludeFile = path.join(gitDir, 'info', 'exclude'),
        begin       = '# BEGIN projectSeatHooks — generated seat hooks, do not edit inside this block',
        end         = '# END projectSeatHooks',
        block       = [begin, ...[...targets].sort().map(target => `/${target}`), end].join('\n'),
        existing    = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '',
        pattern     = new RegExp(`\\n?${begin}[\\s\\S]*?${end}\\n?`),
        stripped    = existing.replace(pattern, '\n'),
        next        = `${stripped.replace(/\n+$/, '')}\n\n${block}\n`;

    fs.mkdirSync(path.dirname(excludeFile), {recursive: true});
    fs.writeFileSync(excludeFile, next.replace(/^\n+/, ''), 'utf8');

    return excludeFile
}

/**
 * @summary Materializes every enumerated hook into the target checkout.
 *
 * Refuses as a whole before writing anything. A projector that wrote four files and then hit a
 * tracked path would leave the seat in a state that is neither the old one nor the new one, and the
 * operator would have to work out which — so the tracked-path audit runs first, across every hook,
 * and an offence aborts the run with nothing written.
 *
 * Orphans are pruned rather than reported, because a leftover hook is not information the operator
 * has to act on — it is a file that keeps executing until it is gone.
 * @param {Object} options
 * @param {String} options.agentosRuntimeRoot
 * @param {String} options.targetRepoRoot
 * @returns {{excludeFile: String, pruned: String[], written: String[]}}
 * @throws {Error} If any projection path is tracked, or a source escapes the runtime root.
 */
export function projectHooks({agentosRuntimeRoot, targetRepoRoot}) {
    // First of the four refusals, and first for a reason the other three do not share: it is the
    // only one that can fire before a single byte of the target is read. The rest audit what this
    // projection would do; this one asks whether the binding it would do it from is real at all.
    assertRuntimeRoot(agentosRuntimeRoot);

    const
        hooks     = enumerateProjection(agentosRuntimeRoot),
        conflicts = hooks.filter(hook => tracked(targetRepoRoot, hook.target)).map(hook => hook.target);

    if (conflicts.length) {
        throw new Error(
            `refusing to overwrite tracked path(s): ${conflicts.join(', ')}. A tracked file at a ` +
            'projection path is authored content — resolve its ownership before projecting.'
        )
    }

    const
        rendered = hooks.map(hook => ({...hook, ...renderProjection(hook.source, agentosRuntimeRoot, targetRepoRoot)})),
        escapees = rendered.filter(hook => hook.escaped.length);

    if (escapees.length) {
        throw new Error(
            'source(s) reach outside the runtime root and cannot be bound: ' +
            escapees.map(hook => `${hook.target} → ${hook.escaped.join(', ')}`).join('; ')
        )
    }

    // Fourth refusal, same shape as the three above and for the same reason. A run that writes nine
    // hook files and then cannot wire them leaves the seat holding executables nothing invokes —
    // which is the silently-dead-hook failure this projector exists to prevent, reproduced one layer
    // up: the files are perfect, the harness never calls them, and every layer reports success.
    //
    // Preflighted as a dry run rather than discovered after the writes, so the projection stays
    // all-or-nothing. An absent manifest is not a failure and passes here untouched.
    //
    // Found by @neo-gpt-emmy reviewing #250: the write arm returned normally and `main()` exited 0
    // after printing "NOT reconciled", so a failed seat wiring was indistinguishable from a good one
    // to any caller that checks an exit code.
    const preflight = reconcileClaudeSettings({agentosRuntimeRoot, targetRepoRoot, write: false});

    if (preflight.declared && preflight.reason) {
        throw new Error(
            `cannot wire the Claude seat: ${preflight.reason}. Nothing was written — the hooks and ` +
            'the settings that invoke them land together or not at all.'
        )
    }

    const
        pruned  = findOrphans(agentosRuntimeRoot, targetRepoRoot),
        written = [];

    pruned.forEach(relPath => fs.rmSync(path.join(targetRepoRoot, relPath)));

    rendered.forEach(({contents, executable, target}) => {
        const absTarget = path.join(targetRepoRoot, target);

        fs.mkdirSync(path.dirname(absTarget), {recursive: true});
        fs.writeFileSync(absTarget, contents, 'utf8');
        // Hooks are invoked as executables by the harnesses, not imported. A config artifact is
        // read, never run, and marking it executable would misdescribe it to anyone listing the
        // directory.
        fs.chmodSync(absTarget, executable ? 0o755 : 0o644);
        written.push(target)
    });

    // Reconciled last, and deliberately: the settings file is what makes the harness *invoke* these
    // files, so pointing at them before they exist would open a window where the seat declares hooks
    // that are not there. The reverse order only ever leaves files nothing calls yet.
    //
    // Its path is not added to the exclude block. `.claude/settings.json` is shared custody, not a
    // projection — excluding it would hide the Engine's own file from the operator's `git status`.
    const reconciled = reconcileClaudeSettings({agentosRuntimeRoot, targetRepoRoot});

    return {
        excludeFile: writeLocalExclude({targetRepoRoot, targets: written}),
        pruned,
        reconciled,
        written
    }
}

/**
 * @summary Resolves one required root binding, failing loud when it is absent.
 *
 * ADR 0040 §2.5 forbids `process.cwd()` as a fallback for either root. A projector that defaulted
 * would write a full set of hooks into whatever directory it happened to start in, and report
 * success doing it.
 * @param {String[]} argv
 * @param {String} flag
 * @param {String} envVar
 * @returns {String} Absolute path.
 * @throws {Error} If the binding is absent or does not exist on disk.
 */
function requireRoot(argv, flag, envVar) {
    const
        prefix = `--${flag}=`,
        raw    = argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || process.env[envVar];

    if (!raw) {
        throw new Error(`missing required root: pass ${prefix}<path> or set ${envVar}. There is no default.`)
    }

    const resolved = path.resolve(raw);

    if (!fs.existsSync(resolved)) throw new Error(`${flag} does not exist: ${resolved}`);

    return resolved
}

/**
 * @summary CLI entrypoint. `--check` audits without writing; the default arm projects.
 * @param {String[]} argv
 * @returns {Number} Process exit code.
 */
export function main(argv) {
    const
        agentosRuntimeRoot = requireRoot(argv, 'runtime-root', 'AGENTOS_RUNTIME_ROOT'),
        targetRepoRoot     = requireRoot(argv, 'target-root',  'AGENTOS_TARGET_REPO_ROOT');

    if (argv.includes('--check')) {
        const report = checkProjection({agentosRuntimeRoot, targetRepoRoot});

        if (report.ok) {
            console.log(`projectSeatHooks --check: OK — every declared hook is projected and current in ${targetRepoRoot}`);
            return 0
        }

        const labels = {
            escapedSpecifiers: 'source reaches outside the runtime root',
            missing          : 'declared but not projected (the seat runs nothing)',
            orphans          : 'projected but no longer declared (still executing)',
            stale            : 'projected from a different revision or a different runtime root',
            trackedConflicts  : 'tracked file occupies a projection path',
            unplacedCommands  : 'a seat config declares a script the projector did not place',
            unreconciledEvents: 'the Claude settings do not match the declared event manifest'
        };

        console.error('projectSeatHooks --check: FAILED');

        Object.entries(labels).forEach(([field, label]) => {
            const entries = report[field];

            if (entries?.length) {
                console.error(`\n  ${label}:`);
                entries.forEach(entry => console.error(
                    `    ${entry.harness ? `[${entry.harness}] ` : ''}${entry.target || entry}`
                ))
            }
        });

        console.error('\n  Repair: re-run without --check to re-project.');
        return 1
    }

    const {excludeFile, pruned, reconciled, written} = projectHooks({agentosRuntimeRoot, targetRepoRoot});

    console.log(`projectSeatHooks: projected ${written.length} hook(s) into ${targetRepoRoot}`);
    written.forEach(target => console.log(`  + ${target}`));
    pruned.forEach(target => console.log(`  - ${target} (no longer declared)`));
    console.log(`  exclude patterns written to ${excludeFile}`);

    // Reported even when nothing moved. "Reconciled: no change" and "reconciliation never ran" are
    // different facts, and silence on success makes them indistinguishable to whoever reads this
    // output to find out whether the seat is wired.
    if (!reconciled.declared) {
        console.log(`  ${CLAUDE_SETTINGS}: no event manifest in this runtime root — nothing to reconcile`)
    } else if (reconciled.reason) {
        console.log(`  ${CLAUDE_SETTINGS}: NOT reconciled — ${reconciled.reason}`)
    } else {
        console.log(
            `  ${CLAUDE_SETTINGS}: ${reconciled.changed ? 'reconciled' : 'already current'} ` +
            `(${reconciled.removed} retired, ${reconciled.added} declared)`
        )
    }

    return 0
}

// Direct-execution guard. Deliberately compares against the realpath of argv[1]: through a symlink
// the two disagree and main() would never run, which is the silent-no-op this projector exists to
// prevent — so the hooks are copied rather than linked (see the module header).
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
    try {
        process.exit(main(process.argv.slice(2)))
    } catch (error) {
        console.error(`projectSeatHooks: ${error.message}`);
        process.exit(1)
    }
}

export {HARNESS_TARGETS};
