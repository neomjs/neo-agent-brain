import {setup} from '../../../../../setup.mjs';

const appName = 'SeatProvenanceTest';

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

import {test, expect}         from '@playwright/test';
import Neo                    from 'neo.mjs/src/Neo.mjs';
import * as core              from 'neo.mjs/src/core/_export.mjs';
import {execFileSync}         from 'node:child_process';
import fs                     from 'node:fs';
import os                     from 'node:os';
import path                   from 'node:path';
import {readRuntimeProvenance} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';
import {formatReport, formatRuntimeRootWarning, recordTrace} from '../../../../../../../ai/scripts/lifecycle/hooks/seatProjectionCheck.mjs';
import {
    checkProjection,
    PROVENANCE_RECEIPT,
    PROVENANCE_TRACE,
    projectHooks
} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';

let scratchDirs = [];

/**
 * @summary Builds a runtime root whose HEAD is deliberately off upstream.
 *
 * `origin/dev` is written as a real remote-tracking ref rather than mocked, because the property under
 * test is what `git merge-base --is-ancestor` answers — substituting a fake would test the substitute.
 * @param {Boolean} parked `true` leaves HEAD on a commit upstream does not contain.
 * @returns {{dir: String, upstreamCommit: String, headCommit: String}}
 */
function runtimeRoot({parked}) {
    const
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-provenance-')),
        git = (...args) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'}).trim();

    scratchDirs.push(dir);

    git('init', '-q', '-b', 'dev', '.');
    git('config', 'user.email', 'unit@test.invalid');
    git('config', 'user.name', 'unit');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'upstream\n');
    git('add', '.');
    git('commit', '-qm', 'upstream commit');

    const upstreamCommit = git('rev-parse', 'HEAD');

    // The remote-tracking ref a real clone would have. Written by hand because the test owns no server.
    git('update-ref', 'refs/remotes/origin/dev', upstreamCommit);

    if (parked) {
        git('checkout', '-q', '-b', 'feature/unmerged');
        fs.writeFileSync(path.join(dir, 'b.txt'), 'in review\n');
        git('add', '.');
        git('commit', '-qm', 'unmerged work');
    }

    return {dir, headCommit: git('rev-parse', 'HEAD'), upstreamCommit}
}

test.afterEach(() => {
    scratchDirs.forEach(dir => fs.rmSync(dir, {force: true, recursive: true}));
    scratchDirs = []
});

/**
 * @summary A projection records which revision produced it, and a revision upstream never saw is reported.
 *
 * The currency check compares seat bytes to what the runtime root renders NOW. That is silent about a
 * root parked on an unmerged branch: the projection is perfectly current and carries code no review has
 * seen, and every downstream check agrees because they all read the same root. Measured 2026-09-05 — a
 * shared checkout sat on an unmerged feature branch for ~12h and nothing asked.
 *
 * Provenance is the second operand, and its remedy is the OPPOSITE of currency's: a stale seat
 * re-projects, a wrong-provenance seat must not, because re-projecting is what installed the problem.
 */
test.describe('seat projection provenance', () => {
    test('a root parked off upstream reports its HEAD as not-contained — and the same root on upstream does not', async () => {
        const parked = runtimeRoot({parked: true});

        const parkedProvenance = readRuntimeProvenance(parked.dir);

        expect(parkedProvenance.commit, 'the receipt operand exists').toBe(parked.headCommit);
        expect(parkedProvenance.ref, 'and names the ref, not the bare word HEAD').toBe('refs/heads/feature/unmerged');
        expect(parkedProvenance.ancestorOfUpstream, 'upstream does not contain it').toBe(false);

        // The control, and it is the reason this arm means anything: the identical probe on a root that
        // IS on upstream must answer differently. Without it, `false` could be what the probe always
        // returns — a verdict true of the case under test and true of everything else.
        const clean = runtimeRoot({parked: false});

        expect(readRuntimeProvenance(clean.dir).ancestorOfUpstream, 'a root on upstream is contained').toBe(true)
    });

    test('an unresolvable upstream is UNKNOWN, never a failure', async () => {
        const {dir} = runtimeRoot({parked: true});

        execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/dev'], {cwd: dir});

        expect(readRuntimeProvenance(dir).ancestorOfUpstream, 'no upstream ⇒ not asked').toBe(null);

        // A probe that cannot run must not red. Otherwise every offline seat reports a provenance
        // failure, which is a worse defect than the one this closes.
        expect(readRuntimeProvenance(dir, 'origin/does-not-exist').ancestorOfUpstream).toBe(null)
    });

    test('the provenance report refuses to prescribe the repair that caused it', async () => {
        const context = formatReport({
            ok        : false,
            provenance: {commit: 'deadbeefcafe', ref: 'refs/heads/feature/unmerged', upstream: 'origin/dev'}
        }, '/tmp/some-seat');

        expect(context, 'it names the wrong-provenance verdict, not staleness').toContain('WRONG PROVENANCE');
        expect(context, 'and says what must not happen').toContain('DO NOT RE-PROJECT');
        expect(context, 'and names the commit upstream does not contain').toContain('deadbeefcafe');

        // The load-bearing negative: the repair command is what installed the unreviewed code. A report
        // that still offers it turns the warning into the attack.
        expect(context, 'the repair command is absent').not.toContain('projectSeatHooks.mjs');
        expect(context, 'and so is its flag surface').not.toContain('--runtime-root=');
    });

    test('an ordinary stale report still carries its repair command', async () => {
        // The other half of the pair. Suppressing the repair line everywhere would "fix" the test above
        // while breaking the case the hook was built for.
        const context = formatReport({ok: false, stale: ['.claude/hooks/x.mjs']}, '/tmp/some-seat');

        expect(context, 'staleness is still reported as staleness').toContain('SEAT PROJECTION IS NOT CURRENT');
        expect(context, 'and still tells the seat how to repair').toContain('projectSeatHooks.mjs')
    });

    test('the hook reports on ITSELF when its own root is off upstream, and audits nothing', async () => {
        // AC-4: the checker audited a property it did not hold. Every seat verdict is measured against
        // the runtime root, so a root off upstream makes "your seat does not match this root" a
        // comparison with unreviewed code — and the repair line would copy it into the seat.
        const context = formatRuntimeRootWarning({
            commit  : 'feedfacedead',
            ref     : 'refs/heads/agent/317-seat-projection-check',
            upstream: 'origin/dev'
        });

        expect(context, 'the subject is the ROOT, not the seat').toContain('RUNTIME ROOT ITSELF IS OFF UPSTREAM');
        expect(context, 'and it names the revision').toContain('feedfacedead');
        expect(context, 'and refuses the repair').toContain('DO NOT RE-PROJECT');

        // The distinction that matters to a reader: this is NOT a seat verdict. Saying the seat is
        // stale here would rank a finding derived from the very authority this message disputes.
        expect(context, 'it does not claim the seat is stale').not.toContain('SEAT PROJECTION IS NOT CURRENT');
        expect(context, 'and offers no repair command').not.toContain('projectSeatHooks.mjs');

        // And the honest half: absence of a warning would not have meant a healthy seat.
        expect(context, 'it says the seat was not audited at all').toContain('NOT audited')
    });
    test('a non-green verdict leaves a durable line, and a green one leaves the seat untouched', async () => {
        // AC-5. Measured on a live seat this morning: the hook had ONE output path — a string into the
        // agent's transcript — and exited 0 either way, so an unacted-on warning was unrecoverable
        // afterwards by any operator, peer, or later session.
        const
            {dir} = runtimeRoot({parked: false}),
            trace = path.join(dir, PROVENANCE_TRACE);

        expect(recordTrace(dir, 'x SEAT PROJECTION IS NOT CURRENT — first line\nremediation prose'), 'a verdict is recorded').toBe(true);

        const written = fs.readFileSync(trace, 'utf8');

        expect(written, 'the headline survives').toContain('SEAT PROJECTION IS NOT CURRENT');
        expect(written, 'the remediation prose does not bury it').not.toContain('remediation prose');
        expect(written.trimEnd().split('\n'), 'one line per verdict').toHaveLength(1);

        // The half that keeps it from becoming noise: a healthy seat must stay byte-identical between
        // sessions, or a reader learns to skip the file — the reported-but-unread failure one layer up.
        expect(recordTrace(dir, null), 'a green verdict records nothing').toBe(false);
        expect(fs.readFileSync(trace, 'utf8'), 'and appends nothing').toBe(written);
    });

    test('an unwritable trace never disturbs the boot', async () => {
        // The hook must never block a session. A trace it cannot write is a worse reason to fail a boot
        // than the condition it was recording, and the transcript line is emitted regardless.
        expect(recordTrace('/proc/definitely-not-writable-by-this-test', 'x verdict'), 'it reports failure').toBe(false)
    });
    test('INTEGRATION: a seat projected from a parked root is byte-CURRENT and provenance-WRONG', async () => {
        // AC-3, and the control is the whole point. `stale`/`missing` empty is not incidental — it is
        // the proof that a currency-only check PASSES this seat. Without that assertion the arm would
        // show provenance firing and say nothing about the gap it exists to close.
        const
            runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-provenance-rt-')),
            seat    = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-provenance-seat-')),
            rtGit   = (...args) => execFileSync('git', args, {cwd: runtime, encoding: 'utf8'}).trim();

        scratchDirs.push(runtime, seat);

        // A REAL runtime root: the actual hook sources, so `assertRuntimeRoot` and the enumerators see
        // what they see in production. A hand-built stub would test the stub.
        fs.cpSync(
            path.join(process.cwd(), 'ai/scripts/lifecycle/hooks'),
            path.join(runtime, 'ai/scripts/lifecycle/hooks'),
            {recursive: true}
        );

        rtGit('init', '-q', '-b', 'dev', '.');
        rtGit('config', 'user.email', 'unit@test.invalid');
        rtGit('config', 'user.name', 'unit');
        rtGit('add', '.');
        rtGit('commit', '-qm', 'hooks on dev');
        rtGit('update-ref', 'refs/remotes/origin/dev', rtGit('rev-parse', 'HEAD'));

        // The incident: the shared root is parked on someone's unmerged branch. No hook BYTES change —
        // an empty commit — so the projection this produces is byte-identical to the upstream one.
        rtGit('checkout', '-q', '-b', 'feature/unmerged');
        rtGit('commit', '-q', '--allow-empty', '-m', 'unmerged work, no hook changes');

        const parkedCommit = rtGit('rev-parse', 'HEAD');

        execFileSync('git', ['init', '-q', '-b', 'dev', '.'], {cwd: seat});

        // The Engine hydrates this; the projector reconciles into it and refuses to write hooks it
        // could not wire. A seat without it is a different failure than the one under test.
        fs.mkdirSync(path.join(seat, '.claude'), {recursive: true});
        fs.writeFileSync(path.join(seat, '.claude/settings.json'), '{}\n', 'utf8');

        projectHooks({agentosRuntimeRoot: runtime, targetRepoRoot: seat});
        // Twice on purpose. The first run reconciles `.claude/settings.json` from `{}`, which leaves
        // `unreconciledEvents` non-empty and would make `ok: false` true for a reason that has nothing
        // to do with provenance — an assertion passing for the wrong cause.
        projectHooks({agentosRuntimeRoot: runtime, targetRepoRoot: seat});

        const receipt = JSON.parse(fs.readFileSync(path.join(seat, PROVENANCE_RECEIPT), 'utf8'));

        expect(receipt.commit, 'the receipt records the parked revision').toBe(parkedCommit);
        expect(receipt.ancestorOfUpstreamAtProjection, 'and knew it was off upstream when it wrote').toBe(false);

        const report = checkProjection({agentosRuntimeRoot: runtime, targetRepoRoot: seat});

        // THE CONTROL: currency is clean. Every byte the seat holds matches what this root renders.
        expect(report.stale,   'no stale files — a currency-only check passes this seat').toEqual([]);
        expect(report.missing, 'and nothing is missing').toEqual([]);

        // Every other axis empty, so `ok: false` below is attributable to provenance and nothing else.
        // Asserted individually rather than trusted: a single contaminated field would otherwise let
        // the verdict pass while provenance did no work at all.
        expect(report.orphans,           'no orphans').toEqual([]);
        expect(report.unplacedCommands,  'no unplaced commands').toEqual([]);
        expect(report.unreconciledEvents,'settings reconciled').toEqual([]);
        expect(report.trackedConflicts,  'no tracked conflicts').toEqual([]);
        expect(report.escapedSpecifiers, 'no escaped specifiers').toEqual([]);

        // THE PROPERTY: and it is still wrong, for a reason currency cannot express.
        expect(report.provenance, 'provenance reports the parked commit').toMatchObject({commit: parkedCommit});
        expect(report.ok, 'so the seat is NOT ok — and provenance is the only field saying so').toBe(false)
    });
});
