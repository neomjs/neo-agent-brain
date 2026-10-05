import {test, expect} from '@playwright/test';
import path           from 'node:path';
import {readSeatModelCatalog, unofferedDeclaration} from '../../../../../../ai/services/fleet/seatModelCatalog.mjs';

// The help text claude CLI 2.1.212 printed for `--effort` on 2026-10-04, the part this read depends on.
const CLAUDE_HELP = [
    '  --effort <level>                      Effort level for the current session',
    '                                        (low, medium, high, xhigh, max)',
    '  --model <model>                       Model for the current session.'
].join('\n');

/**
 * @summary A lifecycle stand-in: the binaries it would resolve, and a login check that records the homes it was
 * asked about.
 */
function makeLifecycle({loggedIn = true} = {}) {
    const homes = [];

    return {
        homes,
        authRequiredForHome : (harnessType, home) => { homes.push(home); return !loggedIn },
        getHarnessBinaryPath: harnessType => `/bin/${harnessType}`
    }
}

test.describe('seatModelCatalog — what a seat\'s harness offers to declare', () => {
    test('a Codex seat asks its own app-server, in its own logged-in home, with the bundled CLI', async () => {
        const
            lifecycle = makeLifecycle(),
            asked     = [],
            catalog   = await readSeatModelCatalog({
                agent       : {id: 'sophie', harnessType: 'codex-desktop'},
                instanceRoot: '/agents',
                lifecycleService: lifecycle,
                readCodex   : options => { asked.push(options); return {state: 'complete', models: [], reason: null} }
            });

        expect(catalog.state).toBe('complete');
        expect(asked).toEqual([{binaryPath: '/bin/codex', codexHome: path.join('/agents', 'sophie', 'harness', 'codex-desktop', 'codex-home')}]);
        expect(lifecycle.homes).toEqual([asked[0].codexHome]);
    });

    test('a Codex home without a login answers its state, never the bundled catalog', async () => {
        let read = false;

        const catalog = await readSeatModelCatalog({
            agent           : {id: 'emmy', harnessType: 'codex'},
            instanceRoot    : '/agents',
            lifecycleService: makeLifecycle({loggedIn: false}),
            readCodex       : () => { read = true }
        });

        expect(catalog).toEqual({state: 'unavailable', models: [], reason: 'the seat has no Codex login yet; its catalog is read once it has one'});
        expect(read, 'no app-server started').toBe(false);
    });

    test('claude-code offers the effort levels its own --help names, and any model id it accepts', async () => {
        const read = runHelp => readSeatModelCatalog({agent: {id: 'cli', harnessType: 'claude-code'}, instanceRoot: '/agents', lifecycleService: makeLifecycle(), runHelp});

        expect(await read(async binary => binary === '/bin/claude-code' ? CLAUDE_HELP : '')).toEqual({
            state: 'complete', models: [], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], reason: null
        });
        expect((await read(async () => 'no effort here')).state, 'help that names no levels').toBe('unavailable');
        expect((await read(async () => { throw new Error('not found') })).reason).toBe('the CLI did not answer --help: not found');
    });

    test('a family Fleet does not configure this way takes no declaration', async () => {
        expect(await readSeatModelCatalog({agent: {id: 'ada', harnessType: 'claude-desktop'}, instanceRoot: '/agents', lifecycleService: makeLifecycle()}))
            .toEqual({state: 'unsupported', models: [], reason: "a 'claude-desktop' seat takes no declared model or reasoning effort"});
    });

    test('only a complete catalog refuses, and only what it lacks: the model, or that model\'s effort', () => {
        const
            complete = {state: 'complete', models: [{id: 'gpt-6-luna', slug: 'gpt-6-luna', efforts: ['low', 'max']}]},
            refusal  = seat => unofferedDeclaration(complete, seat);

        expect(refusal({model: 'gpt-6-astra'})).toBe('model gpt-6-astra is not available');
        expect(refusal({model: 'gpt-6-luna', reasoningEffort: 'ultra'})).toBe('reasoning effort ultra is not available for model gpt-6-luna');
        expect(refusal({model: 'gpt-6-luna', reasoningEffort: 'max'})).toBeNull();
        expect(refusal({reasoningEffort: 'ultra'}), 'an effort alone: the harness picks the model').toBeNull();
        expect(unofferedDeclaration({...complete, state: 'partial'}, {model: 'gpt-6-astra'}), 'a partial read proves no absence').toBeNull();
        expect(unofferedDeclaration(null, {model: 'gpt-6-astra'})).toBeNull();

        // a CLI that names its levels and takes any model id: only the effort can be missing
        const levels = {state: 'complete', models: [], efforts: ['low', 'max']};

        expect(unofferedDeclaration(levels, {model: 'anything', reasoningEffort: 'ultra'})).toBe('reasoning effort ultra is not available');
        expect(unofferedDeclaration(levels, {model: 'anything', reasoningEffort: 'max'})).toBeNull();
    });
});
