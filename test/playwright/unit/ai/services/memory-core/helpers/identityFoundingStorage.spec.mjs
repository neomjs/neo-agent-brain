import {test, expect}                                                           from '@playwright/test';
import Database                                                                 from 'better-sqlite3';
import {generateKeyPairSync}                                                    from 'node:crypto';
import {compileFoundingFamilySeed}                                              from '../../../../../../../ai/graph/identityFoundingSeed.mjs';
import {familyFoundingKey, familyLineageKey, familyPlaneStateKey}               from '../../../../../../../ai/services/shared/identityPublicationKeys.mjs';
import {stringifyCanonicalJson}                                                 from '../../../../../../../ai/services/shared/canonicalJson.mjs';
import {consumeIdentityPublicationBoot}                                         from '../../../../../../../ai/services/memory-core/helpers/identityPublicationLineage.mjs';
import {fenceIdentityPublication, readIdentityPublicationFence}                 from '../../../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs';
import {installIdentityFoundingSource, readIdentityFoundingSourceInTransaction} from '../../../../../../../ai/services/memory-core/helpers/identityFoundingStorage.mjs';

const target     = {planeId: 'founding-fixture', dataRoot: '/fixture/founding'};
const publicKey  = generateKeyPairSync('ed25519').publicKey.export({type: 'spki', format: 'der'}).toString('base64url');
const descriptor = trust => ({version: 1, target: {...target}, issuer: 'fixture-fleet',
    reservation: {attemptId: 'attempt-a', kid: 'kid-a', originRunId: '123e4567-e89b-42d3-a456-426614174000'}, trust});
const bootText = stringifyCanonicalJson(descriptor([{kid: 'kid-a', publicKey}]));
let db, bound;

/** @summary Produces detached complete compiler input without importing the live roster. */
function seed(family = 'gpt') {
    return compileFoundingFamilySeed({
        identities: [{id: '@founder', type: 'AgentIdentity', properties: {accountType: 'agent', modelFamily: family}}],
        subjects  : [{identityKey: '@founder', subject: {authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: '101'}}]
    });
}
/** @summary Installs only into this test's in-memory connection. */
const install = (patch = {}) => installIdentityFoundingSource(db,
    {bootText, target, seed: seed(), sourceRevision: 'reviewed-source:fixture', clock: () => 100, ...patch});
/** @summary Takes the required physical snapshot transaction. */
const read = (readTarget = target) => db.transaction(() => readIdentityFoundingSourceInTransaction(db, {target: readTarget})).deferred();
/** @summary Captures retained bytes independently of the new reader. */
const rows = () => db.prepare('SELECT * FROM Nodes ORDER BY id').all();
/** @summary Writes deliberately corrupt fixture bytes without exercising a production writer. */
function corruptSource(change) {
    const id = familyFoundingKey(target), node = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id).data);
    change(node);
    db.prepare('UPDATE Nodes SET data = ? WHERE id = ?').run(stringifyCanonicalJson(node), id);
}

test.beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL); CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);');
    expect(consumeIdentityPublicationBoot(db, stringifyCanonicalJson(descriptor(null)), target).state).toBe('reserved');
    bound = consumeIdentityPublicationBoot(db, bootText, target);
    expect(bound.state).toBe('bound');
});
test.afterEach(() => db.close());

test('installs one canonical detached source with separate revision and no C7 counter', () => {
    const input = structuredClone(seed()), result = install({seed: input});
    expect(result.state).toBe('installed');
    expect(result.source).toEqual({version: 1, target, revision: 1, seed: input,
        provenance: {sourceRevision: 'reviewed-source:fixture', installedAt: 100, issuer: 'fixture-fleet', lineageHead: bound.head}});
    expect(read()).toEqual(result.source);
    expect(db.prepare('SELECT 1 FROM Nodes WHERE id = ?').get(familyPlaneStateKey(target))).toBeUndefined();
    const row = db.prepare('SELECT * FROM Nodes WHERE id = ?').get(familyFoundingKey(target));
    expect(row.user_id).toBeNull();
    expect(row.data).toBe(stringifyCanonicalJson({id: row.id, label: 'IDENTITY_FAMILY_FOUNDING', properties: result.source}));
    input.entries[0].family = 'changed';
    expect(result.source.seed.entries[0].family).toBe('gpt');
    expect(Object.isFrozen(result.source.seed.entries[0].subject)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(familyFoundingKey(target)).not.toBe(familyLineageKey(target));
    expect(familyFoundingKey(target)).not.toBe(familyFoundingKey({planeId: 'another-plane'}));
});

test('a lost-acknowledgement retry retains the original provenance and bytes', () => {
    const first = install(), before = rows();
    expect(install({sourceRevision: 'a-new-caller-reference', clock: () => {throw new Error('retry must not sample installation time');}}))
        .toEqual({state: 'idempotent', source: first.source});
    expect(rows()).toEqual(before);
});

test('a different complete seed conflicts without replacing founding authority', () => {
    install();
    const before = rows();
    expect(install({seed: seed('claude')})).toMatchObject({state: 'conflict', code: 'founding-source-conflict', remedy: 'reviewed-reconciliation'});
    expect(rows()).toEqual(before);
});

test('missing source and reads outside a transaction refuse rather than return emptiness', () => {
    expect(() => read()).toThrow(/founding/i);
    install();
    expect(() => readIdentityFoundingSourceInTransaction(db, {target})).toThrow(/transaction/i);
    let result;
    db.transaction(() => {result = install();}).immediate();
    expect(result).toMatchObject({state: 'unavailable', code: 'founding-transaction-in-progress'});
});

test('unprovisioned or reserve-only configuration cannot install or retry a source', () => {
    for (const value of [null, stringifyCanonicalJson(descriptor(null))]) {
        const before = rows();
        expect(install({bootText: value}).state).toBe('unavailable');
        expect(rows()).toEqual(before);
    }
    expect(install().state).toBe('installed');
    expect(install({bootText: null}).state).toBe('unavailable');
});

test('a wrong target or changed retained lineage never acquires a fresh source', () => {
    install();
    const before = rows();
    expect(install({target: {...target, dataRoot: '/other'}}).state).toBe('unavailable');
    expect(() => read({...target, planeId: 'other-plane'})).toThrow(/founding/i);
    expect(rows()).toEqual(before);
    corruptSource(node => {node.properties.provenance.lineageHead = bound.head.slice(0, -1) + (bound.head.endsWith('0') ? '1' : '0');});
    const corrupted = rows();
    expect(install()).toMatchObject({state: 'unavailable', code: 'founding-lineage-mismatch'});
    expect(rows()).toEqual(corrupted);
});

for (const existing of [false, true]) {
    test('an unrelated malformed founding row refuses the complete census (installed=' + existing + ')', () => {
        if (existing) install();
        db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run('foreign-record',
            stringifyCanonicalJson({id: 'foreign-record', label: 'IDENTITY_FAMILY_FOUNDING', properties: {bad: true}}));
        const before = rows();
        expect(() => read()).toThrow(/founding/i);
        expect(install().state).toBe('unavailable');
        expect(rows()).toEqual(before);
    });
}

test('a malformed payload under the reserved id cannot be overwritten by first install', () => {
    db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(familyFoundingKey(target), '{not-json');
    const before = rows();
    expect(install().state).toBe('unavailable');
    expect(rows()).toEqual(before);
});

for (const [name, id, value] of [
    ['foreign plane', familyFoundingKey({planeId: 'other-plane'}), {id: familyFoundingKey({planeId: 'other-plane'}), label: 'ordinary'}],
    ['embedded reserved id', 'ordinary-physical-id', {id: 'identity-family-founding-orphan', label: 'ordinary'}],
    ['legacy type marker', 'ordinary-physical-id', {id: 'ordinary-physical-id', type: 'IDENTITY_FAMILY_FOUNDING'}]
]) {
    test('first installation cannot conceal a founding candidate selected by ' + name, () => {
        db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id, stringifyCanonicalJson(value));
        const before = rows();
        expect(install().state).toBe('unavailable');
        expect(() => read()).toThrow(/founding/i);
        expect(rows()).toEqual(before);
    });
}

test('a changed retained seed under its old digest refuses the complete physical read', () => {
    expect(install().state).toBe('installed');
    corruptSource(node => {node.properties.seed.entries[0].family = 'claude';});
    const before = rows();
    expect(() => read()).toThrow(/founding/i);
    expect(install().state).toBe('unavailable');
    expect(rows()).toEqual(before);
});

test('a valid empty seed is explicit source rather than missing source', () => {
    const empty = compileFoundingFamilySeed({identities: [], subjects: []});
    expect(install({seed: empty}).state).toBe('installed');
    expect(read().seed).toEqual(empty);
});

test('missing founding data cannot be reinstalled over retained admitted history', () => {
    expect(install().state).toBe('installed');
    const id = familyPlaneStateKey(target);
    db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id,
        stringifyCanonicalJson({id, label: 'IDENTITY_FAMILY_STATE', properties: {revision: 1}}));
    db.prepare('DELETE FROM Nodes WHERE id = ?').run(familyFoundingKey(target));
    const before = rows();
    expect(install()).toMatchObject({state: 'unavailable', code: 'founding-history-unreconciled'});
    expect(rows()).toEqual(before);
    expect(readIdentityPublicationFence(db, target).state).toBe('clear');
});

test('an orphaned protected relation prevents first installation even without another protected node', () => {
    db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)').run(
        'orphaned-relation', 'ordinary-a', 'ordinary-b', 'IDENTITY_FAMILY_HISTORY',
        stringifyCanonicalJson({id: 'orphaned-relation', source: 'ordinary-a', target: 'ordinary-b', type: 'IDENTITY_FAMILY_HISTORY'}));
    const before = rows(), edges = db.prepare('SELECT * FROM Edges').all();
    expect(install()).toMatchObject({state: 'unavailable', code: 'founding-history-unreconciled'});
    expect(rows()).toEqual(before);
    expect(db.prepare('SELECT * FROM Edges').all()).toEqual(edges);
});

test('an installation clock outside the Date range refuses without retaining a source', () => {
    const before = rows();
    expect(install({clock: () => Number.MAX_SAFE_INTEGER})).toMatchObject({state: 'unavailable', code: 'founding-clock-unavailable'});
    expect(rows()).toEqual(before);
});

test('a durable restore fence blocks source reads and retries without changing retained bytes', () => {
    install();
    const before = rows();
    db.transaction(() => fenceIdentityPublication(db, {...target, operation: 'fixture-delete', source: 'fixture', at: 101})).immediate();
    expect(install().state).toBe('unavailable');
    expect(() => read()).toThrow();
    expect(rows()).toEqual(before);
    expect(readIdentityPublicationFence(db, target).state).toBe('fenced');
});

test('a failed installation rolls its record and trigger writes back together', () => {
    db.exec("CREATE TABLE InstallLog (id TEXT); CREATE TRIGGER reject_founder AFTER INSERT ON Nodes WHEN NEW.id LIKE 'identity-family-founding-%' BEGIN INSERT INTO InstallLog VALUES (NEW.id); SELECT RAISE(ABORT, 'fixture interruption'); END;");
    const before = rows();
    expect(install().state).toBe('unavailable');
    expect(rows()).toEqual(before);
    expect(db.prepare('SELECT * FROM InstallLog').all()).toEqual([]);
    expect(readIdentityPublicationFence(db, target).state).toBe('clear');
});

test('malformed source input refuses without invoking accessors or mutating caller data', () => {
    const input = structuredClone(seed());
    let   calls = 0;
    Object.defineProperty(input.entries[0], 'family', {enumerable: true, get() {calls++; return 'gpt';}});
    const before = rows();
    expect(install({seed: input}).state).toBe('unavailable');
    expect(calls).toBe(0);
    expect(rows()).toEqual(before);
    for (const sourceRevision of ['', '  ', null]) expect(install({sourceRevision}).state).toBe('unavailable');
});
