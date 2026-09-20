import Base              from 'neo.mjs/src/core/Base.mjs';
import {TRUST_TIERS}     from '../../graph/identityRoots.mjs';
import {sanitizeContent} from '../shared/contentTrust/astroturfSanitizer.mjs';
import {contentTypeFor}  from './community/communityContentKinds.mjs';

/** @summary Current content plus repository-relative author association on each supported GraphQL entity. */
export const COMMUNITY_CONTENT_QUERY = `query CommunityContent($id: ID!) {
    node(id: $id) {
        __typename
        ... on Issue { id url updatedAt title body authorAssociation repository { nameWithOwner } }
        ... on PullRequest { id url updatedAt title body authorAssociation repository { nameWithOwner } }
        ... on Discussion { id url updatedAt title body authorAssociation repository { nameWithOwner } }
        ... on IssueComment { id url updatedAt body authorAssociation repository { nameWithOwner } }
        ... on PullRequestReview { id url updatedAt body authorAssociation pullRequest { repository { nameWithOwner } } }
        ... on DiscussionComment { id url updatedAt body authorAssociation discussion { repository { nameWithOwner } } }
    }
}`;

/** @summary Known source-relative association alone controls sanitizer trust; the global roster is not consulted. */
function projectContent({id, url, updatedAt, body, title, association}) {
    const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association),
          tier    = trusted ? TRUST_TIERS.REPO_TRUSTED : association ? TRUST_TIERS.EXTERNAL : TRUST_TIERS.UNCLASSIFIED;

    return {
        status      : 'available', notAuthority: true,
        contentTrust: {tier, sourceRelative: association || 'UNKNOWN'},
        citation    : {providerEntityId: id, url, providerUpdatedAt: updatedAt,
            readAt: new Date().toISOString(), contentVersion: 'current-provider-read'},
        content: {
            body: sanitizeContent(body, {tier}).sanitized,
            ...(typeof title === 'string' ? {title: sanitizeContent(title, {tier}).sanitized} : {})
        }
    }
}

/**
 * @summary Reads current GitHub content without persisting prose or claiming historical body identity.
 * Callers own the source lifecycle fence; this adapter proves provider entity and repository membership.
 * @class Neo.ai.services.github-workflow.GitHubCommunityContentService
 * @extends Neo.core.Base
 * @singleton
 */
class GitHubCommunityContentService extends Base {
    static config = {
        /** @member {String} className='Neo.ai.services.github-workflow.GitHubCommunityContentService' */
        className: 'Neo.ai.services.github-workflow.GitHubCommunityContentService',
        /** @member {Boolean} singleton=true */
        singleton: true
    }

    /**
     * @summary Explicit provider read with fresh source-relative trust; ambiguous failures remain unknown.
     * @param {Object} options A current source registration, metadata observation and optional provider client.
     * @returns {Promise<Object>} Sanitized current content or a typed metadata-only result.
     */
    async read({source, observation, graphqlService} = {}) {
        const type   = contentTypeFor(observation?.occurrenceKind),
              result = status => ({status, notAuthority: true});

        if (source?.canonicalProviderHost !== 'github.com' || !type) return result('unsupported');
        if (!/^[-\w.]+\/[-\w.]+$/.test(source.displayLocator || '')) return result('unknown');

        const repo = source.displayLocator, id = observation.providerEntityId;

        if (typeof id !== 'string' || !id) return result('unknown');

        try {
            const graphql = graphqlService || (await import('./GraphqlService.mjs')).default;

            if (type === 'rest-review-comment') {
                if (!/^[1-9][0-9]*$/.test(id)) return result('unknown');

                const entity    = await graphql.rest('GET', `/repos/${repo}/pulls/comments/${id}`),
                      parentUrl = new URL(entity?.pull_request_url || 'invalid:');

                if (String(entity?.id) !== id || parentUrl.origin !== 'https://api.github.com' ||
                    !new RegExp(`^/repos/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pulls/[1-9][0-9]*$`, 'i').test(parentUrl.pathname) ||
                    typeof entity.body !== 'string') return result('unknown');

                return projectContent({id, url: entity.html_url, updatedAt: entity.updated_at,
                    body: entity.body, association: entity.author_association})
            }

            const response = await graphql.query(COMMUNITY_CONTENT_QUERY, {id}),
                  entity   = response?.node;

            if (!entity) return result('unknown');

            const entityRepo = entity.repository?.nameWithOwner || entity.pullRequest?.repository?.nameWithOwner || entity.discussion?.repository?.nameWithOwner;

            if (entity.__typename !== type || entity.id !== id || entityRepo?.toLowerCase() !== repo.toLowerCase() ||
                typeof entity.body !== 'string') return result('unknown');

            return projectContent({id, url: entity.url, updatedAt: entity.updatedAt,
                body: entity.body, title: entity.title, association: entity.authorAssociation})
        } catch (error) {
            // A generic HTTP 403 may mean rate limiting; null/404 does not prove deletion.
            return result(error.graphqlErrors?.some(item => item.type === 'FORBIDDEN') ? 'inaccessible' : 'unknown')
        }
    }
}

export default Neo.setupClass(GitHubCommunityContentService);
