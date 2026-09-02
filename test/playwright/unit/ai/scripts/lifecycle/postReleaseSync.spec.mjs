import {test, expect} from '@playwright/test';
import fs             from 'fs';
import path           from 'path';

/**
 * The logical-identity guard that stands in front of the archive commit's broad stage.
 *
 * This witness arrives here rather than being authored here. It is arm #6 of the Engine's
 * `PublishReleaseNoteOrphan.spec.mjs`, which `neomjs/neo@c623b2f63c` deleted along with 803 other
 * unit specs while the subject it asserts — `ai/scripts/lifecycle/postReleaseSync.mjs` — moved into
 * this repository. Both halves then read green: the Engine because the spec was gone, this repo
 * because it never received one. See `neomjs/neo#17922` for the census and `#298` for the transfer.
 *
 * Three properties make a source-ORDERING assertion the only available instrument, rather than a
 * weaker choice than a behavioural one:
 *
 * 1. Both release-path commits run `--no-verify` by design, so husky and the `lint-staged` copy of
 *    this same guard are structurally blind to them.
 * 2. Proving the ordering behaviourally would mean cutting a real release.
 * 3. The stage sits DELIBERATELY after a `catch` that continues when `runFullSync()` has thrown.
 *    The guard therefore fires exactly when the corpus-integrity verdict has already refused the
 *    corpus — the highest-risk moment at which to stage broadly — and a collision published from
 *    there stalls Knowledge Base ingestion for the entire corpus, not just the colliding artifacts.
 *
 * The population is pinned per CALL SITE, not per file. The arm this descends from counted broad
 * stages across two files and pinned each file's total; that count went stale the day the split
 * landed. Counting is the part that did not survive the move, so this iterates whatever broad stages
 * the file actually contains: a second one added tomorrow without a guard fails here, and a guarded
 * one does not.
 */

const
    root       = process.cwd(),
    sourcePath = 'ai/scripts/lifecycle/postReleaseSync.mjs';

/**
 * @summary Returns the source lines that stage the working tree broadly (`git add .`).
 * @param {String[]} lines Source split on newlines.
 * @returns {Object[]} Entries of `{index, line}`, one per broad stage, in source order.
 */
function findBroadStages(lines) {
    return lines
        .map((line, index) => ({index, line}))
        .filter(entry => /runCommand\('git add \.'/.test(entry.line))
}

/**
 * @summary Returns the last executable statement before a line, ignoring blanks and comments.
 * @param {String[]} lines Source split on newlines.
 * @param {Number} index Zero-based line index to look back from.
 * @returns {String|undefined} The preceding executable statement, trimmed.
 */
function precedingStatement(lines, index) {
    return lines
        .slice(0, index)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
        .pop()
}

test.describe('postReleaseSync — the archive commit\'s logical-identity guard (#298)', () => {
    const
        source = fs.readFileSync(path.join(root, sourcePath), 'utf8'),
        lines  = source.split('\n');

    test('the guarded script is a live entrypoint, not an orphan this spec would assert over', () => {
        // Non-vacuity for every arm below: a source-ordering claim about an unreachable file asserts
        // nothing. `ADR 0040 §2.3` names this script as the Brain half of the two-command release seam,
        // and the npm alias is how `publish.mjs` hands over to it.
        const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
            .scripts['ai:post-release-sync'];

        expect(script, 'package.json must carry ai:post-release-sync').toBeTruthy();
        expect(script.replace(/^node\s+/, '').replace(/^\.\//, '')).toBe(sourcePath)
    });

    test('every broad stage is immediately preceded by the logical-identity guard', () => {
        const broadStages = findBroadStages(lines);

        // `git add .` is the broad stage. `git add <path>` cannot carry archive content and is
        // deliberately NOT required to carry the guard.
        expect(broadStages.length, `${sourcePath}: expected at least one broad stage to guard`)
            .toBeGreaterThan(0);

        for (const {index} of broadStages) {
            // Immediately-preceding, so a later edit cannot slip an unguarded statement in between and
            // still pass — and so moving the guard to AFTER the stage fails rather than merely being
            // present somewhere in the file.
            expect(precedingStatement(lines, index), `${sourcePath}: broad stage at line ${index + 1} is unguarded`)
                .toMatch(/assertNoArchiveLogicalIdentityCollisions\(/)
        }
    });

    test('the guard consults the shared predicate instead of reimplementing it', () => {
        // The release path and the `lint-staged` path must not be able to disagree about what a
        // collision IS. A local reimplementation would drift silently, and the release path is the one
        // no hook can see.
        expect(source, `${sourcePath}: guard must import the shared predicate`)
            .toMatch(/import \{findLogicalIdentityCollisions\}/);
        expect(source, `${sourcePath}: guard must invoke the shared predicate`)
            .toMatch(/findLogicalIdentityCollisions\(\{/)
    })
});
