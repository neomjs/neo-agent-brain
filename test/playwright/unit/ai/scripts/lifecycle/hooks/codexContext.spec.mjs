import {setup} from '../../../../../setup.mjs';

const appName = 'CodexContextProjectionTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}     from '@playwright/test';
import {spawnSync}        from 'node:child_process';
import fs                 from 'node:fs';
import os                 from 'node:os';
import path               from 'node:path';
import Neo                from 'neo.mjs/src/Neo.mjs';
import * as core          from 'neo.mjs/src/core/_export.mjs';
import {renderProjection} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';

const
    REPO_ROOT   = path.resolve(process.cwd()),
    HOOK_SOURCE = path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/codex/codex-context.mjs');

let scratchDirs = [];

/**
 * @summary Materializes the projected hook into a seat and returns the seat root.
 *
 * Rendered through the real {@link renderProjection}, because the property under test only exists in
 * the projected artifact: the source lives beside the Engine's `.codex/CODEX.md` and can never
 * observe its absence. Testing the source would cover a shape no seat runs.
 * @param {Object} [options]
 * @param {String|null} [options.context=null] Content for `.codex/CODEX.md`; `null` writes no file.
 * @param {Boolean} [options.contextIsDirectory=false] Put a directory where the file belongs.
 * @returns {String} Absolute seat root.
 */
function seatWith({context = null, contextIsDirectory = false} = {}) {
    const seat = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-seat-')));

    scratchDirs.push(seat);

    fs.mkdirSync(path.join(seat, '.codex/hooks'), {recursive: true});
    fs.writeFileSync(
        path.join(seat, '.codex/hooks/codex-context.mjs'),
        renderProjection(HOOK_SOURCE, REPO_ROOT).contents, 'utf8'
    );

    if (contextIsDirectory) {
        fs.mkdirSync(path.join(seat, '.codex/CODEX.md'))
    } else if (context !== null) {
        fs.writeFileSync(path.join(seat, '.codex/CODEX.md'), context, 'utf8')
    }

    return seat
}

/**
 * @summary Runs the projected hook as a real process with an empty payload on stdin.
 * @param {String} seat
 * @returns {{code: Number, stdout: String, stderr: String}}
 */
function run(seat) {
    const result = spawnSync(process.execPath, [path.join(seat, '.codex/hooks/codex-context.mjs')], {
        cwd     : seat,
        encoding: 'utf8',
        input   : '{}'
    });

    return {code: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? ''}
}

test.afterAll(() => {
    scratchDirs.forEach(dir => fs.rmSync(dir, {force: true, recursive: true}));
    scratchDirs = []
});

/**
 * `.codex/CODEX.md` is the TARGET's file — tracked in the Engine, never in this repository — so
 * `projectSeatHooks` deliberately does not place it and a seat that authors none is a legitimate
 * shape. Before #250 that could not matter: the hook only ran from inside the Engine, where the file
 * always exists. Projecting it into arbitrary checkouts turned a guaranteed read into an optional
 * one, and an unguarded `readFileSync` made the optional case fatal.
 *
 * Disposition by @neo-gpt-emmy: fail soft on ENOENT, preserve every other read error.
 */
test.describe('codex-context — a projected seat without a context file', () => {
    test('exits 0 and writes no context when the target authors none', () => {
        // The regression itself: this exited 1 on an unhandled ENOENT, so every UserPromptSubmit in
        // a contextless seat failed. A hook whose entire job is optional enrichment must not be able
        // to take down the turn that invoked it.
        const {code, stdout, stderr} = run(seatWith());

        expect(code, `contextless seat did not exit cleanly:\n${stderr}`).toBe(0);
        expect(stdout).toBe('')
    });

    test('POSITIVE CONTROL: the same seat WITH a context file emits it', () => {
        // Without this, the arm above passes just as well against a hook that never emits anything —
        // "no output" would be indistinguishable from "silently broken".
        const {code, stdout} = run(seatWith({context: 'CONTEXT-PAYLOAD-PRESENT\n'}));

        expect(code).toBe(0);
        expect(stdout).toContain('CONTEXT-PAYLOAD-PRESENT')
    });

    test('a non-ENOENT read failure still throws', () => {
        // The discrimination the disposition requires. A directory where the file belongs yields
        // EISDIR, which describes a BROKEN seat rather than an unconfigured one. Catching every error
        // would convert that into a silent empty context — the same silent-success shape #250 exists
        // to remove, reintroduced by the fix for it.
        const {code, stderr} = run(seatWith({contextIsDirectory: true}));

        expect(code, 'EISDIR was swallowed — the catch is too wide').not.toBe(0);
        expect(stderr).toMatch(/EISDIR|illegal operation on a directory/)
    })
});
