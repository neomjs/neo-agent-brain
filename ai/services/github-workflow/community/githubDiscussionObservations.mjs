import {actorKindFromTypename} from './githubIssueObservations.mjs';

/** @summary Keeps provider actor kind separate from source-relative association and attention. */
function projectActor(actor, sourceAssociation = null) {
    return {
        actorId  : actor?.login ?? null,
        actorKind: actorKindFromTypename(actor?.__typename),
        sourceAssociation
    }
}

/** @summary Appends immutable provider revision IDs only after complete edit-history verification. */
function appendEdits(observations, entity, occurrenceKind, revisionOf, parentProviderEntityId = null) {
    if (!Array.isArray(entity.contentEdits)) {
        if (entity.lastEditedAt) {
            throw new Error(`DISCUSSION_OBSERVATIONS_REQUIRE_EXHAUSTIVE_EDITS:${entity.id}`)
        }
        return
    }

    const ids = new Set();

    for (const edit of entity.contentEdits) {
        if (!edit?.id || !edit.editedAt || ids.has(edit.id)) {
            throw new Error(`DISCUSSION_OBSERVATIONS_EDIT_ID_INVALID:${entity.id}`)
        }

        ids.add(edit.id);
        observations.push({
            providerEntityId    : entity.id,
            ...(parentProviderEntityId ? {parentProviderEntityId} : {}),
            occurrenceKind,
            occurrenceCoordinate: edit.id,
            occurredAt          : edit.editedAt,
            revisionOf,
            ...projectActor(edit.editor)
        })
    }

    const latestEdit = entity.contentEdits.reduce((latest, edit) =>
        !latest || edit.editedAt > latest ? edit.editedAt : latest, null);
    if (Object.hasOwn(entity, 'lastEditedAt') && (entity.lastEditedAt ?? null) !== latestEdit) {
        throw new Error(`DISCUSSION_OBSERVATIONS_LAST_EDIT_MISMATCH:${entity.id}`)
    }
}

/** @summary Records an explicitly provider-dated deletion without inventing its actor. */
function appendDeletion(observations, entity, occurrenceKind, parentProviderEntityId = null) {
    if (!entity.deletedAt) return;

    observations.push({
        providerEntityId    : entity.id,
        ...(parentProviderEntityId ? {parentProviderEntityId} : {}),
        occurrenceKind,
        occurrenceCoordinate: `${entity.id}:deleted:${entity.deletedAt}`,
        occurredAt          : entity.deletedAt,
        actorId             : null,
        actorKind           : 'unknown',
        sourceAssociation   : null,
        absence             : 'deleted',
        deletionEvidence    : {deletedAt: entity.deletedAt},
        lossMarker          : 'deleter-unattributed'
    })
}

/** @summary Preserves a nested reply's own identity and its direct comment parent. */
function appendReplyObservations(observations, reply, commentId) {
    if (!reply?.id) {
        throw new Error('DISCUSSION_OBSERVATIONS_REQUIRE_REPLY_ID')
    }

    const revisionOf = `${reply.id}:created`;

    observations.push({
        providerEntityId      : reply.id,
        parentProviderEntityId: commentId,
        occurrenceKind        : 'discussion.reply',
        occurrenceCoordinate  : revisionOf,
        occurredAt            : reply.createdAt,
        ...projectActor(reply.author, reply.authorAssociation ?? null)
    });
    appendEdits(observations, reply, 'discussion.reply-edited', revisionOf, commentId);
    appendDeletion(observations, reply, 'discussion.reply-deleted', commentId)
}

/**
 * @summary Maps one fully reconciled Discussion to stable, metadata-only occurrence observations.
 * Root, comment, reply, and revision identities remain distinct; a root revision that lacks a
 * granular source fact becomes an explicitly unattributed snapshot marker, never invented state
 * history. Attention remains server policy, not adapter policy.
 * @param {Object} discussion Reconciled root with flat `comments` and flat nested `replies` arrays.
 * @returns {Object[]}
 */
export function discussionToObservations(discussion) {
    if (!discussion?.id) {
        throw new Error('DISCUSSION_OBSERVATIONS_REQUIRE_NODE_ID')
    }

    const observations = [],
          rootRevision = `${discussion.id}:opened`;

    observations.push({
        providerEntityId    : discussion.id,
        occurrenceKind      : 'discussion.opened',
        occurrenceCoordinate: rootRevision,
        occurredAt          : discussion.createdAt,
        ...projectActor(discussion.author, discussion.authorAssociation ?? null)
    });
    appendEdits(observations, discussion, 'discussion.edited', rootRevision);

    for (const comment of discussion.comments ?? []) {
        if (!comment?.id || !Array.isArray(comment.replies)) {
            throw new Error('DISCUSSION_OBSERVATIONS_REQUIRE_COMMENT_AND_REPLIES')
        }

        const revisionOf = `${comment.id}:created`;

        observations.push({
            providerEntityId      : comment.id,
            parentProviderEntityId: discussion.id,
            occurrenceKind        : 'discussion.comment',
            occurrenceCoordinate  : revisionOf,
            occurredAt            : comment.createdAt,
            ...projectActor(comment.author, comment.authorAssociation ?? null)
        });
        appendEdits(observations, comment, 'discussion.comment-edited', revisionOf, discussion.id);
        appendDeletion(observations, comment, 'discussion.comment-deleted', discussion.id);

        for (const reply of comment.replies) {
            appendReplyObservations(observations, reply, comment.id)
        }
    }

    if (discussion.updatedAt) {
        const newestExplained = observations.reduce(
            (latest, observation) => observation.occurredAt > latest ? observation.occurredAt : latest,
            discussion.createdAt
        );

        if (discussion.updatedAt > newestExplained) {
            observations.push({
                providerEntityId    : discussion.id,
                occurrenceKind      : 'discussion.observed-snapshot-change',
                occurrenceCoordinate: `${discussion.id}:snapshot:${discussion.updatedAt}`,
                occurredAt          : discussion.updatedAt,
                actorId             : null,
                actorKind           : 'unknown',
                sourceAssociation   : null,
                lossMarker          : 'snapshot-without-granular-event'
            })
        }
    }

    return observations
}
