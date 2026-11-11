import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import {
    normalizeMailboxObserver,
    readMailboxObservation
} from '../../../../../../../ai/services/memory-core/helpers/mailboxObservation.mjs';

const
    VIEWER          = '@observer',
    VIEWER_VARIANTS = [VIEWER, 'observer', 'AGENT:@observer', 'AGENT:observer'],
    NOW             = '2026-10-09T07:00:00.000Z';

/**
 * @summary Builds only the two SQLite tables consumed by the observer query.
 * @returns {Database}
 */
function createDatabase() {
    const db = new Database(':memory:');

    db.exec(`
        CREATE TABLE Nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX idx_nodes_label ON Nodes(json_extract(data, '$.label'));
        CREATE INDEX idx_nodes_message_sent_at
            ON Nodes(json_extract(data, '$.properties.sentAt') DESC, id DESC) WHERE id LIKE 'MESSAGE:%';
        CREATE INDEX idx_edges_source ON Edges(source);
        CREATE INDEX idx_edges_target ON Edges(target);
    `);

    return db
}

/**
 * @summary Stores one canonical MESSAGE node and its routing/source edges.
 * @param {Database} db In-memory test database.
 * @param {Object} options Node fields and edge descriptors.
 * @returns {String} Message id.
 */
function addMessage(db, {
    id,
    subject = id,
    body = 'message body',
    from = '@sender',
    to = VIEWER,
    toProperties = {},
    priority = 'normal',
    sentAt = NOW,
    createdAt,
    readAt = null,
    archivedAt = null,
    retracted = false,
    wakeSuppressed = false,
    relatedTickets = [],
    task,
    publication,
    requestPublish,
    revision,
    revisions,
    revisionDigest,
    attestedRevisionDigest,
    deliveries = [],
    extraEdges = []
}) {
    const properties = {subject, bodyText: body, priority, sentAt, ...(createdAt === undefined ? {} : {createdAt}), readAt, archivedAt, retracted, wakeSuppressed};

    relatedTickets.length && (properties.relatedTickets = relatedTickets);
    task !== undefined && (properties.task = task);
    publication !== undefined && (properties.publication = publication);
    requestPublish !== undefined && (properties.requestPublish = requestPublish);
    revision !== undefined && (properties.revision = revision);
    revisions !== undefined && (properties.revisions = revisions);
    revisionDigest !== undefined && (properties.revisionDigest = revisionDigest);
    attestedRevisionDigest !== undefined && (properties.attestedRevisionDigest = attestedRevisionDigest);

    const node = {id, label: 'MESSAGE', properties};

    db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id, JSON.stringify(node));

    const edges = [
        ...(from ? [{type: 'SENT_BY', target: from}] : []),
        ...(to ? [{type: 'SENT_TO', target: to, properties: toProperties}] : []),
        ...deliveries.map(({target, ...receipt}) => ({type: 'DELIVERED_TO', target, properties: receipt})),
        ...extraEdges
    ];

    edges.forEach((edge, index) => {
        const row = {id: `${id}:EDGE:${index}`, source: id, target: edge.target, type: edge.type, properties: edge.properties ?? {}};

        db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
            .run(row.id, row.source, row.target, row.type, JSON.stringify(row))
    });

    return id
}

/**
 * @summary Reads through the test database with the server-supplied viewer variants.
 * @param {Database} sqlite In-memory SQLite handle.
 * @param {Object} [options] Observer query options.
 * @returns {Object} The observer list/detail result.
 */
function observe(sqlite, options = {}) {
    return readMailboxObservation({
        sqlite,
        viewerVariants: VIEWER_VARIANTS,
        scope         : 'own',
        policy        : 'team',
        ...options
    })
}

function storedRows(db, table) {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
}

test.describe('mailboxObservation — one policy-bounded, non-stamping read', () => {
    let db;

    test.beforeEach(() => db = createDatabase());
    test.afterEach(() => db.close());

    test('requires an explicit scope and normalizes only observer request fields', () => {
        expect(() => normalizeMailboxObserver()).toThrow(/object/);
        expect(() => normalizeMailboxObserver({})).toThrow(/scope/);
        expect(normalizeMailboxObserver({scope: 'own'})).toEqual({scope: 'own'});
        expect(normalizeMailboxObserver({scope: 'all', memorySharing: 'team'})).toEqual({scope: 'all', memorySharing: 'team'});
        expect(() => normalizeMailboxObserver({scope: 'team'})).toThrow(/scope/);
        expect(() => normalizeMailboxObserver({scope: 'all', memorySharing: 'unknown'})).toThrow(/memorySharing/);
        expect(() => normalizeMailboxObserver({scope: 'all', viewer: '@someone-else'})).toThrow(/unsupported field/)
    });

    test('team all admits MESSAGE nodes once, including archives and retractions, with a bounded body-free projection', () => {
        const direct  = addMessage(db, {id: 'MESSAGE:team-direct', from: '@alice', to: '@bob', archivedAt: '2026-10-08T00:00:00.000Z'}),
            broadcast = addMessage(db, {
                id          : 'MESSAGE:team-broadcast', to: 'AGENT:*', from: '@alice',
                toProperties: {broadcastCohort: 'known', intendedRecipientCount: 2},
                deliveries  : [
                    {target: VIEWER, archivedAt: '2026-10-08T01:00:00.000Z', readAt: '2026-10-08T02:00:00.000Z'},
                    {target: '@peer', archivedAt: null, readAt: null}
                ]
            }),
            retracted = addMessage(db, {
                id        : 'MESSAGE:team-retracted', from: '@alice', to: '@bob', subject: 'old subject', body: 'old body',
                retracted : true, task: {state: 'Submitted', input: 'private task input'}, relatedTickets: ['#2', '#2'],
                extraEdges: [{type: 'REFERENCES_TICKET', target: '#1', properties: {externalRef: '#1'}}]
            });

        const before = {nodes: storedRows(db, 'Nodes'), edges: storedRows(db, 'Edges')},
            result   = observe(db, {scope: 'all', policy: 'team'});

        expect(result).toMatchObject({totalCount: 3, truncated: false, nextOffset: null, limit: 50, offset: 0});
        expect(result.messages.map(row => row.messageId).sort()).toEqual([direct, broadcast, retracted].sort());
        expect(result.messages.find(row => row.messageId === broadcast)).toMatchObject({
            to: 'AGENT:*', archivedAt: '2026-10-08T01:00:00.000Z', readAt: '2026-10-08T02:00:00.000Z'
        });
        expect(result.messages.find(row => row.messageId === direct)).toMatchObject({sentAt: NOW, createdAt: NOW});
        const row = result.messages.find(row => row.messageId === retracted);

        expect(row).toMatchObject({subject: '[retracted by sender]', retracted: true, task: {state: 'Submitted'}, relatedTickets: ['#1', '#2']});
        expect(row).not.toHaveProperty('body');
        expect(JSON.stringify(result)).not.toContain('private task input');

        expect(observe(db, {scope: 'all', policy: 'team', messageId: retracted})).toMatchObject({
            messageId: retracted, subject: '[retracted by sender]', body: '[retracted by sender]',
            retracted: true, task: {state: 'Submitted'}, relatedTickets: ['#1', '#2']
        });
        expect(observe(db, {scope: 'all', policy: 'team', messageId: 'MESSAGE:absent'})).toBeNull();
        expect(JSON.stringify(storedRows(db, 'Nodes'))).toBe(JSON.stringify(before.nodes));
        expect(JSON.stringify(storedRows(db, 'Edges'))).toBe(JSON.stringify(before.edges))
    });

    test('team all rides idx_nodes_message_sent_at without a temp B-tree; detail stays O(1); own starts from indexed route candidates', () => {
        for (let i = 0; i < 500; i++) {
            const id = `IDENTITY:${i}`;

            db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id, JSON.stringify({id, label: 'AgentIdentity', properties: {}}))
        }
        const tieLow = addMessage(db, {id: 'MESSAGE:tie-a', sentAt: '2026-10-09T08:00:00.000Z'}),
            tieHigh  = addMessage(db, {
                id        : 'MESSAGE:tie-b',
                sentAt    : '2026-10-09T08:00:00.000Z',
                extraEdges: [{type: 'UNRELATED', target: '@unrelated'}]
            }),
            nullSentAt  = addMessage(db, {id: 'MESSAGE:null-sent-at', sentAt: null}),
            omittedId   = 'MESSAGE:omitted-sent-at';

        db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(
            omittedId,
            JSON.stringify({id: omittedId, label: 'MESSAGE', properties: {subject: 'omitted', bodyText: 'body', priority: 'normal'}})
        );

        const executed = [],
            sqlite     = {
                prepare(sql) {
                    executed.push(sql);
                    return db.prepare(sql)
                },
                transaction: callback => db.transaction(callback)
            };

        const teamPage = observe(sqlite, {scope: 'all', policy: 'team', limit: 4, offset: 0});

        expect(teamPage.totalCount).toBe(4);
        expect(teamPage.messages.map(row => row.messageId)).toEqual([tieHigh, tieLow, omittedId, nullSentAt]);

        const teamCountSql = executed.find(sql => sql.includes('INDEXED BY idx_nodes_message_sent_at') && sql.includes('COUNT(*)')),
            teamPageSql    = executed.find(sql => sql.includes('INDEXED BY idx_nodes_message_sent_at') && sql.includes('LIMIT @limit OFFSET @offset')),
            teamCountPlan  = db.prepare(`EXPLAIN QUERY PLAN ${teamCountSql}`).all().map(row => row.detail).join('\n'),
            teamPagePlan   = db.prepare(`EXPLAIN QUERY PLAN ${teamPageSql}`).all({limit: 4, offset: 0}).map(row => row.detail).join('\n');

        expect(teamCountPlan).toContain('SCAN n USING COVERING INDEX idx_nodes_message_sent_at');
        expect(teamPagePlan).toContain('SCAN n USING INDEX idx_nodes_message_sent_at');
        expect(teamPagePlan).not.toContain('USE TEMP B-TREE');

        executed.length = 0;
        expect(observe(sqlite, {scope: 'all', policy: 'team', messageId: tieHigh})?.messageId).toBe(tieHigh);

        const detailSql = executed.find(sql => sql.includes('WHERE messageId = @messageId LIMIT 1')),
            detailPlan  = db.prepare(`EXPLAIN QUERY PLAN ${detailSql}`).all({messageId: tieHigh}).map(row => row.detail).join('\n');

        expect(detailPlan).toContain('sqlite_autoindex_Nodes_1');
        expect(detailPlan).not.toContain('idx_nodes_message_sent_at');

        executed.length = 0;
        observe(sqlite, {scope: 'own', policy: 'private'});

        const ownCountSql = executed.find(sql => sql.includes('WITH candidate_ids AS') && sql.includes('COUNT(*)')),
            ownDetails    = db.prepare(`EXPLAIN QUERY PLAN ${ownCountSql}`).all({viewerVariants: JSON.stringify(VIEWER_VARIANTS)}).map(row => row.detail).join('\n'),
            edgeSql       = executed.find(sql => sql.includes('FROM Edges') && sql.includes('REFERENCES_TICKET'));

        expect(ownCountSql).toContain("SELECT source AS messageId FROM Edges WHERE type = 'SENT_TO'");
        expect(ownDetails).toContain('idx_edges_target');
        expect(ownDetails).toContain('sqlite_autoindex_Nodes_1');
        expect(ownDetails).not.toContain('SEARCH n USING INDEX idx_nodes_label');
        expect(edgeSql).toContain("type IN ('SENT_BY', 'SENT_TO', 'DELIVERED_TO', 'PART_OF_THREAD', 'REFERENCES_TICKET')");
        expect(edgeSql).not.toContain('UNRELATED')
    });

    test('team all falls back to the label CTE when idx_nodes_message_sent_at is absent or single-column legacy', () => {
        const first  = addMessage(db, {id: 'MESSAGE:first', sentAt: '2026-10-09T07:00:00.000Z'}),
            second   = addMessage(db, {id: 'MESSAGE:second', sentAt: '2026-10-09T08:00:00.000Z'}),
            nullSent = addMessage(db, {id: 'MESSAGE:null-sent', sentAt: null}),
            indexed  = observe(db, {scope: 'all', policy: 'team'});

        db.exec('DROP INDEX idx_nodes_message_sent_at');
        const withoutIndex = observe(db, {scope: 'all', policy: 'team'});

        expect(withoutIndex).toEqual(indexed);
        expect(withoutIndex.messages.map(row => row.messageId)).toEqual([second, first, nullSent]);

        db.exec("CREATE INDEX idx_nodes_message_sent_at ON Nodes(json_extract(data, '$.properties.sentAt')) WHERE id LIKE 'MESSAGE:%'");
        const withLegacySingleColumn = observe(db, {scope: 'all', policy: 'team'});

        expect(withLegacySingleColumn).toEqual(indexed)
    });

    test('private and legacy all clamp to the viewer sender/inbox, server-granted inboxes and canonical legacy broadcasts', () => {
        const sent    = addMessage(db, {id: 'MESSAGE:sent', from: VIEWER, to: '@peer'}),
            received  = addMessage(db, {id: 'MESSAGE:received', from: '@peer', to: VIEWER}),
            granted   = addMessage(db, {id: 'MESSAGE:granted', from: '@peer', to: '@granted'}),
            unrelated = addMessage(db, {id: 'MESSAGE:unrelated', from: '@peer', to: '@other'}),
            legacy    = addMessage(db, {
                id          : 'MESSAGE:legacy-broadcast', from: '@peer', to: 'AGENT:*',
                toProperties: {broadcastCohort: 'legacy-unknown'}
            }),
            modernWithoutViewer = addMessage(db, {
                id          : 'MESSAGE:modern-no-viewer', from: '@peer', to: 'AGENT:*',
                toProperties: {broadcastCohort: 'known', intendedRecipientCount: 2},
                extraEdges  : [{type: 'DELIVERED_TO', target: '@other'}]
            });

        for (const policy of ['private', 'legacy']) {
            const result = observe(db, {scope: 'all', policy, grantedInboxVariants: ['@granted', 'granted']});

            expect(result.messages.map(row => row.messageId).sort()).toEqual([sent, received, granted, legacy].sort());
            expect(result.messages.map(row => row.messageId)).not.toContain(unrelated);
            expect(result.messages.map(row => row.messageId)).not.toContain(modernWithoutViewer)
        }
    });

    test('own remains the recipient inbox despite team policy and granted targets; involves-me requires an actual endpoint', () => {
        const received = addMessage(db, {id: 'MESSAGE:own-received', from: '@peer', to: VIEWER}),
            sent       = addMessage(db, {id: 'MESSAGE:own-sent', from: VIEWER, to: '@peer'}),
            granted    = addMessage(db, {id: 'MESSAGE:own-grant', from: '@peer', to: '@granted'}),
            legacy     = addMessage(db, {
                id          : 'MESSAGE:own-legacy-broadcast', from: '@peer', to: 'AGENT:*',
                toProperties: {broadcastCohort: 'legacy-unknown'}
            }),
            involvedBroadcast = addMessage(db, {
                id          : 'MESSAGE:involved-broadcast', from: '@peer', to: 'AGENT:*',
                toProperties: {broadcastCohort: 'known', intendedRecipientCount: 1},
                deliveries  : [{target: VIEWER}]
            }),
            uninvolvedBroadcast = addMessage(db, {
                id          : 'MESSAGE:uninvolved-broadcast', from: '@peer', to: 'AGENT:*',
                toProperties: {broadcastCohort: 'known', intendedRecipientCount: 1},
                deliveries  : [{target: '@other'}]
            }),
            unrelated = addMessage(db, {id: 'MESSAGE:unrelated-peer', from: '@peer', to: '@other'});

        const own = observe(db, {scope: 'own', policy: 'team', grantedInboxVariants: ['@granted']});

        expect(own.messages.map(row => row.messageId).sort()).toEqual([received, involvedBroadcast, legacy].sort());
        expect(own.messages.map(row => row.messageId)).not.toContain(sent);
        expect(own.messages.map(row => row.messageId)).not.toContain(granted);

        const involves = observe(db, {scope: 'involves-me', policy: 'private'});

        expect(involves.messages.map(row => row.messageId).sort()).toEqual([received, sent, involvedBroadcast].sort());
        expect(involves.messages.map(row => row.messageId)).not.toContain(uninvolvedBroadcast);
        expect(involves.messages.map(row => row.messageId)).not.toContain(legacy);
        expect(involves.messages.map(row => row.messageId)).not.toContain(unrelated)
    });

    test('archive and Task filters apply before count/page; priority-age continuation advances by served rows', () => {
        const high    = addMessage(db, {id: 'MESSAGE:high', priority: 'high', sentAt: '2026-10-01T00:00:00.000Z', task: {state: 'InputRequired', input: 'not exposed'}}),
            normal    = addMessage(db, {id: 'MESSAGE:normal', priority: 'normal', sentAt: '2026-10-03T00:00:00.000Z', task: {state: 'Working'}}),
            low       = addMessage(db, {id: 'MESSAGE:low', priority: 'low', sentAt: '2026-10-02T00:00:00.000Z', task: {state: 'InputRequired'}}),
            completed = addMessage(db, {id: 'MESSAGE:completed', priority: 'high', sentAt: '2026-09-30T00:00:00.000Z', task: {state: 'Completed'}}),
            archived  = addMessage(db, {id: 'MESSAGE:archived-task', priority: 'normal', sentAt: '2026-10-04T00:00:00.000Z', archivedAt: '2026-10-05T00:00:00.000Z', task: {state: 'InputRequired'}}),
            filters   = {taskStates: ['InputRequired', 'Working'], taskOrder: 'priority-age', limit: 2};

        const first = observe(db, filters), second = observe(db, {...filters, offset: 2}), third = observe(db, {...filters, offset: 4});

        expect(first).toMatchObject({totalCount: 4, truncated: true, nextOffset: 2});
        expect(first.messages.map(row => row.messageId)).toEqual([high, normal]);
        expect(first.messages[0].task).toEqual({state: 'InputRequired'});
        expect(first.messages[0].task).not.toHaveProperty('input');
        expect(second).toMatchObject({totalCount: 4, truncated: false, nextOffset: null});
        expect(second.messages.map(row => row.messageId)).toEqual([archived, low]);
        expect(third.messages).toEqual([]);
        expect(observe(db, {...filters, messageId: completed})).toBeNull();
        expect(observe(db, {scope: 'own', policy: 'team', messageId: completed})).toMatchObject({task: {state: 'Completed'}})
    });

    test('from, thread and tag filters share the same eligibility set for count and detail', () => {
        const matching = addMessage(db, {
                id        : 'MESSAGE:filters', from: '@alice', to: VIEWER,
                extraEdges: [
                    {type: 'PART_OF_THREAD', target: 'THREAD:1'},
                    {type: 'TAGGED_CONCEPT', target: 'concept:one'},
                    {type: 'TAGGED_CONCEPT', target: 'concept:two'}
                ]
            }),
            other = addMessage(db, {id: 'MESSAGE:other', from: '@bob', to: VIEWER}),
            filters = {fromVariants: ['@alice', 'alice'], threadId: 'THREAD:1', taggedConceptGroups: [['concept:one', 'concept:one-alias']]};

        expect(observe(db, filters)).toMatchObject({totalCount: 1, messages: [expect.objectContaining({messageId: matching})]});
        expect(observe(db, {...filters, messageId: matching})?.messageId).toBe(matching);
        expect(observe(db, {...filters, messageId: other})).toBeNull()
    });

    test('invalid bounds and unavailable SQLite fail instead of answering a false empty population', () => {
        for (const options of [
            {limit: 0}, {limit: 201}, {offset: -1}, {offset: 1.5},
            {taskStates: []}, {taskStates: ['not-a-task-state']}, {taskOrder: 'newest'},
            {taggedConceptGroups: [[]]}, {messageId: ''}
        ]) {
            expect(() => observe(db, options), JSON.stringify(options)).toThrow(TypeError)
        }

        expect(() => readMailboxObservation({sqlite: null, viewerVariants: VIEWER_VARIANTS, scope: 'own', policy: 'team'})).toThrow(/SQLite storage is unavailable/);
        const broken = {prepare() { throw new Error('synthetic sqlite failure') }, transaction(fn) { return fn }};

        expect(() => readMailboxObservation({sqlite: broken, viewerVariants: VIEWER_VARIANTS, scope: 'own', policy: 'team'})).toThrow('synthetic sqlite failure')
    });

    test('#1271 Part 4: list observation projects body-free publication state while detail observation projects full publish-gate envelope', () => {
        const pubId = addMessage(db, {
            id         : 'MESSAGE:pub-obs',
            from       : '@agent-author',
            to         : VIEWER,
            subject    : '[publish] release announcement',
            body       : 'rationale body',
            task       : {state: 'InputRequired'},
            publication: {
                state                : 'queued',
                currentRevisionNumber: 2,
                currentRevisionDigest: 'sha256:rev2'
            },
            requestPublish        : {
                channel        : 'x',
                postKind       : 'post',
                text           : 'SECRET DRAFT POST TEXT',
                textAsRequested: 'ORIGINAL REQUESTED TEXT'
            },
            revision              : {
                revisionNumber: 2,
                revisionDigest: 'sha256:rev2',
                payload       : {channel: 'x', postKind: 'post', text: 'SECRET DRAFT POST TEXT'}
            },
            revisions             : [
                {revisionNumber: 1, revisionDigest: 'sha256:rev1'},
                {revisionNumber: 2, revisionDigest: 'sha256:rev2'}
            ],
            revisionDigest        : 'sha256:rev2',
            attestedRevisionDigest: null
        });

        const listResult = observe(db, {scope: 'own', policy: 'team'});
        const listRow    = listResult.messages.find(r => r.messageId === pubId);

        expect(listRow.publication).toEqual({
            state         : 'queued',
            revisionNumber: 2,
            revisionDigest: 'sha256:rev2'
        });
        expect(listRow).not.toHaveProperty('requestPublish');
        expect(listRow).not.toHaveProperty('revision');
        expect(listRow).not.toHaveProperty('revisions');
        expect(JSON.stringify(listResult)).not.toContain('SECRET DRAFT POST TEXT');
        expect(JSON.stringify(listResult)).not.toContain('ORIGINAL REQUESTED TEXT');

        const detailResult = observe(db, {scope: 'own', policy: 'team', messageId: pubId});
        expect(detailResult.publication).toEqual({
            state                : 'queued',
            currentRevisionNumber: 2,
            currentRevisionDigest: 'sha256:rev2'
        });
        expect(detailResult.requestPublish).toMatchObject({
            channel        : 'x',
            postKind       : 'post',
            text           : 'SECRET DRAFT POST TEXT',
            textAsRequested: 'ORIGINAL REQUESTED TEXT'
        });
        expect(detailResult.revision.revisionDigest).toBe('sha256:rev2');
        expect(detailResult.revisions).toHaveLength(2);
        expect(detailResult.revisionDigest).toBe('sha256:rev2');
    });
});
