import {test, expect}                                                         from '@playwright/test';
import Database                                                               from 'better-sqlite3';
import {mkdtempSync, rmSync}                                                  from 'node:fs';
import {tmpdir}                                                               from 'node:os';
import {join}                                                                 from 'node:path';
import {assertIdentityPublicationAbsent, runWithIdentityPublicationPreserved} from '../../../../../ai/graph/identityPublicationProtection.mjs';

let db;

/** @summary Builds a real cascading graph and logs every write for rollback observations. */
function schema(connection) {
    connection.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL, audit_slot INTEGER);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL REFERENCES Nodes(id) ON DELETE CASCADE,
            target TEXT NOT NULL REFERENCES Nodes(id) ON DELETE CASCADE, type TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE GraphLog (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT, operation TEXT);`);
    for (const table of ['Nodes', 'Edges']) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
            const row = operation === 'DELETE' ? 'OLD' : 'NEW';
            connection.exec(`CREATE TRIGGER ${table}_${operation} AFTER ${operation} ON ${table}
                BEGIN INSERT INTO GraphLog(entity_id, operation) VALUES (${row}.id, '${operation}'); END;`);
        }
    }
}
/** @summary Seeds raw fixture data, independent of ordinary production mutation guards. */
function node(id, label = 'ORDINARY', connection = db) {
    connection.prepare('INSERT INTO Nodes (id, user_id, data, audit_slot) VALUES (?, ?, ?, ?)')
        .run(id, 'fixture-owner', JSON.stringify({id, label, properties: {original: true}}), 7);
}
/** @summary Seeds protected and ordinary relations in the actual foreign-key schema. */
function edge(id, source, target, type = 'RELATED_TO', jsonTarget = target) {
    db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'fixture-owner', source, target, type, JSON.stringify({id, source, target: jsonTarget, type}));
}
/** @summary Captures physical columns and log bytes without the production preservation reader. */
const physical = () => Object.fromEntries(['Nodes', 'Edges', 'GraphLog'].map(table =>
    [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
/** @summary Requires the typed refusal and the rollback of all preceding ordinary effects. */
function refused(mutation) {
    const before = physical();
    expect(() => runWithIdentityPublicationPreserved(db, mutation))
        .toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_WRITE_PROTECTED'}));
    expect(physical()).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
}

test.beforeEach(() => {
    db = new Database(':memory:');
    schema(db);
    node('founder', 'IDENTITY_FAMILY_FOUNDING');
    node('historical'); node('ordinary'); node('other');
    edge('history-link', 'founder', 'historical');
});
test.afterEach(() => db.close());

test('ordinary changes commit under the owned transaction with a frozen classification-only context', () => {
    const history = db.prepare('SELECT * FROM Nodes WHERE id = ?').get('historical');
    const result  = runWithIdentityPublicationPreserved(db, context => {
        expect(db.inTransaction).toBe(true);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.keys(context).sort()).toEqual(['isHistoricalEndpoint', 'isProtectedEdge', 'isProtectedNode']);
        expect(context.isProtectedNode('founder')).toBe(true);
        expect(context.isProtectedNode('ordinary')).toBe(false);
        expect(context.isProtectedEdge('history-link')).toBe(true);
        expect(context.isHistoricalEndpoint('historical')).toBe(true);
        expect(context.isHistoricalEndpoint('ordinary')).toBe(false);
        expect(() => {context.isProtectedNode = () => false;}).toThrow();
        db.prepare('UPDATE Nodes SET user_id = ? WHERE id = ?').run('new-owner', 'ordinary');
        return {changed: 1};
    });
    expect(result).toEqual({changed: 1});
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT user_id FROM Nodes WHERE id = ?').get('ordinary').user_id).toBe('new-owner');
    expect(db.prepare('SELECT * FROM Nodes WHERE id = ?').get('historical')).toEqual(history);
});

test('late protected node corruption rolls back ordinary writes and their GraphLog entries', () => {
    refused(() => {
        db.prepare('UPDATE Nodes SET user_id = ? WHERE id = ?').run('new-owner', 'ordinary');
        db.prepare('UPDATE Nodes SET user_id = ? WHERE id = ?').run('forged-owner', 'founder');
    });
});

test('protected JSON bytes cannot change even when their parsed meaning is identical', () => {
    refused(() => db.prepare("UPDATE Nodes SET data = ' ' || data WHERE id = ?").run('founder'));
});

test('all physical columns are preserved, including columns beyond the current graph DTO', () => {
    refused(() => db.prepare('UPDATE Nodes SET audit_slot = 8 WHERE id = ?').run('founder'));
});

for (const column of ['data', 'user_id']) {
    test('different raw TEXT bytes cannot hide behind the same decoded string in ' + column, () => {
        const original = column === 'data'
            ? JSON.stringify({id: 'founder', label: 'IDENTITY_FAMILY_FOUNDING', properties: {text: String.fromCodePoint(0xfffd)}})
            : String.fromCodePoint(0xfffd);
        db.prepare('UPDATE Nodes SET ' + column + ' = ? WHERE id = ?').run(original, 'founder');
        const bytes = Buffer.from(original).toString('hex');
        refused(() => db.prepare('UPDATE Nodes SET ' + column + ' = CAST(? AS TEXT) WHERE id = ?')
            .run(Buffer.from(bytes.replace('efbfbd', '80'), 'hex'), 'founder'));
        expect(db.prepare('SELECT hex(CAST(' + column + ' AS BLOB)) AS bytes FROM Nodes WHERE id = ?').get('founder').bytes)
            .toBe(bytes.toUpperCase());
    });
}

test('distinct SQLite integers cannot hide behind the same JavaScript number', () => {
    db.prepare('UPDATE Nodes SET audit_slot = ? WHERE id = ?').run(9007199254740992n, 'founder');
    refused(() => db.prepare('UPDATE Nodes SET audit_slot = ? WHERE id = ?').run(9007199254740993n, 'founder'));
    expect(db.prepare('SELECT CAST(audit_slot AS TEXT) AS value FROM Nodes WHERE id = ?').get('founder').value)
        .toBe('9007199254740992');
});

test('a non-object protected payload refuses before the callback', () => {
    db.prepare('UPDATE Edges SET data = ? WHERE id = ?').run('[]', 'history-link');
    let calls = 0;
    refused(() => {calls++;});
    expect(calls).toBe(0);
});

test('relabeling a protected node cannot remove it from the after-census', () => {
    refused(() => db.prepare("UPDATE Nodes SET data = json_set(data, '$.label', 'ORDINARY') WHERE id = ?").run('founder'));
});

test('a protected edge cannot change its physical endpoint or user column', () => {
    for (const sql of ["UPDATE Edges SET target = 'other' WHERE id = 'history-link'",
        "UPDATE Edges SET user_id = 'forged' WHERE id = 'history-link'"]) {
        refused(() => db.exec(sql));
    }
});

test('deleting a historical endpoint cannot cascade protected edges away', () => {
    refused(() => {
        db.prepare('DELETE FROM Nodes WHERE id = ?').run('ordinary');
        db.prepare('DELETE FROM Nodes WHERE id = ?').run('historical');
    });
});

test('historical endpoint bytes are preserved even when no protected record itself changes', () => {
    refused(() => db.prepare('UPDATE Nodes SET user_id = ? WHERE id = ?').run('changed', 'historical'));
});

test('a mixed ordinary migration cannot manufacture a new protected node', () => {
    refused(() => {
        node('permitted-new');
        node('identity-family-new', 'ORDINARY');
    });
});

test('a new protected relation is found even between previously ordinary endpoints', () => {
    refused(() => edge('new-protected', 'ordinary', 'other', 'IDENTITY_FAMILY_DECLARATION'));
});

test('ordinary callback failure rolls back effects and retains the original error', () => {
    const error = new Error('fixture callback failure'), before = physical();
    expect(() => runWithIdentityPublicationPreserved(db, () => {
        node('before-error');
        throw error;
    })).toThrow(error);
    expect(physical()).toEqual(before);
});

test('an outer transaction refuses before invoking the callback', () => {
    let calls = 0;
    db.transaction(() => {
        expect(() => runWithIdentityPublicationPreserved(db, () => {calls++;}))
            .toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_WRITE_PROTECTED'}));
    }).immediate();
    expect(calls).toBe(0);
});

test('an async callback refuses before its synchronous prefix can write', () => {
    let calls = 0;
    refused(async () => {calls++; node('async-prefix');});
    expect(calls).toBe(0);
});

test('a thenable callback result refuses and rolls back its synchronous effects', () => {
    refused(() => {
        node('before-thenable');
        return {then() {throw new Error('must not call then');}};
    });
});

test('JSON endpoint aliases are retained in addition to physical foreign-key endpoints', () => {
    node('json-history');
    edge('dual-reference', 'founder', 'historical', 'RELATED_TO', 'json-history');
    refused(context => {
        expect(context.isHistoricalEndpoint('json-history')).toBe(true);
        db.prepare('DELETE FROM Nodes WHERE id = ?').run('json-history');
    });
});

test('an incomplete historical endpoint census refuses before the callback', () => {
    edge('dangling-json-reference', 'founder', 'historical', 'RELATED_TO', 'missing-json-history');
    let calls = 0;
    refused(() => {calls++;});
    expect(calls).toBe(0);
});


test.describe('fixed publication-absence policy', () => {
    test.beforeEach(() => { db.close(); db = new Database(':memory:'); });

    /** @summary Runs the read-only absence check under its caller's physical transaction. */
    const assertAbsent = () => db.transaction(() => assertIdentityPublicationAbsent(db)).immediate();

    test('requires an active physical transaction and accepts a fresh target without creating tables', () => {
        expect(() => assertIdentityPublicationAbsent(db))
            .toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_TRANSACTION_REQUIRED'}));
        const before = db.prepare('SELECT * FROM sqlite_master').all();
        expect(assertAbsent).not.toThrow();
        expect(db.prepare('SELECT * FROM sqlite_master').all()).toEqual(before);
    });

    test('an ordinary complete graph remains unchanged', () => {
        schema(db); node('a'); node('b'); edge('ordinary', 'a', 'b');
        const before = physical();
        expect(assertAbsent).not.toThrow();
        expect(physical()).toEqual(before);
    });

    for (const kind of ['node', 'edge', 'fence']) {
        test('refuses ' + kind + ' publication state without changing graph bytes', () => {
            schema(db); node('a'); node('b');
            if (kind === 'node') node('identity-family-history');
            if (kind === 'edge') edge('protected', 'a', 'b', 'IDENTITY_FAMILY_DECLARES');
            if (kind === 'fence') db.exec('CREATE TABLE IdentityPublicationFence (data TEXT)');
            const before = physical();
            expect(assertAbsent).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED'}));
            expect(physical()).toEqual(before);
        });
    }

    test('a fence without either graph table still requires recovery', () => {
        db.exec('CREATE TABLE IdentityPublicationFence (data TEXT)');
        expect(assertAbsent).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED'}));
    });

    test('SQLite case-insensitive graph names cannot hide protected history', () => {
        db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL, audit_slot INTEGER);
            CREATE TABLE edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT);`);
        node('identity-family-history');
        expect(assertAbsent).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED'}));
    });

    test('SQLite case-insensitive fence names cannot appear absent', () => {
        db.exec('CREATE TABLE identitypublicationfence (data TEXT)');
        expect(assertAbsent).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED'}));
    });

    test('partial schemas and graph names occupied by views are unavailable', () => {
        db.exec('CREATE TABLE Nodes (id TEXT, data TEXT)');
        expect(assertAbsent).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE'}));
        db.exec('DROP TABLE Nodes; CREATE VIEW Nodes AS SELECT 1 AS id; CREATE VIEW Edges AS SELECT 1 AS id;');
        expect(assertAbsent).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE'}));
    });

    test('malformed and non-object node or edge payloads cannot prove absence', () => {
        schema(db); node('a'); node('b'); edge('ordinary', 'a', 'b');
        for (const [table, id] of [['Nodes', 'a'], ['Edges', 'ordinary']]) {
            const original = db.prepare('SELECT data FROM ' + table + ' WHERE id = ?').get(id).data;
            for (const data of ['{invalid', 'null', '[]', '"opaque"', '0']) {
                db.prepare('UPDATE ' + table + ' SET data = ? WHERE id = ?').run(data, id);
                const before = physical();
                expect(assertAbsent).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE'}));
                expect(physical()).toEqual(before);
                db.prepare('UPDATE ' + table + ' SET data = ? WHERE id = ?').run(original, id);
            }
        }
    });
});

test('the immediate transaction excludes a competing WAL writer before the first census', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-publication-preservation-'));
    const file      = join(directory, 'graph.sqlite'), owner = new Database(file), peer = new Database(file, {timeout: 1});
    try {
        owner.pragma('journal_mode = WAL');
        schema(owner); node('ordinary', 'ORDINARY', owner);
        const prepare   = owner.prepare.bind(owner);
        let   inspected = false;
        owner.prepare = sql => {
            if (!inspected && /^SELECT/.test(sql)) {
                inspected = true;
                expect(() => peer.prepare("UPDATE Nodes SET user_id = 'peer' WHERE id = 'ordinary'").run())
                    .toThrow('database is locked');
            }
            return prepare(sql);
        };
        try {
            runWithIdentityPublicationPreserved(owner, () => owner.prepare("UPDATE Nodes SET user_id = 'owner' WHERE id = 'ordinary'").run());
        } finally {owner.prepare = prepare;}
        expect(inspected).toBe(true);
        expect(peer.prepare('SELECT user_id FROM Nodes WHERE id = ?').get('ordinary').user_id).toBe('owner');
    } finally {
        peer.close(); owner.close(); rmSync(directory, {recursive: true, force: true});
    }
});
