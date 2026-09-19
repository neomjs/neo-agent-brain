import {GENESIS_BASIS}            from './githubIssueReconciliation.mjs';
import {discussionToObservations} from './githubDiscussionObservations.mjs';

/**
 * @summary GitHub has no exhaustive Discussion lifecycle or deletion-event history. Visible
 * creations/revisions remain useful, but their absence cannot certify complete provider history.
 * @type {Object[]}
 */
export const UNSUPPORTED_DISCUSSION_HISTORY_GAPS = Object.freeze([
    Object.freeze({axis: 'discussion-state-history', reason: 'github-has-no-discussion-lifecycle-connection'}),
    Object.freeze({axis: 'discussion-deletions', reason: 'github-has-no-exhaustive-discussion-deletion-tombstones'}),
    Object.freeze({axis: 'discussion-child-deletions', reason: 'only-visible-deletedAt-or-explicit-provider-evidence'})
]);

/** @summary Normalizes provider and injected failures without losing non-Error values. */
const reasonOf = error => error instanceof Error ? error.message : String(error);

/**
 * @summary Exhausts a connection with count, unique-id, and cursor-progress checks. Each family
 * owns its cursor; a root timestamp is never substituted for a child connection's completeness.
 * @param {Function} fetchPage Receives the cursor and returns a GraphQL-shaped connection.
 * @param {Object} options
 * @returns {Promise<{nodes: Object[], cursor: String|null}>}
 */
async function walk(fetchPage, {maxPages=Infinity, expectedCount, onNode=()=>{}}={}) {
    const nodes  = [], ids = new Set(), cursors = new Set();
    let   cursor = null, total = expectedCount, pages = 0;

    do {
        if (pages >= maxPages) throw new Error('page-cap');
        const page = await fetchPage(cursor);
        pages++;
        if (!page || !Array.isArray(page.nodes) || !Number.isInteger(page.totalCount) || page.totalCount < 0 ||
            typeof page.pageInfo?.hasNextPage !== 'boolean') {
            throw new Error('DISCUSSION_RECONCILIATION_PAGE_INVALID')
        }
        total ??= page.totalCount;
        if (page.totalCount !== total) throw new Error('DISCUSSION_RECONCILIATION_COUNT_MUTATED');

        for (const node of page.nodes) {
            if (typeof node?.id !== 'string' || !node.id || ids.has(node.id)) {
                throw new Error('DISCUSSION_RECONCILIATION_NODE_ID_INVALID')
            }
            ids.add(node.id);
            nodes.push(node);
            onNode(node);
        }
        if (nodes.length > total) throw new Error('DISCUSSION_RECONCILIATION_COUNT_MISMATCH');
        cursor = page.pageInfo.endCursor ?? null;
        if (!page.pageInfo.hasNextPage) break;
        if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || !page.nodes.length) {
            throw new Error('DISCUSSION_RECONCILIATION_CURSOR_STALLED')
        }
        cursors.add(cursor);
    } while (true);

    if (nodes.length !== total) throw new Error('DISCUSSION_RECONCILIATION_COUNT_MISMATCH');
    return {nodes, cursor}
}

/**
 * @summary Verifies an entity revision and any independently observed child counts.
 * @param {Object} expected
 * @param {Object} actual
 * @param {Boolean} [created=false] Edit heads also echo immutable creation time.
 */
function verifyEntity(expected, actual, created=false) {
    if (!actual || actual.id !== expected.id || actual.updatedAt !== expected.updatedAt ||
        (created && (actual.createdAt !== expected.createdAt || actual.lastEditedAt !== expected.lastEditedAt))) {
        throw new Error(`DISCUSSION_RECONCILIATION_CONTENT_MUTATED:${expected.id}`)
    }
    for (const key of ['comments', 'replies']) {
        if (expected[key]?.totalCount !== undefined && actual[key]?.totalCount !== expected[key].totalCount) {
            throw new Error(`DISCUSSION_RECONCILIATION_CHILDREN_MUTATED:${expected.id}`)
        }
    }
}

/**
 * @summary Exhausts stable edit identities while rejecting changed entity heads or ambiguous
 * creation revisions. The content bodies/diffs are neither requested nor retained.
 * @param {Object} entity
 * @param {Object} head
 * @param {Object} seams
 * @param {Number} maxPages
 * @returns {Promise<Object[]>}
 */
async function editsFor(entity, head, seams, maxPages) {
    const editHead = {id: entity.id, createdAt: entity.createdAt, updatedAt: entity.updatedAt,
        lastEditedAt: entity.lastEditedAt};
    verifyEntity(editHead, head, true);
    if (typeof head.includesCreatedEdit !== 'boolean') {
        throw new Error('DISCUSSION_RECONCILIATION_EDIT_HEAD_INVALID')
    }
    const {nodes} = await walk(async cursor => {
        const page = cursor === null ? head : await seams.fetchContentEditsPage({entityNodeId: entity.id, cursor});
        verifyEntity(editHead, page, true);
        if (page.includesCreatedEdit !== head.includesCreatedEdit) {
            throw new Error('DISCUSSION_RECONCILIATION_EDIT_HEAD_MUTATED')
        }
        return page.userContentEdits;
    }, {maxPages});

    if (nodes.some(edit => typeof edit.editedAt !== 'string' || !edit.editedAt)) {
        throw new Error('DISCUSSION_RECONCILIATION_EDIT_REVISION_INVALID')
    }
    if (!head.includesCreatedEdit) return nodes;
    const creation = nodes.filter(edit => edit.editedAt === entity.createdAt);
    if (creation.length !== 1) throw new Error('DISCUSSION_RECONCILIATION_CREATION_REVISION_AMBIGUOUS');
    return nodes.filter(edit => edit !== creation[0]);
}

/**
 * @summary Re-enumerates visible active/closed Discussions, each comment/reply connection and
 * every content revision. A second entity/count/census read fences mixed snapshots even when a
 * reply edit leaves its root timestamp unchanged. Failed families produce explicit coverage gaps;
 * only fully verified root snapshots emit metadata observations. This pure runner never persists
 * checkpoints or grants attention/claim authority.
 * @param {Object} seams Independent provider acquisition and verification functions.
 * @param {Object} [caps] Optional nonnegative page limits; reaching one degrades coverage.
 * @returns {Promise<Object>} Metadata observations, coverage, provider state, root and entity inventories.
 */
export async function reconcileDiscussionActivity(seams, caps={}) {
    const required = ['fetchDiscussionsPage', 'fetchCommentsPage', 'fetchRepliesPage',
        'fetchContentEditHeads', 'fetchContentEditsPage', 'verifyContentEntities', 'fetchCensusPage'];
    if (required.some(key => typeof seams?.[key] !== 'function')) {
        throw new Error('DISCUSSION_RECONCILIATION_REQUIRES_FETCH_SEAMS')
    }
    const {maxRootPages=Infinity, maxCommentPagesPerDiscussion=Infinity,
        maxReplyPagesPerComment=Infinity, maxEditPagesPerEntity=Infinity} = caps;
    for (const cap of [maxRootPages, maxCommentPagesPerDiscussion, maxReplyPagesPerComment, maxEditPagesPerEntity]) {
        if (cap !== Infinity && (!Number.isInteger(cap) || cap < 0)) {
            throw new Error('DISCUSSION_RECONCILIATION_PAGE_CAP_INVALID')
        }
    }
    const gaps  = UNSUPPORTED_DISCUSSION_HISTORY_GAPS.map(gap => ({...gap})),
          roots = [], entitiesSeen = new Set(), candidates = [], observations = [],
          seen  = node => entitiesSeen.add(node.id),
          gap   = (axis, error, discussionId) => gaps.push({axis, reason: reasonOf(error),
              ...(discussionId ? {discussionId} : {})}),
          rootPage = async (fetch, cursor) => {
              const page = await fetch({cursor});
              return {nodes: page.discussions, pageInfo: page.pageInfo, totalCount: page.totalCount}
          };
    let rootCursor = null, rootComplete = false;
    try {
        const result = await walk(cursor => rootPage(seams.fetchDiscussionsPage, cursor), {
            maxPages: maxRootPages, onNode: node => { roots.push(node); seen(node) }
        });
        rootCursor = result.cursor;
        rootComplete = true;
    } catch (error) { gap('discussions', error) }

    for (const root of roots) {
        const entities = [root], candidate = {root, entities, invalid: false};
        try {
            if (!Number.isInteger(root.comments?.totalCount)) throw new Error('DISCUSSION_RECONCILIATION_CHILD_COUNT_MISSING');
            const comments = await walk(async cursor => {
                const page = await seams.fetchCommentsPage({discussionId: root.id, cursor});
                verifyEntity({id: root.id, updatedAt: root.updatedAt}, page);
                return page.comments;
            }, {maxPages: maxCommentPagesPerDiscussion, expectedCount: root.comments.totalCount, onNode: seen});
            const hydratedComments = [];
            for (const comment of comments.nodes) {
                if (!Number.isInteger(comment.replies?.totalCount) ||
                    (comment.discussion && comment.discussion.id !== root.id) || comment.replyTo) {
                    throw new Error('DISCUSSION_RECONCILIATION_COMMENT_PARENT_INVALID')
                }
                entities.push(comment);
                const replies = await walk(async cursor => {
                    const page = await seams.fetchRepliesPage({commentId: comment.id, cursor});
                    verifyEntity({id: comment.id, updatedAt: comment.updatedAt}, page);
                    return page.replies;
                }, {maxPages: maxReplyPagesPerComment, expectedCount: comment.replies.totalCount, onNode: seen});
                for (const reply of replies.nodes) {
                    if ((reply.discussion && reply.discussion.id !== root.id) ||
                        (reply.replyTo && reply.replyTo.id !== comment.id)) {
                        throw new Error('DISCUSSION_RECONCILIATION_REPLY_PARENT_INVALID')
                    }
                    entities.push(reply);
                }
                hydratedComments.push({...comment, replies: replies.nodes});
            }
            candidate.hydrated = {...root, comments: hydratedComments};
            if (new Set(entities.map(entity => entity.id)).size !== entities.length) {
                throw new Error('DISCUSSION_RECONCILIATION_ENTITY_REUSED')
            }
            const heads = await seams.fetchContentEditHeads({entities});
            if (!Array.isArray(heads) || heads.length !== entities.length) throw new Error('DISCUSSION_RECONCILIATION_EDIT_HEADS_INVALID');
            const edits = new Map();
            for (let i=0; i<entities.length; i++) {
                if (heads[i].status !== 'fulfilled') throw heads[i].reason;
                edits.set(entities[i].id, await editsFor(entities[i], heads[i].value, seams, maxEditPagesPerEntity));
            }
            candidate.hydrated.contentEdits = edits.get(root.id);
            for (const comment of candidate.hydrated.comments) {
                comment.contentEdits = edits.get(comment.id);
                comment.replies = comment.replies.map(reply => ({...reply, contentEdits: edits.get(reply.id)}));
            }
            const verified = await seams.verifyContentEntities({entities});
            if (!Array.isArray(verified) || verified.length !== entities.length) throw new Error('DISCUSSION_RECONCILIATION_VERIFICATION_INVALID');
            entities.forEach((entity, i) => {
                if (verified[i].status !== 'fulfilled') throw verified[i].reason;
                verifyEntity(entity, verified[i].value);
            });
            candidates.push(candidate);
        } catch (error) { gap('discussion-conversation', error, root.id) }
    }

    if (rootComplete) {
        try {
            const census     = await walk(cursor => rootPage(seams.fetchCensusPage, cursor), {maxPages: maxRootPages}),
                  initialIds = roots.map(root => root.id).sort(),
                  finalIds   = census.nodes.map(root => root.id).sort();
            if (JSON.stringify(initialIds) !== JSON.stringify(finalIds)) throw new Error('DISCUSSION_RECONCILIATION_ROOT_MEMBERSHIP_MUTATED');
            const byId = new Map(census.nodes.map(node => [node.id, node]));
            for (const candidate of candidates) {
                try { verifyEntity(candidate.root, byId.get(candidate.root.id)) }
                catch (error) { candidate.invalid = true; gap('discussion-census', error, candidate.root.id) }
            }
        } catch (error) {
            candidates.forEach(candidate => { candidate.invalid = true });
            gap('discussion-census', error);
        }
    }
    for (const candidate of candidates) {
        if (!candidate.invalid) {
            try { observations.push(...discussionToObservations(candidate.hydrated)) }
            catch (error) { gap('discussion-normalization', error, candidate.root.id) }
        }
    }
    return {
        observations,
        currentInventory      : roots.map(root => root.id),
        currentEntityInventory: [...entitiesSeen],
        coverage              : {fromBasis: GENESIS_BASIS, toBasis: rootCursor ?? GENESIS_BASIS, complete: gaps.length === 0, gaps},
        nextProviderState     : {discussionsCursor: rootCursor, rootCount: roots.length}
    }
}
