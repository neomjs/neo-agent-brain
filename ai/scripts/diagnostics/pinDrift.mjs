#!/usr/bin/env node
/**
 * @module ai/scripts/diagnostics/pinDrift
 * @summary Reports which engine commits since a consumer's `neo.mjs` pin touch the engine files that
 * consumer loads, and whether its installed engine is the one its lock names.
 *
 * A consumer repo (this Brain, neo-stage, the Institution) pins the engine by commit. Two questions
 * then have no mechanical answer: *which engine am I running?* and *what between it and `dev`
 * touches what I load?* Without the second, an author writes a workaround for engine behaviour that
 * `dev` already fixed. Without the first, a suite runs an engine its lock does not name, and its red
 * reads as the lock's. A pin hundreds of commits behind carries too many fix subjects to read; this
 * report keeps only the commits that touch the engine files the consumer actually loads.
 *
 * ## Method (all local, read-only)
 *
 * 1. **The pin** is `package-lock.json` → `packages["node_modules/neo.mjs"].resolved`. **What npm
 *    installed** is the same key in `node_modules/.package-lock.json`.
 * 2. **What the consumer loads.** Its tracked `.mjs`/`.js`/`.html` files are scanned for imports
 *    into the engine (`neo.mjs/…` specifiers, relative paths into `node_modules/neo.mjs/`, HTML
 *    script sources). The engine's own relative imports are then walked AT THE PIN, through the
 *    engine checkout's object store. Workers are spawned by file name rather than imported, so a
 *    `src/MicroLoader.mjs` root adds the pin's top-level `src/worker/*.mjs`.
 * 3. **What moved.** `git log --name-only <pin>..<ref>` in the engine checkout. A commit is
 *    reported when it touches a loaded file; fixes print first.
 *
 * Coverage ends at computed `import()` specifiers. Those sites are counted and listed, never
 * guessed. Nothing is fetched or installed: a stale `--ref` shows in its printed date.
 *
 * Usage:
 *   npm run ai:pin-drift -- [--consumer <path>] [--engine <path>] [--ref <rev>]
 *                           [--module <engine path>]... [--json]
 *
 * `--consumer` defaults to this Brain checkout, `--engine` to the consumer's sibling `neo` clone,
 * `--ref` to `origin/dev`. Each `--module` restricts the report to commits touching that engine
 * path, loaded or not: "is the behaviour I am about to work around already fixed upstream?"
 */
import fs                  from 'node:fs';
import path                from 'node:path';
import {fileURLToPath}     from 'node:url';
import {git, readAtCommit} from './gitObjects.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const USAGE = 'Usage: npm run ai:pin-drift -- [--consumer <path>] [--engine <path>] [--ref <rev>] [--module <engine path>]... [--json]';

const ENGINE_PACKAGE = 'neo.mjs',
      LOCK_KEY       = `node_modules/${ENGINE_PACKAGE}`,
      MICRO_LOADER   = 'src/MicroLoader.mjs';

// Statement-start forms only: a JSDoc line (` * import A from …`) is prose, not a load
const STATIC_IMPORT   = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*(['"])(.+?)\1/gm,
      BARE_IMPORT     = /^[ \t]*import\s*(['"])(.+?)\1/gm,
      LITERAL_IMPORT  = /\bimport\(\s*(['"])(.+?)\1\s*\)/g,
      COMPUTED_IMPORT = /\bimport\(\s*(?!['"\s)])/g,
      HTML_SCRIPT     = /<script\b[^>]*\bsrc=(['"])(.+?)\1/gi,
      FIX_SUBJECT     = /^fix(?:\(|!|:)/;

/**
 * Reads the engine pin out of a parsed lock file.
 * @param {Object} lock parsed `package-lock.json` (or `node_modules/.package-lock.json`)
 * @returns {{resolved: String, sha: String, link: Boolean}}
 * @throws {Error} naming the field, when the lock carries no engine entry or no commit sha
 */
export function parsePin(lock) {
    const entry = lock?.packages?.[LOCK_KEY],
          field = `packages["${LOCK_KEY}"].resolved`;

    if (!entry?.resolved) throw new Error(`The lock has no ${field}.`);
    if (entry.link) return {resolved: entry.resolved, sha: null, link: true};

    const sha = entry.resolved.match(/(?:^|[^0-9a-f])([0-9a-f]{40})(?![0-9a-f])/)?.[1];

    if (!sha) throw new Error(`${field} names no engine commit: ${entry.resolved}`);

    return {resolved: entry.resolved, sha, link: false}
}

/**
 * Lists the module specifiers one consumer or engine file loads.
 * @param {String} text the file's source
 * @param {Object} [options]
 * @param {Boolean} [options.html=false] scan `<script src>` instead of module syntax
 * @returns {{specifiers: String[], computed: Number}} literal specifiers, and the count of
 * `import()` sites whose specifier is computed (and therefore not followed)
 */
export function scanImports(text, {html=false} = {}) {
    if (html) return {specifiers: [...text.matchAll(HTML_SCRIPT)].map(match => match[2]), computed: 0};

    const specifiers = [];

    for (const pattern of [STATIC_IMPORT, BARE_IMPORT, LITERAL_IMPORT]) {
        for (const match of text.matchAll(pattern)) specifiers.push(match[2])
    }

    return {specifiers, computed: (text.match(COMPUTED_IMPORT) || []).length}
}

/**
 * Maps a consumer's specifier to the engine path it loads, or null when it loads no engine file.
 * @param {String} specifier as written in the consumer file
 * @param {String} fromFile the importing file, relative to the consumer root
 * @returns {String|null} path inside the engine package, e.g. `src/state/Provider.mjs`
 */
export function engineTarget(specifier, fromFile) {
    const clean = specifier.split(/[?#]/)[0],
          bare  = `${ENGINE_PACKAGE}/`;

    if (clean.startsWith(bare)) return path.posix.normalize(clean.slice(bare.length));
    if (!clean.startsWith('.') && !clean.startsWith('/')) return null;

    // A leading slash is the consumer's own web root, which is its repository root
    const resolved = clean.startsWith('/') ? path.posix.normalize(clean.slice(1)) : path.posix.join(path.posix.dirname(fromFile), clean),
          prefix   = `${LOCK_KEY}/`;

    return resolved.startsWith(prefix) ? resolved.slice(prefix.length) : null
}

/**
 * Adds the engine's worker entries when the consumer boots the engine in a browser: the worker
 * manager spawns them by file name, so no import reaches them.
 * @param {String[]} roots engine paths the consumer loads directly
 * @param {String[]} engineWorkerFiles the pin's top-level `src/worker/` entries
 * @returns {String[]} the worker entries to add as roots (empty without a MicroLoader root)
 */
export function runtimeRoots(roots, engineWorkerFiles) {
    return roots.includes(MICRO_LOADER) ? engineWorkerFiles.filter(file => /^src\/worker\/[^/]+\.mjs$/.test(file)) : []
}

/**
 * Walks the engine files reachable from the roots, one batch read per level.
 * @param {String[]} roots engine paths loaded directly
 * @param {Function} readBatch `paths => Map<path, String|null>`; null marks a path absent at the pin
 * @returns {{files: Map<String, {via: String|null}>, missing: String[], computed: Array<{file: String, count: Number}>}}
 * `via` names the engine file that imported it (null for a root)
 */
export function walkClosure(roots, readBatch) {
    const files    = new Map(),
          missing  = [],
          computed = [],
          seen     = new Set();
    let level = roots.map(file => ({file, via: null}));

    while (level.length) {
        const fresh = level.filter(({file}) => !seen.has(file) && seen.add(file)),
              texts = readBatch(fresh.map(({file}) => file)),
              next  = [];

        for (const {file, via} of fresh) {
            const text = texts.get(file);

            if (text == null) { missing.push(file); continue }

            files.set(file, {via});

            if (!/\.m?js$/.test(file)) continue;

            const scan = scanImports(text);

            if (scan.computed) computed.push({file, count: scan.computed});

            for (const specifier of scan.specifiers) {
                const clean  = specifier.split(/[?#]/)[0],
                      target = clean.startsWith(`${ENGINE_PACKAGE}/`) ? path.posix.normalize(clean.slice(ENGINE_PACKAGE.length + 1))
                          : clean.startsWith('.') ? path.posix.join(path.posix.dirname(file), clean) : null;

                if (target && !target.startsWith('..') && !seen.has(target)) next.push({file: target, via: file})
            }
        }

        level = next
    }

    return {files, missing, computed}
}

/**
 * Parses `git log --format=%x00%h%x09%cs%x09%s --name-only` output.
 * @param {String} raw
 * @returns {Array<{sha: String, date: String, subject: String, files: String[]}>}
 */
export function parseLog(raw) {
    return raw.split('\0').filter(block => block.trim()).map(block => {
        const [header, ...files]      = block.split('\n').filter(Boolean),
              [sha, date, ...subject] = header.split('\t');

        return {sha, date, subject: subject.join('\t'), files}
    })
}

/**
 * Keeps the commits that touch a loaded file (or a named module), fixes first.
 * @param {Object[]} commits from {@link parseLog}, newest first
 * @param {Set<String>|Map<String, *>} loaded engine paths the consumer loads
 * @param {String[]} [modules=[]] when given, keep commits touching these paths instead
 * @returns {Array<{sha: String, date: String, subject: String, fix: Boolean, files: String[]}>}
 * `files` holds the touched paths that made the commit relevant
 */
export function relevantCommits(commits, loaded, modules=[]) {
    const wanted = modules.length ? file => modules.includes(file) : file => loaded.has(file),
          kept   = [];

    for (const commit of commits) {
        const files = commit.files.filter(wanted);

        if (files.length) kept.push({sha: commit.sha, date: commit.date, subject: commit.subject, fix: FIX_SUBJECT.test(commit.subject), files})
    }

    return [...kept.filter(commit => commit.fix), ...kept.filter(commit => !commit.fix)]
}

/**
 * Compares what npm installed with what the lock names.
 * @param {String|null} lockSha
 * @param {Object|null} hiddenLock parsed `node_modules/.package-lock.json`, or null when absent
 * @returns {{sha: String|null, state: String}} state: `matches`, `differs`, `linked`, `unreadable`
 * or `not installed`
 */
export function installedState(lockSha, hiddenLock) {
    if (!hiddenLock?.packages?.[LOCK_KEY]) return {sha: null, state: 'not installed'};

    let installed;

    try {
        installed = parsePin(hiddenLock)
    } catch {
        return {sha: null, state: 'unreadable'}
    }

    if (installed.link) return {sha: null, state: 'linked'};

    return {sha: installed.sha, state: installed.sha === lockSha ? 'matches' : 'differs'}
}

/**
 * Names the chain from a loaded engine file back to the consumer file that reaches it.
 * @param {String} file engine path
 * @param {Map<String, {via: String|null}>} files from {@link walkClosure}
 * @param {Map<String, String[]>} rootImporters engine root → consumer files importing it
 * @returns {String} e.g. `src/mixin/VdomLifecycle.mjs ← src/component/Abstract.mjs ← … ← src/button/Base.mjs ← apps/lab/Main.mjs`:
 * the file, its importer, an ellipsis for further engine hops, the root, and the consumer file
 */
export function reach(file, files, rootImporters) {
    const chain = [file];

    while (files.get(chain.at(-1))?.via) chain.push(files.get(chain.at(-1)).via);

    const shown    = chain.length > 3 ? [chain[0], chain[1], '…', chain.at(-1)] : chain,
          importer = rootImporters.get(chain.at(-1))?.[0];

    return [...shown, ...(importer ? [importer] : [])].join(' ← ')
}

/**
 * Renders the text report.
 * @param {Object} report the object {@link buildReport} returns (and `--json` prints)
 * @returns {String[]} lines
 */
export function formatReport(report) {
    const {consumer, pin, installed, spec, ref, closure, commits, modules} = report;

    const short         = sha => sha ? sha.slice(0, 10) : '-',
          lines         = [`pin-drift · ${consumer.name} (${consumer.branch} @ ${short(consumer.head)})`],
          fixes         = commits.filter(commit => commit.fix),
          others        = commits.filter(commit => !commit.fix),
          workers       = closure.workerEntries ? ` (${closure.workerEntries} of them src/worker modules)` : '',
          installedText = {
              matches        : `installed ${short(installed.sha)} ✓`,
              differs        : `⚠ installed ${short(installed.sha)} ≠ lock: this checkout runs an engine its lock does not name — rm -rf node_modules/neo.mjs && npm install`,
              linked         : 'installed: linked, not a commit',
              unreadable     : 'installed: node_modules/.package-lock.json names no engine commit',
              'not installed': 'installed: none (npm install)'
          }[installed.state];

    lines.push(`engine pin ${short(pin.sha)} ${pin.date} · ${installedText}`);
    if (spec && !spec.includes(pin.sha)) lines.push(`package.json names ${spec}, not the pin`);
    lines.push(`${ref.name} ${short(ref.sha)} ${ref.date} · ${report.behind} commits since the pin, ${report.fixes} of them fixes`);
    lines.push(`loads ${closure.files} engine files from ${closure.roots} entry points${workers}` +
        ` · not followed: ${closure.computedHere} computed import() sites here, ${closure.computedEngine} in the engine (--json lists them)`);

    if (modules.length) {
        lines.push(`${commits.length} ${commits.length === 1 ? 'commit touches' : 'commits touch'} ${modules.join(', ')} (${modules.map(module => `${module}: ${closure.loaded.includes(module) ? 'loaded' : 'not loaded'} here`).join('; ')}):`);
        for (const commit of commits) lines.push(`  ${commit.sha} ${commit.date} ${commit.subject}`);
        return lines
    }

    lines.push(`${fixes.length} ${fixes.length === 1 ? 'fix touches' : 'fixes touch'} what this repo loads:`);
    for (const commit of fixes) {
        lines.push(`  ${commit.sha} ${commit.date} ${commit.subject}`);
        lines.push(`      ${commit.reach.slice(0, 2).join(' · ')}${commit.reach.length > 2 ? ` · +${commit.reach.length - 2}` : ''}`)
    }

    if (others.length) {
        lines.push(`${others.length} other ${others.length === 1 ? 'commit touches' : 'commits touch'} it:`);
        for (const commit of others) lines.push(`  ${commit.sha} ${commit.date} ${commit.subject}`)
    }

    return lines
}

/**
 * Reads a JSON file, or null when it does not exist.
 * @param {String} file
 * @returns {Object|null}
 */
function readJson(file) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

/**
 * Builds the drift report for one consumer checkout.
 * @param {Object} options
 * @param {String} options.consumer consumer checkout
 * @param {String} options.engine engine git checkout
 * @param {String} options.ref engine revision to compare against
 * @param {String[]} options.modules engine paths to restrict the report to
 * @returns {Object} the report {@link formatReport} renders
 */
export function buildReport({consumer, engine, ref, modules}) {
    const lock = readJson(path.join(consumer, 'package-lock.json'));

    if (!lock) throw new Error(`No package-lock.json in ${consumer}.`);

    const pin = parsePin(lock);

    if (pin.link) throw new Error(`The lock links ${ENGINE_PACKAGE} (${pin.resolved}); a linked engine has no pin.`);
    if (readJson(path.join(engine, 'package.json'))?.name !== ENGINE_PACKAGE) throw new Error(`No ${ENGINE_PACKAGE} checkout at ${engine}: pass --engine <neo clone>.`);

    try {
        git(engine, ['cat-file', '-e', `${pin.sha}^{commit}`])
    } catch {
        throw new Error(`${engine} lacks the pin ${pin.sha}: git -C ${engine} fetch origin`)
    }

    let refSha;

    try {
        refSha = git(engine, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
    } catch {
        throw new Error(`${engine} has no ${ref}: pass --ref <rev>, or git -C ${engine} fetch origin`)
    }

    const dateOf = sha => git(engine, ['log', '-1', '--format=%cs', sha]).trim();

    // The consumer side: every tracked file that loads an engine path
    const rootImporters = new Map(),
          computedHere  = [];

    for (const file of git(consumer, ['ls-files', '--', '*.mjs', '*.js', '*.html']).split('\n').filter(Boolean)) {
        const absolute = path.join(consumer, file);

        if (!fs.existsSync(absolute)) continue;

        const scan = scanImports(fs.readFileSync(absolute, 'utf8'), {html: file.endsWith('.html')});

        if (scan.computed) computedHere.push({file, count: scan.computed});

        for (const specifier of scan.specifiers) {
            const target = engineTarget(specifier, file);

            if (target) rootImporters.set(target, [...(rootImporters.get(target) || []), file])
        }
    }

    const directRoots   = [...rootImporters.keys()],
          workerEntries = runtimeRoots(directRoots, git(engine, ['ls-tree', '--name-only', pin.sha, 'src/worker/']).split('\n').filter(Boolean));

    for (const entry of workerEntries) rootImporters.set(entry, rootImporters.get(entry) || [`worker spawned for ${MICRO_LOADER}`]);

    const walk = walkClosure([...new Set([...directRoots, ...workerEntries])], paths => readAtCommit(engine, pin.sha, paths)),
          // A rename after the pin must still name the path the consumer loads
          commits       = parseLog(git(engine, ['log', '--no-renames', '--format=%x00%h%x09%cs%x09%s', '--name-only', `${pin.sha}..${refSha}`])),
          relevant      = relevantCommits(commits, walk.files, modules),
          installed     = installedState(pin.sha, readJson(path.join(consumer, 'node_modules', '.package-lock.json'))),
          manifest      = readJson(path.join(consumer, 'package.json')),
          spec          = manifest?.dependencies?.[ENGINE_PACKAGE] ?? manifest?.devDependencies?.[ENGINE_PACKAGE] ?? null;

    return {
        consumer: {name: path.basename(consumer), path: consumer, branch: git(consumer, ['branch', '--show-current']).trim() || 'detached', head: git(consumer, ['rev-parse', 'HEAD']).trim()},
        spec,
        pin     : {sha: pin.sha, date: dateOf(pin.sha)},
        installed,
        ref     : {name: ref, sha: refSha, date: dateOf(refSha)},
        behind  : commits.length,
        fixes   : commits.filter(commit => FIX_SUBJECT.test(commit.subject)).length,
        modules,
        closure : {
            roots         : directRoots.length + workerEntries.length,
            workerEntries : workerEntries.length,
            files         : walk.files.size,
            loaded        : modules.filter(module => walk.files.has(module)),
            missing       : walk.missing,
            computedHere  : computedHere.reduce((sum, site) => sum + site.count, 0),
            computedEngine: walk.computed.reduce((sum, site) => sum + site.count, 0),
            unfollowed    : [...computedHere, ...walk.computed]
        },
        commits  : relevant.map(commit => ({...commit, reach: commit.files.map(file => walk.files.has(file) ? reach(file, walk.files, rootImporters) : file)}))
    }
}

function main() {
    const args = process.argv.slice(2),
          read = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null,
          // An engine path may be written as the consumer sees it (`node_modules/neo.mjs/src/…`)
          modules  = args.flatMap((arg, index) => arg === '--module' ? [args[index + 1].replace(/^(?:node_modules\/)?neo\.mjs\//, '')] : []);

    if (args.includes('--help')) { console.log(USAGE); return }

    const consumer = path.resolve(read('--consumer') ?? repoRoot);

    try {
        const report = buildReport({consumer, engine: path.resolve(read('--engine') ?? path.join(consumer, '..', 'neo')), ref: read('--ref') ?? 'origin/dev', modules});

        console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report).join('\n'))
    } catch (error) {
        console.error(`pin-drift: ${error.message}\n${USAGE}`);
        process.exitCode = 1
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main()
}
