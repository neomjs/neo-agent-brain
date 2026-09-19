/**
 * @summary Metadata-only GraphQL selections for exhaustive GitHub Discussion reconciliation.
 *
 * Roots, comments, replies, revisions, and verification remain independent axes. The selections
 * deliberately exclude titles, bodies, excerpts, and diffs: this adapter emits provider identity,
 * revision, actor, and coverage facts for neutral admission, never automatic prose.
 * @module ai/services/github-workflow/queries/discussionReconciliationQueries
 */

const ACTOR_SELECTION = 'login __typename';

const EDIT_CONNECTION_SELECTION = `
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes { id editedAt editor { ${ACTOR_SELECTION} } }`;

const COMMENT_SELECTION = `
  id createdAt updatedAt lastEditedAt deletedAt authorAssociation
  author { ${ACTOR_SELECTION} }
  discussion { id }
  replyTo { id }
  replies(first: 1) { totalCount }`;

const CONTENT_EDIT_HEAD_SELECTION = `
  id __typename createdAt updatedAt lastEditedAt includesCreatedEdit
  userContentEdits(first: $editPage) { ${EDIT_CONNECTION_SELECTION} }`;

const CONTENT_EDIT_PAGE_SELECTION = `
  id __typename createdAt updatedAt lastEditedAt includesCreatedEdit
  userContentEdits(first: $editPage, after: $after) { ${EDIT_CONNECTION_SELECTION} }`;

/** @summary Enumerates every visible Discussion root in stable creation order. */
export const FETCH_RECONCILE_DISCUSSIONS = `
query ReconcileDiscussions($owner: String!, $repo: String!, $after: String, $rootPage: Int!) {
  repository(owner: $owner, name: $repo) {
    discussions(first: $rootPage, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id number closed closedAt createdAt updatedAt lastEditedAt authorAssociation
        author { ${ACTOR_SELECTION} }
        comments(first: 1) { totalCount }
      }
    }
  }
}`;

/** @summary Continues one Discussion's top-level comment connection. */
export const FETCH_RECONCILE_DISCUSSION_COMMENTS = `
query ReconcileDiscussionComments($discussionId: ID!, $after: String, $childPage: Int!) {
  node(id: $discussionId) {
    ... on Discussion {
      id
      updatedAt
      comments(first: $childPage, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_SELECTION} }
      }
    }
  }
}`;

/** @summary Continues one Discussion comment's nested reply connection. */
export const FETCH_RECONCILE_DISCUSSION_REPLIES = `
query ReconcileDiscussionReplies($commentId: ID!, $after: String, $childPage: Int!) {
  node(id: $commentId) {
    ... on DiscussionComment {
      id
      updatedAt
      replies(first: $childPage, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_SELECTION} }
      }
    }
  }
}`;

/** @summary Re-reads root membership and mutable root/child-count evidence after traversal. */
export const FETCH_RECONCILE_DISCUSSION_CENSUS = `
query ReconcileDiscussionCensus($owner: String!, $repo: String!, $after: String, $rootPage: Int!) {
  repository(owner: $owner, name: $repo) {
    discussions(first: $rootPage, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id updatedAt
        comments(first: 1) { totalCount }
      }
    }
  }
}`;

/** @summary Hydrates first revision pages for Discussion and DiscussionComment nodes in one batch. */
export const FETCH_RECONCILE_DISCUSSION_CONTENT_EDIT_HEADS = `
query ReconcileDiscussionContentEditHeads($ids: [ID!]!, $editPage: Int!) {
  nodes(ids: $ids) {
    ... on Discussion        { ${CONTENT_EDIT_HEAD_SELECTION} }
    ... on DiscussionComment { ${CONTENT_EDIT_HEAD_SELECTION} }
  }
}`;

/** @summary Continues one Discussion or DiscussionComment revision connection by stable node id. */
export const FETCH_RECONCILE_DISCUSSION_CONTENT_EDITS = `
query ReconcileDiscussionContentEdits($entityId: ID!, $after: String, $editPage: Int!) {
  node(id: $entityId) {
    ... on Discussion        { ${CONTENT_EDIT_PAGE_SELECTION} }
    ... on DiscussionComment { ${CONTENT_EDIT_PAGE_SELECTION} }
  }
}`;

/** @summary Verifies root comment counts and comment reply counts with their revision tokens. */
export const FETCH_RECONCILE_DISCUSSION_CONTENT_REVISIONS = `
query ReconcileDiscussionContentRevisions($ids: [ID!]!) {
  nodes(ids: $ids) {
    id __typename
    ... on Discussion {
      updatedAt
      comments(first: 1) { totalCount }
    }
    ... on DiscussionComment {
      updatedAt
      replies(first: 1) { totalCount }
    }
  }
}`;
