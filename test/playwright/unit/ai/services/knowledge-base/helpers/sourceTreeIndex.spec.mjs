import {spawnSync}    from 'node:child_process';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import process        from 'node:process';
import {test, expect} from '@playwright/test';
import {
    indexSourceTree,
    readClassCard,
    readFolderScene,
    readMethodCallers
}                     from '../../../../../../../ai/services/knowledge-base/helpers/sourceTreeIndex.mjs';
import {main as runCodeIndexCli} from '../../../../../../../ai/scripts/diagnostics/codeIndex.mjs';

const repoRoot      = path.resolve(import.meta.dirname, '../../../../../../..');
const codeIndexPath = path.join(repoRoot, 'ai/scripts/diagnostics/codeIndex.mjs');
const engineSrcDir  = path.join(repoRoot, 'node_modules/neo.mjs/src');

function writeFixtureTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-code-index-fixture-'));
    const src  = path.join(root, 'src');

    fs.mkdirSync(path.join(src, 'core'), {recursive: true});
    fs.mkdirSync(path.join(src, 'mixin'), {recursive: true});
    fs.mkdirSync(path.join(src, 'panel'), {recursive: true});
    fs.mkdirSync(path.join(src, 'other'), {recursive: true});

    fs.writeFileSync(path.join(src, 'core/Base.mjs'), [
        'class Base {',
        '    static config = {',
        "        className: 'Fixture.core.Base',",
        '        mounted_ : false',
        '    }',
        '    set(values) { return values }',
        '    render() { return true }',
        '}',
        'export default Base;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'mixin/badged.mjs'), [
        "import Base from '../core/Base.mjs';",
        'class Badged extends Base {',
        '    static config = {',
        "        className : 'Fixture.mixin.Badged',",
        "        badgeText_: ''",
        '    }',
        '    syncBadge() { return this.badgeText }',
        '}',
        'export default Badged;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'panel/Base.mjs'), [
        "import CoreRoot from '../core/Base.mjs';",
        "import BadgedMixin from '../mixin/badged.mjs';",
        'class PanelBase extends CoreRoot {',
        '    static config = {',
        "        className: 'Fixture.panel.Base',",
        "        ntype    : 'fixture-panel',",
        '        mixins   : [BadgedMixin],',
        "        title_   : 'Untitled',",
        "        mode     : 'static-mode'",
        '    }',
        '    afterSetTitle(value, oldValue) {',
        '        const me = this;',
        '        me.syncBadge();',
        '    }',
        '    beforeSetMode(value) {',
        '        return value;',
        '    }',
        '    render() {',
        '        super.render();',
        '        this.missingHelper();',
        '    }',
        '    updateTitle(nextTitle) {',
        '        const me = this;',
        '        this.title = nextTitle;',
        '        me.set({title: nextTitle});',
        '    }',
        '}',
        'export default PanelBase;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'panel/Detail.mjs'), [
        "import AliasedPanel from './Base.mjs';",
        'class DetailPanel extends AliasedPanel {',
        '    static config = {',
        "        className: 'Fixture.panel.Detail'",
        '    }',
        '    refresh() {',
        '        let me = this;',
        "        me.title = 'Refreshed';",
        '        me.render();',
        '    }',
        '}',
        'export default DetailPanel;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'other/Consumer.mjs'), [
        "import DetailPanel from '../panel/Detail.mjs';",
        'class ExternalConsumer extends DetailPanel {',
        '    static config = {',
        "        className: 'Fixture.other.Consumer'",
        '    }',
        '    drive(panelInstance) {',
        '        const me = this;',
        '        me.updateTitle("FromSubclass");',
        '        panelInstance.set({title: "ExternalSet"});',
        '    }',
        '    missingHelper() {',
        '        return "unrelated-class-method-must-not-bind";',
        '    }',
        '}',
        'export default ExternalConsumer;'
    ].join('\n'));

    return {root, src}
}

test.describe('sourceTreeIndex & codeIndex CLI', () => {
    let fixture;

    test.beforeAll(() => {
        fixture = writeFixtureTree();
    });

    test.afterAll(() => {
        if (fixture?.root) {
            fs.rmSync(fixture.root, {recursive: true, force: true});
        }
    });

    test('refuses a missing rootDir with CODE_INDEX_ROOT_NOT_FOUND', () => {
        expect(() => indexSourceTree({rootDir: path.join(fixture.root, 'does-not-exist')}))
            .toThrow(expect.objectContaining({code: 'CODE_INDEX_ROOT_NOT_FOUND'}));
    });

    test('resolves aliased superclasses, mixins, me/super calls, reactive hooks, and preserves unresolved rows with reasons', () => {
        const index = indexSourceTree({rootDir: fixture.src});

        const detailCard = readClassCard(index, 'Fixture.panel.Detail');
        expect(detailCard.found).toBe(true);
        expect(detailCard.chain).toEqual([
            'Fixture.panel.Detail',
            'Fixture.panel.Base',
            'Fixture.core.Base'
        ]);

        const panelCard = readClassCard(index, 'Fixture.panel.Base');
        expect(panelCard.mixins).toEqual(['Fixture.mixin.Badged']);

        const titleConfig = panelCard.configs.find(cfg => cfg.name === 'title');
        expect(titleConfig.reactive).toBe(true);
        expect(titleConfig.hooks).toEqual([
            {hookKind: 'afterSet', methodName: 'afterSetTitle', line: 11}
        ]);

        const renderMethod = panelCard.methods.find(m => m.name === 'render');
        expect(renderMethod.overrides).toBe(true);
        expect(renderMethod.overridesFrom).toBe('Fixture.core.Base#render');
        expect(renderMethod.callsSuper).toBe(true);

        const syncBadgeCallers = readMethodCallers(index, 'Fixture.mixin.Badged#syncBadge');
        expect(syncBadgeCallers.calls).toEqual([expect.objectContaining({
            kind        : 'call',
            sourcePath  : 'src/panel/Base.mjs',
            callerClass : 'Fixture.panel.Base',
            callerMethod: 'afterSetTitle',
            receiver    : 'me'
        })]);

        const baseRenderCallers = readMethodCallers(index, 'Fixture.core.Base#render');
        expect(baseRenderCallers.calls).toEqual([expect.objectContaining({
            kind        : 'call',
            sourcePath  : 'src/panel/Base.mjs',
            callerClass : 'Fixture.panel.Base',
            callerMethod: 'render',
            receiver    : 'super'
        })]);

        expect(panelCard.unresolved).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind      : 'hook',
                className : 'Fixture.panel.Base',
                methodName: 'beforeSetMode',
                target    : 'mode',
                reason    : 'config-not-reactive'
            }),
            expect.objectContaining({
                kind      : 'call',
                className : 'Fixture.panel.Base',
                methodName: 'render',
                receiver  : 'this',
                callee    : 'missingHelper',
                reason    : 'method-not-on-chain'
            })
        ]));
    });

    test('lists config writes on a hook strictly as possible dispatch and never as a call on fixture and Engine classes', () => {
        const index       = indexSourceTree({rootDir: fixture.src});
        const hookCallers = readMethodCallers(index, 'Fixture.panel.Base#afterSetTitle');

        expect(hookCallers.found).toBe(true);
        expect(hookCallers.calls).toEqual([]);
        expect(hookCallers.possibleDispatches).toHaveLength(4);

        for (const row of hookCallers.possibleDispatches) {
            expect(row.kind).toBe('possible dispatch');
            expect(row.label).toBe('possible dispatch');
            expect(row.sourcePath).toMatch(/^src\//u);
            expect(row.line).toBeGreaterThan(0);
        }

        const chunks  = [];
        const cliRead = runCodeIndexCli(
            ['--root', fixture.src, 'callers', 'Fixture.panel.Base#afterSetTitle'],
            {stdout: {write: text => chunks.push(text)}}
        );
        expect(cliRead.exitCode).toBe(0);
        const writeSection = cliRead.output.split("Config writes for 'title'")[1];
        expect(writeSection).toContain('[possible dispatch] src/panel/Base.mjs:24');
        expect(writeSection).toContain('[possible dispatch] src/panel/Base.mjs:25');
        expect(writeSection).toContain('[possible dispatch] src/panel/Detail.mjs:8');
        expect(writeSection).toContain('[possible dispatch] src/other/Consumer.mjs:9');
        expect(writeSection).not.toContain('[call]');

        const engineIndex = indexSourceTree({rootDir: engineSrcDir});
        expect(engineIndex.indexDurationMs).toBeLessThan(2000);

        const engineHook = readMethodCallers(engineIndex, 'Neo.button.Base#afterSetText');
        expect(engineHook.found).toBe(true);
        expect(engineHook.possibleDispatches.length).toBeGreaterThan(0);
        for (const dispatch of engineHook.possibleDispatches) {
            expect(dispatch.kind).toBe('possible dispatch');
            expect(dispatch.label).toBe('possible dispatch');
            expect(dispatch.sourcePath).toMatch(/^src\//u);
            expect(dispatch.line).toBeGreaterThan(0);
        }
    });

    test('builds folder scenes with internal/border inheritance, mixins, and external callers', () => {
        const index = indexSourceTree({rootDir: fixture.src});
        const scene = readFolderScene(index, 'panel');

        expect(scene.found).toBe(true);
        expect(scene.folder).toBe('src/panel');
        expect(scene.classes.map(c => c.className)).toEqual([
            'Fixture.panel.Base',
            'Fixture.panel.Detail'
        ]);
        expect(scene.inheritance.internal).toEqual([
            {from: 'Fixture.panel.Detail', to: 'Fixture.panel.Base'}
        ]);
        expect(scene.inheritance.outbound).toEqual([
            {from: 'Fixture.panel.Base', to: 'Fixture.core.Base', resolved: true, targetPath: 'src/core/Base.mjs'}
        ]);
        expect(scene.inheritance.inbound).toEqual([
            {from: 'Fixture.other.Consumer', sourcePath: 'src/other/Consumer.mjs', to: 'Fixture.panel.Detail'}
        ]);
        expect(scene.mixins.outbound).toEqual([
            {from: 'Fixture.panel.Base', mixin: 'Fixture.mixin.Badged', targetPath: 'src/mixin/badged.mjs'}
        ]);
        expect(scene.externalCalls).toEqual([expect.objectContaining({
            target   : 'Fixture.panel.Base#updateTitle',
            callCount: 1
        })]);
    });

    test('supports --json, --limit truncation disclosure, --log JSONL receipts, exit-code-1 candidates, and Neo-free subprocess execution', () => {
        const logFile = path.join(fixture.root, 'logs/reads.jsonl');
        const out1    = [];

        const run1 = runCodeIndexCli(
            ['--root', fixture.src, 'card', 'Fixture.panel.Base', '--json', '--limit', '1', '--log', logFile],
            {stdout: {write: text => out1.push(text)}}
        );

        expect(run1.exitCode).toBe(0);
        const parsedJson = JSON.parse(out1.join(''));
        expect(parsedJson.configs).toHaveLength(1);
        expect(parsedJson.methods).toHaveLength(1);
        expect(parsedJson.meta.cut).toBe(true);
        expect(parsedJson.meta.omittedRows).toBeGreaterThan(0);

        const out2 = [];
        const run2 = runCodeIndexCli(
            ['--root', fixture.src, 'callers', 'Fixture.panel.Base#afterSetTitle', '--limit', '2', '--log', logFile],
            {stdout: {write: text => out2.push(text)}}
        );
        expect(run2.exitCode).toBe(0);
        expect(out2.join('')).toContain('2 rows omitted');

        const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(logLines).toHaveLength(2);
        expect(logLines[0]).toMatchObject({
            read            : 'card',
            argument        : 'Fixture.panel.Base',
            extractorVersion: '1.0.0',
            cut             : true
        });
        expect(logLines[0].resultBytes).toBe(Buffer.byteLength(out1.join(''), 'utf8'));
        expect(logLines[0].unresolvedTargets).toEqual(['mode', 'this.missingHelper']);
        expect(typeof logLines[0].indexDurationMs).toBe('number');
        expect(typeof logLines[0].readDurationMs).toBe('number');

        const unknownProc = spawnSync(process.execPath, [
            codeIndexPath,
            '--root', fixture.src,
            'card', 'Panel'
        ], {encoding: 'utf8'});

        expect(unknownProc.status).toBe(1);
        expect(unknownProc.stdout).toContain('Unknown class: Panel');
        expect(unknownProc.stdout).toContain('Fixture.panel.Base');
        expect(unknownProc.stdout).toContain('Fixture.panel.Detail');

        const neoFreeProc = spawnSync(process.execPath, [
            '--input-type=module',
            '-e',
            `import {main} from ${JSON.stringify(codeIndexPath)};
             const res = main(['--root', ${JSON.stringify(fixture.src)}, 'stats'], {stdout: {write() {}}});
             if (globalThis.Neo !== undefined) process.exit(2);
             if (res.exitCode !== 0) process.exit(3);`
        ], {encoding: 'utf8'});

        expect(neoFreeProc.status).toBe(0);
    });
});
