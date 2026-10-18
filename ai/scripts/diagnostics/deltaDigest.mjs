#!/usr/bin/env node
/**
 * @module ai/scripts/diagnostics/deltaDigest
 * @summary States what a review range changed, read from git: its commits and merges, every path with its
 * status, the symbols and test titles it added, removed or changed, the tickets its messages close, and
 * how much of what it added is comment.
 *
 * Review prose restated from memory can name identifiers its delta never had, and each reviewer
 * re-derives the same facts by hand. This digest computes them once, so author and reviewer cite one
 * record.
 *
 * ## Method (all local, read-only)
 *
 * - **Range.** `--base` and `--head` resolve to commits, and every comparison starts at their merge-base,
 *   so a branch that merged its base in counts only its own changes. Merges are listed apart; one whose
 *   `git show --remerge-diff` is not empty carries hand edits a reviewer has to read.
 * - **Files.** `git diff -M` from the merge-base to head: status, line counts, binaries. Every path is
 *   listed; a `--generated` glob only moves the paths it matches into a counted group.
 * - **Symbols and tests.** acorn parses each changed JS file at both ends. Top-level declarations,
 *   imports, exports and class members compare by name and source; `test` / `describe` / `it` titles by
 *   describe path. A file that does not parse is reported with the parser's message, never skipped.
 * - **Close targets.** GitHub's closing keywords in the range's commit messages, with their commit.
 * - **Comments.** Each authored code file's added lines, counted as code, comment or blank.
 * - **Since.** `--since <sha>`, the head a reviewer last read, lists what changed after it: through the
 *   range's own commits, or only through merges.
 *
 * Usage:
 *   npm run ai:delta-digest -- [--repo <path>] [--base <ref>] [--head <ref>] [--since <sha>]
 *                              [--generated <glob>]... [--json]
 *
 * `--repo` defaults to the directory npm was started from, `--base` to `origin/dev`, `--head` to `HEAD`.
 */
import {parse}             from 'acorn';
import path                from 'node:path';
import {fileURLToPath}     from 'node:url';
import {git, readAtCommit} from './gitObjects.mjs';

export const USAGE = 'Usage: npm run ai:delta-digest -- [--repo <path>] [--base <ref>] [--head <ref>] [--since <sha>] [--generated <glob>]... [--json]';

const JS_FILE      = /\.[cm]?js$/,
      TEST_FILE    = /\.(?:spec|test)\.mjs$/,
      CODE_FILE    = /\.(?:[cm]?js|ts|css|scss|py|sh)$/,
      HASH_COMMENT = /\.(?:py|sh)$/,
      STATUS       = {A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed', T: 'type change'},
      CLOSE        = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:([\w.-]+\/[\w.-]+)?#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))/gi,
      SUBJECT_ID   = /\(#(\d+)\)/g,
      // Runner modifiers that still declare a test or suite; `test.step`, `test.use` and the hooks do not
      MODIFIERS    = new Set(['skip', 'only', 'fixme', 'fail', 'slow', 'serial', 'parallel']);

/**
 * Parses a file as a module, then as a script.
 * @param {String} source
 * @returns {Object} acorn's Program node
 * @throws {SyntaxError} the module parse's error, when neither parses
 */
function parseSource(source) {
    const options = {ecmaVersion: 'latest', allowHashBang: true, allowAwaitOutsideFunction: true};

    try {
        return parse(source, {...options, sourceType: 'module'})
    } catch (moduleError) {
        try {
            return parse(source, {...options, sourceType: 'script', allowReturnOutsideFunction: true})
        } catch {
            throw moduleError
        }
    }
}

/**
 * Visits every node under a root. `enter` may return a function, which runs after the node's children.
 * @param {Object} node
 * @param {Function} enter
 */
function walk(node, enter) {
    const leave = enter(node);

    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) if (typeof child?.type === 'string') walk(child, enter)
        } else if (typeof value?.type === 'string') walk(value, enter)
    }

    leave?.()
}

/**
 * Lists the local names a binding pattern declares: `a`, `{a, b: c}`, `[a, ...b]`.
 * @param {Object} pattern
 * @returns {String[]}
 */
function patternNames(pattern) {
    switch (pattern.type) {
        case 'Identifier'       : return [pattern.name];
        case 'ObjectPattern'    : return pattern.properties.flatMap(property => patternNames(property.type === 'RestElement' ? property.argument : property.value));
        case 'ArrayPattern'     : return pattern.elements.filter(Boolean).flatMap(patternNames);
        case 'RestElement'      : return patternNames(pattern.argument);
        case 'AssignmentPattern': return patternNames(pattern.left);
        default                 : return []
    }
}

/**
 * Names one class member: `method`, `static parse`, `get id`, `#getConfig`, `static #configSnapshot`.
 * @param {Object} member
 * @param {String} source
 * @returns {String}
 */
function memberName(member, source) {
    if (member.type === 'StaticBlock') return 'static {}';

    const key  = member.key,
          name = key.type === 'PrivateIdentifier' ? `#${key.name}`
              : member.computed ? `[${source.slice(key.start, key.end)}]`
              : key.type === 'Identifier' ? key.name : String(key.value),
          kind = member.kind === 'get' || member.kind === 'set' ? `${member.kind} ` : '';

    return `${member.static ? 'static ' : ''}${kind}${name}`
}

/**
 * Lists a module's symbols: its top-level declarations, imports and exports, and each class's members.
 * A class's own entry is its header, so a member's change marks only that member.
 * @param {String} source
 * @returns {Map<String, String>} symbol → its source, keyed like `Provider`, `Provider.beforeSetData`,
 * `Provider.static config`, `Base.get id`, `import aiConfig`, `export {a as b}`, `export default`
 * @throws {SyntaxError} when the source does not parse
 */
export function extractSymbols(source) {
    const symbols = new Map(),
          text    = node => source.slice(node.start, node.end),
          set     = (name, value) => {
              let key = name;

              for (let count = 2; symbols.has(key); count++) key = `${name} #${count}`;

              symbols.set(key, value)
          },
          declare = (node, prefix) => {
              if (node.type === 'FunctionDeclaration') {
                  set(node.id?.name ?? 'default', prefix + text(node))
              } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
                  const name = node.id?.name ?? 'default';

                  set(name, prefix + source.slice(node.start, node.body.start).trim());

                  for (const member of node.body.body) set(`${name}.${memberName(member, source)}`, text(member))
              } else if (node.type === 'VariableDeclaration') {
                  for (const declarator of node.declarations) {
                      for (const name of patternNames(declarator.id)) set(name, `${prefix}${node.kind} ${text(declarator)}`)
                  }
              }
          };

    for (const node of parseSource(source).body) {
        if (node.type === 'ImportDeclaration') {
            if (!node.specifiers.length) set(`import ${node.source.raw}`, text(node));

            for (const specifier of node.specifiers) set(`import ${specifier.local.name}`, `${text(specifier)} from ${node.source.raw}`)
        } else if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration) declare(node.declaration, 'export ');

            for (const specifier of node.specifiers) set(`export {${text(specifier)}}`, text(specifier) + (node.source ? ` from ${node.source.raw}` : ''))
        } else if (node.type === 'ExportDefaultDeclaration') {
            if (/^(?:Function|Class)Declaration$/.test(node.declaration.type)) declare(node.declaration, 'export default ');
            else set('export default', text(node.declaration))
        } else if (node.type === 'ExportAllDeclaration') {
            set(`export *${node.exported ? ` as ${text(node.exported)}` : ''} from ${node.source.raw}`, text(node))
        } else {
            declare(node, '')
        }
    }

    return symbols
}

/**
 * Names a test-runner call, or returns null: `test`, `it`, `test.skip`, `test.describe.serial`, `describe.only`.
 * @param {Object} callee a CallExpression's callee
 * @returns {{kind: String, modifier: String|null}|null} kind `test` or `suite`
 */
function runnerCall(callee) {
    const parts = [];
    let   node  = callee;

    while (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
        parts.unshift(node.property.name);
        node = node.object
    }

    if (node.type !== 'Identifier' || !['test', 'it', 'describe'].includes(node.name)) return null;

    const suite     = node.name === 'describe' || parts[0] === 'describe',
          modifiers = parts.filter(part => part !== 'describe');

    if (modifiers.some(part => !MODIFIERS.has(part))) return null;

    return {kind: suite ? 'suite' : 'test', modifier: modifiers.join('.') || null}
}

/**
 * Reads a title written as a string, or as a template literal without expressions.
 * @param {Object} node
 * @returns {String|null}
 */
function staticTitle(node) {
    if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;

    return null
}

/**
 * Lists a spec's test titles by describe path. A runner call counts only when it passes a callback, so
 * `test.skip(condition, reason)` inside a test is no declaration.
 * @param {String} source
 * @returns {{titles: Map<String, String|null>, dynamic: Number}} `suite › … › test` → its modifier
 * (`skip`, `only`, … or null), and the count of declarations whose title is computed
 * @throws {SyntaxError} when the source does not parse
 */
export function extractTestTitles(source) {
    const titles = new Map(),
          suites = [];
    let dynamic = 0;

    walk(parseSource(source), node => {
        if (node.type !== 'CallExpression' || !node.arguments.some(arg => /Function/.test(arg.type))) return;

        const call = runnerCall(node.callee);

        if (!call) return;

        const title = staticTitle(node.arguments[0]);

        if (title === null) { dynamic++; return }

        if (call.kind === 'test') { titles.set([...suites, title].join(' › '), call.modifier); return }

        suites.push(title);

        return () => suites.pop()
    });

    return {titles, dynamic}
}

/**
 * Finds the tickets a range's commit messages close, and the ids its subjects carry.
 * @param {Array<{sha: String, subject: String, message: String}>} commits
 * @returns {{closes: Array<{sha: String, keyword: String, target: String}>, subjectIds: Array<{id: Number, shas: String[]}>}}
 * a `target` reads `#N` or `owner/repo#N`
 */
export function closeTargets(commits) {
    const closes = [],
          ids    = new Map();

    for (const {sha, subject, message} of commits) {
        for (const match of message.matchAll(CLOSE)) {
            const [, keyword, repo, number, urlRepo, urlNumber] = match;

            closes.push({sha, keyword, target: `${repo ?? urlRepo ?? ''}#${number ?? urlNumber}`})
        }

        for (const [, id] of subject.matchAll(SUBJECT_ID)) ids.set(Number(id), [...(ids.get(Number(id)) ?? []), sha])
    }

    return {closes, subjectIds: [...ids].map(([id, shas]) => ({id, shas}))}
}

/**
 * Counts added lines as code, comment or blank. A block comment is followed across the lines given,
 * which are one hunk's additions in order; a line opening with `*` continues a block whose opener lies
 * outside the hunk.
 * @param {String[]} lines
 * @param {String} file its extension decides the syntax: `#` for Python and shell, `//` and `/* *\/` otherwise
 * @returns {{code: Number, comment: Number, blank: Number}}
 */
export function classifyAddedLines(lines, file) {
    const counts = {code: 0, comment: 0, blank: 0},
          hash   = HASH_COMMENT.test(file);
    let inBlock = false;

    for (const raw of lines) {
        const line = raw.trim();

        if (!line) counts.blank++;
        else if (hash) counts[line.startsWith('#') ? 'comment' : 'code']++;
        else if (inBlock) { counts.comment++; inBlock = !line.includes('*/') }
        else if (line.startsWith('/*')) { counts.comment++; inBlock = !line.includes('*/') }
        else if (line.startsWith('//') || line.startsWith('*')) counts.comment++;
        else counts.code++
    }

    return counts
}

/**
 * Compiles a git-style glob: `**` crosses directories, `*` and `?` stay within one.
 * @param {String} glob
 * @returns {RegExp}
 */
function globPattern(glob) {
    const pattern = glob.split(/(\*\*\/|\*\*|\*|\?)/).map(part => ({'**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]'})[part] ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');

    return new RegExp(`^${pattern}$`)
}

/**
 * Parses `git diff --name-status -z`.
 * @param {String} raw
 * @returns {Array<{status: String, path: String, from?: String, similarity?: Number}>}
 */
function parseNameStatus(raw) {
    const tokens = raw.split('\0'),
          files  = [];

    for (let index = 0; index < tokens.length - 1;) {
        const code = tokens[index++];

        if (!code) continue;

        const letter = code[0];

        if (letter === 'R' || letter === 'C') files.push({status: STATUS[letter], similarity: Number(code.slice(1)), from: tokens[index++], path: tokens[index++]});
        else files.push({status: STATUS[letter] ?? letter, path: tokens[index++]})
    }

    return files
}

/**
 * Parses `git diff --numstat -z`, keyed by each file's head path.
 * @param {String} raw
 * @returns {Map<String, {added: Number, deleted: Number}|{binary: true}>}
 */
function parseNumstat(raw) {
    const tokens = raw.split('\0'),
          counts = new Map();

    for (let index = 0; index < tokens.length; index++) {
        if (!tokens[index]) continue;

        const [added, deleted, file] = tokens[index].split('\t');

        // A rename leaves the path empty and follows with its old and new paths
        const target = file === '' ? tokens[index += 2] : file;

        counts.set(target, added === '-' ? {binary: true} : {added: Number(added), deleted: Number(deleted)})
    }

    return counts
}

/**
 * Reads a path git quoted. With `core.quotePath=false` only quotes, backslashes and control characters
 * are escaped, each control character as one octal byte.
 * @param {String} text `"…"`
 * @returns {String}
 */
function unquote(text) {
    return text.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (escape, code) => code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : {n: '\n', t: '\t'}[code] ?? code)
}

/**
 * Collects each file's added lines from `git diff -U0`, one array per hunk.
 * @param {String} raw
 * @returns {Map<String, String[][]>}
 */
function parseAddedLines(raw) {
    const files = new Map();
    let   file  = null, hunk = null;

    for (const line of raw.split('\n')) {
        if (line.startsWith('diff --git ')) { file = null; hunk = null }
        else if (!hunk && line.startsWith('+++ ')) {
            const target = line.slice(4);

            file = target === '/dev/null' ? null : (target.startsWith('"') ? unquote(target) : target).replace(/^b\//, '')
        }
        else if (line.startsWith('@@')) {
            hunk = [];

            if (file) files.set(file, [...(files.get(file) ?? []), hunk])
        }
        else if (hunk && line.startsWith('+')) hunk.push(line.slice(1))
    }

    return files
}

/**
 * Compares two keyed maps.
 * @param {Map} before
 * @param {Map} after
 * @returns {{added: String[], removed: String[], changed: String[]}}
 */
function compare(before, after) {
    const added   = [...after.keys()].filter(key => !before.has(key)),
          removed = [...before.keys()].filter(key => !after.has(key)),
          changed = [...after.keys()].filter(key => before.has(key) && before.get(key) !== after.get(key));

    return {added, removed, changed}
}

/**
 * Resolves a revision to its commit, naming the flag that gave it.
 * @param {String} repo
 * @param {String} ref
 * @param {String} flag
 * @returns {String}
 */
function resolveCommit(repo, ref, flag) {
    try {
        return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim()
    } catch {
        throw new Error(`${flag} ${ref} names no commit in ${repo}; fetch it first (git -C ${repo} fetch origin)`)
    }
}

/**
 * Builds the digest of `base…head` in one checkout.
 * @param {Object} options
 * @param {String} options.repo checkout
 * @param {String} [options.base='origin/dev']
 * @param {String} [options.head='HEAD']
 * @param {String|null} [options.since=null] a review anchor: the head a reviewer last read
 * @param {String[]} [options.generated=[]] globs of pipeline-owned paths, counted apart
 * @returns {Object} the digest {@link formatDigest} renders (and `--json` prints)
 */
export function buildDigest({repo, base = 'origin/dev', head = 'HEAD', since = null, generated = []}) {
    let root;

    try {
        root = git(repo, ['rev-parse', '--show-toplevel']).trim()
    } catch {
        throw new Error(`--repo ${repo} is no git checkout`)
    }

    const baseSha     = resolveCommit(root, base, '--base'),
          headSha     = resolveCommit(root, head, '--head'),
          globs       = generated.map(globPattern),
          isGenerated = file => globs.some(pattern => pattern.test(file));
    let mergeBase;

    try {
        mergeBase = git(root, ['merge-base', baseSha, headSha]).trim()
    } catch {
        throw new Error(`--base ${base} and --head ${head} share no history`)
    }

    // The range's commits, oldest first; a merge stays apart from the commits it joins
    const log = git(root, ['log', '--reverse', '--topo-order', '--format=%x00%H%x1f%P%x1f%B', `${baseSha}..${headSha}`]).split('\0').filter(Boolean).map(block => {
              const [sha, parents, message] = block.split('\x1f');

              return {sha, parents: parents.split(' ').filter(Boolean), subject: message.split('\n')[0], message: message.trim()}
          }),
          commits = log.filter(commit => commit.parents.length < 2).map(({sha, subject}) => ({sha, subject})),
          merges  = log.filter(commit => commit.parents.length > 1).map(({sha, subject}) => {
              const edited = git(root, ['show', '--remerge-diff', '--format=', '--name-only', sha]).split('\n').filter(Boolean);

              return {sha, subject, handEdited: edited.length > 0, files: edited}
          });

    const counts   = parseNumstat(git(root, ['diff', '-M', '--numstat', '-z', mergeBase, headSha])),
          all      = parseNameStatus(git(root, ['diff', '-M', '--name-status', '-z', mergeBase, headSha])).map(file => ({...file, ...counts.get(file.path)})),
          authored = all.filter(file => !isGenerated(file.path)),
          pipeline = all.filter(file => isGenerated(file.path));

    // Both ends of every changed, authored JS file, read in one batch per end
    const scripts = authored.filter(file => JS_FILE.test(file.path) && !file.binary),
          before  = readAtCommit(root, mergeBase, scripts.filter(file => file.status !== 'added').map(file => file.from ?? file.path)),
          after   = readAtCommit(root, headSha, scripts.filter(file => file.status !== 'deleted').map(file => file.path)),
          symbols = [], tests = [], unparsed = [];

    for (const file of scripts) {
        const sides = {base: before.get(file.from ?? file.path) ?? '', head: file.status === 'deleted' ? '' : after.get(file.path) ?? ''},
              read  = extract => Object.fromEntries(Object.entries(sides).map(([side, source]) => {
                  try {
                      return [side, extract(source)]
                  } catch (error) {
                      unparsed.push({path: file.path, side, message: error.message});
                      return [side, null]
                  }
              })),
              found = read(extractSymbols);

        if (found.base && found.head) {
            const delta = compare(found.base, found.head);

            if (delta.added.length || delta.removed.length || delta.changed.length) symbols.push({path: file.path, ...delta})
        }

        if (!TEST_FILE.test(file.path) || !found.base || !found.head) continue;

        const titles = read(extractTestTitles),
              delta  = compare(titles.base.titles, titles.head.titles);

        if (delta.added.length || delta.removed.length || delta.changed.length) tests.push({path: file.path, ...delta, dynamic: titles.head.dynamic})
    }

    // Added lines by kind, for the authored code files only
    const exclusions = generated.map(glob => `:(exclude,glob)${glob}`),
          added      = parseAddedLines(git(root, ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', mergeBase, headSha, '--', '.', ...exclusions])),
          comments   = authored.filter(file => CODE_FILE.test(file.path) && added.has(file.path)).map(file => {
              const total = added.get(file.path).map(hunk => classifyAddedLines(hunk, file.path)).reduce((sum, part) => ({
                  code   : sum.code + part.code,
                  comment: sum.comment + part.comment,
                  blank  : sum.blank + part.blank
              }), {code: 0, comment: 0, blank: 0});

              return {path: file.path, ...total, flagged: total.comment > total.code}
          });

    let anchor = null;

    if (since) {
        const sinceSha = resolveCommit(root, since, '--since'),
              own      = new Set(git(root, ['log', '--no-merges', '--format=', '--name-only', headSha, `^${sinceSha}`, `^${baseSha}`]).split('\n').filter(Boolean)),
              changed  = parseNameStatus(git(root, ['diff', '-M', '--name-status', '-z', sinceSha, headSha]));
        let ancestor = true;

        try {
            git(root, ['merge-base', '--is-ancestor', sinceSha, headSha])
        } catch {
            ancestor = false
        }

        anchor = {
            sha  : sinceSha,
            ancestor,
            files: changed.map(file => ({...file, through: own.has(file.path) || own.has(file.from) ? 'own commits' : 'merges only'}))
        }
    }

    return {
        repo: {name: path.basename(root), path: root},
        base: {ref: base, sha: baseSha},
        head: {ref: head, sha: headSha},
        mergeBase,
        commits,
        merges,
        ...closeTargets(log),
        files    : authored,
        generated: {globs: generated, files: pipeline.length, added: pipeline.reduce((sum, file) => sum + (file.added ?? 0), 0), deleted: pipeline.reduce((sum, file) => sum + (file.deleted ?? 0), 0)},
        symbols,
        tests,
        unparsed,
        comments,
        since    : anchor
    }
}

/**
 * Renders the text digest.
 * @param {Object} digest from {@link buildDigest}
 * @returns {String[]} lines
 */
export function formatDigest(digest) {
    const {repo, base, head, mergeBase, commits, merges, closes, subjectIds, files, generated, symbols, tests, unparsed, comments, since} = digest;

    const short   = sha => sha.slice(0, 10),
          count   = (number, noun) => `${number} ${noun}${number === 1 ? '' : 's'}`,
          code    = file => file.status === 'renamed' ? `R${file.similarity}` : file.status === 'copied' ? `C${file.similarity}` : {added: 'A', deleted: 'D', modified: 'M', 'type change': 'T'}[file.status] ?? file.status,
          sum     = key => files.reduce((total, file) => total + (file[key] ?? 0), 0),
          names   = ({added, removed, changed}) => [...added.map(name => `+ ${name}`), ...removed.map(name => `− ${name}`), ...changed.map(name => `~ ${name}`)].join(', '),
          flagged = comments.filter(file => file.flagged),
          lines   = [`delta-digest · ${repo.name} · ${base.ref} ${short(base.sha)} … ${head.ref} ${short(head.sha)} · merge-base ${short(mergeBase)}`];

    lines.push(`${count(commits.length, 'commit')}${merges.length ? `, ${count(merges.length, 'merge')}` : ''}:`);
    for (const commit of commits) lines.push(`  ${short(commit.sha)} ${commit.subject}`);
    for (const merge of merges) lines.push(`  ${short(merge.sha)} ${merge.subject} · ${merge.handEdited ? `hand edits in ${merge.files.join(', ')}` : 'clean'}`);

    lines.push(`closes: ${closes.length ? closes.map(hit => `${hit.keyword} ${hit.target} (${short(hit.sha)})`).join(', ') : 'nothing'} · subject ids: ${subjectIds.length ? subjectIds.map(({id}) => `#${id}`).join(', ') : 'none'}`);

    lines.push(`${count(files.length, 'authored file')} (+${sum('added')} −${sum('deleted')})${generated.files ? `, ${count(generated.files, 'generated file')} (+${generated.added} −${generated.deleted}) under ${generated.globs.join(', ')}` : ''}:`);
    for (const file of files) lines.push(`  ${code(file)} ${file.from ? `${file.from} → ` : ''}${file.path} ${file.binary ? 'binary' : `+${file.added} −${file.deleted}`}`);

    if (symbols.length) {
        lines.push('symbols:');
        for (const entry of symbols) lines.push(`  ${entry.path}: ${names(entry)}`)
    }

    if (tests.length) {
        lines.push('tests:');
        for (const entry of tests) lines.push(`  ${entry.path}: ${names(entry)}${entry.dynamic ? ` · ${count(entry.dynamic, 'computed title')} not compared` : ''}`)
    }

    for (const entry of unparsed) lines.push(`unparsed ${entry.path} (${entry.side}): ${entry.message}`);

    lines.push(`comments: ${flagged.length ? flagged.map(file => `${file.path} adds ${file.comment} comment to ${file.code} code lines`).join('; ') : 'no file adds more comment lines than code'}`);

    if (since) {
        const through = label => since.files.filter(file => file.through === label).map(file => file.path);

        lines.push(`since ${short(since.sha)}${since.ancestor ? '' : ' (not an ancestor of head: the branch was rewritten)'}: ${count(since.files.length, 'file')} changed`);
        if (through('own commits').length) lines.push(`  through own commits: ${through('own commits').join(', ')}`);
        if (through('merges only').length) lines.push(`  only through merges: ${through('merges only').join(', ')}`)
    }

    return lines
}

function main() {
    const args    = process.argv.slice(2),
          valueAt = (index, flag) => {
              if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} needs a value`);

              return args[index + 1]
          },
          read    = flag => args.includes(flag) ? valueAt(args.indexOf(flag), flag) : null;

    if (args.includes('--help')) { console.log(USAGE); return }

    try {
        const generated = args.flatMap((arg, index) => arg === '--generated' ? [valueAt(index, arg)] : []),
              digest    = buildDigest({
                  repo : path.resolve(read('--repo') ?? process.env.INIT_CWD ?? process.cwd()),
                  base : read('--base') ?? 'origin/dev',
                  head : read('--head') ?? 'HEAD',
                  since: read('--since'),
                  generated
              });

        console.log(args.includes('--json') ? JSON.stringify(digest, null, 2) : formatDigest(digest).join('\n'))
    } catch (error) {
        console.error(`delta-digest: ${error.message}\n${USAGE}`);
        process.exitCode = 1
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main()
}
