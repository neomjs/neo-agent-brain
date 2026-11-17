import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {importGraphJsonl} from '../../../../../../../ai/services/memory-core/helpers/graphJsonlImport.mjs';
import {
    SUBJECT_BINDING_ACTIVATION_RECORD,
    SUBJECT_BINDING_RECORD,
    SUBJECT_BINDING_TABLE,
    activateSubjectBinding,
    bindAdministratively,
    bindAtFirstAdmission,
    isSubjectSelectionActive,
    readIdentityBinding,
    readSubjectBinding,
    readSubjectBindingActivation,
    readSubjectBindingRecords,
    renameBoundIdentities,
    restoreSubjectBindingRecord
} from '../../../../../../../ai/services/memory-core/helpers/subjectBinding.mjs';

const
    GITHUB = 'https://api.github.com',
    S      = Object.freeze({authProvider: 'github', providerBaseUrl: GITHUB, providerUserId: '1001'}),
    T      = Object.freeze({authProvider: 'github', providerBaseUrl: GITHUB, providerUserId: '2002'});

let root, db;

/** @summary Opens a graph file with the Nodes/Edges populations a restore writes. */
const openGraph = name => {
    const graph = new Database(path.join(root, name));
    graph.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);`);
    return graph;
};

test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'subject-binding-'));
    db   = openGraph('graph.sqlite');
});

test.afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(root, {recursive: true, force: true});
});

/** @summary Runs one writer inside its own physical transaction, as its production caller does. */
const inTransaction = fn => db.transaction(fn)();

/** @summary Counts stored bindings, so a refusal can prove it wrote nothing. */
const count = () => db.prepare(`SELECT COUNT(*) AS n FROM ${SUBJECT_BINDING_TABLE}`).get().n;

/** @summary A binding row as a bundle carries it. */
const row = (subject, identityId, boundAt = 10) => ({...subject, identityId, writer: 'first-admission', foundingRevision: null, formerBaseUrls: [], boundAt});

/** @summary Writes records as a graph bundle file and returns its path. */
const bundle = records => {
    const file = path.join(root, `bundle-${fs.readdirSync(root).length}.jsonl`);
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    return file;
};

/** @summary Restores a bundle through the graph importer with a no-op fence, as disposable staging does. */
const restore = (filePath, mode, warnings = []) =>
    importGraphJsonl({db, filePath, mode, beforeMutation: () => {}, warn: message => warnings.push(message)});

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
        expect(result.binding).toEqual({...S, identityId: '@ada', writer: 'first-admission', foundingRevision: null, formerBaseUrls: [], boundAt: 10});
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
        expect(result.binding).toEqual({...S, identityId: '@ada', writer: 'administrative', foundingRevision: 'rev-1', formerBaseUrls: [], boundAt: 10});
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
        expect(readSubjectBinding(db, moved), 'the row keeps the endpoint it left').toMatchObject({identityId: '@ada', formerBaseUrls: [GITHUB]});
        expect(Object.isFrozen(readSubjectBinding(db, moved).formerBaseUrls)).toBe(true);
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

    test('selection reads active or known dormant, and a connection that cannot answer throws instead of reading dormant', () => {
        expect(isSubjectSelectionActive(db), 'no record').toBe(false);

        for (const connection of [null, undefined, {open: false}]) {
            expect(() => isSubjectSelectionActive(connection)).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_UNAVAILABLE'}));
        }

        inTransaction(() => activateSubjectBinding(db, {cutoverRevision: 'cut-1', at: 10}));
        expect(isSubjectSelectionActive(db)).toBe(true);
    });

    test('the relation sits outside the graph populations: clearing Nodes and Edges leaves it', () => {
        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));
        db.exec('DELETE FROM Nodes; DELETE FROM Edges;');

        expect(readSubjectBinding(db, S).identityId).toBe('@ada');
    });

    test('an identity rename carries each binding to its new id, and a swap passes', () => {
        const U = {...S, providerUserId: '3003'};

        expect(inTransaction(() => renameBoundIdentities(db, id => id))).toBe(0);

        inTransaction(() => {
            bindAtFirstAdmission(db, {subject: S, identityId: '@a', at: 10});
            bindAtFirstAdmission(db, {subject: T, identityId: '@b', at: 10});
            bindAtFirstAdmission(db, {subject: U, identityId: '@c', at: 10});
        });

        const swap  = {'@a': '@b', '@b': '@a'},
              moved = inTransaction(() => renameBoundIdentities(db, id => swap[id] ?? id));

        expect(moved).toBe(2);
        expect(readSubjectBinding(db, S).identityId).toBe('@b');
        expect(readSubjectBinding(db, T).identityId).toBe('@a');
        expect(readSubjectBinding(db, U).identityId).toBe('@c');
        expect(() => renameBoundIdentities(db, id => id)).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_TRANSACTION_REQUIRED'}));
    });

    test('a rename that merges two bound identities refuses, and the migration changes nothing', () => {
        inTransaction(() => {
            bindAtFirstAdmission(db, {subject: S, identityId: '@a', at: 10});
            bindAtFirstAdmission(db, {subject: T, identityId: '@b', at: 10});
        });

        expect(() => inTransaction(() => renameBoundIdentities(db, id => id === '@a' ? '@b' : id)))
            .toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_IDENTITY_CLAIMED', identityId: '@b'}));
        expect(readSubjectBinding(db, S).identityId).toBe('@a');
        expect(readSubjectBinding(db, T).identityId).toBe('@b');
    });

    test('a malformed stored row reads as unavailable, never as a binding', () => {
        inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));
        db.prepare(`UPDATE ${SUBJECT_BINDING_TABLE} SET foundingRevision = 'forged'`).run();

        expect(() => readSubjectBinding(db, S)).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_UNAVAILABLE'}));
        expect(() => readSubjectBindingRecords(db)).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_UNAVAILABLE'}));
    });

    test.describe('a graph bundle carries the relation', () => {
        test('the relation exports as its own records: every binding, then the activation', () => {
            expect(readSubjectBindingRecords(db)).toEqual([]);

            inTransaction(() => {
                bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10});
                bindAdministratively(db, {subject: T, identityId: '@grace', foundingRevision: 'rev-1', at: 11});
                activateSubjectBinding(db, {cutoverRevision: 'cut-1', at: 12});
            });

            expect(readSubjectBindingRecords(db)).toEqual([
                {type: SUBJECT_BINDING_RECORD, data: row(S, '@ada')},
                {type: SUBJECT_BINDING_RECORD, data: {...T, identityId: '@grace', writer: 'administrative', foundingRevision: 'rev-1', formerBaseUrls: [], boundAt: 11}},
                {type: SUBJECT_BINDING_ACTIVATION_RECORD, data: {cutoverRevision: 'cut-1', activatedAt: 12}}
            ]);
        });

        test('a round trip into a fresh graph keeps every binding and the activation', async () => {
            inTransaction(() => {
                bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10});
                activateSubjectBinding(db, {cutoverRevision: 'cut-1', at: 12});
            });

            const file = bundle([{type: 'node', data: {id: '@ada'}}, ...readSubjectBindingRecords(db)]);

            db.close();
            db = openGraph('fresh.sqlite');

            const {counts} = await restore(file, 'replace');

            expect(counts.subjectBindings).toEqual({inserted: 2, skippedExisting: 0, failed: 0});
            expect(readSubjectBinding(db, S)).toEqual(row(S, '@ada'));
            expect(readSubjectBindingActivation(db)).toEqual({cutoverRevision: 'cut-1', activatedAt: 12});
        });

        test('replace keeps the target relation when the bundle carries none, as an older bundle does', async () => {
            inTransaction(() => bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10}));

            const {counts} = await restore(bundle([{type: 'node', data: {id: '@ada'}}]), 'replace');

            expect(counts.subjectBindings).toEqual({inserted: 0, skippedExisting: 0, failed: 0});
            expect(readSubjectBinding(db, S).identityId).toBe('@ada');
        });

        test('replace swaps the binding rows for the bundle\'s, and the activation only ever moves forward', async () => {
            inTransaction(() => {
                bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10});
                activateSubjectBinding(db, {cutoverRevision: 'cut-1', at: 12});
            });

            await restore(bundle([
                {type: SUBJECT_BINDING_RECORD, data: row(T, '@grace', 20)},
                {type: SUBJECT_BINDING_ACTIVATION_RECORD, data: {cutoverRevision: 'cut-0', activatedAt: 5}}
            ]), 'replace');

            expect(readSubjectBinding(db, S)).toBeNull();
            expect(readSubjectBinding(db, T)).toEqual(row(T, '@grace', 20));
            expect(readSubjectBindingActivation(db)).toEqual({cutoverRevision: 'cut-1', activatedAt: 12});
        });

        test('merge restores the relation as one unit: one conflicting record refuses every record, and the target keeps its own', async () => {
            const
                warnings    = [],
                conflicting = [
                    {type: SUBJECT_BINDING_RECORD, data: row(S, '@ada', 10)},
                    {type: SUBJECT_BINDING_RECORD, data: row(T, '@grace', 13)},
                    {type: SUBJECT_BINDING_RECORD, data: row(S, '@mallory', 11)}
                ];

            inTransaction(() => {
                bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10});
                activateSubjectBinding(db, {cutoverRevision: 'cut-1', at: 12});
            });

            const {counts} = await restore(bundle(conflicting), 'merge', warnings);

            expect(counts.subjectBindings).toEqual({inserted: 0, skippedExisting: 0, failed: 3});
            expect(readSubjectBinding(db, S).identityId).toBe('@ada');
            expect(readSubjectBinding(db, T), 'the valid row before the conflict is rolled back with it').toBeNull();
            expect(readIdentityBinding(db, '@mallory')).toBeNull();
            expect(readSubjectBindingActivation(db)).toEqual({cutoverRevision: 'cut-1', activatedAt: 12});
            expect(warnings).toEqual([expect.stringContaining('@ada')]);

            // without the conflict, an identical row is skipped and a new one inserted
            const {counts: clean} = await restore(bundle(conflicting.slice(0, 2)), 'merge');

            expect(clean.subjectBindings).toEqual({inserted: 1, skippedExisting: 1, failed: 0});
            expect(readSubjectBinding(db, T).identityId).toBe('@grace');
        });

        test('a refused replace keeps the target relation and activation whole', async () => {
            inTransaction(() => {
                bindAtFirstAdmission(db, {subject: S, identityId: '@ada', at: 10});
                activateSubjectBinding(db, {cutoverRevision: 'cut-1', at: 12});
            });

            // the bundle binds one identity to two subjects
            const {counts} = await restore(bundle([
                {type: SUBJECT_BINDING_RECORD, data: row(T, '@grace', 20)},
                {type: SUBJECT_BINDING_RECORD, data: row({...T, providerUserId: '999'}, '@grace', 21)}
            ]), 'replace');

            expect(counts.subjectBindings).toEqual({inserted: 0, skippedExisting: 0, failed: 2});
            expect(readSubjectBinding(db, S), 'the replace cleared nothing').toEqual(row(S, '@ada'));
            expect(readSubjectBinding(db, T)).toBeNull();
            expect(readSubjectBindingActivation(db)).toEqual({cutoverRevision: 'cut-1', activatedAt: 12});
        });

        test('a malformed record never becomes a binding or an activation', async () => {
            expect(() => restoreSubjectBindingRecord(db, {type: SUBJECT_BINDING_RECORD, data: row(S, '@ada')}))
                .toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_TRANSACTION_REQUIRED'}));

            const {counts} = await restore(bundle([
                {type: SUBJECT_BINDING_RECORD, data: {...row(S, '@ada'), foundingRevision: 'forged'}},
                {type: SUBJECT_BINDING_RECORD, data: {...row(S, '@ada'), writer: 'tool-payload'}},
                {type: SUBJECT_BINDING_RECORD, data: {...row(S, '@ada'), extra: true}},
                {type: SUBJECT_BINDING_RECORD, data: {authProvider: 'github', identityId: '@ada', writer: 'first-admission', foundingRevision: null, boundAt: 10}},
                // only an administrative move leaves an endpoint, and never the current one or the same one twice
                {type: SUBJECT_BINDING_RECORD, data: {...row(S, '@ada'), formerBaseUrls: ['https://old.example']}},
                {type: SUBJECT_BINDING_RECORD, data: {...row(S, '@ada'), writer: 'administrative', foundingRevision: 'rev-1', formerBaseUrls: [S.providerBaseUrl]}},
                {type: SUBJECT_BINDING_RECORD, data: {...row(S, '@ada'), writer: 'administrative', foundingRevision: 'rev-1', formerBaseUrls: ['https://old.example', 'https://old.example']}},
                {type: SUBJECT_BINDING_ACTIVATION_RECORD, data: {cutoverRevision: '', activatedAt: 10}}
            ]), 'merge');

            expect(counts.subjectBindings).toEqual({inserted: 0, skippedExisting: 0, failed: 8});
            expect(readSubjectBinding(db, S)).toBeNull();
            expect(readSubjectBindingActivation(db)).toBeNull();
        });
    });
});
