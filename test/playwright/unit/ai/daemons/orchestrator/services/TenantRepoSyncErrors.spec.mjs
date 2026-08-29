import {test, expect} from '@playwright/test';
import {
    KB_TENANT_REPO_SYNC_SYNC_FAILED,
    KB_TENANT_REPO_SYNC_LEASE_HELD,
    KB_TENANT_REPO_SYNC_LEASE_LOST,
    KB_TENANT_REPO_SYNC_REPO_NOT_CONFIGURED,
    KB_TENANT_REPO_SYNC_TENANT_NOT_FOUND,
    KB_TENANT_REPO_SYNC_MANIFEST_UPDATE_FAILED,
    KB_TENANT_REPO_SYNC_CONCURRENCY_GATE_TIMEOUT,
    KB_TENANT_REPO_SYNC_INVALID_CONCURRENCY_GATE_TIMEOUT,
    KB_TENANT_REPO_SYNC_INVALID_CONCURRENCY_LIMIT,
    KB_TENANT_REPO_SYNC_EMPTY_MATERIALIZATION,
    KB_TENANT_REPO_SYNC_CONTENT_NOT_EMBEDDABLE,
    KB_TENANT_REPO_SYNC_MATERIALIZATION_UNPROVEN,
    KB_TENANT_REPO_SYNC_STARVED,
    TENANT_REPO_SYNC_ERROR_CODES,
    TenantRepoSyncError,
    isTenantRepoSyncErrorCode,
    isTerminalSyncFailure,
    buildTerminalStop,
    isStoppedForCurrentInput,
    KB_INGEST_ENVELOPE_REF_NOT_FOUND
} from '../../../../../../../ai/daemons/orchestrator/services/TenantRepoSyncErrors.mjs';

test.describe('TenantRepoSyncErrors taxonomy (#11942 AC3+AC4)', () => {
    test('all exported codes carry the canonical KB_TENANT_REPO_SYNC_ prefix', () => {
        const codes = [
            KB_TENANT_REPO_SYNC_SYNC_FAILED,
            KB_TENANT_REPO_SYNC_LEASE_HELD,
            KB_TENANT_REPO_SYNC_LEASE_LOST,
            KB_TENANT_REPO_SYNC_REPO_NOT_CONFIGURED,
            KB_TENANT_REPO_SYNC_TENANT_NOT_FOUND,
            KB_TENANT_REPO_SYNC_MANIFEST_UPDATE_FAILED,
            KB_TENANT_REPO_SYNC_CONCURRENCY_GATE_TIMEOUT,
            KB_TENANT_REPO_SYNC_EMPTY_MATERIALIZATION
        ];

        codes.forEach(code => {
            expect(code).toMatch(/^KB_TENANT_REPO_SYNC_/);
        });
    });

    test('TENANT_REPO_SYNC_ERROR_CODES array contains exactly the exported codes', () => {
        expect(Array.isArray(TENANT_REPO_SYNC_ERROR_CODES)).toBe(true);
        expect(TENANT_REPO_SYNC_ERROR_CODES.length).toBe(13);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_SYNC_FAILED);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_LEASE_HELD);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_LEASE_LOST);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_REPO_NOT_CONFIGURED);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_TENANT_NOT_FOUND);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_MANIFEST_UPDATE_FAILED);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_CONCURRENCY_GATE_TIMEOUT);
        // Membership is the runTask preservation mechanism: a typed config refusal outside this
        // list is wrapped to SYNC_FAILED at the public boundary.
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_INVALID_CONCURRENCY_LIMIT);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_INVALID_CONCURRENCY_GATE_TIMEOUT);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_EMPTY_MATERIALIZATION);
        // The effect-bearing sibling. Bumping the count alone would let a new code pass the guard
        // without ever being named — the count is a tripwire, membership is the actual assertion.
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_MATERIALIZATION_UNPROVEN);
        // The third zero-effect case: content declared, every chunk refused before the provider.
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_CONTENT_NOT_EMBEDDABLE);
        expect(TENANT_REPO_SYNC_ERROR_CODES).toContain(KB_TENANT_REPO_SYNC_STARVED);
    });

    test('TENANT_REPO_SYNC_ERROR_CODES is truly immutable — external mutation rejected', () => {
        // Object.freeze(new Set(...)) freezes the Set wrapper's properties but NOT
        // Set membership — .add() still mutates the underlying collection. Object.freeze
        // on an array, by contrast, rejects .push / indexed assignment / length mutation
        // in strict mode. ES modules are strict by default, so these throw.
        expect(Object.isFrozen(TENANT_REPO_SYNC_ERROR_CODES)).toBe(true);
        expect(() => TENANT_REPO_SYNC_ERROR_CODES.push('KB_TENANT_REPO_SYNC_MUTATED')).toThrow(TypeError);
        expect(() => { TENANT_REPO_SYNC_ERROR_CODES[TENANT_REPO_SYNC_ERROR_CODES.length] = 'KB_TENANT_REPO_SYNC_MUTATED'; }).toThrow(TypeError);
        expect(() => { TENANT_REPO_SYNC_ERROR_CODES.length = 0; }).toThrow(TypeError);
        expect(TENANT_REPO_SYNC_ERROR_CODES.length).toBe(13);
        expect(TENANT_REPO_SYNC_ERROR_CODES).not.toContain('KB_TENANT_REPO_SYNC_MUTATED');
        expect(isTenantRepoSyncErrorCode('KB_TENANT_REPO_SYNC_MUTATED')).toBe(false);
    });

    test('isTenantRepoSyncErrorCode discriminates membership correctly', () => {
        expect(isTenantRepoSyncErrorCode(KB_TENANT_REPO_SYNC_SYNC_FAILED)).toBe(true);
        expect(isTenantRepoSyncErrorCode('KB_GITMIRROR_FETCH_FAILED')).toBe(false);
        expect(isTenantRepoSyncErrorCode('KB_TENANT_REPO_SYNC_UNKNOWN_FUTURE_CODE')).toBe(false);
        expect(isTenantRepoSyncErrorCode(null)).toBe(false);
        expect(isTenantRepoSyncErrorCode(undefined)).toBe(false);
        expect(isTenantRepoSyncErrorCode(123)).toBe(false);
    });

    test('TenantRepoSyncError carries code + meta and inherits from Error', () => {
        const err = new TenantRepoSyncError(
            KB_TENANT_REPO_SYNC_SYNC_FAILED,
            'fetch failed',
            {tenantId: 't1', repoSlug: 'org/repo', phase: 'fetch'}
        );

        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('TenantRepoSyncError');
        expect(err.code).toBe(KB_TENANT_REPO_SYNC_SYNC_FAILED);
        expect(err.message).toBe('fetch failed');
        expect(err.meta).toEqual({tenantId: 't1', repoSlug: 'org/repo', phase: 'fetch'});
    });

    test('TenantRepoSyncError meta defaults to empty object when omitted', () => {
        const err = new TenantRepoSyncError(KB_TENANT_REPO_SYNC_MANIFEST_UPDATE_FAILED, 'write failed');
        expect(err.meta).toEqual({});
    });

    test('TenantRepoSyncError preserves stack trace for debugging', () => {
        const err = new TenantRepoSyncError(KB_TENANT_REPO_SYNC_SYNC_FAILED, 'test');
        expect(err.stack).toBeTruthy();
        expect(err.stack).toContain('TenantRepoSyncError');
    });
});

// #237. A cause a later identical attempt cannot change, so the lane must STOP rather than back off.
// The specimen: one repo at consecutiveFailures 36 with a backoffMultiplier of 2^36 — a number only
// reachable by classifying one terminal cause as transient thirty-six separate times.
//
// The predicate is two-valued ON PURPOSE, and the pair below is the reason. `REF_NOT_FOUND` alone is
// ambiguous: against an unreachable mirror it is a fetch that has not happened yet, and a later
// attempt genuinely may succeed. Against a reachable one it is a branch that is not there, and
// `fetch --all --prune` keeps not finding it.
test.describe('isTerminalSyncFailure — stopping without silencing the transient case (#237)', () => {

    test('an unresolvable ref with the mirror REACHABLE is terminal', () => {
        expect(isTerminalSyncFailure({
            sourceErrorCode: KB_INGEST_ENVELOPE_REF_NOT_FOUND,
            accessConfirmed: true
        })).toBe(true);
    });

    // 🔴 THE ANTI-CHEAP-HALF CONTROL. An implementation keyed on the error code alone passes the arm
    // above and fails here — it would stop a lane whose mirror was simply unreachable this sweep,
    // converting a real transient failure into a silent permanent one. Same code, opposite verdict.
    test('the SAME unresolvable ref with the mirror UNREACHABLE is NOT terminal', () => {
        expect(isTerminalSyncFailure({
            sourceErrorCode: KB_INGEST_ENVELOPE_REF_NOT_FOUND,
            accessConfirmed: false
        })).toBe(false);
    });

    // The mirror image: access alone must not stop anything either. Every other cause reaching this
    // lane — transport, manifest, embedding, lease — stays retryable against a reachable mirror.
    test('a reachable mirror does not make OTHER causes terminal', () => {
        for (const code of TENANT_REPO_SYNC_ERROR_CODES) {
            expect(isTerminalSyncFailure({sourceErrorCode: code, accessConfirmed: true}), code).toBe(false);
        }
    });

    test('absent or malformed inputs are never terminal — the default is to keep retrying', () => {
        expect(isTerminalSyncFailure()).toBe(false);
        expect(isTerminalSyncFailure({})).toBe(false);
        expect(isTerminalSyncFailure({sourceErrorCode: null, accessConfirmed: true})).toBe(false);
        // Truthy-but-not-true must not qualify: the caller passes a real boolean, and a loose check
        // would let an accidental string or object stop a lane.
        expect(isTerminalSyncFailure({
            sourceErrorCode: KB_INGEST_ENVELOPE_REF_NOT_FOUND,
            accessConfirmed: 'yes'
        })).toBe(false);
    });

    // The code is deliberately NOT a member of the taxonomy: it is raised one layer down by
    // `tenantRepoIngestEnvelopeBuilder` and arrives here as a SOURCE code. Reddens if a future edit
    // "tidies" it into TENANT_REPO_SYNC_ERROR_CODES, which would change how `runTask` wraps it.
    test('the envelope code stays a sibling-prefix SOURCE code, not a taxonomy member', () => {
        expect(KB_INGEST_ENVELOPE_REF_NOT_FOUND).toBe('KB_INGEST_ENVELOPE_REF_NOT_FOUND');
        expect(isTenantRepoSyncErrorCode(KB_INGEST_ENVELOPE_REF_NOT_FOUND)).toBe(false);
        expect(TENANT_REPO_SYNC_ERROR_CODES).not.toContain(KB_INGEST_ENVELOPE_REF_NOT_FOUND);
    });
});

// #238 round 2. The classifier above decides that an attempt cannot succeed; THIS decides whether a
// later sweep is allowed to attempt at all. Round 1 shipped only the first half: the failure counter
// froze, `isRepoDue` kept admitting the repo every cadence, and the same clone/fetch/envelope work
// ran forever to rediscover the same cause. A frozen counter is not a stop.
test.describe('isStoppedForCurrentInput — stop keyed on INPUT, not on elapsed time (#238)', () => {

    const stop = buildTerminalStop({
        ref            : 'refs/heads/main',
        sourceErrorCode: KB_INGEST_ENVELOPE_REF_NOT_FOUND,
        at             : 1700000000000
    });

    // 🔴 THE CLOCK CONTROL. The predicate takes no time input at all, which is the property: there is
    // no elapsed value that can flip it. A stop that expires is a slower retry wearing a stop's name.
    test('the SAME ref stays stopped — the predicate has no time input to age out', () => {
        expect(isStoppedForCurrentInput({terminalStop: stop, currentRef: 'refs/heads/main'})).toBe(true);
        // Same call, any later sweep: identical inputs, identical verdict.
        expect(isStoppedForCurrentInput({terminalStop: stop, currentRef: 'refs/heads/main'})).toBe(true);
    });

    // 🔴 THE RESUMPTION CONTROL, and the reason this is a fingerprint rather than a `stopped: true`
    // flag. Repointing the repo clears the stop by COMPARISON — no reset command, no TTL, no
    // revalidation pass anyone has to remember to run. A boolean could not express this.
    test('a CHANGED ref resumes, with no clearing mechanism to invoke', () => {
        expect(isStoppedForCurrentInput({terminalStop: stop, currentRef: 'refs/heads/develop'})).toBe(false);
        expect(isStoppedForCurrentInput({terminalStop: stop, currentRef: 'HEAD'})).toBe(false);
    });

    // Fails OPEN, deliberately. A wrong `false` costs one wasted attempt; a wrong `true` is a repo
    // that never syncs again while reporting a reason that is not true.
    test('an absent or malformed fingerprint never suppresses', () => {
        expect(isStoppedForCurrentInput()).toBe(false);
        expect(isStoppedForCurrentInput({terminalStop: null, currentRef: 'HEAD'})).toBe(false);
        expect(isStoppedForCurrentInput({terminalStop: {}, currentRef: 'HEAD'})).toBe(false);
        // A record missing its cause is not a stop record — it cannot say WHY, so it may not suppress.
        expect(isStoppedForCurrentInput({terminalStop: {ref: 'HEAD'}, currentRef: 'HEAD'})).toBe(false);
        // A repo with no resolvable current ref cannot be matched against anything.
        expect(isStoppedForCurrentInput({terminalStop: stop, currentRef: null})).toBe(false);
        expect(isStoppedForCurrentInput({terminalStop: stop, currentRef: undefined})).toBe(false);
    });

    test('the fingerprint carries exactly the two inputs the gate compares, plus an operator timestamp', () => {
        expect(stop).toEqual({
            at             : 1700000000000,
            ref            : 'refs/heads/main',
            sourceErrorCode: KB_INGEST_ENVELOPE_REF_NOT_FOUND
        });
    });

    // The two halves compose in one direction only, and the ordering is the fix. Classification says
    // "this attempt cannot succeed"; suppression says "do not attempt". Round 1 had the first without
    // the second, so every cadence still paid for the work.
    test('classification and suppression are different questions about the same failure', () => {
        const terminal = isTerminalSyncFailure({
            sourceErrorCode: KB_INGEST_ENVELOPE_REF_NOT_FOUND,
            accessConfirmed: true
        });

        expect(terminal).toBe(true);
        // Same cause, but the gate answers about the NEXT sweep and needs the persisted input.
        expect(isStoppedForCurrentInput({terminalStop: null, currentRef: 'refs/heads/main'})).toBe(false);
        expect(isStoppedForCurrentInput({terminalStop: stop, currentRef: 'refs/heads/main'})).toBe(true);
    });
});
