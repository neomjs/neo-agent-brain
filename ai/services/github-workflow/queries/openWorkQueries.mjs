/**
 * @module ai/services/github-workflow/queries/openWorkQueries
 * @summary The open-work producer's two reads (`ai/services/fleet/openWorkProducer.mjs`): the open
 * pull requests of the repositories the Fleet's seats work on, and the ones merged or closed within a
 * window of close times. Both are one search per page, and `pageInfo` is part of the contract: a page
 * the budget cuts off, or a review-request, latest-review or latest-opinion list past its first 20,
 * makes the pulse partial, never complete. The latest review is any engagement, a comment included;
 * the latest opinion is each reviewer's standing approval or change request, which a later comment
 * on the same head does not withdraw.
 *
 * Variables: `$query` (a search string with `is:pr` and the `repo:` qualifiers), `$cursor`.
 */
import {createHash} from 'node:crypto';

/**
 * The open half: per PR, what a holder change is computed from, and the title the cockpit names it by.
 * @type {String}
 */
export const OPEN_WORK_SNAPSHOT = `
  query OpenWorkSnapshot($query: String!, $cursor: String) {
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
          title
          isDraft
          headRefOid
          reviewDecision
          mergeable
          body
          author {
            login
          }
          repository {
            nameWithOwner
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
              state
              author {
                login
              }
              commit {
                oid
              }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                oid
                statusCheckRollup {
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
 * @summary Published GraphQL formula estimates for these two static documents, not timeout-cost bounds.
 * Snapshot has the search plus four connections for up to 50 PRs: round((1 + 50 * 4) / 100) = 2.
 * Terminal has one connection; the published minimum is one. The gate also uses measured maxima.
 * @see https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
 * @type {Object[]}
 */
export const OPEN_WORK_QUERY_COSTS = Object.freeze([
    Object.freeze({queryHash: createHash('sha256').update(OPEN_WORK_SNAPSHOT).digest('hex'), formulaCost: 2}),
    Object.freeze({queryHash: createHash('sha256').update(OPEN_WORK_TERMINAL).digest('hex'), formulaCost: 1})
]);

/**
 * @summary Identify one of the existing static documents without hashing variables or credentials.
 * @param {String} query The exact static document.
 * @returns {Object|null} Its declared operational estimate, or null for an unsupported document.
 */
export function openWorkQueryCost(query) {
    return query === OPEN_WORK_SNAPSHOT ? OPEN_WORK_QUERY_COSTS[0] : query === OPEN_WORK_TERMINAL ? OPEN_WORK_QUERY_COSTS[1] : null
}
