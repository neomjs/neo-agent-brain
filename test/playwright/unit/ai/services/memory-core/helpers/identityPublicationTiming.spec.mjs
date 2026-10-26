import {test, expect}                    from '@playwright/test';
import {resolveForwardFamilyBoundary}    from '../../../../../../../ai/services/memory-core/helpers/identityPublicationTiming.mjs';
import {buildFamilyProjection, familyAt} from '../../../../../../../ai/graph/identityFamilyProjection.mjs';

test('a first boundary requires explicit absence and keeps the admission clock sample', () => {
    expect(resolveForwardFamilyBoundary({admittedAt: 0, previousBoundary: null})).toEqual({allowed: true, since: 0});
    expect(resolveForwardFamilyBoundary({admittedAt: 42, previousBoundary: null})).toEqual({allowed: true, since: 42});
    expect(resolveForwardFamilyBoundary({admittedAt: 42}).allowed).toBe(false);
});

test('equal time refuses without silently incrementing the boundary', () => {
    const result = resolveForwardFamilyBoundary({admittedAt: 30, previousBoundary: 30});
    expect(result).toEqual({allowed: false, retryable: true, code: 'forward-boundary-not-later',
        cause: 'same-millisecond', blockingBoundary: 30, admittedAt: 30});
    expect(result).not.toHaveProperty('since');
    expect(Object.isFrozen(result)).toBe(true);
});

test('a backwards clock stays retryable until an actual sample passes the blocking boundary', () => {
    for (const admittedAt of [12, 15, 29]) {
        expect(resolveForwardFamilyBoundary({admittedAt, previousBoundary: 30})).toEqual({
            allowed: false, retryable: true, code: 'forward-boundary-not-later',
            cause  : 'clock-regression', blockingBoundary: 30, admittedAt
        });
    }
    expect(resolveForwardFamilyBoundary({admittedAt: 30, previousBoundary: 30}).cause).toBe('same-millisecond');
    expect(resolveForwardFamilyBoundary({admittedAt: 31, previousBoundary: 30})).toEqual({allowed: true, since: 31});
});

test('late delivery keeps the prior family between the signed act and its admission', () => {
    const signedAct = Object.freeze({effectiveAt: 15, family: 'claude'});
    const boundary  = resolveForwardFamilyBoundary({admittedAt: 30, previousBoundary: 10});
    const history   = {
        baselineSince: 10, revision: 3,
        memberships  : [{bindingId: 'A', since: 10, until: null}],
        declarations : [
            {admissionId: 'first', bindingId: 'A', operatorPrincipal: 'operator-a', since: 10,
                revision: 2, family: 'gpt', model: null},
            {admissionId: 'late', bindingId: 'A', operatorPrincipal: 'operator-a', since: boundary.since,
                revision: 3, family: signedAct.family, model: null}
        ],
        corrections: []
    };
    const projection = buildFamilyProjection(history);
    expect(projection.valid).toBe(true);
    expect(familyAt(projection, signedAct.effectiveAt)).toEqual({state: 'classified', family: 'gpt'});
    expect(familyAt(projection, 20)).toEqual({state: 'classified', family: 'gpt'});
    expect(familyAt(projection, 30)).toEqual({state: 'classified', family: 'claude'});
    expect(signedAct.effectiveAt).toBe(15);

    history.revision = 4;
    history.corrections.push({admissionId: 'repair-first', targetAdmissionId: 'first',
        operatorPrincipal: 'operator-a', revision: 4, family: 'gemini', model: null});
    const corrected = buildFamilyProjection(history);
    expect(familyAt(corrected, 20)).toEqual({state: 'classified', family: 'gemini'});
    expect(familyAt(corrected, 30)).toEqual({state: 'classified', family: 'claude'});
});

for (const value of [undefined, null, -1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '30']) {
    test('rejects a noncanonical clock sample: ' + String(value), () => {
        expect(resolveForwardFamilyBoundary({admittedAt: value, previousBoundary: 10})).toEqual({
            allowed: false, retryable: false, code: 'invalid-boundary-time'
        });
    });
}

test('malformed prior history cannot be mistaken for a first declaration', () => {
    for (const previousBoundary of [undefined, -1, -0, 1.5, NaN, Infinity, '10']) {
        expect(resolveForwardFamilyBoundary({admittedAt: 30, previousBoundary}).allowed).toBe(false);
    }
});

test('the maximum safe timestamp cannot be silently advanced', () => {
    const admittedAt = Number.MAX_SAFE_INTEGER;
    expect(resolveForwardFamilyBoundary({admittedAt, previousBoundary: admittedAt - 1})).toEqual({allowed: true, since: admittedAt});
    expect(resolveForwardFamilyBoundary({admittedAt, previousBoundary: admittedAt}).retryable).toBe(true);
});
