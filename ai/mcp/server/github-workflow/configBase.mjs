import path                   from 'path';
import {fileURLToPath}        from 'url';
import ConfigProvider, {leaf} from '../../../ConfigProvider.mjs';

const __filename     = fileURLToPath(import.meta.url);
const __dirname      = path.dirname(__filename);
const packageRoot    = path.resolve(__dirname, '../../../../');
const projectRoot    = process.cwd() === '/' ? packageRoot : process.cwd();
const contentRoot    = path.resolve(projectRoot, 'resources/content');
const validLogLevels = ['error', 'warn', 'info', 'log', 'debug'];

function parseLogLevel(envVarName, {env = process.env, warn = console.warn} = {}) {
    const rawValue = env[envVarName];
    if (rawValue === undefined || rawValue === null || rawValue === '') return;
    const value = String(rawValue).trim().toLowerCase();

    if (validLogLevels.includes(value)) {
        return value;
    }

    warn(`[Config] Invalid ${envVarName} value: "${rawValue}" (must be one of: ${validLogLevels.join(', ')}); falling back.`);
    return undefined;
}

/**
 * @summary Extendable defaults and formulas for the GitHub Workflow MCP server.
 *
 * Supports loading configuration from a custom file and merging with defaults.
 * The configuration handles GitHub repository details, sync settings, and server behavior options.
 *
 * @class Neo.ai.mcp.server.github-workflow.ConfigBase
 * @extends Neo.ai.ConfigProvider
 */
class ConfigBase extends ConfigProvider {
    static config = {
        /**
         * @member {String} className='Neo.ai.mcp.server.github-workflow.ConfigBase'
         * @protected
         */
        className: 'Neo.ai.mcp.server.github-workflow.ConfigBase',
        /**
         * @member {Object} data
         */
        data: {
            /**
             * The checkout owning ordinary GitHub Workflow operations.
             * @type {string}
             */
            projectRoot: leaf(projectRoot),
            /**
             * Global debug flag for all MCP servers.
             * @type {boolean}
             */
            debug: leaf(false),
            /**
             * Minimum stderr log level for the GitHub workflow logger.
             * @type {string}
             */
            logLevel: leaf('warn', 'NEO_LOG_LEVEL', 'string', {parse: parseLogLevel}),
            /**
             * @summary Shared MCP logger policy for GitHub Workflow.
             *
             * Priority-filtered stderr only. `debug: true` promotes the default `warn`
             * threshold to `debug`; no file sink is used for this workflow server.
             * @type {Object}
             */
            logger: leaf({
                defaultLevel: 'warn',
                fileSink    : false,
                stderrMode  : 'threshold'
            }),
            /**
             * Cache duration for healthy health checks (in milliseconds).
             * Unhealthy results are never cached.
             * @type {number}
             */
            healthCheckCacheDuration: leaf(5 * 60 * 1000), // 5 minutes
            /**
             * The minimum required version of the GitHub CLI (`gh`).
             * @type {string}
             */
            minGhVersion: leaf('2.0.0'),
            /**
             * The owner of the GitHub repository.
             * @type {string}
             */
            owner: leaf('neomjs', 'NEO_MCP_GITHUB_OWNER', 'string'),
            /**
             * The name of the GitHub repository.
             * @type {string}
             */
            repo: leaf('neo', 'NEO_MCP_GITHUB_REPO', 'string'),
            /**
             * Whether to automatically commit and push changes after a sync.
             * Only executes if the user has write permissions and there are non-metadata changes.
             * @type {boolean}
             */
            pushToRepoAfterSync: leaf(true),
            /**
             * Configuration for the issue synchronization service.
             */
            issueSync: {
                /**
                 * The root directory for synced content.
                 * @type {string}
                 */
                contentRootOverride: leaf(null, 'NEO_MCP_GITHUB_CONTENT_ROOT', 'string', {
                    requiredFor: [{
                        entrypoints: ['sync-github-workflow'],
                        modes      : ['corpus-only'],
                        reason     : 'Corpus-only emission requires an explicitly declared destination root.'
                    }]
                }),
                /**
                 * Explicit provenance for legacy unqualified input. New writes always use the
                 * resolved repository identity and never infer it from a filesystem path.
                 * @type {string|null}
                 */
                legacyRepoSlug: leaf(null, 'NEO_MCP_GITHUB_LEGACY_REPO_SLUG', 'string'),
                /**
                 * The path to the directory for active issues.
                 * @type {string}
                 */
                issuesDirOverride: leaf(null, 'NEO_MCP_GITHUB_ISSUES_DIR', 'string'),
                /**
                 * The root directory for version-based archives across all entities.
                 * @type {string}
                 */
                archiveRootOverride: leaf(null, 'NEO_MCP_GITHUB_ARCHIVE_ROOT', 'string'),
                /**
                 * The path to the directory for discussions.
                 * @type {string}
                 */
                discussionsDirOverride: leaf(null, 'NEO_MCP_GITHUB_DISCUSSIONS_DIR', 'string'),
                /**
                 * Initial number of discussions projected per GraphQL page (1–30). The syncer halves
                 * this value and retries the same cursor when GitHub reports
                 * `RESOURCE_LIMITS_EXCEEDED`.
                 * @type {number}
                 */
                discussionOuterPageSize: leaf(30),
                /**
                 * The path to the directory for pull requests.
                 * @type {string}
                 */
                pullsDirOverride: leaf(null, 'NEO_MCP_GITHUB_PULLS_DIR', 'string'),
                /**
                 * The path to the synchronization metadata file.
                 * @type {string}
                 */
                metadataFileOverride: leaf(null, 'NEO_MCP_GITHUB_METADATA_FILE', 'string'),
                /**
                 * Labels that, when present on an issue, will cause it to be ignored and deleted locally.
                 * @type {string[]}
                 */
                droppedLabels: leaf(['dropped', 'wontfix', 'duplicate']),
                /**
                 * Containment denylist: discussions whose `number` or `author.login` match are excluded
                 * from sync — never written to `resources/content/**` or downstream KB chunks. Cached
                 * copies are quarantined (file + content-index entry removed) by `number` even when
                 * GitHub no longer lists them; `author` matching is fetch-time exclusion only (the sync
                 * cache persists `number`, not author). Policy-free; the empty default is a no-op.
                 * @type {{numbers: Number[], authors: String[]}}
                 */
                discussionDenylist: leaf({numbers: [], authors: []}),
                /**
                 * Containment denylist for issues — the `discussionDenylist` sibling, on the surface we
                 * actually get attacked on. Issues whose `number` or `author.login` match are excluded
                 * from sync and never written to `resources/content/**` or downstream KB chunks.
                 *
                 * `droppedLabels` already contains a labelled issue, but only by asserting a disposition
                 * (`dropped` / `wontfix` / `duplicate`) that hostile content does not have, and only one
                 * artifact at a time. This leaf is the author-level and number-level lever: one entry
                 * contains an account, and it does not require mislabelling the artifact to do it.
                 *
                 * `number` matching quarantines an already-synced copy (file + content-index entry) even
                 * when GitHub no longer lists it — the spam-hammer-hidden case. `author` matching is
                 * fetch-time exclusion only, because `metadata.issues` persists `number` and not author
                 * login, so a cached copy cannot be resolved back to its author. Policy-free; the empty
                 * default is a no-op.
                 * @type {{numbers: Number[], authors: String[]}}
                 */
                issueDenylist: leaf({numbers: [], authors: []}),
                /**
                 * Product names to redact from untrusted GitHub-authored content when the content-trust
                 * sanitizer projects sync/write-boundary Markdown. Empty by default; policy values belong
                 * in local config, not in syncer code.
                 * @type {string[]}
                 */
                productNameDenylist: leaf([]),
                /**
                 * The date from which to start synchronizing issues and releases.
                 * @type {string}
                 */
                syncStartDate: leaf('2025-01-01T00:00:00Z'),
                /**
                 * The path to the directory for release notes.
                 * @type {string}
                 */
                releaseNotesDirOverride: leaf(null, 'NEO_MCP_GITHUB_RELEASE_NOTES_DIR', 'string'),
                /**
                 * A prefix for issue filenames to prevent them from starting with a number (e.g., 'issue-').
                 * @type {string}
                 */
                issueFilenamePrefix: leaf('issue-'),
                /**
                 * @member {String} discussionFilenamePrefix='discussion-'
                 */
                discussionFilenamePrefix: leaf('discussion-'),
                /**
                 * A prefix for version-based archive directories (e.g., 'v' for 'v1.2.3').
                 * Applies to both milestone titles and release tags.
                 * @type {string}
                 */
                versionDirectoryPrefix: leaf('v'),
                /**
                 * Whether closed issues and pull requests may use semver milestone titles as an
                 * archive-bucket fallback when release-date bucketing finds no cut release.
                 * @type {boolean}
                 */
                routeByMilestone: leaf(false),
                /**
                 * The maximum number of items per chunk directory in the archive.
                 * @type {number}
                 */
                archiveChunkThreshold: leaf(100),
                /**
                 * A prefix for archive chunk directories (e.g., 'chunk-').
                 * @type {string}
                 */
                archiveChunkPrefix: leaf('chunk-'),
                /**
                 * A prefix for release note filenames (e.g., 'v').
                 * @type {string}
                 */
                releaseFilenamePrefix: leaf('v'),
                /**
                 * The maximum number of issues to fetch from the GitHub API in a single sync.
                 * Defensive ceiling against runaway pagination on a misconfigured GraphQL pageInfo while
                 * leaving enough headroom for clean-slate exhaustive emission under the archive contract.
                 * The local droppedLabels filter further trims the actual processed set.
                 * @type {number}
                 */
                maxIssues: leaf(20000),
                /**
                 * Safety cap on releases fetched from the GitHub API. Must exceed the repo's total
                 * release count: the closed-item bucketing reference (`ReleaseNotesSyncer.sortedReleases`)
                 * spans the full history, so a cap below the total would drop the oldest releases and
                 * mis-bucket pre-cap closed items.
                 * @type {number}
                 */
                maxReleases: leaf(2000),
                /**
                 * The number of releases to fetch per page in GraphQL queries.
                 * @type {number}
                 */
                releaseQueryLimit: leaf(50),
                /**
                 * The maximum buffer size for the `gh` CLI command output.
                 * @type {number}
                 */
                maxGhOutputBuffer: leaf(10 * 1024 * 1024), // 10 MB
                /**
                 * The markdown delimiter used to separate the issue body from the comments section.
                 * @type {string}
                 */
                commentSectionDelimiter: leaf('## Comments'),
                /**
                 * Maximum number of labels to fetch per issue in GraphQL queries.
                 * @type {number}
                 */
                maxLabelsPerIssue: leaf(20),
                /**
                 * Maximum number of labels to fetch for the entire repository in GraphQL queries.
                 * @type {number}
                 */
                maxRepoLabels: leaf(100),
                /**
                 * Maximum number of assignees to fetch per issue in GraphQL queries.
                 * @type {number}
                 */
                maxAssigneesPerIssue: leaf(10),
                /**
                 * Maximum number of sub-issues to fetch per issue in GraphQL queries.
                 * @type {number}
                 */
                maxSubIssuesPerIssue: leaf(100),
                /**
                 * Maximum number of timeline items to fetch per issue in GraphQL queries.
                 * @type {number}
                 */
                maxTimelineItemsPerIssue: leaf(50)
            },
            /**
             * Configuration for pull request queries.
             */
            pullRequest: {
                /**
                 * Default values for pull request queries.
                 */
                defaults: {
                    /**
                     * The default number of pull requests to return.
                     * @type {number}
                     */
                    limit: leaf(30),
                    /**
                     * The default state of pull requests to list.
                     * @type {string}
                     */
                    state: leaf('open')
                },
                /**
                 * The maximum number of pull requests that can be fetched in a single API call.
                 * @type {number}
                 */
                maxLimit: leaf(100),
                /**
                 * Maximum number of comments to fetch per pull request in GraphQL queries.
                 * @type {number}
                 */
                maxCommentsPerPullRequest: leaf(100)
            }
        },
        /**
         * @summary Resolves GitHub corpus paths from the one relocatable content-root parent.
         *
         * Corpus-only emission must declare `contentRootOverride` and writes beneath its repository
         * child. Ordinary invocation retains the existing checkout layout for Portal/SEO compatibility.
         * Logical index identity remains repository-qualified in both modes. Each child is a genuine
         * reactive derivation from that parent; the matching `*Override` leaf is the sole escape hatch.
         */
        formulas: {
            // Metadata stores target-relative paths. In corpus-only mode the target is the declared
            // corpus checkout, while ordinary operation retains the module-time checkout anchor.
            'issueSync.metadataBaseRoot': data => data.issueSync.contentRootOverride ?? data.projectRoot,
            'issueSync.contentRoot': data => data.issueSync.contentRootOverride ?? contentRoot,
            'issueSync.corpusLeaseFile': data => path.resolve(data.issueSync.contentRoot, '.corpus-sync.lock'),
            'issueSync.originRoot' : data => data.issueSync.contentRootOverride
                ? path.resolve(data.issueSync.contentRootOverride, data.repo)
                : contentRoot,
            'issueSync.issuesDir': data => data.issueSync.issuesDirOverride ??
                path.resolve(data.issueSync.originRoot, 'issues'),
            'issueSync.archiveRoot': data => data.issueSync.archiveRootOverride ??
                path.resolve(data.issueSync.originRoot, 'archive'),
            'issueSync.discussionsDir': data => data.issueSync.discussionsDirOverride ??
                path.resolve(data.issueSync.originRoot, 'discussions'),
            'issueSync.pullsDir': data => data.issueSync.pullsDirOverride ??
                path.resolve(data.issueSync.originRoot, 'pulls'),
            'issueSync.metadataFile': data => data.issueSync.metadataFileOverride ??
                path.resolve(data.issueSync.originRoot, '.sync-metadata.json'),
            'issueSync.releaseNotesDir': data => data.issueSync.releaseNotesDirOverride ??
                path.resolve(data.issueSync.originRoot, 'release-notes')
        }
    }
}
export default Neo.setupClass(ConfigBase);
