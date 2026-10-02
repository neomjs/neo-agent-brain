/**
 * @module ai/services/github-workflow/queries/openWorkQueries
 * @summary The open-work producer's two reads (`ai/services/fleet/openWorkProducer.mjs`): the open
 * pull requests of the repositories the Fleet's seats work on, and the ones merged or closed within a
 * window of close times. Both are one search per page, and `pageInfo` is part of the contract: a page
 * the budget cuts off, or a review-request or latest-review list past its first 20, makes the pulse
 * partial, never complete.
 *
 * Variables: `$query` (a search string with `is:pr` and the `repo:` qualifiers), `$cursor`.
 */

/**
 * The open half: per PR, what a holder change is computed from.
 * @type {String}
 */
export const OPEN_WORK_SNAPSHOT = `
  query OpenWorkSnapshot($query: String!, $cursor: String) {
    rateLimit {
      cost
    }
    search(query: $query, type: ISSUE, first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          number
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
    rateLimit {
      cost
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
