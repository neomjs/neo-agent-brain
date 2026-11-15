import * as acorn            from 'acorn';
import {spawnSync}           from 'node:child_process';
import fs                    from 'node:fs';
import path                  from 'node:path';
import process               from 'node:process';
import {test, expect}        from '@playwright/test';
import {inspectSourceModule} from '../../../../../../../ai/services/knowledge-base/helpers/inspectSourceModule.mjs';

const repoRoot   = path.resolve(import.meta.dirname, '../../../../../../..');
const helperPath = path.join(repoRoot, 'ai/services/knowledge-base/helpers/inspectSourceModule.mjs');

test.describe('inspectSourceModule — pure acorn module inspector', () => {
    test('imports acorn only and never boots Neo in a fresh Node process', () => {
        const source      = fs.readFileSync(helperPath, 'utf8');
        const ast         = acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
        const importNodes = ast.body.filter(
            node => node.type === 'ImportDeclaration'
                || (node.type === 'ExportNamedDeclaration' && node.source)
                || node.type === 'ExportAllDeclaration'
        );

        expect(importNodes.map(node => node.source.value)).toEqual(['acorn']);
        expect(source).not.toContain('INSPECT_SOURCE_MODULE_VERSION');
        expect(source).toContain('A separate hierarchy scan already produced different class totals');

        const probe = spawnSync(process.execPath, [
            '--input-type=module',
            '-e',
            `import * as mod from ${JSON.stringify(helperPath)};
             const out = mod.inspectSourceModule('export default class A {}', 'A.mjs', {extractCalls: true});
             if (globalThis.Neo !== undefined) process.exit(2);
             if (out.className !== 'A') process.exit(3);
             if ('INSPECT_SOURCE_MODULE_VERSION' in mod) process.exit(4);`
        ], {encoding: 'utf8'});

        expect(probe.status).toBe(0);
    });

    test('returns a coded failure without throwing when strict is false, and throws KB_SOURCE_PARSE_FAILED when strict is true', () => {
        const malformed = 'import x from "y"; class Broken extends {{{';

        const nonStrict = inspectSourceModule(malformed, 'src/Broken.mjs');
        expect(nonStrict).toMatchObject({
            parseFailed: true,
            code       : 'KB_SOURCE_PARSE_FAILED',
            sourcePath : 'src/Broken.mjs'
        });
        expect(typeof nonStrict.message).toBe('string');

        expect(() => inspectSourceModule(malformed, 'src/Broken.mjs', {strict: true}))
            .toThrow(expect.objectContaining({
                code   : 'KB_SOURCE_PARSE_FAILED',
                details: expect.objectContaining({sourcePath: 'src/Broken.mjs'})
            }));
    });

    test('preserves the default chunk-producer return shape when extractCalls is false', () => {
        const source = [
            "import ParentAlias from './Parent.mjs';",
            'class Widget extends ParentAlias {',
            '    static config = {',
            "        className: 'App.view.Widget',",
            "        ntype    : 'app-widget',",
            '        title_   : null',
            '    }',
            '    render() { return this.title }',
            '}',
            'export default Widget;'
        ].join('\n');

        const result = inspectSourceModule(source, 'src/view/Widget.mjs');

        expect(result.className).toBe('App.view.Widget');
        expect(result.declaresSuper).toBe(true);
        expect(result.superClassReference).toEqual({kind: 'identifier', name: 'ParentAlias'});
        expect(result.imports).toEqual([{
            kind        : 'default',
            localName   : 'ParentAlias',
            importedName: 'default',
            source      : './Parent.mjs'
        }]);
        expect(result.calls).toBeUndefined();
        expect(result.configWrites).toBeUndefined();
        expect(result.mixins).toBeUndefined();
        expect(result.unindexedClasses).toBeUndefined();
    });

    test('extracts ntype, mixins, reactive configs, lexical this/me/super calls, and config writes when extractCalls is true', () => {
        const source = [
            "import BasePanel from './BasePanel.mjs';",
            "import ResizeMixin from '../mixin/Resize.mjs';",
            '',
            'class DashboardPanel extends BasePanel {',
            '    static observable = true',
            '',
            '    static config = {',
            "        className: 'App.DashboardPanel',",
            "        ntype    : 'dashboard-panel',",
            "        mixins   : [ResizeMixin, 'Neo.mixin.Focusable'],",
            "        title_   : 'Overview',",
            '        closable : false',
            '    }',
            '',
            '    afterSetTitle(value, oldValue) {',
            '        let count = 0, me = this;',
            '        super.afterSetTitle(value, oldValue);',
            '        this.refreshHeader();',
            '        const run = () => me.syncBadge();',
            '        function innerHelper() {',
            '            this.notInstanceCall();',
            '            me.notifyOuter();',
            '        }',
            '        function shadowed(me) {',
            '            me.notBoundToThis();',
            '        }',
            '        this[dynamicHook]();',
            '        run();',
            '        innerHelper();',
            '        shadowed({});',
            '    }',
            '',
            '    applyState(childWidget) {',
            '        const me = this;',
            "        this.title = 'Next';",
            '        me.closable = true;',
            "        me.set({title: 'Batch', closable: false});",
            "        childWidget.set({collapsed: true});",
            '    }',
            '}',
            '',
            'export default DashboardPanel;'
        ].join('\n');

        const result = inspectSourceModule(source, 'src/DashboardPanel.mjs', {extractCalls: true});

        expect(result.ntype).toBe('dashboard-panel');
        expect(result.mixins).toEqual([
            {kind: 'literal', value: 'Neo.core.Observable', via: 'static-observable', line: 5},
            {kind: 'identifier', name: 'ResizeMixin', line: 10},
            {kind: 'literal', value: 'Neo.mixin.Focusable', line: 10}
        ]);
        expect(result.configs).toEqual([
            {name: 'title', declaredKey: 'title_', reactive: true, line: 11},
            {name: 'closable', declaredKey: 'closable', reactive: false, line: 12}
        ]);

        const afterSetTitle = result.methods.find(m => m.name === 'afterSetTitle');
        expect(afterSetTitle.hook).toEqual({kind: 'afterSet', configName: 'title'});

        const extractedCalls = afterSetTitle.calls.map(c => ({
            receiver: c.receiver,
            callee  : c.callee,
            computed: c.computed
        }));
        expect(extractedCalls).toEqual([
            {receiver: 'super', callee: 'afterSetTitle', computed: false},
            {receiver: 'this', callee: 'refreshHeader', computed: false},
            {receiver: 'me', callee: 'syncBadge', computed: false},
            {receiver: 'me', callee: 'notifyOuter', computed: false},
            {receiver: 'this', callee: '[dynamicHook]', computed: true}
        ]);

        const writes = result.configWrites.map(w => ({
            methodName: w.methodName,
            receiver  : w.receiver,
            name      : w.name,
            writeKind : w.writeKind
        }));
        expect(writes).toEqual([
            {methodName: 'applyState', receiver: 'this', name: 'title', writeKind: 'assignment'},
            {methodName: 'applyState', receiver: 'me', name: 'closable', writeKind: 'assignment'},
            {methodName: 'applyState', receiver: 'me', name: 'title', writeKind: 'set'},
            {methodName: 'applyState', receiver: 'me', name: 'closable', writeKind: 'set'},
            {methodName: 'applyState', receiver: 'external', name: 'collapsed', writeKind: 'set'}
        ]);
        expect(result.unindexedClasses).toEqual([]);
    });

    test('records secondary top-level classes, nested factory classes, and class expressions in unindexedClasses without altering primary class selection', () => {
        const multiClassSource = [
            'class DriveAbort extends Error {}',
            'const InlineElement = class extends HTMLElement {};',
            'class EventSimulator {',
            '    static config = {',
            "        className: 'Neo.main.addon.EventSimulator'",
            '    }',
            '}',
            'export default EventSimulator;'
        ].join('\n');

        const multiResult = inspectSourceModule(multiClassSource, 'src/main/addon/EventSimulator.mjs', {
            extractCalls: true
        });
        expect(multiResult.className).toBe('Neo.main.addon.EventSimulator');
        expect(multiResult.unindexedClasses).toEqual([
            {
                name         : 'DriveAbort',
                line         : 1,
                declaresSuper: true,
                superName    : 'Error',
                expression   : 'class DriveAbort extends Error',
                reason       : 'secondary-class-in-module'
            },
            {
                name         : null,
                line         : 2,
                declaresSuper: true,
                superName    : 'HTMLElement',
                expression   : 'class <anonymous> extends HTMLElement',
                reason       : 'class-expression'
            }
        ]);

        const factorySource = [
            "import FunctionalBase from './component/Base.mjs';",
            'export function defineComponent(spec) {',
            '    class FunctionalComponent extends FunctionalBase {}',
            '    return FunctionalComponent;',
            '}'
        ].join('\n');

        const factoryResult = inspectSourceModule(factorySource, 'src/functional/defineComponent.mjs', {
            extractCalls: true
        });
        expect(factoryResult.className).toBe('');
        expect(factoryResult.unindexedClasses).toEqual([
            {
                name         : 'FunctionalComponent',
                line         : 3,
                declaresSuper: true,
                superName    : 'FunctionalBase',
                expression   : 'class FunctionalComponent extends FunctionalBase',
                reason       : 'nested-class-declaration'
            }
        ]);
    });
});
