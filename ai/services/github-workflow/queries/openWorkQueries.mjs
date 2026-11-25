/**
 * @module ai/services/github-workflow/queries/openWorkQueries
 * @summary The open-work producer's two reads (`ai/services/fleet/openWorkProducer.mjs`): the open
 * pull requests of the repositories the Fleet's seats work on, and the ones merged or closed within a
 * window of close times. Both are one search per page, and `pageInfo` is part of the contract: a page
 * the budget cuts off, or a review-request, latest-review or latest-opinion list past its first 20,
 * makes the pulse partial, never complete. The latest review is any engagement, a comment included;
 * the latest opinion is each reviewer's standing approval or change request, which a later comment
 * on the same head does not withdraw. Original review history has its own bounded timeline coverage;
 * its unread prefix never makes current-work coverage partial.
 *
 * Variables: `$query` (a search string with `is:pr` and the `repo:` qualifiers), `$cursor`.
 *
 * A merged pull request adds one read, once: what its merge unblocked ({@link OPEN_WORK_UNBLOCKED}).
 * Only the outside read adds original comment and current-head check facts for CI classification.
 * Legacy native-seat `repair-ci` wakes retain their send-time check-name read.
 */
import {createHash} from 'node:crypto';

/**
 * @summary Builds the shared open-work selection, with extra fields only for the outside reader.
 * The body and every commit's message (up to 100, with whether more exist) carry the model an outside PR names.
 * Each issue it closes carries GitHub's count of its open blockers, which holds an approved head off the merge.
 * @param {String} name Static GraphQL operation name.
 * @param {Boolean} [includeOutside=false] Include original CI evidence inside the existing connections.
 * @returns {String}
 * @private
 */
function snapshotQuery(name, includeOutside = false) {
    return `
  query ${name}($query: String!, $cursor: String) {
    viewer { id }
    rateLimit {
      cost
      limit
      remaining
      resetAt
    }
    search(query: $query, type: ISSUE, first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          id
          number
          title
          isDraft
          headRefOid
          baseRefName
          reviewDecision
          mergeable
          mergeStateStatus
          body
          authorAssociation
          author {
            __typename
            login
          }
          repository {
            nameWithOwner
          }
          closingIssuesReferences(first: 10) {
            pageInfo {
              hasNextPage
            }
            nodes {
              number
              repository {
                nameWithOwner
              }
              issueDependenciesSummary {
                blockedBy
              }
            }
          }
          commitMessages: commits(first: 100) {
            pageInfo {
              hasNextPage
            }
            nodes {
              commit {
                message
              }
            }
          }
          reviewRequests(first: 20) {
            pageInfo {
              hasNextPage
            }
            nodes {
              requestedReviewer {
                __typename
                ... on User {
                  login
                }
                ... on Bot {
                  login
                }
                ... on Mannequin {
                  login
                }
                ... on Team {
                  slug
                  organization {
                    login
                  }
                }
              }
            }
          }
          latestReviews(first: 20) {
            pageInfo {
              hasNextPage
            }
            nodes {
              state
              author {
                __typename
                login
              }
              commit {
                oid
              }
            }
          }
          latestOpinionatedReviews(first: 20) {
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              submittedAt
              state
              author {
                __typename
                ... on Node { id }
                login
              }
              commit {
                oid
              }
            }
          }
          comments(last: 10) {
            pageInfo {
              hasPreviousPage
            }
            nodes {
              ${includeOutside ? 'id url body updatedAt' : ''}
              createdAt
              authorAssociation
              author {
                __typename
                ${includeOutside ? '... on Node { id }' : ''}
                login
              }
            }
          }
          reviews(last: 10) {
            pageInfo {
              hasPreviousPage
            }
            nodes {
              submittedAt
              authorAssociation
              author {
                __typename
                login
              }
            }
          }
          timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, REVIEW_DISMISSED_EVENT]) {
            pageInfo {
              hasPreviousPage
              hasNextPage
            }
            nodes {
              __typename
              ... on ReviewRequestedEvent {
                id
                createdAt
                actor { __typename login ... on Node { id } }
                requestedReviewer {
                  __typename
                  ... on Node { id }
                  ... on User { login }
                  ... on Bot { login }
                  ... on Mannequin { login }
                  ... on Team { slug organization { login } }
                }
              }
              ... on ReviewRequestRemovedEvent {
                id
                createdAt
                actor { __typename login ... on Node { id } }
                requestedReviewer {
                  __typename
                  ... on Node { id }
                  ... on User { login }
                  ... on Bot { login }
                  ... on Mannequin { login }
                  ... on Team { slug organization { login } }
                }
              }
              ... on ReviewDismissedEvent {
                id
                createdAt
                actor { __typename login ... on Node { id } }
                review { id }
              }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                oid
                status {
                  state
                  contexts {
                    context
                    state
                  }
                }
                statusCheckRollup {
                  state
                  ${includeOutside ? `contexts(first: 100) {
                    pageInfo {
                      hasNextPage
                    }
                    nodes {
                      __typename
                      ... on CheckRun {
                        id
                        name
                        status
                        conclusion
                        startedAt
                        completedAt
                        checkSuite {
                          app { id slug }
                          workflowRun {
                            workflow { id name }
                          }
                        }
                      }
                      ... on StatusContext {
                        id
                        context
                        state
                        createdAt
                        updatedAt
                        targetUrl
                      }
                    }
                  }` : ''}
                }
                checkSuites(last: 100) {
                  pageInfo {
                    hasPreviousPage
                  }
                  nodes {
                    status
                    conclusion
                    workflowRun {
                      event
                      workflow {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;
}

/** @summary Lean authored and held seat pages, including the common holder and review facts. @type {String} */
export const OPEN_WORK_SNAPSHOT = snapshotQuery('OpenWorkSnapshot');

/** @summary Outside pages add original receipts and head-bound check evidence for CI classification. @type {String} */
export const OPEN_WORK_OUTSIDE_SNAPSHOT = snapshotQuery('OpenWorkOutsideSnapshot', true);

/**
 * The terminal half: merged or closed PRs whose close falls in the producer's window.
 * @type {String}
 */
export const OPEN_WORK_TERMINAL = `
  query OpenWorkTerminal($query: String!, $cursor: String) {
    viewer { id }
    rateLimit {
      cost
      limit
      remaining
      resetAt
    }
    search(query: $query, type: ISSUE, first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          number
          state
          headRefOid
          mergedAt
          closedAt
          body
          author {
            login
          }
          repository {
            nameWithOwner
          }
        }
      }
    }
  }
`;

/**
 * Closed issues whose close falls in the producer's catch-up window, with each issue's parent and that parent's
 * sub-issue summary, author and assignees, so the transition where an open parent's last sub closes is observed
 * without scanning open issues.
 * Variables: `$query` (a search string with `is:issue is:closed` and the `repo:` qualifiers), `$cursor`.
 * @type {String}
 */
export const OPEN_WORK_CLOSEOUT = `
  query OpenWorkCloseout($query: String!, $cursor: String) {
    viewer { id }
    rateLimit {
      cost
      limit
      remaining
      resetAt
    }
    search(query: $query, type: ISSUE, first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on Issue {
          number
          closedAt
          parent {
            number
            state
            repository {
              nameWithOwner
            }
            author {
              login
            }
            assignees(first: 10) {
              nodes {
                login
              }
            }
            subIssuesSummary {
              total
              completed
            }
          }
        }
      }
    }
  }
`;

/**
 * A merged pull request's unblock read: the issues it closes, the open issues each one blocks, and for those
 * their assignees and every issue still blocking them. Each dependency list carries `totalCount`, so a list
 * past its page is visible: an unread dependent would never be woken, and an unread blocker may still be open.
 * An issue has at most ten assignees, so their list is whole by GitHub's own limit.
 * Variables: `$owner`, `$name`, `$number`.
 * @type {String}
 */
export const OPEN_WORK_UNBLOCKED = `
  query OpenWorkUnblocked($owner: String!, $name: String!, $number: Int!) {
    viewer { id }
    rateLimit {
      cost
      limit
      remaining
      resetAt
    }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 10) {
          totalCount
          nodes {
            number
            repository {
              nameWithOwner
            }
            blocking(first: 50) {
              totalCount
              nodes {
                number
                state
                repository {
                  nameWithOwner
                }
                assignees(first: 10) {
                  nodes {
                    login
                  }
                }
                blockedBy(first: 50) {
                  totalCount
                  nodes {
                    number
                    state
                    repository {
                      nameWithOwner
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * A `repair-ci` wake's read: each check on one head, a check run by name, conclusion, start and workflow
 * (a re-run check keeps every run), a commit status by context and state. A head with more than one page
 * of checks is not a complete list.
 * Variables: `$owner`, `$name`, `$oid` (the full head).
 * @type {String}
 */
export const OPEN_WORK_FAILED_CHECKS = `
  query OpenWorkFailedChecks($owner: String!, $name: String!, $oid: GitObjectID!) {
    repository(owner: $owner, name: $name) {
      object(oid: $oid) {
        ... on Commit {
          statusCheckRollup {
            contexts(first: 100) {
              pageInfo {
                hasNextPage
              }
              nodes {
                ... on CheckRun {
                  name
                  conclusion
                  startedAt
                  checkSuite {
                    workflowRun {
                      workflow {
                        name
                      }
                    }
                  }
                }
                ... on StatusContext {
                  context
                  state
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * @summary Published GraphQL formula estimates for the static pulse documents, not timeout-cost bounds.
 * Seat snapshots have the search plus ten connections for up to 50 PRs: round((1 + 50 * 10) / 100) = 5.
 * Outside snapshots add head check contexts: round((1 + 50 * 11) / 100) = 6. Terminal has one connection;
 * the published minimum is one. Unblocked reads 10 closing issues, 50
 * blocked issues each, and two lists on each of those: round((1 + 10 + 500 + 500) / 100) = 10, which a
 * live read measured too. The gate also uses measured maxima.
 *
 * The third entry prices the previous published snapshot document. The wake gate looks up every retained pulse's
 * hash over its 24-hour window, and refuses a failed call it cannot price, so an upgrade would otherwise
 * hold a not-yet-activated producer for a day. It keeps one generation: the next change to the snapshot
 * replaces this hash with the then-current one rather than adding another.
 * @see https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
 * @type {Object[]}
 */
export const OPEN_WORK_QUERY_COSTS = Object.freeze([
    Object.freeze({queryHash: createHash('sha256').update(OPEN_WORK_SNAPSHOT).digest('hex'), formulaCost: 5}),
    Object.freeze({queryHash: createHash('sha256').update(OPEN_WORK_TERMINAL).digest('hex'), formulaCost: 1}),
    Object.freeze({queryHash: 'b5ff22d235e6f55be3d305f2684aeb8102789e434bd2f5f739b407614f68b4f0', formulaCost: 5}),
    Object.freeze({queryHash: createHash('sha256').update(OPEN_WORK_UNBLOCKED).digest('hex'), formulaCost: 10}),
    Object.freeze({queryHash: createHash('sha256').update(OPEN_WORK_OUTSIDE_SNAPSHOT).digest('hex'), formulaCost: 6}),
    Object.freeze({queryHash: 'cc48d6f109037e45aee1f032e624114d81cdd1ce944eaa50ad89d357262a16f2', formulaCost: 6}),
    Object.freeze({queryHash: createHash('sha256').update(OPEN_WORK_CLOSEOUT).digest('hex'), formulaCost: 1})
]);

/**
 * @summary Identify one of the existing static documents without hashing variables or credentials.
 * @param {String} query The exact static document.
 * @returns {Object|null} Its declared operational estimate, or null for an unsupported document.
 */
export function openWorkQueryCost(query) {
    return query === OPEN_WORK_SNAPSHOT ? OPEN_WORK_QUERY_COSTS[0]
        : query === OPEN_WORK_TERMINAL ? OPEN_WORK_QUERY_COSTS[1]
        : query === OPEN_WORK_UNBLOCKED ? OPEN_WORK_QUERY_COSTS[3]
        : query === OPEN_WORK_OUTSIDE_SNAPSHOT ? OPEN_WORK_QUERY_COSTS[4]
        : query === OPEN_WORK_CLOSEOUT ? OPEN_WORK_QUERY_COSTS[6] : null
}
