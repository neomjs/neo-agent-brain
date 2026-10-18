import Neo                                          from 'neo.mjs/src/Neo.mjs';
import {createConfigProxy}                          from '../../../ConfigProvider.mjs';
import ConfigBase                                   from '../../../mcp/server/github-workflow/configBase.mjs';
import {cloneConfigSubtree, validateConfigSnapshot} from '../../shared/configSnapshot.mjs';

/**
 * Build an isolated plain-object `github-workflow` configuration snapshot by applying
 * `overrides` to a disposable `ConfigBase` instance so all `issueSync` path formulas
 * derive from the single `configBase.mjs` SSOT definition.
 *
 * @param {Object} aiConfig
 * @param {Object} [overrides={}]
 * @returns {Object}
 */
export function createGitHubWorkflowConfigSnapshot(aiConfig, overrides = {}) {
    const isolated = createConfigProxy(Neo.create(ConfigBase));

    try {
        if (overrides.owner !== undefined) {
            isolated.owner = overrides.owner;
        }
        if (overrides.repo !== undefined) {
            isolated.repo = overrides.repo;
        }
        if (overrides.projectRoot !== undefined) {
            isolated.projectRoot = overrides.projectRoot;
        }

        const issueSyncOverrides = overrides.issueSync || {};
        for (const [key, value] of Object.entries(issueSyncOverrides)) {
            if (key === 'discussionDenylist' || key === 'issueDenylist') {
                isolated.issueSync[key] = {
                    ...isolated.issueSync[key],
                    ...value,
                    numbers: [...(value?.numbers ?? isolated.issueSync[key]?.numbers ?? [])],
                    authors: [...(value?.authors ?? isolated.issueSync[key]?.authors ?? [])]
                };
            } else if (Array.isArray(value)) {
                isolated.issueSync[key] = [...value];
            } else {
                isolated.issueSync[key] = value;
            }
        }

        const pullRequestOverrides = overrides.pullRequest || {};
        for (const [key, value] of Object.entries(pullRequestOverrides)) {
            if (key === 'defaults' && value && typeof value === 'object') {
                isolated.pullRequest.defaults = {
                    ...isolated.pullRequest.defaults,
                    ...value
                };
            } else {
                isolated.pullRequest[key] = value;
            }
        }

        return {
            owner      : isolated.owner,
            repo       : isolated.repo,
            projectRoot: isolated.projectRoot,
            pullRequest: cloneConfigSubtree(isolated, ['pullRequest']),
            issueSync  : cloneConfigSubtree(isolated, ['issueSync'])
        };
    } finally {
        isolated.destroy();
    }
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
