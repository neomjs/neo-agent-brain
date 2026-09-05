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
 * **Report, never repair.** The seat is told what is wrong and given the command; it never writes a
 * REPAIR. It does make one diagnostic write — {@link recordTrace} appends a line to an untracked,
 * git-excluded log on a non-green verdict — and the distinction is the whole contract: a diagnostic
 * record changes nothing the harness executes, while a repair changes what runs next session. The
 * trace refuses a tracked path for the same reason the projector does, so the write can never reach
 * authored content either.
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
import {checkProjection, PROVENANCE_TRACE, readRuntimeProvenance, tracked} from './projectSeatHooks.mjs';

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
 * @summary The verdict this hook returns about ITSELF, when its own runtime root is off upstream.
 *
 * Distinct from every seat verdict, and reported instead of them rather than beside them: with the
 * root off upstream, the seat comparison is against unreviewed bytes, so listing which seat files
 * "do not match" would rank findings derived from an authority this same message is disputing. One
 * question at a time — fix the root, then ask about the seat.
 * @param {Object} own {@link readRuntimeProvenance} result for `agentosRuntimeRoot`.
 * @returns {String}
 * @protected
 */
export function formatRuntimeRootWarning({commit, ref, upstream}) {
    return [
        '⚠️ THE RUNTIME ROOT ITSELF IS OFF UPSTREAM — this seat was NOT audited, because the authority to audit it against is unreviewed.',
        '',
        `${agentosRuntimeRoot} is on ${commit}${ref ? ` (${ref})` : ''}, which ${upstream} does NOT contain.`,
        'Every seat verdict is measured against this root, so any answer right now — current or stale —',
        'is a comparison with code no review has seen. Absence of a warning would not have meant a healthy seat.',
        '',
        'DO NOT RE-PROJECT while this holds; that is what copies the unreviewed revision into the seat.',
        '',
        'If the root is a shared checkout, someone parked it on their branch — branch work belongs in a',
        `worktree so the shared root stays on ${upstream}. Move it back, or hand this to @tobiu.`,
        '',
        `Context: ${REPAIR_DOC}`
    ].join('\n')
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
 * @summary Appends one line per non-green verdict, so a sighting outlives the session that saw it.
 *
 * Before this the hook had exactly one output path — a string into the agent's own transcript — and
 * exited 0 either way, so an unacted-on warning left no artifact any operator, peer or later session
 * could find. Measured on a live seat 2026-09-05: zero `writeFile`/`appendFile`/`console` calls in
 * the whole file.
 *
 * Green writes NOTHING. A healthy seat must stay byte-identical between sessions, or the trace
 * becomes noise that the reader learns to skip — which is the failure it exists to end, one layer up.
 *
 * Never throws. An unwritable trace is a worse reason to disturb a boot than the condition it records,
 * so a failed append is silently dropped: the transcript line has already been emitted regardless.
 * @param {String} targetRepoRoot Absolute target repository root.
 * @param {String|null} context The emitted verdict, or `null` when the seat is current.
 * @returns {Boolean} Whether a line was appended.
 * @protected
 */
export function recordTrace(targetRepoRoot, context) {
    if (!context) return false;

    try {
        // Same custody contract the projector enforces, enforced here too because THIS is the writer.
        // A trace path someone has committed is authored content, and a diagnostic append is still an
        // overwrite of work nobody agreed to hand us. Reporting is never worth mutating a tracked file.
        if (tracked(targetRepoRoot, PROVENANCE_TRACE)) return false;

        const file = path.join(targetRepoRoot, PROVENANCE_TRACE);

        fs.mkdirSync(path.dirname(file), {recursive: true});
        // First line only: the verdict's headline is what a later reader scans for, and appending the
        // full multi-line context once per session would bury it in its own remediation prose.
        fs.appendFileSync(file, `${new Date().toISOString()}\t${context.split('\n')[0]}\n`, 'utf8');
        return true
    } catch {
        return false
    }
}

/**
 * @summary Hook entrypoint. Reports; never repairs, never throws, never blocks.
 * @protected
 */
export async function main(payload, runtimeRoot = agentosRuntimeRoot) {
    // The payload is a parameter with a stdin default rather than a stdin read, so a spec can exercise
    // the real routing — which verdict reaches which sink — instead of asserting on formatters and
    // hoping the wiring matches. @neo-gpt-emmy's RA-3 landed precisely in the gap a formatter-only
    // arm cannot see: the exception path emitted and recorded nothing, and every arm still passed.
    const targetRepoRoot = resolveTargetRepoRoot(payload ?? await readPayload());

    if (!targetRepoRoot) {
        emit(
            'Seat projection was NOT verified this session: the hook payload carried no usable target ' +
            'checkout, and ADR 0040 §2.5 forbids falling back to the working directory. Treat the ' +
            'projection state as unknown rather than current.'
        );
        return
    }

    try {
        // Asked BEFORE the seat is audited, because it decides whether this hook's own verdict is worth
        // anything. Every finding below is measured against `agentosRuntimeRoot`; if that root is itself
        // sitting on a revision upstream never saw, "your seat does not match this root" is a comparison
        // against unreviewed code, and the repair line would install it. The checker audited a property
        // it did not hold — this is that gap closed, and it is the only case where the hook reports on
        // itself rather than on the seat.
        const own = readRuntimeProvenance(runtimeRoot);

        if (own.ancestorOfUpstream === false) {
            const context = formatRuntimeRootWarning(own);

            recordTrace(targetRepoRoot, context);
            emit(context);
            return
        }

        const context = formatReport(checkProjection({agentosRuntimeRoot: runtimeRoot, targetRepoRoot}), targetRepoRoot);

        recordTrace(targetRepoRoot, context);
        emit(context)
    } catch (error) {
        // RA-3: this path emitted and recorded nothing, so "one line per non-green verdict" was false
        // for the case a later reader most needs — the checker itself failing. A verdict that exists
        // only in a transcript is the gap AC-5 closes, and an exception is still a verdict.
        const context = `Seat projection was NOT verified this session — the check itself failed: ${error.message}. ` +
                        'Unknown, not current.';

        recordTrace(targetRepoRoot, context);
        emit(context)
    }
}

// Direct-execution guard against the realpath, matching projectSeatHooks: through a symlink `argv[1]`
// keeps the link path while `import.meta.url` resolves the target, the two disagree, and `main()`
// never runs — a silent no-op in the one file whose job is to end silent no-ops.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
    await main()
}
