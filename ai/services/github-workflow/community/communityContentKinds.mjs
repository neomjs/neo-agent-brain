import {TIMELINE_KIND_BY_TYPENAME}              from './githubIssueObservations.mjs';
import {PULL_REQUEST_TIMELINE_KIND_BY_TYPENAME} from './githubPullRequestObservations.mjs';

/** @summary Body-bearing producer kinds mapped to their current provider entity type. */
const CONTENT_TYPES = {
    'issue.opened'                         : 'Issue',
    'issue.edited'                         : 'Issue',
    'issue.observed-snapshot-change'       : 'Issue',
    'issue.comment'                        : 'IssueComment',
    'issue.comment-edited'                 : 'IssueComment',
    'pull_request.opened'                  : 'PullRequest',
    'pull_request.edited'                  : 'PullRequest',
    'pull_request.observed-snapshot-change': 'PullRequest',
    'pull_request.comment'                 : 'IssueComment',
    'pull_request.comment-edited'          : 'IssueComment',
    'pull_request.review-created'          : 'PullRequestReview',
    'pull_request.review-submitted'        : 'PullRequestReview',
    'pull_request.review-edited'           : 'PullRequestReview',
    'pull_request.review-comment'          : 'rest-review-comment',
    'pull_request.review-comment-edited'   : 'rest-review-comment',
    'discussion.opened'                    : 'Discussion',
    'discussion.edited'                    : 'Discussion',
    'discussion.observed-snapshot-change'  : 'Discussion',
    'discussion.comment'                   : 'DiscussionComment',
    'discussion.comment-edited'            : 'DiscussionComment',
    'discussion.reply'                     : 'DiscussionComment',
    'discussion.reply-edited'              : 'DiscussionComment'
};

/** @summary Positive occurrence vocabulary mirrors producer roots, children and timeline maps; never popularity. */
export const SUPPORTED_GITHUB_COMMUNITY_KINDS = Object.freeze([
    ...Object.keys(CONTENT_TYPES),
    ...Object.values(TIMELINE_KIND_BY_TYPENAME),
    ...Object.values(PULL_REQUEST_TIMELINE_KIND_BY_TYPENAME),
    'issue.deleted', 'pull_request.deleted', 'discussion.deleted',
    'discussion.comment-deleted', 'discussion.reply-deleted'
]);

/** @summary Metadata event ids are not assumed to identify a prose-bearing entity. */
export function contentTypeFor(kind) {
    return Object.hasOwn(CONTENT_TYPES, kind) ? CONTENT_TYPES[kind] : null
}
