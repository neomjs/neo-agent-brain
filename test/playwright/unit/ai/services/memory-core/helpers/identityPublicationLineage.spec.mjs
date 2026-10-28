import {test, expect}                                                                                           from '@playwright/test';
import Database                                                                                                 from 'better-sqlite3';
import {generateKeyPairSync, sign}                                                                              from 'node:crypto';
import {consumeIdentityPublicationBoot, readIdentityPublicationLineage, verifyIdentityPublicationInTransaction} from '../../../../../../../ai/services/memory-core/helpers/identityPublicationLineage.mjs';
import {fenceIdentityPublication}                                                                               from '../../../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs';
import {familyLineageKey}                                                                                       from '../../../../../../../ai/services/shared/identityPublicationKeys.mjs';
import {stringifyCanonicalJson}                                                                                 from '../../../../../../../ai/services/shared/canonicalJson.mjs';

const target      = {planeId: 'fixture-plane', dataRoot: '/fixture/plane'};
const originRunId = '123e4567-e89b-42d3-a456-426614174000';
const first       = generateKeyPairSync('ed25519'), second = generateKeyPairSync('ed25519');
const spki        = key => key.export({type: 'spki', format: 'der'}).toString('base64url');
let db;

/** @summary Supplies trusted boot input only to the disposable owner fixture. */
function descriptor(trust = null) {
    return {version: 1, target: {...target}, issuer: 'fixture-fleet',
        reservation: {attemptId: 'attempt-a', kid: 'kid-a', originRunId}, trust};
}
/** @summary Encodes the exact atomic boot carrier used by the owner. */
const text = value => stringifyCanonicalJson(value);
/** @summary Captures physical state, independent of the source's own witness projection. */
const rows = () => db.prepare('SELECT * FROM Nodes ORDER BY id').all();
/** @summary Checks schema state without creating the operational fence. */
const fenceExists = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'IdentityPublicationFence'").get());
/** @summary Supplies generated test public material without any live credential. */
const trusted = (key = first.publicKey) => descriptor([{kid: 'kid-a', publicKey: spki(key)}]);

/** @summary Signs fixture bytes independently; operation validation remains the admission owner's next step. */
function signedEnvelope(patch = {}, key = first.privateKey) {
    const payload = Buffer.from(text({version: 1, purpose: 'identity-family-publication', audience: target.planeId,
        issuer   : 'fixture-fleet', kid: 'kid-a', issuedAt: 100, expiresAt: 300100,
        operation: {kind: 'baseline', operationId: 'fixture-operation'}, ...patch}));
    return payload.toString('base64url') + '.' + sign(null,
        Buffer.concat([Buffer.from('neo.identity-family-publication.v1\0'), payload]), key).toString('base64url');
}

/** @summary Calls the transaction-local verifier without exposing an earlier witness as authority. */
const verifyInside = (boot = trusted(), token = signedEnvelope(), now = 100) =>
    db.transaction(() => verifyIdentityPublicationInTransaction(db, text(boot), target, token, now)).immediate();

test.beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);`);
});
test.afterEach(() => db.close());

test('ordinary witness reads never reserve absent history or initialize a clear fence', () => {
    expect(readIdentityPublicationLineage(db, text(descriptor()), target).state).toBe('unadmitted');
    expect(rows()).toEqual([]);
    expect(fenceExists()).toBe(false);
    expect(readIdentityPublicationLineage(null, text(descriptor()), target).code).toBe('publication-graph-unavailable');
});

test('first reservation and exact retry preserve the original attempt and deterministic head', () => {
    const firstWitness = consumeIdentityPublicationBoot(db, text(descriptor()), target);
    expect(firstWitness).toMatchObject({state: 'reserved', target, issuer: 'fixture-fleet',
        reservation: descriptor().reservation, fingerprint: null});
    const before = rows();
    expect(consumeIdentityPublicationBoot(db, text(descriptor()), target)).toEqual(firstWitness);
    expect(rows()).toEqual(before);
    expect(Object.isFrozen(firstWitness)).toBe(true);
    expect(Object.isFrozen(firstWitness.target)).toBe(true);
    expect(Object.isFrozen(firstWitness.reservation)).toBe(true);
});

test('a competing issuer, attempt, kid or original run cannot open another reservation', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    const before = rows();
    for (const field of ['issuer', 'attemptId', 'kid', 'originRunId']) {
        const input = descriptor();
        if (field === 'issuer') input.issuer = 'other';
        else input.reservation[field] = field === 'originRunId' ? '223e4567-e89b-42d3-a456-426614174000' : 'other';
        expect(consumeIdentityPublicationBoot(db, text(input), target).state).toBe('conflict');
        expect(rows()).toEqual(before);
    }
});

test('public trust cannot skip reservation; binding is once and retries never re-mint', () => {
    expect(consumeIdentityPublicationBoot(db, text(trusted()), target).code).toBe('lineage-reservation-required');
    expect(rows()).toEqual([]);
    expect(fenceExists()).toBe(false);
    const reserved = consumeIdentityPublicationBoot(db, text(descriptor()), target);
    const bound    = consumeIdentityPublicationBoot(db, text(trusted()), target);
    expect(bound.state).toBe('bound');
    expect(bound.head).not.toBe(reserved.head);
    expect(bound.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    const before = rows();
    expect(consumeIdentityPublicationBoot(db, text(trusted()), target)).toEqual(bound);
    expect(consumeIdentityPublicationBoot(db, text(descriptor()), target)).toEqual(bound);
    expect(consumeIdentityPublicationBoot(db, text(trusted(second.publicKey)), target).code).toBe('lineage-key-conflict');
    expect(rows()).toEqual(before);
    expect(bound).not.toHaveProperty('publicKey');
});

test('extra configured kids require explicit rotation rather than inheriting generation authority', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    const input = trusted();
    input.trust.push({kid: 'kid-b', publicKey: spki(second.publicKey)});
    const before = rows();
    expect(consumeIdentityPublicationBoot(db, text(input), target).code).toBe('lineage-rotation-required');
    expect(rows()).toEqual(before);
});

test('a failed initial lineage insert rolls back clear-fence creation in the same transaction', () => {
    db.exec("CREATE TRIGGER refuse_lineage BEFORE INSERT ON Nodes BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END;");
    expect(consumeIdentityPublicationBoot(db, text(descriptor()), target).state).toBe('unadmitted');
    expect(rows()).toEqual([]);
    expect(fenceExists()).toBe(false);
});

test('an outer transaction cannot expose a reservation witness before its own commit', () => {
    let result;
    expect(() => db.transaction(() => {
        result = consumeIdentityPublicationBoot(db, text(descriptor()), target);
        throw new Error('outer rollback');
    }).immediate()).toThrow('outer rollback');
    expect(result.state).toBe('unadmitted');
    expect(rows()).toEqual([]);
    expect(fenceExists()).toBe(false);
});

test('a read refuses an outer uncommitted transaction instead of witnessing rollback-prone authority', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    expect(db.transaction(() => readIdentityPublicationLineage(db, text(descriptor()), target)).deferred().state)
        .toBe('unadmitted');
    expect(readIdentityPublicationLineage(db, text(descriptor()), target).state).toBe('reserved');
});

test('missing lineage after reservation is unavailable, never fresh enablement', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    db.exec('DELETE FROM Nodes');
    expect(consumeIdentityPublicationBoot(db, text(descriptor()), target).code).toBe('lineage-missing');
    expect(rows()).toEqual([]);
});

test('missing fence after reservation is unavailable and cannot be repaired by boot', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    db.exec('DROP TABLE IdentityPublicationFence');
    const before = rows();
    expect(consumeIdentityPublicationBoot(db, text(descriptor()), target).code).toBe('publication-fence-missing');
    expect(rows()).toEqual(before);
    expect(fenceExists()).toBe(false);
});

test('a live restore fence survives every reservation/binding retry and ordinary read', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    db.transaction(() => fenceIdentityPublication(db, {...target, operation: 'fixture-restore', source: 'fixture'})).immediate();
    const before = rows();
    for (const input of [descriptor(), trusted()]) {
        expect(consumeIdentityPublicationBoot(db, text(input), target).state).toBe('fenced');
        expect(readIdentityPublicationLineage(db, text(input), target).state).toBe('fenced');
    }
    expect(rows()).toEqual(before);
});

test('orphaned protected history cannot be mistaken for a fresh plane', () => {
    db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run('identity-family-old-receipt', text({id: 'identity-family-old-receipt'}));
    const before = rows();
    expect(consumeIdentityPublicationBoot(db, text(descriptor()), target).code).toBe('publication-history-unreconciled');
    expect(rows()).toEqual(before);
    expect(fenceExists()).toBe(false);
});

test('malformed or wrong-target records stay unavailable without erasing their bytes', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    const id = familyLineageKey(target);
    db.prepare('UPDATE Nodes SET data = ? WHERE id = ?').run('{"bad":true}', id);
    const before = rows();
    expect(consumeIdentityPublicationBoot(db, text(descriptor()), target).state).toBe('unadmitted');
    expect(readIdentityPublicationLineage(db, text(descriptor()), target).state).toBe('unadmitted');
    expect(rows()).toEqual(before);
    expect(() => consumeIdentityPublicationBoot(db, text(descriptor()), {...target, dataRoot: '/other'})).toThrow('target');
});

test('unprovisioned config leaves already-bound graph authority intact and does not serve an empty success', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    consumeIdentityPublicationBoot(db, text(trusted()), target);
    const before = rows();
    expect(consumeIdentityPublicationBoot(db, null, target).state).toBe('unadmitted');
    expect(readIdentityPublicationLineage(db, null, target).state).toBe('unadmitted');
    expect(rows()).toEqual(before);
});

test('transaction-local delivery verification never provisions absent lineage or a fence', () => {
    expect(verifyInside().authenticated).toBe(false);
    expect(rows()).toEqual([]);
    expect(fenceExists()).toBe(false);
    expect(verifyIdentityPublicationInTransaction(db, text(trusted()), target, signedEnvelope(), 100).code)
        .toBe('publication-transaction-required');
});

test('delivery needs current public trust and physically bound lineage, not an old bound witness', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    expect(verifyInside().code).toBe('publication-lineage-unbound');
    consumeIdentityPublicationBoot(db, text(trusted()), target);
    const before = rows();
    expect(readIdentityPublicationLineage(db, text(descriptor()), target).state).toBe('bound');
    expect(verifyInside(descriptor()).code).toBe('publication-trust-unavailable');
    expect(verifyInside(null).code).toBe('publication-not-provisioned');
    expect(verifyInside().authenticated).toBe(true);
    expect(rows()).toEqual(before);
});

test('a delivery valid before lock acquisition can expire before the transaction-local check', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    consumeIdentityPublicationBoot(db, text(trusted()), target);
    const token = signedEnvelope(), before = rows();
    expect(verifyInside(trusted(), token, 300099).authenticated).toBe(true);
    expect(verifyInside(trusted(), token, 300100).code).toBe('outside-validity');
    expect(verifyInside(trusted(), token, 99).code).toBe('outside-validity');
    expect(rows()).toEqual(before);
});

test('same-transaction fencing prevents verification even after an earlier positive witness', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    consumeIdentityPublicationBoot(db, text(trusted()), target);
    expect(readIdentityPublicationLineage(db, text(trusted()), target).state).toBe('bound');
    const result = db.transaction(() => {
        fenceIdentityPublication(db, {...target, operation: 'fixture-restore', source: 'fixture', at: 100});
        expect(readIdentityPublicationLineage(db, text(trusted()), target).code).toBe('publication-transaction-in-progress');
        return verifyIdentityPublicationInTransaction(db, text(trusted()), target, signedEnvelope(), 100);
    }).immediate();
    expect(result.code).toBe('publication-restore-fenced');
});

test('a signature under changed unconsumed key bytes or a forged authentication object is insufficient', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    consumeIdentityPublicationBoot(db, text(trusted()), target);
    const before = rows();
    expect(verifyInside(trusted(second.publicKey), signedEnvelope({}, second.privateKey)).code).toBe('lineage-key-conflict');
    expect(verifyInside(trusted(), {authenticated: true, envelope: {}}).code).toBe('malformed-envelope');
    expect(verifyInside(trusted(), signedEnvelope({issuer: 'other-fleet'})).code).toBe('untrusted-envelope');
    expect(rows()).toEqual(before);
});

test('cold physical corruption refuses rather than reusing a previous authority read', () => {
    consumeIdentityPublicationBoot(db, text(descriptor()), target);
    consumeIdentityPublicationBoot(db, text(trusted()), target);
    expect(verifyInside().authenticated).toBe(true);
    db.prepare('UPDATE Nodes SET data = ? WHERE id = ?').run('{"bad":true}', familyLineageKey(target));
    const before = rows();
    expect(verifyInside().code).toBe('publication-history-unavailable');
    expect(rows()).toEqual(before);
});
