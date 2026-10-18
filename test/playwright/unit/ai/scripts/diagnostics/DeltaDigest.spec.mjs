import {test, expect}            from '@playwright/test';
import {execFileSync, spawnSync} from 'node:child_process';
import fs                        from 'node:fs';
import os                        from 'node:os';
import path                      from 'node:path';
import {fileURLToPath}           from 'node:url';
import {
    USAGE,
    buildDigest,
    classifyAddedLines,
    closeTargets,
    extractSymbols,
    extractTestTitles,
    formatDigest
} from '../../../../../../ai/scripts/diagnostics/deltaDigest.mjs';

const script = fileURLToPath(new URL('../../../../../../ai/scripts/diagnostics/deltaDigest.mjs', import.meta.url));

test.describe('deltaDigest (#1105)', () => {
    test('AC-3: symbols are declarations, imports, exports and class members, keyed so a member change marks only that member', () => {
        const source = [
            "import aiConfig from './config.mjs';",
            "import {a, b as c} from './x.mjs';",
            "import './side.mjs';",
            'export const ONE = 1, TWO = 2;',
            'const {left, right: other} = pair;',
            'export function plain() {}',
            'export async function later() {}',
            'class Service extends Base {',
            "    static config = {className: 'Service'}",
            '    static #snapshot = null',
            '    #cache = new Map()',
            '    constructor() { super() }',
            '    get id() { return 1 }',
            '    set id(value) {}',
            '    async load() { return 1 }',
            '    #getConfig() {}',
            '    static create() {}',
            "    ['computed' + 1]() {}",
            '    static {}',
            '}',
            'export {Service as Default};',
            "export * from './all.mjs';",
            'export default Neo.setupClass(Service);'
        ].join('\n');

        const before = extractSymbols(source),
              after  = extractSymbols(source.replace('async load() { return 1 }', 'async load() { return 2 }'));

        expect([...before.keys()]).toEqual([
            'import aiConfig', 'import a', 'import c', "import './side.mjs'",
            'ONE', 'TWO', 'left', 'other', 'plain', 'later',
            'Service', 'Service.static config', 'Service.static #snapshot', 'Service.#cache', 'Service.constructor',
            'Service.get id', 'Service.set id', 'Service.load', 'Service.#getConfig', 'Service.static create',
            "Service.['computed' + 1]", 'Service.static {}',
            'export {Service as Default}', "export * from './all.mjs'", 'export default'
        ]);
        expect([...before.keys()].filter(key => before.get(key) !== after.get(key))).toEqual(['Service.load']);

        // A script that is no module still parses; a file that parses as neither throws acorn's error
        expect([...extractSymbols('with (scope) {}\nfunction f() {}').keys()]).toEqual(['f']);
        expect(() => extractSymbols('export const = ;')).toThrow(SyntaxError);
    });

    test('AC-4: test titles are read by describe path, with their modifier; computed titles are counted, not guessed', () => {
        const {titles, dynamic} = extractTestTitles([
            "test.describe('suite', () => {",
            "    test('plain', async () => {});",
            "    test.skip('skipped', () => {});",
            "    test.describe.serial('inner', () => {",
            '        it(`template title`, () => {});',
            '    });',
            '    test.beforeEach(() => {});',
            "    test('in a loop ' + name, () => {});",
            "    test('guarded', () => { test.skip(process.env.CI, 'not on CI'); });",
            '});',
            "describe.only('other', function () { test.fixme('later', () => {}) });"
        ].join('\n'));

        expect([...titles]).toEqual([
            ['suite › plain', null],
            ['suite › skipped', 'skip'],
            ['suite › inner › template title', null],
            ['suite › guarded', null],
            ['other › later', 'fixme']
        ]);
        expect(dynamic).toBe(1);
    });

    test('AC-5: closing keywords are found with their commit, and subjects give their ticket ids', () => {
        const {closes, subjectIds} = closeTargets([
            {sha: 'a1', subject: 'feat(x): one (#12)', message: 'feat(x): one (#12)\n\nResolves #12\nRefs #9'},
            {sha: 'b2', subject: 'fix(y): two (#13) (#14)', message: 'fix(y): two (#13) (#14)\n\nfixes neomjs/neo#3, Closes: #4\nfixed https://github.com/neomjs/neo-stage/issues/5\na fixture #6 is no keyword'}
        ]);

        expect(closes).toEqual([
            {sha: 'a1', keyword: 'Resolves', target: '#12'},
            {sha: 'b2', keyword: 'fixes', target: 'neomjs/neo#3'},
            {sha: 'b2', keyword: 'Closes', target: '#4'},
            {sha: 'b2', keyword: 'fixed', target: 'neomjs/neo-stage#5'}
        ]);
        expect(subjectIds).toEqual([{id: 12, shas: ['a1']}, {id: 13, shas: ['b2']}, {id: 14, shas: ['b2']}]);
    });

    test('AC-6: added lines count as code, comment or blank, following a block comment across its lines', () => {
        expect(classifyAddedLines(['/**', ' * @summary x', ' */', 'const a = 1;', '', '// note', 'b(); // trailing'], 'a.mjs')).toEqual({code: 2, comment: 4, blank: 1});
        expect(classifyAddedLines(['/* opens', 'still a comment', 'closes */ ', 'code();'], 'a.mjs')).toEqual({code: 1, comment: 3, blank: 0});
        expect(classifyAddedLines(['# a comment', 'run()'], 'tool.py')).toEqual({code: 1, comment: 1, blank: 0});
    });

    test.describe('a fixture repository, end to end through git', () => {
        let root, repo, anchor, first, merged, merges;

        const git   = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim(),
              write = files => Object.entries(files).forEach(([file, content]) => {
                  fs.mkdirSync(path.dirname(path.join(repo, file)), {recursive: true});
                  fs.writeFileSync(path.join(repo, file), content)
              }),
              commit = message => { git('add', '-A'); git('commit', '-q', '-m', message) },
              lines  = count => Array.from({length: count}, (_, index) => `export const line${index} = ${index};`).join('\n') + '\n',
              digest = () => buildDigest({repo, base: 'main', head: 'feature', since: anchor, generated: ['resources/content/**']});

        test.beforeAll(() => {
            root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delta-digest-')));
            repo = path.join(root, 'repo');
            fs.mkdirSync(repo);
            git('init', '-q', '-b', 'main');
            git('config', 'user.email', 'test@example.com');
            git('config', 'user.name', 'Test User');

            write({
                'src/keep.mjs'             : 'export default class Keep {\n    render() { return 1 }\n    stay() { return 0 }\n}\n',
                'src/old.mjs'              : lines(10),
                'src/gone.mjs'             : 'export function gone() {}\n',
                'src/conflict.mjs'         : "export const side = 'base';\n",
                'test/keep.spec.mjs'       : "test('keeps rendering', () => {});\ntest('stays', () => {});\n",
                'assets/logo.bin'          : Buffer.from([0, 1, 2, 3]),
                'resources/content/page.md': 'one\n'
            });
            commit('init');
            git('switch', '-q', '-c', 'feature');

            git('mv', 'src/old.mjs', 'src/new.mjs');
            fs.rmSync(path.join(repo, 'src/gone.mjs'));
            write({
                'src/new.mjs'              : lines(10) + 'export const extra = 1;\n',
                'src/keep.mjs'             : 'export default class Keep {\n    render() { return 2 }\n    stay() { return 0 }\n    async load() {}\n    #secret() {}\n}\n',
                'src/notes.mjs'            : '/**\n * @summary Notes.\n * One.\n * Two.\n */\nexport const notes = 1;\n',
                'src/broken.mjs'           : 'export const = ;\n',
                'test/keep.spec.mjs'       : "test('renders', () => {});\ntest('stays', () => {});\n",
                'assets/logo.bin'          : Buffer.from([0, 9, 8, 7]),
                'resources/content/page.md': 'two\n'
            });
            commit("feat(digest): the fixture's changes (#7)\n\nResolves #7");
            first = git('rev-parse', 'HEAD');

            // A clean merge of main, then the review anchor
            git('switch', '-q', 'main');
            write({'src/main-only.mjs': 'export const main = 1;\n'});
            commit('chore: main moves');
            git('switch', '-q', 'feature');
            git('merge', '-q', '--no-ff', '-m', 'Merge main into feature', 'main');
            anchor = git('rev-parse', 'HEAD');

            // A merge whose conflict is resolved by hand, between two own commits
            git('switch', '-q', 'main');
            write({'src/conflict.mjs': "export const side = 'main';\n", 'src/main-later.mjs': 'export const later = 1;\n'});
            commit('chore: main edits the conflict');
            git('switch', '-q', 'feature');
            write({'src/conflict.mjs': "export const side = 'feature';\n"});
            commit('feat: the feature edits the conflict (#7)');
            spawnSync('git', ['-C', repo, 'merge', '-q', '-m', 'Merge main again', 'main']);
            write({'src/conflict.mjs': "export const side = 'both';\n"});
            commit('Merge main again');
            write({'src/new.mjs': lines(10) + 'export const extra = 2;\n'});
            commit('fix: the feature touches new again (#7)');

            // main moves on after the last merge: a diff from main itself, not the merge-base, would show it reverted
            git('switch', '-q', 'main');
            merged = git('rev-parse', 'HEAD');
            write({'src/main-after.mjs': 'export const after = 1;\n'});
            commit('chore: main moves after the last merge');
            git('switch', '-q', 'feature');

            merges = git('rev-list', '--merges', '--reverse', 'main..feature').split('\n')
        });

        test.afterAll(() => fs.rmSync(root, {recursive: true, force: true}));

        test('AC-1: the range starts at the merge-base, lists own commits apart from merges, and marks the hand-resolved merge', () => {
            const result = digest();

            expect(result.mergeBase).toBe(merged);
            expect(result.base.sha).toBe(git('rev-parse', 'main'));
            expect(result.commits.map(commit => commit.subject)).toEqual([
                "feat(digest): the fixture's changes (#7)",
                'feat: the feature edits the conflict (#7)',
                'fix: the feature touches new again (#7)'
            ]);
            expect(result.merges).toEqual([
                {sha: merges[0], subject: 'Merge main into feature', handEdited: false, files: []},
                {sha: merges[1], subject: 'Merge main again', handEdited: true, files: ['src/conflict.mjs']}
            ]);
        });

        test('AC-2: every authored path carries its status and counts; main\'s own files stay out, generated paths are counted apart', () => {
            const result = digest();

            expect(result.files.map(({status, path: file, from, binary}) => ({status, path: file, ...(from ? {from} : {}), ...(binary ? {binary} : {})}))).toEqual([
                {status: 'modified', path: 'assets/logo.bin', binary: true},
                {status: 'added', path: 'src/broken.mjs'},
                {status: 'modified', path: 'src/conflict.mjs'},
                {status: 'deleted', path: 'src/gone.mjs'},
                {status: 'modified', path: 'src/keep.mjs'},
                {status: 'renamed', path: 'src/new.mjs', from: 'src/old.mjs'},
                {status: 'added', path: 'src/notes.mjs'},
                {status: 'modified', path: 'test/keep.spec.mjs'}
            ]);
            expect(result.files.find(file => file.path === 'src/new.mjs')).toMatchObject({added: 1, deleted: 0});
            expect(result.generated).toEqual({globs: ['resources/content/**'], files: 1, added: 1, deleted: 1});
        });

        test('AC-3/AC-4: symbols and test titles are compared at both ends; a file that does not parse is named, not skipped', () => {
            const result = digest();

            expect(result.symbols).toEqual([
                {path: 'src/conflict.mjs', added: [], removed: [], changed: ['side']},
                {path: 'src/gone.mjs', added: [], removed: ['gone'], changed: []},
                {path: 'src/keep.mjs', added: ['Keep.load', 'Keep.#secret'], removed: [], changed: ['Keep.render']},
                {path: 'src/new.mjs', added: ['extra'], removed: [], changed: []},
                {path: 'src/notes.mjs', added: ['notes'], removed: [], changed: []}
            ]);
            expect(result.unparsed).toEqual([{path: 'src/broken.mjs', side: 'head', message: expect.stringContaining('Unexpected token')}]);
            expect(result.tests).toEqual([{path: 'test/keep.spec.mjs', added: ['renders'], removed: ['keeps rendering'], changed: [], dynamic: 0}]);
        });

        test('AC-5/AC-6: closing keywords and subject ids are found, and a file adding more comment than code is flagged', () => {
            const result = digest();

            expect(result.closes).toEqual([{sha: first, keyword: 'Resolves', target: '#7'}]);
            expect(result.subjectIds).toEqual([{id: 7, shas: result.commits.map(commit => commit.sha)}]);
            expect(result.comments.filter(file => file.flagged)).toEqual([{path: 'src/notes.mjs', code: 1, comment: 5, blank: 0, flagged: true}]);
        });

        test('AC-7: since a review anchor, each changed file is attributed to own commits or to merges only', () => {
            expect(digest().since).toEqual({
                sha     : anchor,
                ancestor: true,
                files   : [
                    {status: 'modified', path: 'src/conflict.mjs', through: 'own commits'},
                    {status: 'added', path: 'src/main-later.mjs', through: 'merges only'},
                    {status: 'modified', path: 'src/new.mjs', through: 'own commits'}
                ]
            });
        });

        test('AC-8: the CLI prints the digest as text or JSON, prints usage, and names the flag that failed', () => {
            const run  = (...args) => spawnSync('node', [script, '--repo', repo, ...args], {encoding: 'utf8'}),
                  json = run('--base', 'main', '--head', 'feature', '--since', anchor, '--generated', 'resources/content/**', '--json'),
                  text = run('--base', 'main', '--head', 'feature', '--since', anchor, '--generated', 'resources/content/**');

            expect(json.status).toBe(0);
            expect(JSON.parse(json.stdout)).toEqual(JSON.parse(JSON.stringify(digest())));
            expect(text.stdout.trim().split('\n')).toEqual(formatDigest(digest()));
            expect(text.stdout).toContain(`closes: Resolves #7 (${first.slice(0, 10)}) · subject ids: #7`);
            expect(text.stdout).toContain('  R90 src/old.mjs → src/new.mjs +1 −0');
            expect(text.stdout).toContain('comments: src/notes.mjs adds 5 comment to 1 code lines');
            expect(text.stdout).toContain('  only through merges: src/main-later.mjs');

            expect(run('--help').stdout.trim()).toBe(USAGE);

            const unknown = run('--base', 'nope');

            expect(unknown.status).toBe(1);
            expect(unknown.stderr).toContain('--base nope names no commit');
            expect(run('--since').stderr).toContain('--since needs a value');
        });
    });
});
