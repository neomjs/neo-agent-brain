import {expect, test}      from '@playwright/test';
import fs                  from 'node:fs/promises';
import os                  from 'node:os';
import path                from 'node:path';
import {PassThrough}       from 'node:stream';
import {answerQuestions}   from '../../../../../../ai/scripts/setup/firstRun.mjs';
import {RECIPE_VERSION, evaluateRecipe} from '../../../../../../ai/services/fleet/firstRunRecipe.mjs';
import {createHost}        from '../../../../../../ai/services/fleet/hostEffects.mjs';
import {presets}           from '../../../../../../ai/services/fleet/placementPresets.mjs';
import {createSetupRecord} from '../../../../../../ai/services/fleet/setupRunRecord.mjs';

// The CLI's interactive pass in-process: the real recipe and presets over a prompt stream, the record under
// a temp root. Its sibling spec drives the CLI as a child process, which is never a TTY and never prompts.

const
    RUN_ID = '0f1e2d3c-4b5a-4968-8777-6655443322aa',
    target = {planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'};

/** One prompted pass: the next line is typed only once a prompt asked for it. */
async function session({setupRoot, id, lines}) {
    const
        queue  = [...lines],
        input  = new PassThrough(),
        output = new PassThrough(),
        seen   = [];

    output.on('data', chunk => {
        const text = String(chunk);

        seen.push(text);
        if (text.endsWith(': ')) {
            input.write(`${queue.shift() ?? ''}\n`);
        }
    });

    const record = await answerQuestions({
        evaluate   : candidate => evaluateRecipe({target, record: candidate, observers: {}, presets}),
        answers    : {},
        record     : createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION}),
        recordPath : path.join(setupRoot, `${id}.json`),
        host       : createHost(),
        io         : {input, output},
        interactive: true,
        stderr     : {write: () => true}
    });

    return {
        asked   : ['preset (', 'plane credential file path', 'the provider key file'].filter(prefix => seen.join('').includes(prefix)),
        consents: record.consents.map(consent => consent.stepId)
    };
}

test.describe('firstRun answerQuestions (interactive)', () => {
    test('each question is decided after the previous answer: a local preset never asks for a provider key, a hosted one does (review round 1, RA-2)', async () => {
        const
            root      = await fs.mkdtemp(path.join(os.tmpdir(), 'first-run-prompts-')),
            setupRoot = path.join(root, 'setup'),
            patPath   = path.join(root, 'plane-pat'),
            keyPath   = path.join(root, 'gemini-key');

        await fs.mkdir(setupRoot, {recursive: true});
        await fs.writeFile(patPath, 'ghp_FAKEPAT0123456789abcdefghijklmnopqrstuv\n', {mode: 0o600});
        await fs.writeFile(keyPath, 'AIzaFAKEKEY\n', {mode: 0o600});

        expect(await session({setupRoot, id: 'local', lines: ['local-small', patPath]})).toEqual({
            asked   : ['preset (', 'plane credential file path'],
            consents: ['preset', 'plane-credential']
        });
        expect(await session({setupRoot, id: 'hosted', lines: ['hosted', patPath, keyPath]})).toEqual({
            asked   : ['preset (', 'plane credential file path', 'the provider key file'],
            consents: ['preset', 'plane-credential', 'provider-key']
        });
    });
});
