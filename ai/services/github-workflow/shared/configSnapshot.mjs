import path                                         from 'path';
import {cloneConfigSubtree, validateConfigSnapshot} from '../../shared/configSnapshot.mjs';

/**
 * Clone the `github-workflow` configuration slices from `aiConfig` into an isolated plain
 * object with reactive path getters on `issueSync` so tests can override `contentRootOverride`,
 * `archiveChunkThreshold`, `routeByMilestone`, `discussionDenylist`, `issueDenylist`, etc.
 * without mutating the shared `aiConfig` module object.
 *
 * @param {Object} aiConfig
 * @param {Object} [overrides={}]
 * @returns {Object}
 */
export function createGitHubWorkflowConfigSnapshot(aiConfig, overrides = {}) {
    const baseIssueSync      = cloneConfigSubtree(aiConfig, ['issueSync']);
    const issueSyncOverrides = overrides.issueSync || {};

    const issueSync = {
        ...baseIssueSync,
        ...issueSyncOverrides,
        droppedLabels: [
            ...(issueSyncOverrides.droppedLabels ?? baseIssueSync.droppedLabels ?? [])
        ],
        discussionDenylist: {
            numbers: [
                ...(issueSyncOverrides.discussionDenylist?.numbers ?? baseIssueSync.discussionDenylist?.numbers ?? [])
            ],
            authors: [
                ...(issueSyncOverrides.discussionDenylist?.authors ?? baseIssueSync.discussionDenylist?.authors ?? [])
            ]
        },
        issueDenylist: {
            numbers: [
                ...(issueSyncOverrides.issueDenylist?.numbers ?? baseIssueSync.issueDenylist?.numbers ?? [])
            ],
            authors: [
                ...(issueSyncOverrides.issueDenylist?.authors ?? baseIssueSync.issueDenylist?.authors ?? [])
            ]
        },
        productNameDenylist: [
            ...(issueSyncOverrides.productNameDenylist ?? baseIssueSync.productNameDenylist ?? [])
        ]
    };

    const basePullRequest      = cloneConfigSubtree(aiConfig, ['pullRequest']);
    const pullRequestOverrides = overrides.pullRequest || {};

    const pullRequest = {
        ...basePullRequest,
        ...pullRequestOverrides,
        defaults: {
            ...(basePullRequest.defaults || {}),
            ...(pullRequestOverrides.defaults || {})
        }
    };

    const snapshot = {
        owner      : overrides.owner ?? aiConfig.owner,
        repo       : overrides.repo ?? aiConfig.repo,
        projectRoot: overrides.projectRoot ?? aiConfig.projectRoot,
        pullRequest,
        issueSync
    };

    Object.defineProperties(issueSync, {
        metadataBaseRoot: {
            enumerable  : true,
            configurable: true,
            get() { return this.contentRootOverride ?? snapshot.projectRoot; }
        },
        contentRoot: {
            enumerable  : true,
            configurable: true,
            get() { return this.contentRootOverride ?? ''; }
        },
        corpusLeaseFile: {
            enumerable  : true,
            configurable: true,
            get() { return this.contentRoot ? path.resolve(this.contentRoot, '.corpus-sync.lock') : ''; }
        },
        originRoot: {
            enumerable  : true,
            configurable: true,
            get() { return this.contentRootOverride ? path.resolve(this.contentRootOverride, snapshot.repo) : ''; }
        },
        issuesDir: {
            enumerable  : true,
            configurable: true,
            get() { return this.issuesDirOverride ?? (this.originRoot ? path.resolve(this.originRoot, 'issues') : ''); }
        },
        archiveRoot: {
            enumerable  : true,
            configurable: true,
            get() { return this.archiveRootOverride ?? (this.originRoot ? path.resolve(this.originRoot, 'archive') : ''); }
        },
        discussionsDir: {
            enumerable  : true,
            configurable: true,
            get() { return this.discussionsDirOverride ?? (this.originRoot ? path.resolve(this.originRoot, 'discussions') : ''); }
        },
        pullsDir: {
            enumerable  : true,
            configurable: true,
            get() { return this.pullsDirOverride ?? (this.originRoot ? path.resolve(this.originRoot, 'pulls') : ''); }
        },
        metadataFile: {
            enumerable  : true,
            configurable: true,
            get() { return this.metadataFileOverride ?? (this.originRoot ? path.resolve(this.originRoot, '.sync-metadata.json') : ''); }
        },
        releaseNotesDir: {
            enumerable  : true,
            configurable: true,
            get() { return this.releaseNotesDirOverride ?? (this.originRoot ? path.resolve(this.originRoot, 'release-notes') : ''); }
        }
    });

    return snapshot;
}

/**
 * Validate a `github-workflow` service config snapshot before storing it.
 *
 * @param {Object|null} value
 * @param {String} serviceName
 * @returns {Object|null}
 */
export function validateGitHubWorkflowConfigSnapshot(value, serviceName) {
    return validateConfigSnapshot(value, {
        serviceName,
        requiredSubtrees: ['issueSync']
    });
}
