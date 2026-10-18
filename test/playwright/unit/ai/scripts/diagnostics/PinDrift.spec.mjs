import {test, expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    buildReport,
    engineTarget,
    formatReport,
    installedState,
    parsePin,
    reach,
    relevantCommits,
    runtimeRoots,
    scanImports,
    walkClosure
} from '../../../../../../ai/scripts/diagnostics/pinDrift.mjs';

const SHA   = 'a87a89e293d00000000000000000000000000001',
      OTHER = '9e48135295d846870f2bf4947e2ba80115e01da4',
      lock  = resolved => ({packages: {'node_modules/neo.mjs': {resolved}}});

test.describe('pinDrift (#1094)', () => {
    test('AC-1: both lock forms yield the pin; a lock without one refuses at the field', () => {
        expect(parsePin(lock(`https://github.com/neomjs/neo/archive/${SHA}.tar.gz`)).sha).toBe(SHA);
        expect(parsePin(lock(`git+ssh://git@github.com/neomjs/neo.git#${SHA}`)).sha).toBe(SHA);
        expect(parsePin({packages: {'node_modules/neo.mjs': {resolved: '../neo', link: true}}})).toEqual({resolved: '../neo', sha: null, link: true});
        expect(() => parsePin({packages: {}})).toThrow('packages["node_modules/neo.mjs"].resolved');
        expect(() => parsePin(lock('github:neomjs/neo#dev'))).toThrow('names no engine commit');
    });

    test('AC-2: engine loads are found at statement starts; prose and computed specifiers are not followed', () => {
        const source = [
            "import Provider from 'neo.mjs/src/state/Provider.mjs';",
            'import {',
            '    a,',
            '    b',
            "} from '../../node_modules/neo.mjs/src/B.mjs';",
            "export {c} from './local.mjs';",
            "import fs from 'node:fs';",
            '/**',
            " * import Prose from 'neo.mjs/src/Prose.mjs'",
            ' */',
            "const lazy = await import('neo.mjs/src/Lazy.mjs'),",
            '      named = await import(name);'
        ].join('\n');

        const {specifiers, computed} = scanImports(source),
              targets                = specifiers.map(specifier => engineTarget(specifier, 'test/unit/x.spec.mjs'));

        expect(targets).toEqual(['src/state/Provider.mjs', 'src/B.mjs', null, null, 'src/Lazy.mjs']);
        expect(computed).toBe(1);

        const html = scanImports('<script type="module" src="/node_modules/neo.mjs/src/MicroLoader.mjs"></script>', {html: true});

        expect(html.specifiers.map(specifier => engineTarget(specifier, 'apps/lab/index.html'))).toEqual(['src/MicroLoader.mjs']);
    });

    test('AC-3: the walk follows relative imports, ends on cycles, reports missing targets, and a MicroLoader root adds the worker modules', () => {
        const sources = {
                  'src/a.mjs': "import B from './b.mjs';\nimport C from 'neo.mjs/src/c.mjs';",
                  'src/b.mjs': "import A from './a.mjs';\nimport Gone from './gone.mjs';\nconst x = import(dynamic);",
                  'src/c.mjs': 'export default 1;'
              },
              reads   = [],
              walk    = walkClosure(['src/a.mjs'], paths => {
                  reads.push(paths);
                  return new Map(paths.map(file => [file, sources[file] ?? null]))
              });

        expect([...walk.files.keys()]).toEqual(['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
        expect(walk.files.get('src/b.mjs').via).toBe('src/a.mjs');
        expect(walk.missing).toEqual(['src/gone.mjs']);
        expect(walk.computed).toEqual([{file: 'src/b.mjs', count: 1}]);
        expect(reads.flat().filter(file => file === 'src/a.mjs')).toHaveLength(1);

        const workers = ['src/worker/App.mjs', 'src/worker/Data.mjs', 'src/worker/mixin', 'src/worker/README.md'];

        expect(runtimeRoots(['src/MicroLoader.mjs'], workers)).toEqual(['src/worker/App.mjs', 'src/worker/Data.mjs']);
        expect(runtimeRoots(['src/Neo.mjs'], workers)).toEqual([]);
    });

    test('AC-4: only commits touching a loaded file are kept, fixes first; --module reaches files nothing loads', () => {
        const commits = [
            {sha: '1', date: '2026-10-03', subject: 'feat(core): base grows (#3)',          files: ['src/core/Base.mjs']},
            {sha: '2', date: '2026-10-02', subject: 'fix(other): unrelated (#4)',           files: ['src/Unrelated.mjs']},
            {sha: '3', date: '2026-10-01', subject: 'fix(state): parents enumerate (#2)', files: ['src/state/Provider.mjs', 'README.md']}
        ];
        const loaded = new Set(['src/core/Base.mjs', 'src/state/Provider.mjs']);

        expect(relevantCommits(commits, loaded).map(({sha, fix, files}) => ({sha, fix, files}))).toEqual([
            {sha: '3', fix: true,  files: ['src/state/Provider.mjs']},
            {sha: '1', fix: false, files: ['src/core/Base.mjs']}
        ]);
        expect(relevantCommits(commits, loaded, ['src/Unrelated.mjs']).map(commit => commit.sha)).toEqual(['2']);
    });

    test('AC-5: the installed engine is compared with the lock', () => {
        expect(installedState(SHA, lock(`git+ssh://git@github.com/neomjs/neo.git#${SHA}`))).toEqual({sha: SHA, state: 'matches'});
        expect(installedState(SHA, lock(`git+ssh://git@github.com/neomjs/neo.git#${OTHER}`))).toEqual({sha: OTHER, state: 'differs'});
        expect(installedState(SHA, null)).toEqual({sha: null, state: 'not installed'});
        expect(installedState(SHA, {packages: {'node_modules/neo.mjs': {resolved: '../neo', link: true}}})).toEqual({sha: null, state: 'linked'});
        expect(installedState(SHA, lock('github:neomjs/neo#dev'))).toEqual({sha: null, state: 'unreadable'});
    });

    test('a reach names the importer, elides further engine hops, and ends at the consumer file', () => {
        const files = new Map([
            ['src/d.mjs', {via: 'src/c.mjs'}],
            ['src/c.mjs', {via: 'src/b.mjs'}],
            ['src/b.mjs', {via: 'src/a.mjs'}],
            ['src/a.mjs', {via: null}]
        ]);
        const importers = new Map([['src/a.mjs', ['app.mjs']]]);

        expect(reach('src/d.mjs', files, importers)).toBe('src/d.mjs ← src/c.mjs ← … ← src/a.mjs ← app.mjs');
        expect(reach('src/b.mjs', files, importers)).toBe('src/b.mjs ← src/a.mjs ← app.mjs');
        expect(reach('src/a.mjs', files, importers)).toBe('src/a.mjs ← app.mjs');
    });

    test.describe('a fixture engine and consumer, end to end through git', () => {
        let root, engine, consumer, pin;

        const git   = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim(),
              write = (dir, files) => Object.entries(files).forEach(([file, text]) => {
                  fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
                  fs.writeFileSync(path.join(dir, file), text)
              }),
              commit = (dir, message) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message) },
              init   = dir => { fs.mkdirSync(dir); git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'test@example.com'); git(dir, 'config', 'user.name', 'Test User') };

        test.beforeAll(() => {
            root     = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pin-drift-')));
            engine   = path.join(root, 'neo');
            consumer = path.join(root, 'consumer');

            init(engine);
            write(engine, {
                'package.json'          : JSON.stringify({name: 'neo.mjs'}),
                'src/core/Base.mjs'     : 'export default class Base {}\n',
                'src/state/Provider.mjs': "import Base from '../core/Base.mjs';\nexport default class Provider extends Base {}\n",
                'src/Unrelated.mjs'     : 'export default 1;\n',
                'src/MicroLoader.mjs'   : "import './Main.mjs';\n",
                'src/Main.mjs'          : 'export default 1;\n',
                'src/worker/App.mjs'    : 'export default 1;\n'
            });
            commit(engine, 'init');
            pin = git(engine, 'rev-parse', 'HEAD');

            write(engine, {'src/state/Provider.mjs': "import Base from '../core/Base.mjs';\nexport default class Provider extends Base {static parents = true}\n"});
            commit(engine, 'fix(state): inherited provider data enumerates across the parent chain (#2)');
            write(engine, {'src/Unrelated.mjs': 'export default 2;\n'});
            commit(engine, 'fix(other): nothing the consumer loads (#4)');
            write(engine, {'README.md': 'docs\n'});
            commit(engine, 'docs: readme');
            git(engine, 'mv', 'src/core/Base.mjs', 'src/core/Core.mjs');
            commit(engine, 'refactor(core): rename Base (#5)');

            init(consumer);
            write(consumer, {
                'package.json'     : JSON.stringify({dependencies: {'neo.mjs': 'github:neomjs/neo#dev'}}),
                'package-lock.json': JSON.stringify(lock(`git+ssh://git@github.com/neomjs/neo.git#${pin}`)),
                'app.mjs'          : "import Provider from 'neo.mjs/src/state/Provider.mjs';\nconst plugin = await import(pluginName);\n",
                'index.html'       : '<script type="module" src="./node_modules/neo.mjs/src/MicroLoader.mjs"></script>\n',
                '.gitignore'       : 'node_modules/\n'
            });
            write(consumer, {'node_modules/.package-lock.json': JSON.stringify(lock(`git+ssh://git@github.com/neomjs/neo.git#${OTHER}`))});
            commit(consumer, 'init')
        });

        test.afterAll(() => fs.rmSync(root, {recursive: true, force: true}));

        test('the report keeps the commits touching what the consumer loads and flags the installed engine', () => {
            const report = buildReport({consumer, engine, ref: 'HEAD', modules: []});

            expect(report.pin.sha).toBe(pin);
            expect(report.installed).toEqual({sha: OTHER, state: 'differs'});
            expect(report.spec).toBe('github:neomjs/neo#dev');
            expect(report.behind).toBe(4);
            expect(report.fixes).toBe(2);
            expect(report.closure).toMatchObject({files: 5, workerEntries: 1, computedHere: 1, missing: []});
            expect(report.commits.map(({subject, files}) => ({subject, files}))).toEqual([
                {subject: 'fix(state): inherited provider data enumerates across the parent chain (#2)', files: ['src/state/Provider.mjs']},
                // --no-renames keeps the path the consumer loads at the pin
                {subject: 'refactor(core): rename Base (#5)', files: ['src/core/Base.mjs']}
            ]);
            expect(report.commits[0].reach).toEqual(['src/state/Provider.mjs ← app.mjs']);
            expect(report.commits[1].reach).toEqual(['src/core/Base.mjs ← src/state/Provider.mjs ← app.mjs']);

            const lines = formatReport(report);

            expect(lines.some(line => line.includes('⚠ installed 9e48135295 ≠ lock') && line.includes('rm -rf node_modules/neo.mjs && npm install'))).toBe(true);
            expect(lines).toContain('package.json names github:neomjs/neo#dev, not the pin');
            expect(lines).toContain('1 fix touches what this repo loads:');
            expect(lines).toContain('1 other commit touches it:');
        });

        test('--module reports commits on a file the consumer does not load', () => {
            const report = buildReport({consumer, engine, ref: 'HEAD', modules: ['src/Unrelated.mjs']});

            expect(report.commits.map(commit => commit.subject)).toEqual(['fix(other): nothing the consumer loads (#4)']);
            expect(formatReport(report).at(-2)).toBe('1 commit touches src/Unrelated.mjs (src/Unrelated.mjs: not loaded here):');
        });

        test('a pin the engine checkout lacks fails with the fetch command', () => {
            const stale = path.join(root, 'stale');

            init(stale);
            write(stale, {'package-lock.json': JSON.stringify(lock(`git+ssh://git@github.com/neomjs/neo.git#${OTHER}`))});
            commit(stale, 'init');

            expect(() => buildReport({consumer: stale, engine, ref: 'HEAD', modules: []})).toThrow(`lacks the pin ${OTHER}: git -C ${engine} fetch origin`);
        });
    });
});
