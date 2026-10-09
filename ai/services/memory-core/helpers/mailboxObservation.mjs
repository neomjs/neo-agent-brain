import {TASK_STATES} from '../taskAssignmentContract.mjs';

/**
 * @module ai/services/memory-core/helpers/mailboxObservation
 * @summary Pure, SQLite-owned observer population for explicit A2A mailbox reads.
 *
 * The server supplies a transport-bound viewer, its already-resolved sharing policy and any
 * independently granted inbox targets. This module neither resolves identity nor decides policy.
 * Every scope is selected before the count and bounded page, and the detail lookup uses the same
 * eligibility CTE. Reads include retained archives and never stamp receipts or mutate Tasks.
 */

const
    MAILBOX_RETRACTED_PLACEHOLDER = '[retracted by sender]',
    MAX_MAILBOX_OBSERVATION_LIMIT = 200,
    OBSERVER_EDGE_TYPE_SQL        = "'SENT_BY', 'SENT_TO', 'DELIVERED_TO', 'PART_OF_THREAD', 'REFERENCES_TICKET'",
    OBSERVER_SCOPES               = new Set(['all', 'involves-me', 'own']),
    SHARING_POLICIES              = new Set(['private', 'legacy', 'team']);

/**
 * @summary Validates the public observer selector without resolving the caller or deployment policy.
 * @param {Object} [observer={}] Explicit observer request.
 * @returns {{scope: 'all'|'involves-me'|'own', memorySharing?: 'private'|'legacy'|'team'}}
 * @throws {TypeError} When a scope, policy or extra field is not part of this request contract.
 */
export function normalizeMailboxObserver(observer) {
    if (!observer || typeof observer !== 'object' || Array.isArray(observer)) {
        throw new TypeError('mailbox observer must be an object')
    }

    const unknown = Object.keys(observer).filter(key => !['scope', 'memorySharing'].includes(key));

    if (unknown.length) {
        throw new TypeError(`mailbox observer has unsupported field(s): ${unknown.sort().join(', ')}`)
    }

    const {scope} = observer;

    if (typeof scope !== 'string' || !OBSERVER_SCOPES.has(scope)) {
        throw new TypeError("mailbox observer scope must be 'own', 'involves-me' or 'all'")
    }

    const result = {scope};

    if (observer.memorySharing !== undefined) {
        if (!SHARING_POLICIES.has(observer.memorySharing)) {
            throw new TypeError("mailbox observer memorySharing must be 'private', 'legacy' or 'team'")
        }

        result.memorySharing = observer.memorySharing
    }

    return result
}

/**
 * @summary Reads only the source edges needed by the observer projection, through the source index.
 * @param {Object} sqlite SQLite handle.
 * @param {String} messageId MESSAGE node id.
 * @returns {Object[]}
 * @private
 */
function sourceObservationEdges(sqlite, messageId) {
    return sqlite.prepare(`
        SELECT target, type, data FROM Edges
        WHERE source = ? AND type IN (${OBSERVER_EDGE_TYPE_SQL})
        ORDER BY id
    `).all(messageId)
}

/**
 * @summary Validates an identity-variant list supplied by the authenticated server boundary.
 * @param {*} values Candidate storage identities.
 * @param {String} name Input label for the refusal.
 * @param {Boolean} [required=false] Whether at least one value is required.
 * @returns {String[]} A deduplicated array, preserving the caller's canonical variant order.
 * @private
 */
function stringVariants(values, name, required = false) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value)) {
        throw new TypeError(`mailbox observation ${name} must be an array of non-empty strings`)
    }

    const result = [...new Set(values)];

    if (required && !result.length) {
        throw new TypeError(`mailbox observation ${name} must contain at least one identity variant`)
    }

    return result
}

/**
 * @summary Binds a JSON identity array once for SQLite's indexed route predicates.
 * @param {Object} params Bound parameter object.
 * @param {String} key SQL parameter name without its `@` prefix.
 * @param {String[]} values Identity variants.
 * @returns {String} SQL membership expression.
 * @private
 */
function jsonMembership(params, key, values) {
    params[key] = JSON.stringify(values);
    return `IN (SELECT value FROM json_each(@${key}))`
}

/**
 * @summary Builds the one server-owned message population before count, page or detail selection.
 * @param {Object} options Observer and filter inputs.
 * @param {String[]} options.viewerVariants Transport-stamped viewer spellings.
 * @param {String[]} options.grantedInboxVariants Independently admitted inbox target spellings.
 * @param {'all'|'involves-me'|'own'} options.scope Observer scope.
 * @param {'private'|'legacy'|'team'} options.policy Already-resolved deployment content policy.
 * @param {String[]} options.fromVariants Optional sender filter spellings.
 * @param {String} [options.threadId] Optional thread filter.
 * @param {String[][]} options.taggedConceptGroups Optional AND-of-OR concept filter groups.
 * @param {String[]} [options.taskStates] Optional pre-page Task-state filter.
 * @param {String} [options.taskOrder] Optional Task order.
 * @returns {{cte: String, params: Object, orderBy: String}}
 * @private
 */
function buildObservationQuery({
    viewerVariants,
    grantedInboxVariants,
    scope,
    policy,
    fromVariants,
    threadId,
    taggedConceptGroups,
    taskStates,
    taskOrder
}) {
    const params = {},
        viewer = scope === 'all' && policy === 'team'
            ? null
            : jsonMembership(params, 'viewerVariants', viewerVariants),
        inbox = scope === 'all' && policy !== 'team'
            ? jsonMembership(params, 'inboxVariants', [...new Set([...viewerVariants, ...grantedInboxVariants])])
            : null,
        senderFilter = fromVariants.length
            ? jsonMembership(params, 'fromVariants', fromVariants)
            : null,
        routed = (edgeType, variants, alias) => `EXISTS (
            SELECT 1 FROM Edges ${alias}
            WHERE ${alias}.source = n.id AND ${alias}.type = '${edgeType}'
              AND ${alias}.target ${variants}
        )`,
        legacyBroadcastPredicate = (edgeAlias, sourceExpression, deliveryAlias) => `(
            ${edgeAlias}.type = 'SENT_TO'
            AND ${edgeAlias}.target = 'AGENT:*'
            AND (
                json_extract(${edgeAlias}.data, '$.properties.broadcastCohort') = 'legacy-unknown'
                OR json_extract(${edgeAlias}.data, '$.properties.intendedRecipientCount') = 0
            )
            AND NOT EXISTS (
                SELECT 1 FROM Edges ${deliveryAlias}
                WHERE ${deliveryAlias}.source = ${sourceExpression} AND ${deliveryAlias}.type = 'DELIVERED_TO'
            )
        )`,
        senderIsViewer = viewer && routed('SENT_BY', viewer, 'observer_sender'),
        sentToViewer = viewer && routed('SENT_TO', viewer, 'observer_sent_to'),
        deliveredToViewer = viewer && routed('DELIVERED_TO', viewer, 'observer_delivered_to'),
        sentToInbox = inbox && routed('SENT_TO', inbox, 'observer_inbox_sent_to'),
        deliveredToInbox = inbox && routed('DELIVERED_TO', inbox, 'observer_inbox_delivered_to'),
        legacyBroadcast = `EXISTS (
            SELECT 1 FROM Edges observer_legacy
            WHERE observer_legacy.source = n.id
              AND ${legacyBroadcastPredicate('observer_legacy', 'n.id', 'observer_delivery')}
        )`,
        scopePredicate = scope === 'all' && policy === 'team'
            ? '1 = 1'
            : scope === 'own'
                ? `(${sentToViewer} OR ${deliveredToViewer} OR ${legacyBroadcast})`
                : scope === 'involves-me'
                    ? `(${senderIsViewer} OR ${sentToViewer} OR ${deliveredToViewer})`
                    : `(${senderIsViewer} OR ${sentToInbox ?? '0'} OR ${deliveredToInbox ?? '0'} OR ${legacyBroadcast})`,
        eligibility = [scopePredicate];

    if (senderFilter) {
        eligibility.push(routed('SENT_BY', senderFilter, 'observer_from_filter'))
    }

    if (threadId !== undefined) {
        params.threadId = threadId;
        eligibility.push(`EXISTS (
            SELECT 1 FROM Edges observer_thread
            WHERE observer_thread.source = n.id AND observer_thread.type = 'PART_OF_THREAD'
              AND observer_thread.target = @threadId
        )`)
    }

    taggedConceptGroups.forEach((group, index) => {
        const key = `taggedConceptGroup${index}`;

        params[key] = JSON.stringify(group);
        eligibility.push(`EXISTS (
            SELECT 1 FROM Edges observer_tag
            WHERE observer_tag.source = n.id AND observer_tag.type = 'TAGGED_CONCEPT'
              AND observer_tag.target IN (SELECT value FROM json_each(@${key}))
        )`)
    });

    if (taskStates !== undefined) {
        params.taskStates = JSON.stringify(taskStates);
        eligibility.push(`json_extract(n.data, '$.properties.task.state') IN (SELECT value FROM json_each(@taskStates))`)
    }

    const candidateBranches = [];
    const candidateRoute = (edgeType, variants) => {
        if (!variants) return;
        candidateBranches.push(`SELECT source AS messageId FROM Edges WHERE type = '${edgeType}' AND target ${variants}`)
    };

    if (!(scope === 'all' && policy === 'team')) {
        if (scope === 'own') {
            candidateRoute('SENT_TO', viewer);
            candidateRoute('DELIVERED_TO', viewer)
        } else if (scope === 'involves-me') {
            candidateRoute('SENT_BY', viewer);
            candidateRoute('SENT_TO', viewer);
            candidateRoute('DELIVERED_TO', viewer)
        } else {
            candidateRoute('SENT_BY', viewer);
            candidateRoute('SENT_TO', inbox);
            candidateRoute('DELIVERED_TO', inbox)
        }
        if (scope !== 'involves-me') {
            candidateBranches.push(`SELECT observer_legacy.source AS messageId FROM Edges observer_legacy
                WHERE ${legacyBroadcastPredicate('observer_legacy', 'observer_legacy.source', 'observer_delivery')}`)
        }
    }

    const candidateCte = candidateBranches.length
            ? `candidate_ids AS MATERIALIZED (${candidateBranches.join('\nUNION\n')}), `
            : '',
        eligibleFrom = candidateBranches.length
            ? 'FROM candidate_ids candidate CROSS JOIN Nodes n ON n.id = candidate.messageId'
            : 'FROM Nodes n',
        cte = `WITH ${candidateCte}eligible AS (
        SELECT DISTINCT n.id AS messageId
        ${eligibleFrom}
        WHERE json_extract(n.data, '$.label') = 'MESSAGE'
          AND ${eligibility.join('\n          AND ')}
    ), filtered AS (
        SELECT eligible.messageId, n.data,
               CASE COALESCE(json_extract(n.data, '$.properties.priority'), 'normal')
                   WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1
               END AS priorityRank,
               json_extract(n.data, '$.properties.sentAt') AS sentAt
        FROM eligible JOIN Nodes n ON n.id = eligible.messageId
    )`;

    return {
        cte,
        params,
        orderBy: taskOrder === 'priority-age'
            ? 'priorityRank ASC, sentAt ASC, messageId ASC'
            : 'sentAt DESC, messageId DESC'
    }
}

/**
 * @summary Parses one graph record's JSON data without treating malformed storage as an empty record.
 * @param {*} value SQLite `data` column.
 * @param {String} label Row kind for the error.
 * @returns {Object}
 * @private
 */
function parseRecord(value, label) {
    let record;

    try {
        record = typeof value === 'string' ? JSON.parse(value) : value
    } catch {
        throw new Error(`mailbox observation ${label} row contains invalid JSON`)
    }

    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`mailbox observation ${label} row is not an object`)
    }

    return record
}

/**
 * @summary Projects one admitted MESSAGE into the bounded observer row or detail shape.
 * @param {Object} row SQLite node row.
 * @param {Object[]} edges Its source edges.
 * @param {String[]} viewerVariants Viewer identity variants for broadcast receipts.
 * @param {Boolean} [includeBody=false] Whether this is the explicitly admitted detail result.
 * @returns {Object}
 * @private
 */
function projectMessage(row, edges, viewerVariants, includeBody = false) {
    const node = parseRecord(row.data, 'MESSAGE');

    if (node.label !== 'MESSAGE') {
        throw new Error('mailbox observation result is not a MESSAGE node')
    }

    const properties = node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
            ? node.properties
            : {},
        sentByEdge = edges.find(edge => edge.type === 'SENT_BY'),
        sentToEdge = edges.find(edge => edge.type === 'SENT_TO'),
        deliveryEdges = edges.filter(edge => edge.type === 'DELIVERED_TO'),
        viewerDelivery = deliveryEdges.find(edge => viewerVariants.includes(edge.target)),
        to = sentToEdge?.target ?? viewerDelivery?.target ?? null,
        retracted = Boolean(properties.retracted),
        relatedTickets = new Set(Array.isArray(properties.relatedTickets) ? properties.relatedTickets.filter(value => typeof value === 'string' && value) : []);

    for (const edge of edges) {
        if (edge.type !== 'REFERENCES_TICKET') continue;

        const data = parseRecord(edge.data, 'REFERENCES_TICKET edge'),
            externalRef = data.properties?.externalRef,
            ticket = typeof externalRef === 'string' && externalRef ? externalRef : edge.target;

        typeof ticket === 'string' && ticket && relatedTickets.add(ticket)
    }

    const receipt = viewerDelivery ? parseRecord(viewerDelivery.data, 'DELIVERED_TO edge').properties ?? {} : null,
        readAt = receipt
            ? receipt.readAt ?? null
            : to === 'AGENT:*' && deliveryEdges.length > 0
                ? null
                : properties.readAt ?? null,
        archivedAt = receipt
            ? receipt.archivedAt ?? null
            : to === 'AGENT:*' && deliveryEdges.length > 0
                ? null
                : properties.archivedAt ?? null,
        task = properties.task && typeof properties.task === 'object' && !Array.isArray(properties.task)
            ? {state: typeof properties.task.state === 'string' ? properties.task.state : null}
            : null,
        subject = retracted ? MAILBOX_RETRACTED_PLACEHOLDER : properties.subject ?? null,
        result = {
            messageId: row.messageId,
            subject,
            from: sentByEdge?.target ?? null,
            to,
            priority: properties.priority ?? null,
            task,
            sentAt: properties.sentAt ?? null,
            createdAt: properties.createdAt ?? properties.sentAt ?? null,
            readAt,
            archivedAt,
            partOfThread: edges.find(edge => edge.type === 'PART_OF_THREAD')?.target ?? null,
            relatedTickets: [...relatedTickets].sort(),
            retracted,
            wakeSuppressed: Boolean(properties.wakeSuppressed)
        };

    if (includeBody) {
        result.body = retracted ? MAILBOX_RETRACTED_PLACEHOLDER : properties.bodyText ?? null
    }

    return result
}

/**
 * @summary Reads one policy-bounded A2A observer population from SQLite without repair, receipt stamping or writes.
 * The count and page share one transaction and one eligibility CTE; a detail id must pass the exact same filter.
 * @param {Object} options
 * @param {Object} options.sqlite better-sqlite3-compatible SQLite handle.
 * @param {String[]} options.viewerVariants Transport-bound viewer identity storage spellings.
 * @param {String[]} [options.grantedInboxVariants=[]] Independently admitted inbox target spellings.
 * @param {'all'|'involves-me'|'own'} options.scope Validated observer scope.
 * @param {'private'|'legacy'|'team'} options.policy Effective, server-resolved sharing policy.
 * @param {Number} [options.limit=50] Positive page size, at most 200.
 * @param {Number} [options.offset=0] Non-negative continuation offset.
 * @param {String[]} [options.taskStates] Task-state filter, before count and pagination.
 * @param {'priority-age'} [options.taskOrder] Task ordering, valid only with `taskStates`.
 * @param {String[]} [options.fromVariants=[]] Optional server-normalized sender filter.
 * @param {String} [options.threadId] Optional thread filter.
 * @param {String[][]} [options.taggedConceptGroups=[]] AND-of-OR tag filters.
 * @param {String} [options.messageId] When present, return the admitted detail or `null`.
 * @returns {Object} A bounded list envelope or one detail row / `null`.
 * @throws {TypeError|Error} Invalid input, unavailable storage or a failed query; never a false-zero.
 */
export function readMailboxObservation({
    sqlite,
    viewerVariants,
    grantedInboxVariants = [],
    scope,
    policy,
    limit = 50,
    offset = 0,
    taskStates,
    taskOrder,
    fromVariants = [],
    threadId,
    taggedConceptGroups = [],
    messageId
} = {}) {
    if (!sqlite || typeof sqlite.prepare !== 'function' || typeof sqlite.transaction !== 'function') {
        throw new Error('mailbox observation SQLite storage is unavailable')
    }
    if (!OBSERVER_SCOPES.has(scope)) {
        throw new TypeError("mailbox observation scope must be 'own', 'involves-me' or 'all'")
    }
    if (!SHARING_POLICIES.has(policy)) {
        throw new TypeError("mailbox observation requires an effective 'private', 'legacy' or 'team' policy")
    }
    viewerVariants = stringVariants(viewerVariants, 'viewerVariants', true);
    grantedInboxVariants = stringVariants(grantedInboxVariants, 'grantedInboxVariants');
    fromVariants = stringVariants(fromVariants, 'fromVariants');

    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MAILBOX_OBSERVATION_LIMIT) {
        throw new TypeError(`mailbox observation limit must be an integer from 1 to ${MAX_MAILBOX_OBSERVATION_LIMIT}`)
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new TypeError('mailbox observation offset must be a non-negative safe integer')
    }
    if (threadId !== undefined && (typeof threadId !== 'string' || !threadId)) {
        throw new TypeError('mailbox observation threadId must be a non-empty string')
    }
    if (!Array.isArray(taggedConceptGroups) || taggedConceptGroups.some(group => !Array.isArray(group) || !group.length || group.some(tag => typeof tag !== 'string' || !tag))) {
        throw new TypeError('mailbox observation taggedConceptGroups must be non-empty string groups')
    }
    if (taskStates !== undefined && (!Array.isArray(taskStates) || !taskStates.length || taskStates.some(state => !TASK_STATES.includes(state)))) {
        throw new TypeError(`mailbox observation taskStates must be a non-empty list of ${TASK_STATES.join(', ')}`)
    }
    if (taskOrder !== undefined && (taskOrder !== 'priority-age' || taskStates === undefined)) {
        throw new TypeError("mailbox observation taskOrder must be 'priority-age' and requires taskStates")
    }
    if (messageId !== undefined && (typeof messageId !== 'string' || !messageId)) {
        throw new TypeError('mailbox observation messageId must be a non-empty string')
    }

    const query = buildObservationQuery({viewerVariants, grantedInboxVariants, scope, policy, fromVariants, threadId, taggedConceptGroups, taskStates, taskOrder}),
        {cte, params, orderBy} = query;

    return sqlite.transaction(() => {
        if (messageId !== undefined) {
            const row = sqlite.prepare(`${cte} SELECT messageId, data FROM filtered WHERE messageId = @messageId LIMIT 1`)
                .get({...params, messageId});

            if (!row) return null;

            const edges = sourceObservationEdges(sqlite, row.messageId);

            return projectMessage(row, edges, viewerVariants, true)
        }

        const totalCount = sqlite.prepare(`${cte} SELECT COUNT(*) AS count FROM filtered`).get(params).count,
            pageRows = sqlite.prepare(`${cte} SELECT messageId, data FROM filtered ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
                .all({...params, limit, offset}),
            messages = pageRows.map(row => {
                const edges = sourceObservationEdges(sqlite, row.messageId);

                return projectMessage(row, edges, viewerVariants)
            }),
            truncated = offset + pageRows.length < totalCount;

        return {
            messages,
            totalCount,
            truncated,
            nextOffset: truncated ? offset + pageRows.length : null,
            limit,
            offset
        }
    })()
}
