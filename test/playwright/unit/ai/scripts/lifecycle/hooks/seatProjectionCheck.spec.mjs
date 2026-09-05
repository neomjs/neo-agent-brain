import {setup} from '../../../../../setup.mjs';

const appName = 'SeatProjectionCheckTest';

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

import {test, expect}    from '@playwright/test';
import Neo               from 'neo.mjs/src/Neo.mjs';
import * as core         from 'neo.mjs/src/core/_export.mjs';
import {execFileSync}    from 'node:child_process';
import fs                from 'node:fs';
import os                from 'node:os';
import path              from 'node:path';
import {
    bindRuntimeRoot,
    isProjectorOwnedCommand
} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';
import {
    formatReport,
    resolveTargetRepoRoot
} from '../../../../../../../ai/scripts/lifecycle/hooks/seatProjectionCheck.mjs';

const REPO_ROOT = path.resolve(process.cwd());

let scratchDirs = [];

/**
 * @summary Creates a throwaway git checkout, since ownership and target-binding both consult git.
 * @returns {String} Absolute scratch repository root.
 */
function scratchRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-projection-check-'));

    scratchDirs.push(dir);
    execFileSync('git', ['init', '-q', '.'], {cwd: dir});
    execFileSync('git', ['config', 'user.email', 'unit@test.invalid'], {cwd: dir});
    execFileSync('git', ['config', 'user.name', 'unit'], {cwd: dir});

    return dir
}

test.afterEach(() => {
    scratchDirs.forEach(dir => fs.rmSync(dir, {force: true, recursive: true}));
    scratchDirs = []
});

test.describe('seatProjectionCheck — runtime-root binding', () => {
    test('substitutes the token into every command that carries it', () => {
        const bound = bindRuntimeRoot({
            events: {
                SessionStart: [{hooks: [
                    {type: 'command', command: 'node "<agentosRuntimeRoot>/ai/x.mjs"'},
                    {type: 'command', command: 'node "$(git rev-parse --show-toplevel)/.claude/hooks/y.mjs"'}
                ]}]
            }
        }, '/opt/brain');

        const commands = bound.events.SessionStart[0].hooks.map(entry => entry.command);

        expect(commands[0]).toBe('node "/opt/brain/ai/x.mjs"');
        // The projected sibling is untouched: it resolves against the TARGET root at run time, and
        // rewriting it would bind it to the wrong repository.
        expect(commands[1]).toBe('node "$(git rev-parse --show-toplevel)/.claude/hooks/y.mjs"')
    });

    test('the bound path is SHELL-LITERAL, not shell source', () => {
        // @neo-gpt-emmy bound the real manifest with this runtime root and the probe received
        // `/tmp/neoPROBE/...` — the declared executable was not the executed one. Double quotes do
        // not stop command substitution; single quotes do.
        const bound = bindRuntimeRoot({
            events: {SessionStart: [{hooks: [
                {type: 'command', command: `/usr/bin/env node '<agentosRuntimeRoot>/ai/x.mjs'`}
            ]}]}
        }, '/tmp/neo$(printf PROBE)').events.SessionStart[0].hooks[0].command;

        expect(bound).toBe(`/usr/bin/env node '/tmp/neo$(printf PROBE)/ai/x.mjs'`);
    });

    test('a single quote inside the runtime root cannot escape its own quoting', () => {
        // The escape the fix depends on. Without `'\\''` the substituted value would close the
        // quoting the manifest opened and everything after it would become shell source.
        const bound = bindRuntimeRoot({
            events: {Stop: [{hooks: [{type: 'command', command: `node '<agentosRuntimeRoot>/a.mjs'`}]}]}
        }, `/tmp/it's`).events.Stop[0].hooks[0].command;

        expect(bound).toBe(`node '/tmp/it'\\''s/a.mjs'`);
    });

    test('a manifest without the token comes back unchanged', () => {
        const manifest = {events: {Stop: [{hooks: [{type: 'command', command: 'node "./a.mjs"'}]}]}};

        expect(bindRuntimeRoot(manifest, '/opt/brain')).toEqual(manifest)
    });

    test('a manifest with no events is returned as-is rather than throwing', () => {
        expect(bindRuntimeRoot({}, '/opt/brain')).toEqual({});
        expect(bindRuntimeRoot(null, '/opt/brain')).toBe(null)
    })
});

test.describe('seatProjectionCheck — ownership, the idempotence key', () => {
    // The failure this pins is silent and cumulative rather than loud. A runtime-resident command
    // lives in no target directory, so the path-matching arm cannot see it; unrecognized, it
    // survives the retire pass and every re-projection APPENDS another copy, leaving the seat
    // running the same check N times. Nothing errors, so only this assertion catches it.
    test('a runtime-resident command is recognized as projector-owned', () => {
        const target = scratchRepo();

        expect(isProjectorOwnedCommand(
            'node "/opt/brain/ai/scripts/lifecycle/hooks/seatProjectionCheck.mjs"', target
        )).toBe(true)
    });

    test('an OPERATOR command that merely NAMES the checker is not ours', () => {
        const target = scratchRepo();

        // @neo-gpt-emmy executed exactly this against the first version and it was classified as
        // ours and RETIRED. It invokes `/opt/company/audit.mjs`; our name is an argument. Deleting a
        // foreign hook is the custody violation the tracked test protects the Engine from, and it is
        // worse here because nothing in the target marks the entry as somebody else's.
        expect(isProjectorOwnedCommand(
            'node "/opt/company/audit.mjs" --watch seatProjectionCheck.mjs', target
        )).toBe(false);
    });

    test('the checker named as an option VALUE rather than the executable is not ours either', () => {
        const target = scratchRepo();

        // One step beyond the reported case: here the FULL path appears, but as a `--config` value.
        // A predicate keyed on the path alone would claim it; executable position is what decides.
        expect(isProjectorOwnedCommand(
            'node /opt/x.mjs --config /opt/brain/ai/scripts/lifecycle/hooks/seatProjectionCheck.mjs', target
        )).toBe(false);
    });

    test('the canonical entry is recognized in either quoting style', () => {
        const target = scratchRepo();

        // The positive control both negatives need: rejecting foreign commands must not stop us
        // retiring our own, or every re-projection appends a duplicate.
        expect(isProjectorOwnedCommand(
            `node "/opt/brain/${'ai/scripts/lifecycle/hooks'}/seatProjectionCheck.mjs"`, target
        )).toBe(true);
        expect(isProjectorOwnedCommand(
            `/usr/bin/env node '/opt/brain/ai/scripts/lifecycle/hooks/seatProjectionCheck.mjs'`, target
        )).toBe(true);
    });

    test('an unrelated runtime-root script is NOT claimed', () => {
        const target = scratchRepo();

        // The census is closed on purpose: a predicate keyed on the runtime-root directory instead
        // of the name would claim every Agent OS script a seat's settings happened to mention.
        expect(isProjectorOwnedCommand(
            'node "/opt/brain/ai/scripts/lifecycle/checkSunsetted.mjs"', target
        )).toBe(false)
    });

    test('a TRACKED hook in an owned directory stays somebody else\'s', () => {
        const
            target  = scratchRepo(),
            relPath = '.claude/hooks/rgReplaceGuardHook.mjs';

        fs.mkdirSync(path.join(target, '.claude/hooks'), {recursive: true});
        fs.writeFileSync(path.join(target, relPath), '// engine-owned\n');
        execFileSync('git', ['add', relPath], {cwd: target});
        execFileSync('git', ['commit', '-qm', 'engine guard'], {cwd: target});

        // Committing it is the whole point of this arm, and the reason it is spelled out: an
        // uncommitted fixture reports the guard as ours and retires the Engine's entry, so the
        // fixture passes while testing the opposite of the contract.
        expect(isProjectorOwnedCommand(
            `node "$(git rev-parse --show-toplevel)/${relPath}"`, target
        )).toBe(false)
    })
});

test.describe('seatProjectionCheck — target binding', () => {
    test('binds a git checkout named by the payload', () => {
        const target = scratchRepo();

        expect(resolveTargetRepoRoot({cwd: target})).toBe(path.resolve(target))
    });

    test('refuses to guess when the payload names nothing', () => {
        // ADR 0040 §2.5 forbids a `process.cwd()` fallback for either root. A cwd default is the
        // convenience that survives every review until the hook runs from somewhere else and
        // silently audits the wrong tree.
        expect(resolveTargetRepoRoot({})).toBe(null);
        expect(resolveTargetRepoRoot({cwd: ''})).toBe(null);
        expect(resolveTargetRepoRoot(null)).toBe(null)
    });

    test('refuses a directory that is not a checkout', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-projection-check-plain-'));

        scratchDirs.push(dir);
        expect(resolveTargetRepoRoot({cwd: dir})).toBe(null)
    })
});

test.describe('seatProjectionCheck — what the agent reads', () => {
    test('a current seat says nothing at all', () => {
        expect(formatReport({ok: true}, '/seat')).toBe(null)
    });

    test('ABSENT and STALE are reported as different failures', () => {
        const context = formatReport({
            missing: ['.claude/hooks/laneStateStopHook.mjs'],
            ok     : false,
            stale  : ['.claude/hooks/turnPresenceHook.mjs']
        }, '/seat');

        // One word for both would lose the distinction that decides urgency: a stale hook runs and
        // enforces an OLDER contract, an absent one enforces nothing and the seat has no gate.
        expect(context).toContain('ABSENT (1)');
        expect(context).toContain('laneStateStopHook.mjs');
        expect(context).toContain('STALE (1)');
        expect(context).toContain('turnPresenceHook.mjs');
        expect(context.indexOf('ABSENT')).toBeLessThan(context.indexOf('STALE'))
    });

    test('the repair line always travels with its escalation target', () => {
        const context = formatReport({missing: ['.claude/hooks/x.mjs'], ok: false}, '/seat');

        // A seat whose harness refuses the write would otherwise be handed an instruction it cannot
        // follow, once per session, until it learns to ignore the warning — the reported-but-unread
        // failure this hook exists to end, one layer up.
        expect(context).toContain('projectSeatHooks.mjs');
        // Single-quoted since the RA-2 repair: this line is meant to be pasted into a shell, and a
        // double-quoted path containing `$(…)` would execute rather than resolve. A repair
        // instruction that runs something other than what it displays is worse than none.
        expect(context).toContain(`--target-root='/seat'`);
        expect(context).toContain('operator action, not a retry')
    });

    test('a repair line for a shell-hostile path stays inert when pasted', () => {
        const context = formatReport({missing: ['.claude/hooks/x.mjs'], ok: false}, '/seat/$(printf PWNED)');

        // The emitted instruction must carry the path as data. Asserting the quoted form rather than
        // "does not contain PWNED" — the substitution would not have run here anyway, so only the
        // quoting is evidence.
        expect(context).toContain(`--target-root='/seat/$(printf PWNED)'`)
    })
});
