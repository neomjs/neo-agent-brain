import {deriveRepoSlugFromCloneUrl} from './tenantRepoAccessContract.mjs';

/**
 * @summary Declares separate, non-overlapping extraction plans for the image-carried Engine and Brain corpora.
 *
 * Shared-core `kbSync` stays separate from tenant-repo sync. Both repositories have their own
 * revision reader and hierarchy authority; this plan names only relative territories inside each one.
 * The image reader owns filesystem placement and the runner owns overlap/gap validation.
 */

const ENGINE_REPO_SLUG = 'neo',
      BRAIN_REPO_SLUG  = 'neo-agent-brain';

/**
 * @summary Creates one route rooted inside a single repository revision.
 * @param {String} extractorId
 * @param {String} root
 * @param {String[]} include
 * @param {Object} [options]
 * @param {String[]} [exclude]
 * @returns {Object}
 * @private
 */
function route(extractorId, root, include, options, exclude = []) {
    return {
        extractorId,
        territory: {roots: [root], include, ...(exclude.length ? {exclude} : {})},
        ...(options ? {options} : {})
    }
}

/**
 * @summary Returns the image roots and profile for exactly one shared-core repository.
 *
 * ReleaseNotesSource is omitted because neither image carries its old `.github/RELEASE_NOTES`
 * territory. SkillSource is omitted because neither image carries `.agents/skills`; that corpus
 * has its own repository and tenant lane. The Engine's learning tree is an assigned input, while
 * the Brain's `learn/` has no tree and uses an explicit file-selected parser mode.
 *
 * @param {String} repoSlug `neo` or `neo-agent-brain`.
 * @returns {{repoSlug: String, roots: String[], profile: Object}}
 */
export function createCoreCorpusProfilePlan(repoSlug) {
    if (repoSlug === ENGINE_REPO_SLUG) {
        return {
            repoSlug,
            roots  : ['src', 'apps', 'examples', 'docs/app', 'learn', 'resources/content/concepts', 'test/playwright'],
            profile: {
                profileSchemaVersion: 1,
                routes              : [
                    route('ApiSource', 'src',      ['**/*.mjs'], {type: 'src',     hierarchyScope: 'source-path'}),
                    route('ApiSource', 'apps',     ['**/*.mjs'], {type: 'app',     hierarchyScope: 'source-path'}),
                    route('ApiSource', 'examples', ['**/*.mjs'], {type: 'example', hierarchyScope: 'source-path'}),
                    route('ApiSource', 'docs/app', ['**/*.mjs'], {type: 'app',     hierarchyScope: 'source-path'}),
                    route('AdrSource', 'learn/agentos/decisions', ['[0-9][0-9][0-9][0-9]-*.md']),
                    route('ConceptSource', 'resources/content/concepts', ['*.md']),
                    route('LearningSource', 'learn', ['tree.json', '**/*.md'],
                        {treePath: 'learn/tree.json'}, ['agentos/decisions/**']),
                    route('TestSource', 'test/playwright', ['**/*.mjs'])
                ],
                fallback: {action: 'exclude'}
            }
        }
    }

    if (repoSlug === BRAIN_REPO_SLUG) {
        return {
            repoSlug,
            roots  : ['src', 'ai', 'learn', 'test/playwright'],
            profile: {
                profileSchemaVersion: 1,
                routes              : [
                    route('ApiSource', 'src', ['**/*.mjs'], {type: 'brain-source',       hierarchyScope: 'source-path'}),
                    route('ApiSource', 'ai',  ['**/*.mjs'], {type: 'ai-infrastructure', hierarchyScope: 'source-path'}),
                    route('AdrSource', 'learn/agentos/decisions', ['[0-9][0-9][0-9][0-9]-*.md']),
                    route('LearningSource', 'learn', ['**/*.md'], {mode: 'files'},
                        ['agentos/decisions/**']),
                    route('TestSource', 'test/playwright', ['**/*.mjs'])
                ],
                fallback: {action: 'exclude'}
            }
        }
    }

    throw new TypeError(`Shared core corpus profile has no repository '${repoSlug}'`)
}

export const CORE_CORPUS_REPO_SLUGS = Object.freeze([ENGINE_REPO_SLUG, BRAIN_REPO_SLUG]);

/**
 * @summary Refuses a tenant GitMirror route over a shared image-carried core repository.
 *
 * The caller supplies the EFFECTIVE graph/YAML/Tier-1 winner, never the Tier-1 array alone.
 * A declared repo slug can alias a different clone URL, so both the Chroma ownership key and
 * the canonical GitHub source identity are checked. Disabled entries are not admitted.
 * @param {Object} options
 * @param {String} options.tenantId The shared core corpus tenant.
 * @param {Object[]} options.tenantRepos Effective, normalized tenant-repo entries.
 * @returns {void}
 */
export function assertNoCoreCorpusAcquisitionOverlap({tenantId, tenantRepos} = {}) {
    if (typeof tenantId !== 'string' || !tenantId || !Array.isArray(tenantRepos)) {
        throw new TypeError('Shared core acquisition requires an exact tenant and effective tenant-repo list')
    }

    const coreSlugs  = new Set(CORE_CORPUS_REPO_SLUGS),
          coreClones = new Set(CORE_CORPUS_REPO_SLUGS.map(slug => `github.com/neomjs/${slug}`));

    for (const repo of tenantRepos) {
        if (repo?.tenantId !== tenantId || repo.disabled === true || repo.enabled === false) continue;

        const slug  = typeof repo.repoSlug === 'string' ? repo.repoSlug.toLowerCase() : '',
              clone = typeof repo.cloneUrl === 'string' && repo.cloneUrl
                  ? deriveRepoSlugFromCloneUrl(repo.cloneUrl).toLowerCase()
                  : '';

        if (coreSlugs.has(slug) || coreClones.has(clone)) {
            const error = new Error(`Shared core repository '${slug || clone}' is also configured for tenant-repo-sync`);

            error.code = 'KB_CORE_CORPUS_ACQUISITION_OVERLAP';
            throw error
        }
    }
}
