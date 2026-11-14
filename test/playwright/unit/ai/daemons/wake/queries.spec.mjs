import { test, expect } from '@playwright/test';
import Database         from 'better-sqlite3';
import fs               from 'fs-extra';
import os               from 'os';
import path             from 'path';
import {
    collapseDuplicateShapeCRoutes,
    getGraphLogEntries,
    getLastSyncId,
    getUnreadSunsetHandovers,
    markNodesAsRead,
    markSunsetHandoversSummaryProcessed,
    writeSunsetFocusItemsReceipt,
    writeLastSyncId
} from '../../../../../../ai/daemons/wake/queries.mjs';

test.describe('ai/daemons/wake/queries', () => {
    let db;

    test.beforeEach(() => {
        // We use an in-memory database for testing the pure query logic
        db = new Database(':memory:');
        db.exec(`
            CREATE TABLE Nodes (
                id TEXT PRIMARY KEY,
                data TEXT
            )
        `);
    });

    test.afterEach(() => {
        if (db) {
            try { db.close(); } catch (e) {}
        }
    });

    // A message node as the store writes it: `{id, label, properties}`, no `type`
    const SINCE    = '2026-11-14T12:00:00.000Z',
          handover = (id, properties = {}, label = 'MESSAGE') => ({id, label, properties: {
              sentAt: '2026-11-14T15:17:47.449Z', taggedConcepts: ['sunset-protocol-handover'], ...properties
          }}),
          insert   = node => db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(node.id, JSON.stringify(node)),
          read     = () => getUnreadSunsetHandovers(db, {sinceIso: SINCE});

    test.describe('getUnreadSunsetHandovers', () => {
        test('finds an unread handover in the shape the store writes', () => {
            insert(handover('MESSAGE:1', {taggedConcepts: ['sunset-protocol-handover', 'other-concept']}));

            expect(read().map(node => node.id)).toEqual(['MESSAGE:1']);
            expect(read()[0].label).toBe('MESSAGE');
        });

        test('leaves a handover sent before the bound: no rotation can act on it any more', () => {
            insert(handover('MESSAGE:old', {sentAt: '2026-06-20T03:31:45.548Z'}));
            insert(handover('MESSAGE:edge', {sentAt: SINCE}));

            expect(read().map(node => node.id)).toEqual(['MESSAGE:edge']);
        });

        test('ignores a read handover', () => {
            insert(handover('MESSAGE:1', {readAt: new Date().toISOString()}));

            expect(read()).toEqual([]);
        });

        test('ignores summary-processed handovers without marking recipient readAt', () => {
            insert(handover('MESSAGE:1', {handoverSummaryProcessedAt: new Date().toISOString(), readAt: null}));

            expect(read()).toEqual([]);
        });

        test('ignores a message without the taggedConcept', () => {
            insert(handover('MESSAGE:1', {taggedConcepts: ['some-other-concept']}));

            expect(read()).toEqual([]);
        });

        test('ignores a node that is not a message', () => {
            insert(handover('EPISODIC:1', {}, 'EPISODIC'));

            expect(read()).toEqual([]);
        });
    });

    test.describe('markSunsetHandoversSummaryProcessed', () => {
        test('receipt and completion preserve intervening recipient and other property writes', () => {
            const node = handover('MESSAGE:stale', {readAt: null, extra: 'before'});
            insert(node);
            const stale = read()[0];
            db.prepare("UPDATE Nodes SET data = json_set(data, '$.properties.readAt', ?, '$.properties.extra', ?) WHERE id = ?")
                .run('2026-11-06T00:00:00Z', 'after', node.id);

            writeSunsetFocusItemsReceipt(db, node.id, {named: 2, placed: 1});
            let stored = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(node.id).data);
            expect(stored.properties).toMatchObject({readAt: '2026-11-06T00:00:00Z', extra: 'after', focusItemsReceipt: {named: 2, placed: 1}});
            expect(read().map(item => item.id)).toEqual([node.id]);

            markSunsetHandoversSummaryProcessed(db, [stale]);
            stored = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(node.id).data);
            expect(stored.properties).toMatchObject({readAt: '2026-11-06T00:00:00Z', extra: 'after', focusItemsReceipt: {named: 2, placed: 1}});
            expect(stored.properties.handoverSummaryProcessedAt).toEqual(expect.any(String));
            expect(read()).toEqual([])
        });

        test('missing receipt remains pending after read; a historical read without a receipt stays excluded', () => {
            for (const id of ['MESSAGE:pending', 'MESSAGE:historical']) {
                insert(handover(id, {readAt: '2026-11-06T00:00:00Z'}));
            }
            writeSunsetFocusItemsReceipt(db, 'MESSAGE:pending', 'missing');
            const stored = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get('MESSAGE:pending').data);
            expect(stored.properties.focusItemsReceipt).toBe('missing');
            expect(read().map(item => item.id)).toEqual(['MESSAGE:pending']);
            markSunsetHandoversSummaryProcessed(db, [stored]);
            expect(read()).toEqual([])
        });

        test('sets the summary-processed marker without consuming the inbox read state', () => {
            const node = handover('MESSAGE:1', {readAt: null});
            insert(node);

            markSunsetHandoversSummaryProcessed(db, [node]);

            const row         = db.prepare('SELECT data FROM Nodes WHERE id = ?').get('MESSAGE:1');
            const updatedNode = JSON.parse(row.data);

            expect(updatedNode.properties.handoverSummaryProcessedAt).toBeDefined();
            expect(new Date(updatedNode.properties.handoverSummaryProcessedAt).getTime()).not.toBeNaN();
            expect(updatedNode.properties.readAt).toBeNull();
        });
    });

    test.describe('markNodesAsRead', () => {
        test('updates readAt for provided nodes', () => {
            const node = {
                id        : 'msg-1',
                type      : 'MESSAGE',
                properties: {
                    taggedConcepts: ['sunset-protocol-handover']
                }
            };
            db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(node.id, JSON.stringify(node));

            markNodesAsRead(db, [node]);

            const row         = db.prepare('SELECT data FROM Nodes WHERE id = ?').get('msg-1');
            const updatedNode = JSON.parse(row.data);

            expect(updatedNode.properties.readAt).toBeDefined();
            expect(new Date(updatedNode.properties.readAt).getTime()).not.toBeNaN();
        });

        test('handles empty array gracefully', () => {
            expect(() => markNodesAsRead(db, [])).not.toThrow();
        });
    });

    test.describe('getGraphLogEntries (#15114)', () => {
        test('projects typed event columns when the additive schema is present', () => {
            db.exec(`
                CREATE TABLE GraphLog (
                    log_id INTEGER PRIMARY KEY,
                    entity_id TEXT,
                    entity_type TEXT,
                    event_id TEXT,
                    event_payload TEXT
                )
            `);
            db.prepare(`
                INSERT INTO GraphLog(log_id, entity_id, entity_type, event_id, event_payload)
                VALUES (1, ?, 'task_state_changed', ?, ?)
            `).run('MESSAGE:task', 'task-event-1', '{"schemaVersion":"task-state-change.v1"}');

            expect(getGraphLogEntries(db, 0)).toEqual([{
                log_id       : 1,
                entity_id    : 'MESSAGE:task',
                entity_type  : 'task_state_changed',
                event_id     : 'task-event-1',
                event_payload: '{"schemaVersion":"task-state-change.v1"}'
            }]);
        });

        test('keeps legacy GraphLog readable before Memory Core applies the column migration', () => {
            db.exec(`
                CREATE TABLE GraphLog (
                    log_id INTEGER PRIMARY KEY,
                    entity_id TEXT,
                    entity_type TEXT
                )
            `);
            db.prepare('INSERT INTO GraphLog(log_id, entity_id, entity_type) VALUES (1, ?, ?)')
                .run('MESSAGE:legacy', 'nodes');

            expect(getGraphLogEntries(db, 0)).toEqual([{
                log_id       : 1,
                entity_id    : 'MESSAGE:legacy',
                entity_type  : 'nodes',
                event_id     : null,
                event_payload: null
            }]);
        });
    });

    test.describe('getLastSyncId / writeLastSyncId (resume cursor)', () => {
        let tmpDir, stateFile;

        test.beforeEach(() => {
            // GraphLog is the MAX(log_id) source for the fail-to-the-tip fallback.
            // The outer beforeEach already created `db`; add the cursor source here.
            db.exec(`
                CREATE TABLE GraphLog (
                    log_id      INTEGER PRIMARY KEY,
                    entity_id   TEXT,
                    entity_type TEXT
                )
            `);
            tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-cursor-'));
            stateFile = path.join(tmpDir, 'lastSyncId');
        });

        test.afterEach(() => {
            try { fs.removeSync(tmpDir); } catch (e) {}
        });

        const seedLog = maxId => {
            const stmt = db.prepare('INSERT INTO GraphLog (log_id, entity_id, entity_type) VALUES (?, ?, ?)');
            for (let id = 1; id <= maxId; id++) {
                stmt.run(id, `n-${id}`, 'nodes');
            }
        };

        test.describe('getLastSyncId', () => {
            test('missing cursor file → MAX(log_id) (resume at tip, skip backlog)', () => {
                seedLog(42);
                expect(getLastSyncId(db, stateFile)).toBe(42);
            });

            test('empty cursor file → MAX(log_id), NOT 0 (prevents full-backlog flood)', () => {
                seedLog(42);
                fs.writeFileSync(stateFile, '', 'utf8');
                expect(getLastSyncId(db, stateFile)).toBe(42);
            });

            test('corrupt (non-numeric) cursor file → MAX(log_id), NOT 0', () => {
                seedLog(99);
                fs.writeFileSync(stateFile, 'not-a-number', 'utf8');
                expect(getLastSyncId(db, stateFile)).toBe(99);
            });

            test('negative cursor value → MAX(log_id) (negative is corruption, not a replay)', () => {
                seedLog(99);
                fs.writeFileSync(stateFile, '-5', 'utf8');
                expect(getLastSyncId(db, stateFile)).toBe(99);
            });

            test('valid positive cursor is preserved', () => {
                seedLog(99);
                fs.writeFileSync(stateFile, '42', 'utf8');
                expect(getLastSyncId(db, stateFile)).toBe(42);
            });

            test('cursor ahead of MAX(log_id) clamps to the current tip', () => {
                seedLog(99);
                fs.writeFileSync(stateFile, '150', 'utf8');
                expect(getLastSyncId(db, stateFile)).toBe(99);
            });

            test('cursor ahead of an empty GraphLog clamps to 0', () => {
                fs.writeFileSync(stateFile, '150', 'utf8');
                expect(getLastSyncId(db, stateFile)).toBe(0);
            });

            test('valid 0 cursor is preserved (not treated as corruption)', () => {
                seedLog(99);
                fs.writeFileSync(stateFile, '0', 'utf8');
                expect(getLastSyncId(db, stateFile)).toBe(0);
            });

            test('empty cursor + empty log → 0 (nothing to replay)', () => {
                fs.writeFileSync(stateFile, '', 'utf8');
                expect(getLastSyncId(db, stateFile)).toBe(0);
            });
        });

        test.describe('writeLastSyncId', () => {
            test('persists the cursor value (readable back)', () => {
                writeLastSyncId(stateFile, 137);
                expect(fs.readFileSync(stateFile, 'utf8')).toBe('137');
            });

            test('round-trips through getLastSyncId', () => {
                seedLog(500);
                writeLastSyncId(stateFile, 137);
                expect(getLastSyncId(db, stateFile)).toBe(137);
            });

            test('overwrites an existing cursor and leaves no .tmp residue', () => {
                writeLastSyncId(stateFile, 1);
                writeLastSyncId(stateFile, 2);
                expect(fs.readFileSync(stateFile, 'utf8')).toBe('2');
                expect(fs.existsSync(`${stateFile}.tmp`)).toBe(false);
            });
        });
    });

    test.describe('collapseDuplicateShapeCRoutes (instance-address aware)', () => {
        // A same-app route (appName) is NOT a stable identity address once multiple named peers
        // run the same app (e.g. several Claude instances). The collapse key must therefore include
        // the instance-address fields, or a wake for one named peer collapses onto another's route
        // and delivers to the wrong instance.
        const makeSub = (id, metadata, updatedAt = '2026-01-01T00:00:00.000Z') => ({
            id,
            properties: {
                agentIdentity        : '@neo-opus-ada',
                trigger              : 'SENT_TO_ME',
                filters              : {},
                harnessTarget        : 'bridge-daemon',
                harnessTargetMetadata: metadata,
                updatedAt
            }
        });

        test('keeps two same-app routes that target different instances distinct', () => {
            const result = collapseDuplicateShapeCRoutes([
                makeSub('sub-ada',  {appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/Users/x/.claude-ada'}),
                makeSub('sub-vega', {appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/Users/x/.claude-vega'})
            ]);
            expect(result.length).toBe(2);
        });

        test('keeps a generic same-app route distinct from an instance-addressed one', () => {
            const result = collapseDuplicateShapeCRoutes([
                makeSub('sub-generic',  {appName: 'Claude'}),
                makeSub('sub-addressed', {appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/Users/x/.claude-vega'})
            ]);
            expect(result.length).toBe(2);
        });

        test('does not collapse a legacy userDataDir route onto a different instanceAddress route', () => {
            const result = collapseDuplicateShapeCRoutes([
                makeSub('sub-legacy',    {appName: 'Claude', userDataDir: '/Users/x/.claude-ada'}),
                makeSub('sub-canonical', {appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/Users/x/.claude-vega'})
            ]);
            expect(result.length).toBe(2);
        });

        test('still collapses genuine duplicates (identical route tuple), newest wins', () => {
            const result = collapseDuplicateShapeCRoutes([
                makeSub('sub-old', {appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/Users/x/.claude-ada'}, '2026-01-01T00:00:00.000Z'),
                makeSub('sub-new', {appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/Users/x/.claude-ada'}, '2026-02-01T00:00:00.000Z')
            ]);
            expect(result.length).toBe(1);
            expect(result[0].id).toBe('sub-new');
        });
    });
});
