#!/usr/bin/env node
/**
 * @module ai/scripts/lifecycle/hooks/seatProjectionCheck
 * @summary Claude `SessionStart` hook — reports a stale or unprojected seat into the agent's own
 * transcript, so a hook fix that landed in the Brain cannot sit unreached in a checkout for days.
 *
 * The gap this closes (#317): `projectSeatHooks` has exactly one non-test caller, `bootstrapWorktree`
 * — the NEW-checkout path. A seat that already exists is projected once and never revisited, so the
 * propagation rule is *a hook fix reaches a checkout only if the checkout is newer than the fix*.
 * Measured: #296 closed 2026-09-02T09:49Z; one seat's hooks were projected 08:35 earlier and failed
 * open 319 consecutive times before anyone looked at the hook's own audit log.
 *
 * **Nothing here is a new detector.** `checkProjection` already reports the exact conditions, already
 * exits non-zero, and already prints the repair line. It simply had no caller. This file is that
 * caller, and adding it is the whole change.
 *
 * **Why this script is NOT projected into the seat, and must never become so.** Every hook under
 * `hooks/<harness>/` is copied into the target checkout by {@link enumerateHooks}; files at THIS
 * level are not (`projectSeatHooks.mjs` is the standing precedent). That placement is load-bearing
 * rather than tidy: a checker living in the seat is subject to the staleness it detects, and — the
 * case that decided it — **a projected checker cannot detect its own absence.** A peer seat audited
 * during #317 came back `missing`, all nine hook files gone; a wrapper shipped as a tenth would have
 * been gone with them and reported nothing. Resolution direction is independently mandated by
 * ADR 0040 §2.5: seat hooks resolve Brain substrate only through `agentosRuntimeRoot`-provisioned
 * artifacts, never relatively from `targetRepoRoot`.
 *
 * **Report, never repair.** The seat is told what is wrong and given the command; it does not write.
 * Auto-projection would push any Brain commit into every checkout unattended, with no review between
 * merge and execution, to save a single turn. It is also not the escape it appears to be: the write
 * touches `.claude/settings.json`, which is precisely what one peer's permission classifier already
 * refuses — so healing would fail on the seats that most need it while removing the human from the
 * ones it works on.
 *
 * **Never blocks a boot.** Every failure path — unbound target, unreadable root, a throw inside the
 * checker — emits an honest line and exits 0. A verification hook that can stop a session is a worse
 * defect than the one it reports.
 *
 * @see https://github.com/neomjs/neo-agent-brain/issues/317
 * @see https://github.com/neomjs/neo-agent-brain/issues/79 — the arming-parity sibling
 */
import fs                              from 'node:fs';
import path                            from 'node:path';
import {fileURLToPath, pathToFileURL}  from 'node:url';
import {checkProjection}               from './projectSeatHooks.mjs';

const
    __filename         = fileURLToPath(import.meta.url),
    agentosRuntimeRoot = path.resolve(path.dirname(__filename), '..', '..', '..', '..'),
    REPAIR_DOC         = 'https://github.com/neomjs/neo-agent-brain/issues/317';

/**
 * @summary Reads the hook payload from stdin, or an empty object when nothing arrives.
 *
 * A payload that never arrives is not an error: the hook still has to decide something, and deciding
 * "target unbound" is a better answer than hanging on a pipe that was never written to.
 * @returns {Promise<Object>}
 * @protected
 */
async function readPayload() {
    if (process.stdin.isTTY) return {};

    const chunks = [];

    try {
        for await (const chunk of process.stdin) chunks.push(chunk)
    } catch {
        return {}
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
        return {}
    }
}

/**
 * @summary Binds the target checkout from the payload, never from ambient `process.cwd()`.
 *
 * ADR 0040 §2.5 forbids a cwd fallback for either root, and the reason is this hook's exact shape:
 * a cwd default is the convenience that survives every review until the hook runs from somewhere
 * else and silently audits the wrong tree. Reporting an unbound target is the honest answer.
 * @param {Object} payload Claude hook payload.
 * @returns {String|null} Absolute target repository root, or `null` when it cannot be bound.
 * @protected
 */
export function resolveTargetRepoRoot(payload) {
    const candidate = payload?.cwd;

    if (typeof candidate !== 'string' || !candidate) return null;

    const resolved = path.resolve(candidate);

    return fs.existsSync(path.join(resolved, '.git')) ? resolved : null
}

/**
 * @summary Turns a projection report into the sentence the agent reads on its first turn.
 *
 * `missing` and `stale` are separated because they are different failures wearing one word. A stale
 * hook runs and enforces an *older* contract; a missing one enforces nothing at all and the seat has
 * no gate. `checkProjection` already distinguishes them — this only stops the distinction being lost
 * on the way to the reader.
 *
 * The repair line always travels with its escalation target. A seat whose harness refuses the write
 * would otherwise be handed an instruction it cannot follow, once per session, until it learns to
 * ignore the warning — which is the reported-but-unread failure this hook exists to end, one layer up.
 * @param {Object} report {@link checkProjection} result.
 * @param {String} targetRepoRoot Absolute target repository root.
 * @returns {String|null} Agent-facing context, or `null` when the seat is current.
 * @protected
 */
export function formatReport(report, targetRepoRoot) {
    if (report.ok) return null;

    // Single-quoted for the same reason the manifest is: any path emitted here is meant to be COPIED
    // INTO A SHELL, and a double-quoted path containing `$(…)` would execute rather than resolve. An
    // instruction that runs something other than what it displays is worse than no instruction.
    // Declared before the first verdict rather than beside the repair block: both arms quote paths.
    const
        sh      = value => `'${String(value).split("'").join(`'\\''`)}'`,
        lines   = [],
        missing = report.missing ?? [],
        stale   = report.stale ?? [],
        orphans = report.orphans ?? [];

    // Provenance is reported ALONE and without the repair line, because its remedy is the opposite of
    // every other finding's. A stale seat re-projects; a wrong-provenance seat MUST NOT — re-projecting
    // from a root parked off upstream is what put the unreviewed code in the seat, so prescribing it
    // here would turn the report into the attack. Returning early also keeps the two verdicts from
    // being read as one list of things to fix with one command.
    if (report.provenance) {
        const {commit, ref, upstream} = report.provenance;

        return [
            '⚠️ SEAT PROJECTION HAS THE WRONG PROVENANCE — your hooks may be current, and are still not trustworthy.',
            '',
            `This seat was projected from ${commit}${ref ? ` (${ref})` : ''}, which ${upstream} does NOT contain.`,
            'The bytes can match the runtime root perfectly and still be code that no review has seen:',
            'currency compares the seat to the root, and says nothing about where the root itself was pointing.',
            '',
            'DO NOT RE-PROJECT. Re-projecting is the action that installed this, and running it again',
            'against the same root reinstalls it while making every downstream check agree.',
            '',
            `FIX THE ROOT FIRST — get ${sh(agentosRuntimeRoot)} onto a revision ${upstream} contains`,
            '(its own branch work belongs in a worktree, so the shared root can stay on the integration',
            'branch), and only then re-project. If the root is not yours to move, hand this to @tobiu.',
            '',
            `Context: ${REPAIR_DOC}`
        ].join('\n')
    }

    lines.push('⚠️ SEAT PROJECTION IS NOT CURRENT — your Agent OS hooks do not match this runtime root.');
    lines.push('');

    missing.length && lines.push(
        `ABSENT (${missing.length}) — declared but never projected, so these gates run NOTHING and ` +
        `their absence is silent at every surface: ${missing.join(', ')}`
    );

    stale.length && lines.push(
        `STALE (${stale.length}) — projected from a different revision or runtime root, so these gates ` +
        `enforce an older contract than the one that shipped: ${stale.join(', ')}`
    );

    orphans.length && lines.push(
        `ORPHANED (${orphans.length}) — still executing but no longer declared: ${orphans.join(', ')}`
    );

    lines.push('');
    lines.push('REPAIR (writes only untracked, git-excluded seat artifacts):');
    lines.push(`  node ${sh(path.join(agentosRuntimeRoot, 'ai/scripts/lifecycle/hooks/projectSeatHooks.mjs'))} \\`);
    lines.push(`    --runtime-root=${sh(agentosRuntimeRoot)} --target-root=${sh(targetRepoRoot)}`);
    lines.push('');
    lines.push(
        'If your harness refuses that write — it touches .claude/settings.json, which some permission ' +
        'classifiers block — this is an operator action, not a retry. Hand the command above to @tobiu ' +
        `rather than reporting the same warning again next session. Context: ${REPAIR_DOC}`
    );

    return lines.join('\n')
}

/**
 * @summary Emits SessionStart context, or nothing when the seat is current.
 * @param {String|null} context Agent-facing context.
 * @protected
 */
function emit(context) {
    context && process.stdout.write(JSON.stringify({
        hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: context}
    }))
}

/**
 * @summary Hook entrypoint. Reports; never repairs, never throws, never blocks.
 * @protected
 */
async function main() {
    const targetRepoRoot = resolveTargetRepoRoot(await readPayload());

    if (!targetRepoRoot) {
        emit(
            'Seat projection was NOT verified this session: the hook payload carried no usable target ' +
            'checkout, and ADR 0040 §2.5 forbids falling back to the working directory. Treat the ' +
            'projection state as unknown rather than current.'
        );
        return
    }

    try {
        emit(formatReport(checkProjection({agentosRuntimeRoot, targetRepoRoot}), targetRepoRoot))
    } catch (error) {
        emit(
            `Seat projection was NOT verified this session — the check itself failed: ${error.message}. ` +
            'Unknown, not current.'
        )
    }
}

// Direct-execution guard against the realpath, matching projectSeatHooks: through a symlink `argv[1]`
// keeps the link path while `import.meta.url` resolves the target, the two disagree, and `main()`
// never runs — a silent no-op in the one file whose job is to end silent no-ops.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
    await main()
}
