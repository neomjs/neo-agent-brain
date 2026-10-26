import {test, expect}                                                    from '@playwright/test';
import Database                                                          from 'better-sqlite3';
import {generateKeyPairSync, sign}                                       from 'node:crypto';
import {spawn}                                                           from 'node:child_process';
import fs                                                                from 'node:fs';
import os                                                                from 'node:os';
import path                                                              from 'node:path';
import {admitIdentityMembership}                                         from '../../../../../../../ai/services/memory-core/helpers/identityPublicationMembership.mjs';
import {consumeIdentityPublicationBoot}                                  from '../../../../../../../ai/services/memory-core/helpers/identityPublicationLineage.mjs';
import {fenceIdentityPublication}                                        from '../../../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs';
import {familyMembershipKey, familyPlaneStateKey, familySubjectStateKey} from '../../../../../../../ai/services/shared/identityPublicationKeys.mjs';
import {stringifyCanonicalJson}                                          from '../../../../../../../ai/services/shared/canonicalJson.mjs';

const target  = {planeId: 'membership-fixture', dataRoot: '/fixture/membership'};
const key     = generateKeyPairSync('ed25519');
const reserve = {version: 1, target, issuer: 'fixture-fleet',
    reservation: {attemptId: 'fixture-attempt', kid: 'key-a', originRunId: '123e4567-e89b-42d3-a456-426614174000'}, trust: null};
const boot = stringifyCanonicalJson({...reserve,
    trust: [{kid: 'key-a', publicKey: key.publicKey.export({type: 'spki', format: 'der'}).toString('base64url')}]});
const binding = (seatId = 'seat-a', incarnation = 'inc-a', providerUserId = '1') => ({seatId, incarnation,
    subject: {authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId, providerUsername: 'login-' + providerUserId}});
const baseline = (bindings = [binding()], operationId = 'baseline-a') => ({kind: 'baseline', operationId,
    effectiveAt: 90, expectedPlaneRevision: 0, bindings});
const operation = (kind, operationId, targetBinding = binding(), membershipRevision = 1, extra = {}) => ({
    kind, operationId, binding: targetBinding, effectiveAt: 100,
    expectedMembershipRevision: membershipRevision, expectedAdmissionRevision: 0, ...extra
});
let db;

/** @summary Uses independent signing primitives and literal protocol bytes, with test-only keys. */
function token(value, issuedAt = 100, patch = {}) {
    const payload = Buffer.from(stringifyCanonicalJson({version: 1, purpose: 'identity-family-publication',
        audience : target.planeId, issuer: 'fixture-fleet', kid: 'key-a', issuedAt, expiresAt: issuedAt + 300000,
        operation: value, ...patch}));
    return payload.toString('base64url') + '.' + sign(null,
        Buffer.concat([Buffer.from('neo.identity-family-publication.v1\0'), payload]), key.privateKey).toString('base64url');
}
const submit   = (value, at = 100) => admitIdentityMembership(db, token(value, at), {bootText: boot, target, clock: () => at});
const snapshot = () => Object.fromEntries(['Nodes', 'Edges', 'GraphLog', 'IdentityPublicationFence'].map(table =>
    [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
const properties = id => JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id).data).properties;
const members    = () => db.prepare("SELECT data FROM Nodes WHERE json_extract(data, '$.label') = 'IDENTITY_FAMILY_MEMBERSHIP'")
    .all().map(row => JSON.parse(row.data).properties);
const memberId  = value => familyMembershipKey({planeId: target.planeId, ...value});
const subjectId = value => familySubjectStateKey({planeId: target.planeId, subject: value.subject});

test.beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL REFERENCES Nodes(id),
            target TEXT NOT NULL REFERENCES Nodes(id), type TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE GraphLog (log_id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, entity_type TEXT NOT NULL);
        CREATE TRIGGER node_insert AFTER INSERT ON Nodes BEGIN INSERT INTO GraphLog(entity_id, entity_type) VALUES (NEW.id, 'nodes'); END;
        CREATE TRIGGER node_update AFTER UPDATE ON Nodes BEGIN INSERT INTO GraphLog(entity_id, entity_type) VALUES (NEW.id, 'nodes'); END;`);
    expect(consumeIdentityPublicationBoot(db, stringifyCanonicalJson(reserve), target).state).toBe('reserved');
    expect(consumeIdentityPublicationBoot(db, boot, target).state).toBe('bound');
});
test.afterEach(() => db.close());

test('one complete baseline commits all bindings, per-subject counters and its receipt', () => {
    const a      = binding(), b = binding('seat-b', 'inc-b', '2');
    const result = submit(baseline([a, b]));
    expect(result.state).toBe('accepted');
    expect(result.receipt).toMatchObject({kind: 'baseline', revision: 1, admittedAt: 100,
        membershipRevision: null, admissionRevision: null, bindingIds: [memberId(a), memberId(b)]});
    expect(properties(familyPlaneStateKey(target))).toMatchObject({memberCount: 2, subjectCount: 2, revision: 1});
    expect(properties(subjectId(a))).toMatchObject({membershipRevision: 1, admissionRevision: 0, lastBoundary: 100});
    expect(members().every(value => value.retired === null && value.rekeys.length === 0)).toBe(true);
    expect(Object.isFrozen(result.receipt.bindingIds)).toBe(true);
});

test('missing baseline is unavailable, but an explicitly admitted empty census is valid', () => {
    const before = snapshot();
    expect(submit(operation('bind', 'first', binding(), 0)).code).toBe('membership-unknown');
    expect(snapshot()).toEqual(before);
    expect(submit(baseline([])).state).toBe('accepted');
    expect(properties(familyPlaneStateKey(target)).memberCount).toBe(0);
    expect(submit(operation('bind', 'first', binding(), 0), 110).state).toBe('accepted');
});

test('identical re-signed retries return the original receipt before stale state and clock checks', () => {
    const initial = baseline(), first = submit(initial);
    expect(submit(operation('rekey', 'rename', binding(), 1, {newSeatId: 'renamed'}), 110).state).toBe('accepted');
    const before = snapshot();
    expect(submit(initial, 50)).toEqual({state: 'idempotent', receipt: first.receipt});
    expect(snapshot()).toEqual(before);
    expect(submit(baseline([], initial.operationId), 120).code).toBe('logical-operation-conflict');
    expect(submit(baseline([], 'other-baseline'), 120).code).toBe('baseline-already-admitted');
    expect(snapshot()).toEqual(before);
});

test('retry still needs current delivery expiry and an unfenced consumed lineage', () => {
    const value = baseline();
    submit(value);
    const before = snapshot();
    expect(admitIdentityMembership(db, token(value), {bootText: boot, target, clock: () => 300100}).code).toBe('outside-validity');
    expect(snapshot()).toEqual(before);
    db.transaction(() => fenceIdentityPublication(db, {...target, operation: 'fixture-restore', source: 'fixture', at: 110})).immediate();
    expect(submit(value, 120).code).toBe('publication-restore-fenced');
});

test('both revision expectations bind a new operation and stale competitors cannot write', () => {
    submit(baseline());
    const b = binding('seat-b', 'inc-b');
    expect(submit(operation('bind', 'bind-b', b), 110).state).toBe('accepted');
    const before = snapshot();
    expect(submit(operation('bind', 'bind-c', binding('seat-c', 'inc-c')), 120).code).toBe('membership-revision-conflict');
    expect(submit(operation('rekey', 'bad-admission-revision', binding(), 2,
        {newSeatId: 'next', expectedAdmissionRevision: 1}), 120).code).toBe('admission-revision-conflict');
    expect(snapshot()).toEqual(before);
});

test('a second subject starts its own counters while the plane revision covers both', () => {
    submit(baseline());
    const b = binding('seat-b', 'inc-b', '2');
    expect(submit(operation('bind', 'bind-b', b, 0), 110).receipt).toMatchObject({revision: 2, membershipRevision: 1});
    expect(properties(subjectId(binding())).membershipRevision).toBe(1);
    expect(properties(subjectId(b)).membershipRevision).toBe(1);
    expect(properties(familyPlaneStateKey(target)).subjectCount).toBe(2);
});

test('re-key retains original binding bytes and immutable incarnation without a transient retirement', () => {
    const a = binding();
    submit(baseline());
    const before = properties(memberId(a));
    expect(submit(operation('rekey', 'rename', a, 1, {newSeatId: 'renamed'}), 110).state).toBe('accepted');
    const after = properties(memberId(a));
    expect(after.binding).toEqual(before.binding);
    expect(after.bound).toEqual(before.bound);
    expect(after.retired).toBeNull();
    expect(after.rekeys.map(value => value.seatId)).toEqual(['renamed']);
    expect(submit(operation('retire', 'old-key', a, 2, {removal: {operationId: 'remove-a', completedAt: 99, outcome: 'removed'}}), 120).code)
        .toBe('binding-incarnation-mismatch');
    expect(members()).toHaveLength(1);
});

test('renaming onto another active key refuses without changing either member', () => {
    submit(baseline([binding(), binding('seat-b', 'inc-b', '2')]));
    const before = snapshot();
    expect(submit(operation('rekey', 'rename', binding(), 1, {newSeatId: 'seat-b'}), 110).code).toBe('seat-key-already-bound');
    expect(snapshot()).toEqual(before);
});

test('pending removal changes nothing; completed retirement retains history and recreation requires a fresh incarnation', () => {
    submit(baseline());
    const before  = snapshot();
    const pending = operation('retire', 'retire-a', binding(), 1,
        {removal: {operationId: 'remove-a', completedAt: 99, outcome: 'pending'}});
    expect(submit(pending, 110).state).toBe('refused');
    expect(snapshot()).toEqual(before);
    const completed = {...pending, removal: {...pending.removal, outcome: 'removed'}};
    expect(submit(completed, 110).state).toBe('accepted');
    expect(properties(memberId(binding())).retired.admission.admittedAt).toBe(110);
    expect(submit(operation('bind', 'reuse-incarnation', binding(), 2), 120).code).toBe('incarnation-already-admitted');
    expect(submit(operation('bind', 'fresh-incarnation', binding('seat-a', 'fresh-a'), 2), 120).state).toBe('accepted');
    expect(members()).toHaveLength(2);
    expect(members().filter(value => !value.retired)).toHaveLength(1);
});

test('a same-clock or backward-clock new bind creates neither state nor receipt', () => {
    submit(baseline());
    const before = snapshot(), next = operation('bind', 'bind-b', binding('seat-b', 'inc-b'));
    expect(submit(next, 100)).toMatchObject({state: 'conflict', retryable: true, cause: 'same-millisecond', blockingBoundary: 100});
    expect(submit(next, 99)).toMatchObject({state: 'conflict', retryable: true, cause: 'clock-regression', blockingBoundary: 100});
    expect(snapshot()).toEqual(before);
    expect(submit(next, 101).state).toBe('accepted');
});

test('receipt failure rolls back membership, counters and trigger-produced GraphLog together', () => {
    const before = snapshot();
    db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON Nodes
        WHEN json_extract(NEW.data, '$.label') = 'IDENTITY_FAMILY_RECEIPT'
        BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END;`);
    const value = baseline([binding(), binding('seat-b', 'inc-b', '2')]);
    expect(submit(value).state).toBe('unavailable');
    expect(snapshot()).toEqual(before);
    db.exec('DROP TRIGGER reject_receipt');
    expect(submit(value).state).toBe('accepted');
});

test('an outer transaction cannot obtain a rollback-prone accepted receipt', () => {
    const before = snapshot();
    expect(db.transaction(() => submit(baseline())).immediate().code).toBe('publication-transaction-in-progress');
    expect(snapshot()).toEqual(before);
});

test('active capacity remains enforced after baseline and retirement frees only its current slot', () => {
    const all = Array.from({length: 128}, (_, index) => binding('seat-' + index, 'inc-' + index));
    expect(submit(baseline(all)).state).toBe('accepted');
    const before = snapshot();
    expect(submit(operation('bind', 'excess', binding('excess', 'excess')), 110)).toMatchObject({
        code: 'binding-capacity-exceeded', seatCount: 128, limit: 128, seatId: 'excess', remedy: 'correct-or-retire'
    });
    expect(snapshot()).toEqual(before);
    expect(submit(operation('retire', 'retire-one', all[0], 1,
        {removal: {operationId: 'remove-one', completedAt: 99, outcome: 'removed'}}), 120).state).toBe('accepted');
    expect(submit(operation('bind', 'replacement', binding('seat-0', 'replacement'), 2), 130).state).toBe('accepted');
    expect(members()).toHaveLength(129);
    expect(members().filter(value => !value.retired)).toHaveLength(128);
});

test('missing physical membership is unavailable, never a smaller positive set', () => {
    submit(baseline());
    db.prepare('DELETE FROM Nodes WHERE id = ?').run(memberId(binding()));
    const before = snapshot();
    expect(submit(operation('bind', 'new', binding('seat-b', 'inc-b')), 110).state).toBe('unavailable');
    expect(snapshot()).toEqual(before);
});

test('protected labels under an unexpected physical id cannot disappear from baseline completeness', () => {
    db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)').run('unexpected-id',
        stringifyCanonicalJson({id: 'unexpected-id', label: 'IDENTITY_FAMILY_MEMBERSHIP', properties: {}}));
    const before = snapshot();
    expect(submit(baseline([])).state).toBe('unavailable');
    expect(snapshot()).toEqual(before);
});

test('ordinary objects and malformed complete baselines cannot manufacture admission', () => {
    const before = snapshot();
    expect(admitIdentityMembership(db, {authenticated: true, operation: baseline()}, {bootText: boot, target, clock: () => 100}).state)
        .toBe('refused');
    expect(submit(baseline([binding(), null])).state).toBe('refused');
    expect(snapshot()).toEqual(before);
});

test('a canonical but inconsistent receipt cannot substitute different binding evidence on retry', () => {
    const value = baseline();
    submit(value);
    const row  = db.prepare("SELECT id, data FROM Nodes WHERE json_extract(data, '$.label') = 'IDENTITY_FAMILY_RECEIPT'").get();
    const node = JSON.parse(row.data);
    node.properties.result.bindingIds = ['unrelated-binding'];
    db.prepare('UPDATE Nodes SET data = ? WHERE id = ?').run(stringifyCanonicalJson(node), row.id);
    const before = snapshot();
    expect(submit(value, 110).state).toBe('unavailable');
    expect(submit(operation('bind', 'fresh-after-corrupt-receipt', binding('seat-b', 'inc-b')), 110).state).toBe('unavailable');
    expect(snapshot()).toEqual(before);
});

test('retained delivery-window and forward-boundary corruption cannot be hidden by a later maximum', () => {
    submit(baseline());
    const b = binding('seat-b', 'inc-b');
    submit(operation('bind', 'bind-b', b), 110);
    submit(operation('retire', 'retire-a', binding(), 2,
        {removal: {operationId: 'remove-a', completedAt: 99, outcome: 'removed'}}), 120);
    const memberRow  = db.prepare('SELECT id, data FROM Nodes WHERE id = ?').get(memberId(b));
    const receiptRow = db.prepare("SELECT id, data FROM Nodes WHERE json_extract(data, '$.label') = 'IDENTITY_FAMILY_RECEIPT' AND json_extract(data, '$.properties.operationId') = 'bind-b'").get();
    for (const validDeliveryWindow of [false, true]) {
        const memberNode = JSON.parse(memberRow.data), receiptNode = JSON.parse(receiptRow.data);
        memberNode.properties.bound.admittedAt = 100;
        if (validDeliveryWindow) {
            memberNode.properties.bound.issuedAt = 90;
            memberNode.properties.bound.expiresAt = 300090;
        }
        receiptNode.properties.result.admittedAt = 100;
        for (const node of [memberNode, receiptNode]) db.prepare('UPDATE Nodes SET data = ? WHERE id = ?')
            .run(stringifyCanonicalJson(node), node.id);
        const before = snapshot();
        expect(submit(operation('bind', 'fresh-after-bad-time', binding('seat-c', 'inc-c'), 3), 130).state).toBe('unavailable');
        expect(snapshot()).toEqual(before);
    }
});

test('a later subject cannot retain a first bind at the plane baseline boundary', () => {
    submit(baseline());
    const b = binding('seat-b', 'inc-b', '2');
    expect(submit(operation('bind', 'new-subject', b, 0), 110).state).toBe('accepted');
    const member  = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(memberId(b)).data);
    const subject = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(subjectId(b)).data);
    const receipt = JSON.parse(db.prepare("SELECT data FROM Nodes WHERE json_extract(data, '$.label') = 'IDENTITY_FAMILY_RECEIPT' AND json_extract(data, '$.properties.operationId') = 'new-subject'").get().data);
    Object.assign(member.properties.bound, {admittedAt: 100, issuedAt: 90, expiresAt: 300090});
    subject.properties.lastBoundary = 100;
    receipt.properties.result.admittedAt = 100;
    for (const node of [member, subject, receipt]) db.prepare('UPDATE Nodes SET data = ? WHERE id = ?')
        .run(stringifyCanonicalJson(node), node.id);
    const before = snapshot();
    expect(submit(operation('bind', 'after-invalid-first-bind', binding('seat-c', 'inc-c', '2')), 120).state)
        .toBe('unavailable');
    expect(snapshot()).toEqual(before);
});

test('noncanonical owner clock values cannot produce a receipt that JSON silently changes', () => {
    const before = snapshot(), value = {...baseline(), effectiveAt: 0};
    for (const at of [-0, -1, NaN, Infinity, 1.5]) {
        expect(admitIdentityMembership(db, token(value, 0), {bootText: boot, target, clock: () => at}).code)
            .toBe('publication-clock-unavailable');
        expect(snapshot()).toEqual(before);
    }
});

/** @summary Runs the real helper in another process against only this test's explicitly named file. */
function contender(file, bootText, value, servedTarget, mode = 'reply') {
    const script = `
        import Database from 'better-sqlite3';
        import {admitIdentityMembership} from ${JSON.stringify(new URL('../../../../../../../ai/services/memory-core/helpers/identityPublicationMembership.mjs', import.meta.url).href)};
        const [file, bootText, token, target, mode] = process.argv.slice(1);
        const db = new Database(file, {timeout: 10000});
        process.on('message', message => {
            if (message !== 'go') return;
            const result = admitIdentityMembership(db, token, {bootText, target: JSON.parse(target), clock: () => 120});
            if (mode === 'lost-ack') { process.send({committed: result.state === 'accepted'}); return; }
            db.close(); process.send({result}, () => process.exit(0));
        });
        process.send({ready: true});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, bootText,
        token(value, 110), JSON.stringify(servedTarget), mode], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
    let   errors = '', readyDone = false, resultDone = false, resolveReady, rejectReady, resolveResult, rejectResult, resolveExit;
    const ready  = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const exited = new Promise(resolve => { resolveExit = resolve; });
    // Both rejection handlers are attached now, including a result whose ready phase may fail first.
    ready.catch(() => {}); result.catch(() => {});
    child.stdout.on('data', () => {});
    child.stderr.on('data', value => { errors = (errors + value).slice(-4096); });
    const timer = setTimeout(() => {
        const error = new Error('Fixture child timed out: ' + errors);
        rejectReady(error); rejectResult(error); child.kill('SIGKILL');
    }, 15000);
    timer.unref();
    child.on('message', message => {
        if (message.ready) { readyDone = true; resolveReady(); }
        if (message.result || Object.hasOwn(message, 'committed')) { resultDone = true; resolveResult(message); }
    });
    child.once('error', error => { clearTimeout(timer); rejectReady(error); rejectResult(error); resolveExit({code: null, signal: null}); });
    child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (!readyDone) rejectReady(new Error('Fixture child startup failed: ' + errors));
        if (!resultDone) rejectResult(new Error('Fixture child exited before result: ' + errors));
        resolveExit({code, signal});
    });
    return {child, ready, result, exited};
}

/** @summary Copies the already-provisioned disposable fixture into WAL storage, never a served plane. */
async function withWalFixture(body) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-family-wal-'));
    const file = path.join(root, 'graph.sqlite');
    await db.backup(file);
    const connection = new Database(file), children = [];
    try {
        connection.pragma('journal_mode = WAL');
        expect(connection.pragma('journal_mode', {simple: true})).toBe('wal');
        await body({connection, file, children});
    } finally {
        for (const item of children) {
            if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
            await item.exited;
        }
        connection.close();
        fs.rmSync(root, {recursive: true, force: true});
    }
}

test('two WAL processes competing at one revision yield one commit and one conflict', async () => {
    submit(baseline());
    await withWalFixture(async ({connection, file, children}) => {
        for (const name of ['b', 'c']) children.push(contender(file, boot,
            operation('bind', 'bind-' + name, binding('seat-' + name, 'inc-' + name)), target));
        await Promise.all(children.map(item => item.ready));
        children.forEach(item => item.child.send('go'));
        const replies = await Promise.all(children.map(item => item.result));
        expect(replies.map(value => value.result.state).sort()).toEqual(['accepted', 'conflict']);
        expect(replies.find(value => value.result.state === 'conflict').result.code).toBe('membership-revision-conflict');
        const state = JSON.parse(connection.prepare('SELECT data FROM Nodes WHERE id = ?').get(familyPlaneStateKey(target)).data).properties;
        expect(state).toMatchObject({revision: 2, memberCount: 2, subjectCount: 1});
        expect(connection.prepare("SELECT count(*) AS count FROM Nodes WHERE json_extract(data, '$.label') = 'IDENTITY_FAMILY_RECEIPT'").get().count).toBe(2);
        expect(await Promise.all(children.map(item => item.exited))).toEqual([{code: 0, signal: null}, {code: 0, signal: null}]);
    });
});

test('process loss after commit but before delivery preserves the original retry receipt', async () => {
    submit(baseline());
    const value = operation('bind', 'lost-ack', binding('seat-b', 'inc-b'));
    await withWalFixture(async ({file, children}) => {
        const item = contender(file, boot, value, target, 'lost-ack'); children.push(item);
        await item.ready; item.child.send('go');
        expect(await item.result).toEqual({committed: true});
        item.child.kill('SIGKILL');
        expect((await item.exited).signal).toBe('SIGKILL');
        const reopened = new Database(file);
        try {
            const before = reopened.prepare('SELECT * FROM Nodes ORDER BY id').all();
            const replay = admitIdentityMembership(reopened, token(value, 130), {bootText: boot, target, clock: () => 130});
            expect(replay).toMatchObject({state: 'idempotent', receipt: {revision: 2, admittedAt: 120, operationId: 'lost-ack'}});
            expect(reopened.prepare('SELECT * FROM Nodes ORDER BY id').all()).toEqual(before);
        } finally { reopened.close(); }
    });
});
