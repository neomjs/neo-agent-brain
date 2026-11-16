import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    SUBJECT_BINDING_TABLE,
    activateSubjectBinding,
    bindAdministratively,
    bindAtFirstAdmission,
    readIdentityBinding,
    readSubjectBinding,
    readSubjectBindingActivation
} from '../../../../../../../ai/services/memory-core/helpers/subjectBinding.mjs';

const
    GITHUB = 'https://api.github.com',
    S      = Object.freeze({authProvider: 'github', providerBaseUrl: GITHUB, providerUserId: '1001'}),
    T      = Object.freeze({authProvider: 'github', providerBaseUrl: GITHUB, providerUserId: '2002'});

let root, db;

test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'subject-binding-'));
    db   = new Database(path.join(root, 'graph.sqlite'));
    db.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);`);
});

test.afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(root, {recursive: true, force: true});
});

/** @summary Runs one writer inside its own physical transaction, as its production caller does. */
const inTransaction = fn => db.transaction(fn)();

/** @summary Counts stored bindings, so a refusal can prove it wrote nothing. */
const count = () => db.prepare(`SELECT COUNT(*) AS n FROM ${SUBJECT_BINDING_TABLE}`).get().n;

test.describe('ai/services/memory-core/helpers/subjectBinding', () => {
    test('a plane with no relation reads every subject and identity as unbound, and selection as dormant', () => {
        expect(readSubjectBinding(db, S)).toBeNull();
        expect(readIdentityBinding(db, '@ada')).toBeNull();
        expect(readSubjectBindingActivation(db)).toBeNull();
    });

    test('first admission binds the identity its transaction created, and only inside that transaction', () => {
        expect(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}))
            .toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_TRANSACTION_REQUIRED'}));
        expect(readSubjectBinding(db, S)).toBeNull();

        const result = inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));

        expect(result.state).toBe('bound');
        expect(result.binding).toEqual({...S, identityId: '@ada', writer: 'first-admission', foundingRevision: null, boundAt: 10});
        expect(Object.isFrozen(result.binding)).toBe(true);
        expect(readIdentityBinding(db, '@ada')).toEqual(result.binding);
    });

    test('re-presenting a matching binding returns it without a write', () => {
        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));

        const again = inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 99}));

        expect(again.state).toBe('matching');
        expect(again.binding.boundAt).toBe(10);
        expect(count()).toBe(1);
    });

    test('a bound subject cannot act as another identity: the refusal names the bound one and writes nothing', () => {
        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));

        let error;
        try {
            inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@other', at: 11}));
        } catch (e) {
            error = e;
        }

        expect(error.code).toBe('SUBJECT_BINDING_SUBJECT_CLAIMED');
        expect(error.identityId).toBe('@ada');
        expect(error.message).toContain('@ada');
        expect(readIdentityBinding(db, '@other')).toBeNull();
        expect(count()).toBe(1);
    });

    test('a re-registered login gets nothing: an identity bound to one subject refuses a second subject', () => {
        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));

        for (const write of [
            () => bindAtFirstAdmission(db, {subject: T, identityId: '@ada', at: 11}),
            () => bindAdministratively(db, {subject: T, identityId: '@ada', foundingRevision: 'rev-1', at: 11})
        ]) {
            expect(() => inTransaction(write)).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_IDENTITY_CLAIMED', identityId: '@ada'}));
        }

        expect(readSubjectBinding(db, T)).toBeNull();
        expect(readSubjectBinding(db, S).identityId).toBe('@ada');
    });

    test('an administrative bind binds an existing identity and records its founding revision', () => {
        expect(() => inTransaction(() => bindAdministratively(db, {subject: S, identityId: '@ada', at: 10})))
            .toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_INVALID'}));

        const result = inTransaction(() => bindAdministratively(db, {subject: S, identityId: '@ada', foundingRevision: 'rev-1', at: 10}));

        expect(result.state).toBe('bound');
        expect(result.binding).toEqual({...S, identityId: '@ada', writer: 'administrative', foundingRevision: 'rev-1', boundAt: 10});
    });

    test('an administrative endpoint move keeps the identity; first admission never moves one', () => {
        const moved = {...S, providerBaseUrl: 'https://github.example.com/api/v3'};

        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));

        expect(() => inTransaction(() => bindAtFirstAdmission(db, {subject: moved, identityId: '@ada', at: 11})))
            .toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_IDENTITY_CLAIMED'}));

        const result = inTransaction(() => bindAdministratively(db, {subject: moved, identityId: '@ada', foundingRevision: 'rev-2', at: 12}));

        expect(result.state).toBe('moved');
        expect(result.previous.providerBaseUrl).toBe(GITHUB);
        expect(readSubjectBinding(db, S)).toBeNull();
        expect(readSubjectBinding(db, moved).identityId).toBe('@ada');
        expect(count()).toBe(1);
    });

    test('a different account at the same endpoint is not an endpoint move', () => {
        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));

        expect(() => inTransaction(() => bindAdministratively(db, {subject: T, identityId: '@ada', foundingRevision: 'rev-3', at: 11})))
            .toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_IDENTITY_CLAIMED'}));
        expect(readSubjectBinding(db, S).identityId).toBe('@ada');
    });

    test('an incomplete subject is nonqualifying and binds nothing', () => {
        for (const subject of [null, {}, {...S, providerUserId: ''}, {...S, providerBaseUrl: undefined}, {...S, authProvider: ' github'}]) {
            expect(() => inTransaction(() => bindAtFirstAdmission(db, {subject, identityId: '@ada', at: 10})))
                .toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_INVALID'}));
            expect(() => readSubjectBinding(db, subject)).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_INVALID'}));
        }
        expect(readIdentityBinding(db, '@ada')).toBeNull();
    });

    test('activation stays absent until the cutover records it, and the first record holds', () => {
        expect(() => activateSubjectBinding(db, {cutoverRevision: 'cut-1', at: 10}))
            .toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_TRANSACTION_REQUIRED'}));
        expect(readSubjectBindingActivation(db)).toBeNull();

        inTransaction(() => activateSubjectBinding(db, {cutoverRevision: 'cut-1', at: 10}));
        inTransaction(() => activateSubjectBinding(db, {cutoverRevision: 'cut-2', at: 20}));

        expect(readSubjectBindingActivation(db)).toEqual({cutoverRevision: 'cut-1', activatedAt: 10});
    });

    test('the relation sits outside the graph populations: clearing Nodes and Edges leaves it', () => {
        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));
        db.exec('DELETE FROM Nodes; DELETE FROM Edges;');

        expect(readSubjectBinding(db, S).identityId).toBe('@ada');
    });

    test('a malformed stored row reads as unavailable, never as a binding', () => {
        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));
        db.prepare(`UPDATE ${SUBJECT_BINDING_TABLE} SET foundingRevision = 'forged'`).run();

        expect(() => readSubjectBinding(db, S)).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_UNAVAILABLE'}));
    });
});
