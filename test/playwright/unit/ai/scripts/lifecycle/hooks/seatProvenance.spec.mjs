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
import {formatReport}          from '../../../../../../../ai/scripts/lifecycle/hooks/seatProjectionCheck.mjs';

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
    })
});
