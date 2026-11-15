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
    readMethodCallers,
    summarizeSourceTreeIndex
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
    fs.mkdirSync(path.join(src, 'widget'), {recursive: true});
    fs.mkdirSync(path.join(src, 'sim'), {recursive: true});
    fs.mkdirSync(path.join(src, 'functional'), {recursive: true});

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
        '    drive(panelInstance, otherPanel) {',
        '        const me = this;',
        '        me.updateTitle("FromSubclass");',
        '        panelInstance.set({title: "ExternalSet"});',
        '        otherPanel.set({title: "SecondExternalSet"});',
        '    }',
        '    missingHelper() {',
        '        return "unrelated-class-method-must-not-bind";',
        '    }',
        '}',
        'export default ExternalConsumer;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'other/Badge.mjs'), [
        "import CoreRoot from '../core/Base.mjs';",
        'class Badge extends CoreRoot {',
        '    static config = {',
        "        className: 'Fixture.other.Badge',",
        "        title_   : ''",
        '    }',
        '    afterSetTitle(value) {',
        '        return value;',
        '    }',
        '    applyBadge() {',
        "        this.title = 'BadgeOnly';",
        '    }',
        '}',
        'export default Badge;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'widget/BaseWidget.mjs'), [
        "import CoreRoot from '../core/Base.mjs';",
        'class BaseWidget extends CoreRoot {',
        '    static config = {',
        "        className: 'Fixture.widget.BaseWidget',",
        "        label_   : ''",
        '    }',
        '    afterSetLabel(value) {',
        '        return value;',
        '    }',
        '}',
        'export default BaseWidget;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'widget/BlockingChild.mjs'), [
        "import BaseWidget from './BaseWidget.mjs';",
        'class BlockingChild extends BaseWidget {',
        '    static config = {',
        "        className: 'Fixture.widget.BlockingChild'",
        '    }',
        '    afterSetLabel(value) {',
        '        return value;',
        '    }',
        '}',
        'export default BlockingChild;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'widget/BlockingLeaf.mjs'), [
        "import BlockingChild from './BlockingChild.mjs';",
        'class BlockingLeaf extends BlockingChild {',
        '    static config = {',
        "        className: 'Fixture.widget.BlockingLeaf'",
        '    }',
        '    writeBlocked() {',
        '        const me = this;',
        "        me.label = 'x';",
        '    }',
        '}',
        'export default BlockingLeaf;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'widget/ForwardingChild.mjs'), [
        "import BaseWidget from './BaseWidget.mjs';",
        'class ForwardingChild extends BaseWidget {',
        '    static config = {',
        "        className: 'Fixture.widget.ForwardingChild'",
        '    }',
        '    afterSetLabel(value, oldValue) {',
        '        super.afterSetLabel(value, oldValue);',
        '    }',
        '    writeForwarded() {',
        "        this.label = 'y';",
        '    }',
        '}',
        'export default ForwardingChild;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'sim/Runner.mjs'), [
        "import CoreRoot from '../core/Base.mjs';",
        'class LocalAbort extends Error {}',
        'const CustomTag = class extends HTMLElement {};',
        'class SimRunner extends CoreRoot {',
        '    static config = {',
        "        className: 'Fixture.sim.Runner'",
        '    }',
        '    run() { return Boolean(CustomTag) }',
        '}',
        'export default SimRunner;'
    ].join('\n'));

    fs.writeFileSync(path.join(src, 'functional/defineWidget.mjs'), [
        "import CoreRoot from '../core/Base.mjs';",
        'export function defineWidget() {',
        '    class FunctionalWidget extends CoreRoot {}',
        '    return FunctionalWidget;',
        '}'
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

    test('lists only reachable chain writes on a hook as possible dispatch, isolates unrelated configs and blocked overrides, and routes external writes to unresolved', () => {
        const index       = indexSourceTree({rootDir: fixture.src});
        const hookCallers = readMethodCallers(index, 'Fixture.panel.Base#afterSetTitle');

        expect(hookCallers.found).toBe(true);
        expect(hookCallers.calls).toEqual([]);
        expect(hookCallers.possibleDispatches).toHaveLength(3);
        expect(hookCallers.possibleDispatches.map(row => `${row.sourcePath}:${row.line}`)).toEqual([
            'src/panel/Base.mjs:24',
            'src/panel/Base.mjs:25',
            'src/panel/Detail.mjs:8'
        ]);

        for (const row of hookCallers.possibleDispatches) {
            expect(row.kind).toBe('possible dispatch');
            expect(row.label).toBe('possible dispatch');
            expect(row.receiver).not.toBe('external');
        }

        expect(hookCallers.unresolved).toEqual([
            expect.objectContaining({
                kind      : 'write',
                sourcePath: 'src/other/Consumer.mjs',
                line      : 9,
                className : 'Fixture.other.Consumer',
                methodName: 'drive',
                receiver  : 'external',
                configName: 'title',
                target    : 'title',
                expression: 'panelInstance.set({title: ...})',
                reason    : 'receiver-class-unresolved'
            }),
            expect.objectContaining({
                kind      : 'write',
                sourcePath: 'src/other/Consumer.mjs',
                line      : 10,
                className : 'Fixture.other.Consumer',
                methodName: 'drive',
                receiver  : 'external',
                configName: 'title',
                target    : 'title',
                expression: 'otherPanel.set({title: ...})',
                reason    : 'receiver-class-unresolved'
            })
        ]);

        const badgeCallers = readMethodCallers(index, 'Fixture.other.Badge#afterSetTitle');
        expect(badgeCallers.possibleDispatches.map(row => row.writerClass)).toEqual(['Fixture.other.Badge']);

        const baseLabelCallers = readMethodCallers(index, 'Fixture.widget.BaseWidget#afterSetLabel');
        expect(baseLabelCallers.possibleDispatches.map(row => row.writerClass)).toEqual([
            'Fixture.widget.ForwardingChild'
        ]);

        const blockingLabelCallers = readMethodCallers(index, 'Fixture.widget.BlockingChild#afterSetLabel');
        expect(blockingLabelCallers.possibleDispatches.map(row => row.writerClass)).toEqual([
            'Fixture.widget.BlockingLeaf'
        ]);

        const chunks  = [];
        const cliRead = runCodeIndexCli(
            ['--root', fixture.src, 'callers', 'Fixture.panel.Base#afterSetTitle'],
            {stdout: {write: text => chunks.push(text)}}
        );
        expect(cliRead.exitCode).toBe(0);
        const [beforeUnresolved, unresolvedSection] = cliRead.output.split('Unresolved (2):');
        const writeSection                          = beforeUnresolved.split("Config writes for 'title'")[1];
        expect(writeSection).toContain('[possible dispatch] src/panel/Base.mjs:24');
        expect(writeSection).toContain('[possible dispatch] src/panel/Base.mjs:25');
        expect(writeSection).toContain('[possible dispatch] src/panel/Detail.mjs:8');
        expect(writeSection).not.toContain('Consumer.mjs');
        expect(writeSection).not.toContain('Badge.mjs');
        expect(writeSection).not.toContain('[call]');
        expect(unresolvedSection).toContain(
            'src/other/Consumer.mjs:9 Fixture.other.Consumer#drive -> panelInstance.set({title: ...}) (receiver-class-unresolved)'
        );
        expect(unresolvedSection).not.toContain('[possible dispatch]');

        const engineIndex = indexSourceTree({rootDir: engineSrcDir});
        expect(engineIndex.indexDurationMs).toBeLessThan(2000);

        const buttonHook = readMethodCallers(engineIndex, 'Neo.button.Base#afterSetText');
        expect(buttonHook.found).toBe(true);
        expect(buttonHook.possibleDispatches.some(d => d.sourcePath.endsWith('ToggleOperatorsButton.mjs'))).toBe(true);
        expect(buttonHook.possibleDispatches.some(d => d.receiver === 'external')).toBe(false);

        const componentHook = readMethodCallers(engineIndex, 'Neo.component.Base#afterSetText');
        expect(componentHook.found).toBe(true);
        expect(componentHook.possibleDispatches.some(d => d.sourcePath.endsWith('ToggleOperatorsButton.mjs'))).toBe(false);
        expect(componentHook.possibleDispatches.some(d => d.receiver === 'external')).toBe(false);

        const tooltipHook = readMethodCallers(engineIndex, 'Neo.tooltip.Base#afterSetText');
        expect(tooltipHook.found).toBe(true);
        expect(tooltipHook.possibleDispatches.some(d => d.sourcePath.endsWith('Toolbar.mjs'))).toBe(false);

        const chipHook = readMethodCallers(engineIndex, 'Neo.component.Chip#afterSetText');
        expect(chipHook.found).toBe(true);
        expect(chipHook.possibleDispatches.some(d => d.sourcePath.endsWith('Toolbar.mjs'))).toBe(false);
    });

    test('builds folder scenes with internal/border inheritance, mixins, explicit receiver-scoped external calls heading, and unindexed classes', () => {
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

        const simSceneOut = [];
        const simSceneCli = runCodeIndexCli(
            ['--root', fixture.src, 'scene', 'sim'],
            {stdout: {write: text => simSceneOut.push(text)}}
        );
        expect(simSceneCli.exitCode).toBe(0);
        expect(simSceneCli.output).toContain(
            'Methods called from outside folder (only calls through this, me, and super; 0):'
        );
        expect(simSceneCli.output).toContain('Unresolved (2):');
        expect(simSceneCli.output).toContain('src/sim/Runner.mjs:2 class LocalAbort extends Error (secondary-class-in-module)');
        expect(simSceneCli.output).toContain('src/sim/Runner.mjs:3 class <anonymous> extends HTMLElement (class-expression)');
    });

    test('discloses secondary, factory-nested, and anonymous unindexed classes on card and Engine lookups', () => {
        const abortOut = [];
        const abortRun = runCodeIndexCli(
            ['--root', fixture.src, 'card', 'LocalAbort'],
            {stdout: {write: text => abortOut.push(text)}}
        );
        expect(abortRun.exitCode).toBe(1);
        expect(abortRun.result.found).toBe(false);
        expect(abortRun.result.unindexed).toHaveLength(1);
        expect(abortRun.output.indexOf('Not indexed (1):')).toBeGreaterThan(-1);
        expect(abortRun.output.indexOf('Not indexed (1):')).toBeLessThan(abortRun.output.indexOf('Candidates'));
        expect(abortRun.output).toContain(
            'src/sim/Runner.mjs:2 class LocalAbort extends Error (secondary-class-in-module)'
        );

        const fnOut = [];
        const fnRun = runCodeIndexCli(
            ['--root', fixture.src, 'card', 'FunctionalWidget'],
            {stdout: {write: text => fnOut.push(text)}}
        );
        expect(fnRun.exitCode).toBe(1);
        expect(fnRun.result.found).toBe(false);
        expect(fnRun.output).toContain(
            'src/functional/defineWidget.mjs:3 class FunctionalWidget extends CoreRoot (nested-class-declaration)'
        );

        const engineDriveAbort = runCodeIndexCli(
            ['--root', engineSrcDir, 'card', 'DriveAbort'],
            {stdout: {write() {}}}
        );
        expect(engineDriveAbort.exitCode).toBe(1);
        expect(engineDriveAbort.output).toContain('Not indexed (1):');
        expect(engineDriveAbort.output).toContain('EventSimulator.mjs:8 class DriveAbort extends Error (secondary-class-in-module)');
    });

    test('reads git provenance via git CLI for checkouts and isolates non-git or node_modules roots', () => {
        const untrackedIndex = indexSourceTree({rootDir: fixture.src});
        expect(untrackedIndex.commit).toBeNull();
        expect(untrackedIndex.origin).toBeNull();

        const nodeModulesIndex = indexSourceTree({rootDir: engineSrcDir});
        expect(nodeModulesIndex.commit).toBeNull();
        expect(nodeModulesIndex.origin).toBeNull();

        const gitRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-code-index-git-'));
        try {
            const gitSrcDir = path.join(gitRepoDir, 'src');
            fs.mkdirSync(gitSrcDir, {recursive: true});
            fs.writeFileSync(path.join(gitSrcDir, 'Sample.mjs'), [
                'class Sample {',
                '    static config = {',
                "        className: 'GitFixture.Sample'",
                '    }',
                '}',
                'export default Sample;'
            ].join('\n'));

            spawnSync('git', ['init'], {cwd: gitRepoDir, stdio: 'ignore'});
            spawnSync('git', ['config', 'user.email', 'test@example.invalid'], {cwd: gitRepoDir, stdio: 'ignore'});
            spawnSync('git', ['config', 'user.name', 'Test'], {cwd: gitRepoDir, stdio: 'ignore'});
            spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/sample.git'], {cwd: gitRepoDir, stdio: 'ignore'});
            spawnSync('git', ['add', '.'], {cwd: gitRepoDir, stdio: 'ignore'});
            spawnSync('git', ['commit', '-m', 'init'], {cwd: gitRepoDir, stdio: 'ignore'});

            const trackedIndex = indexSourceTree({rootDir: gitSrcDir});
            expect(trackedIndex.commit).toMatch(/^[0-9a-f]{40}$/iu);
            expect(trackedIndex.origin).toBe('https://example.invalid/sample.git');
        } finally {
            fs.rmSync(gitRepoDir, {recursive: true, force: true});
        }
    });

    test('returns frozen Contract Ledger fields with methods and WeakMap-backed private internals', () => {
        const index = indexSourceTree({rootDir: fixture.src});

        expect(Object.isFrozen(index)).toBe(true);
        expect('_internal' in index).toBe(false);
        expect(Array.isArray(index.methods)).toBe(true);
        expect(Object.isFrozen(index.methods)).toBe(true);
        expect(index.methods).toEqual(expect.arrayContaining([
            expect.objectContaining({
                className    : 'Fixture.panel.Base',
                sourcePath   : 'src/panel/Base.mjs',
                name         : 'render',
                kind         : 'method',
                static       : false,
                computed     : false,
                overrides    : true,
                overridesFrom: 'Fixture.core.Base#render',
                callsSuper   : true
            })
        ]));

        for (const fn of [
            () => readClassCard({}, 'Fixture.panel.Base'),
            () => readMethodCallers({}, 'Fixture.panel.Base#render'),
            () => readFolderScene({}, 'panel'),
            () => summarizeSourceTreeIndex({})
        ]) {
            expect(fn).toThrow(expect.objectContaining({code: 'CODE_INDEX_INVALID_HANDLE'}));
        }
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
        expect(out2.join('')).toContain('1 rows omitted');

        const callersJsonOut = [];
        const runCallersJson = runCodeIndexCli(
            ['--root', fixture.src, 'callers', 'Fixture.panel.Base#afterSetTitle', '--json', '--limit', '1'],
            {stdout: {write: text => callersJsonOut.push(text)}}
        );
        expect(runCallersJson.exitCode).toBe(0);
        const parsedCallersJson = JSON.parse(callersJsonOut.join(''));
        expect(parsedCallersJson.possibleDispatches).toHaveLength(1);
        expect(parsedCallersJson.unresolved).toHaveLength(1);
        expect(parsedCallersJson.meta.cut).toBe(true);
        expect(parsedCallersJson.meta.omittedRows).toBe(3);

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
