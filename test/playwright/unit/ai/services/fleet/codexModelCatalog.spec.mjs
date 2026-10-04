import {test, expect} from '@playwright/test';
import {spawn}        from 'node:child_process';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {readCodexModelCatalog} from '../../../../../../ai/services/fleet/codexModelCatalog.mjs';

// A stand-in app-server speaking the protocol codex-cli 0.160.0 answered on 2026-10-04: one JSON message per line,
// `initialize`, the `initialized` notification, then `model/list` pages. Its scenario argument picks the answers.
const FAKE_SERVER = `
const scenario = process.argv[2], model = (id, extra = {}) => ({id, supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'max'}], defaultReasoningEffort: 'low', hidden: false, isDefault: false, ...extra});
let buffer = '', pages = 0;
const reply = message => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (scenario === 'silent') continue;
        if (scenario === 'garbage') { process.stdout.write('not json\\n'); continue }
        if (message.method === 'initialize') { reply({id: message.id, result: {codexHome: process.env.CODEX_HOME}}); continue }
        if (message.method !== 'model/list') continue;
        if (message.params.includeHidden !== true) { reply({id: message.id, error: {message: 'hidden entries were not asked for'}}); continue }
        pages++;
        if (scenario === 'refuse') reply({id: message.id, error: {message: 'not signed in'}});
        else if (scenario === 'second-page-fails' && pages === 2) reply({id: message.id, error: {message: 'rate limited'}});
        else if (scenario === 'endless') reply({id: message.id, result: {data: [model('m' + pages)], nextCursor: 'c' + pages}});
        else if (message.params.cursor === null) reply({id: message.id, result: {data: [model('home:' + process.env.CODEX_HOME, {isDefault: true})], nextCursor: 'c1'}});
        else reply({id: message.id, result: {data: [model('gpt-hidden', {hidden: true, defaultReasoningEffort: 'max'})], nextCursor: null}});
    }
});
`;

test.describe('codexModelCatalog — a Codex seat\'s catalog through its own app-server', () => {
    let fakePath;

    test.beforeAll(() => {
        fakePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-')), 'fake-app-server.cjs');
        fs.writeFileSync(fakePath, FAKE_SERVER)
    });

    const read = (scenario, extra = {}) => readCodexModelCatalog({
        binaryPath: '/opt/codex',
        codexHome : '/agents/sophie/codex-home',
        spawnFn   : (binary, args, options) => {
            expect([binary, args]).toEqual(['/opt/codex', ['app-server']]);
            return spawn(process.execPath, [fakePath, scenario], options)
        },
        ...extra
    });

    test('every page is followed, hidden entries included and flagged, in the seat\'s own home', async () => {
        const catalog = await read('pages');

        expect(catalog.state).toBe('complete');
        expect(catalog.models).toEqual([
            {id: 'home:/agents/sophie/codex-home', slug: 'home:/agents/sophie/codex-home', efforts: ['low', 'max'], defaultEffort: 'low', hidden: false, isDefault: true},
            {id: 'gpt-hidden',                     slug: 'gpt-hidden',                     efforts: ['low', 'max'], defaultEffort: 'max', hidden: true,  isDefault: false}
        ]);
    });

    test('a refused, broken or silent read answers its state and reason, never an empty catalog', async () => {
        expect(await read('refuse')).toEqual({state: 'unavailable', models: [], reason: "the app-server refused 'model/list': not signed in"});
        expect(await read('garbage')).toEqual({state: 'unavailable', models: [], reason: 'the app-server answered a line that is not JSON'});
        expect(await read('silent', {timeoutMs: 300})).toEqual({state: 'unavailable', models: [], reason: 'the catalog read took longer than 300 ms'});
        expect((await readCodexModelCatalog({binaryPath: '/no/such/codex', codexHome: '/tmp'})).state, 'a binary that is not there').toBe('unavailable');
    });

    test('pages read before a failure stay, as a partial catalog that proves no model missing', async () => {
        const catalog = await read('second-page-fails');

        expect(catalog.state).toBe('partial');
        expect(catalog.models.map(model => model.id)).toEqual(['home:/agents/sophie/codex-home']);
        expect(catalog.reason).toBe("the app-server refused 'model/list': rate limited");
        expect((await read('endless')).reason, 'a cursor that never ends cannot hold Start').toBe('the catalog did not end within 20 pages');
    });
});
