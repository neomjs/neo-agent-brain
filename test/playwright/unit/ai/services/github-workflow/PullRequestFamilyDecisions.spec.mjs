import {test, expect} from '@playwright/test';
import '../../../../../../node_modules/neo.mjs/src/Neo.mjs';
import '../../../../../../node_modules/neo.mjs/src/core/_export.mjs';
import {setup}                           from '../../../../setup.mjs';
import {createIdentityPublicationClient} from '../../../../../../ai/services/shared/identityPublicationClient.mjs';
import {compileFoundingFamilySeed}       from '../../../../../../ai/graph/identityFoundingSeed.mjs';
import {familyMembershipKey}             from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';

setup({neoConfig: {unitTestMode: true}, appConfig: {name: 'PullRequestFamilyDecisionsTest'}});

const HEAD              = 'a'.repeat(40);
const viewer            = {__typename: 'User', databaseId: 10, login: 'neo-gpt-euclid'};
const identityAssertion = {ok: true, principals: {
    agentIdentity: '@neo-gpt-euclid', githubLogin: 'neo-gpt-euclid', memoryCoreIdentity: '@neo-gpt-euclid'
}};
const target  = {planeId: 'decision-fixture', dataRoot: '/fixture/decision'};
const at      = hour => Date.parse(`2026-07-29T0${hour}:00:00.000Z`);
const subject = id => ({authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: String(id)});

/** @summary Supplies a complete carrier whose author returns to its first family after an intermediate declaration. */
function familySnapshot({reviewerSwitched = false} = {}) {
    const founding = compileFoundingFamilySeed({
        identities: [[20, 'gpt'], [30, 'claude']].map(([id, family]) => ({id: '@fixture-' + id,
            type: 'AgentIdentity', properties: {accountType: 'agent', modelFamily: family}})),
        subjects: [20, 30].map(id => ({identityKey: '@fixture-' + id, subject: subject(id)}))
    });
    const revision = reviewerSwitched ? 4 : 3;
    const subjects = [20, 30].map(id => {
        const binding   = {subject: {...subject(id), providerUsername: 'fixture-' + id}, seatId: 'seat-' + id, incarnation: 'inc-' + id};
        const bindingId = familyMembershipKey({planeId: target.planeId, ...binding});
        const acts      = id === 20 ? [[3, 'claude', 2], [5, 'gpt', 3]] : reviewerSwitched ? [[6, 'gemini', 4]] : [];
        return {subject: subject(id), membershipRevision: 1, admissionRevision: acts.length,
            bindings: [{bindingId, binding, currentSeatId: binding.seatId}],
            source  : {baselineSince: at(0), revision, memberships: [{bindingId, since: at(0), until: null}],
                declarations: acts.map(([hour, family, version]) => ({admissionId: 'act-' + version, bindingId,
                    operatorPrincipal: 'operator', since: at(hour), revision: version, family, model: null})), corrections: []}};
    });
    return {version: 1, target, revision, baselineSince: at(0), founding, foundingRevision: 1,
        foundingProvenance: {sourceRevision: 'fixture', installedAt: 1, issuer: 'fixture-fleet', lineageHead: 'identity-family-lineage-head-' + 'a'.repeat(64)},
        counts            : {subjects: 2, admittedSubjects: 2, memberships: 2, declarations: revision - 1, corrections: 0}, subjects};
}

/** @summary Exercises the registered read client and its identity/target proof with an isolated MCP transport. */
function sourceFixture({identity = '@neo-gpt-euclid', expectedIdentity = '@neo-gpt-euclid', servedTarget = target,
    response = () => ({state: 'available', snapshot: familySnapshot()})} = {}) {
    const calls  = [];
    const client = createIdentityPublicationClient({baseUrl: 'https://fixture.example/mc/mcp', credential: 'fixture-only',
        expectedIdentity, expectedTarget: target,
        createSession: () => ({client: {async connect() {}, async close() {}, async callTool({name}) {
            calls.push(name);
            return {structuredContent: name === 'list_permissions' ? {identity} : name === 'healthcheck' ?
                {plane: {id: servedTarget.planeId, dataRoot: servedTarget.dataRoot}} : await response()};
        }}, transport: {async terminateSession() {}}})});
    return {client, calls};
}

/** @summary Supplies otherwise-positive provider evidence so unavailable family authority cannot hide behind another gate. */
function pullRequest() {
    return {
        number        : 1512, state: 'OPEN', mergedAt: null, baseRefName: 'dev', headRefOid: HEAD,
        createdAt     : '2026-07-29T01:00:00.000Z', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
        author        : {__typename: 'User', databaseId: 20, login: 'neo-opus-vega'}, authorAssociation: 'MEMBER',
        body          : 'Authored by Vega (Claude Opus, test).',
        commitMessages: {nodes: [], pageInfo: {hasNextPage: false}},
        reviewRequests: {nodes: [], pageInfo: {hasNextPage: false}},
        reviews       : {nodes: [{state: 'APPROVED', author: {__typename: 'User', databaseId: 30, login: 'neo-gpt-emmy'},
            submittedAt: '2026-07-29T07:00:00.000Z', commit: {oid: HEAD}}], pageInfo: {hasPreviousPage: false}},
        comments: {nodes: [], pageInfo: {hasPreviousPage: false}},
        commits : {nodes: [{commit: {oid: HEAD, statusCheckRollup: {contexts: {
            nodes: [], totalCount: 0, pageInfo: {hasNextPage: false}
        }}}}]}
    };
}

const reviewer    = {__typename: 'User', databaseId: 30, login: 'neo-gpt-emmy'};
const CLAUDE_HEAD = 'b'.repeat(40);
const GEMINI_HEAD = 'c'.repeat(40);
const reviewBody  = `# PR Review Summary
**Status:** Request Changes
### 🪜 Strategic-Fit Decision
- Decision: Request Changes
### 🧭 Patch-Blind Premise Snapshot
* **Inputs Read Before Patch:** ticket, changed-file list, current dev source.
* **Expected Solution Shape:** preserve the historical family of each review.
* **Patch Verdict:** requires the named boundary repair.
* **Premise Coherence:** coheres with the accepted temporal family contract.
### 🕸️ Context & Graph Linking
* **Target Epic / Issue ID:** Resolves #1512
* **Related Graph Nodes:** #1296
* **Origin Session ID:** 8c622ae9-0ef1-4bf1-9a27-5dfe228b4fac
### 🔬 Depth Floor
- Documented search: checked the review-budget consumer and source projection.
### 🧠 Graph Ingestion Notes
* **[KB_GAP]**: N/A.
* **[TOOLING_GAP]**: N/A.
* **[RETROSPECTIVE]**: Historical review accounting fixture.
### 📋 Required Actions
- [ ] preserve historical family accounting
### 📊 Evaluation Metrics
[ARCH_ALIGNMENT]: 80 - structural fit
[CONTENT_COMPLETENESS]: 80 - covers the boundary
[EXECUTION_QUALITY]: 80 - falsifiers exercised
[PRODUCTIVITY]: 70 - bounded scope
[IMPACT]: 60 - review budget
[COMPLEXITY]: 40 - temporal projection
[EFFORT_PROFILE]: Quick Win`;
const repairBody = `# PR Review Follow-Up — exceptional verdicts only
**Status:** Request Changes
**Opening:** Re-checking the addressed delta.
### 🧭 Patch-Blind Premise Snapshot
* **Inputs Read Before Patch:** prior review, author response, changed-file list.
* **Expected Solution Shape:** repair preserves historical family charging.
* **Patch Verdict:** a repair-minted defect remains.
* **Premise Coherence:** coheres with the accepted temporal family contract.
### 🪜 Strategic-Fit Decision
- **Decision**: Request Changes
- **Rationale**: The repair introduced the named defect.
### ⚓ Prior Review Anchor
* **PR:** #1512
* **Target Issue:** #1512
* **Prior Review Comment ID:** PRR_gemini
* **Author Response Comment ID:** IC_456
* **Latest Head SHA:** ${HEAD}
* **Origin Session ID:** 8c622ae9-0ef1-4bf1-9a27-5dfe228b4fac
### 🔁 Delta Scope
* **Files changed:** family consumer
* **PR body / close-target changes:** pass
* **Branch freshness / merge state:** clean
### ✅ Previous Required Actions Audit
* **Addressed:** prior action; the repair introduced another defect.
### 🔬 Delta Depth Floor
* **Documented search:** checked the repaired boundary and historical source.
### 🔬 Premise Falsifiers
* **Source-coordinate falsifiers:** ai/services/github-workflow/PullRequestService.mjs:1
* **What survives:** the source qualification and prior accepted changes.
### 📊 Metrics Delta
* **[ARCH_ALIGNMENT]**: unchanged
* **[CONTENT_COMPLETENESS]**: unchanged
* **[EXECUTION_QUALITY]**: unchanged
* **[PRODUCTIVITY]**: unchanged
* **[IMPACT]**: unchanged
* **[COMPLEXITY]**: unchanged
* **[EFFORT_PROFILE]**: unchanged
### 📋 Required Actions
- [ ] repair the newly introduced family charging defect`;

/** @summary Retains original actor identity and submission time independently of its current family. */
function priorReview(hour, {body = 'Prior required action.', head = hour < 6 ? CLAUDE_HEAD : GEMINI_HEAD} = {}) {
    return {id: 'PRR_' + hour, state: 'CHANGES_REQUESTED', author: reviewer,
        submittedAt: new Date(at(hour)).toISOString(), body, commit: {oid: head}};
}

/** @summary Binds one review-creation decision to its captured viewer, provider and registered family source. */
function reviewFixture(reviews) {
    const observedViewers = [];
    const mutations       = [];
    const {client, calls} = sourceFixture({identity: '@neo-gpt-emmy', expectedIdentity: '@neo-gpt-emmy',
        response: () => ({state: 'available', snapshot: familySnapshot({reviewerSwitched: true})})});
    const deps = {
        source          : {authProvider: 'github', providerBaseUrl: 'https://api.github.com'},
        now             : () => new Date(at(8)),
        rest            : async () => {throw new Error('Review creation must use the captured GraphQL acquisition');},
        readFamilySource: async actor => {observedViewers.push(actor); return client.readSnapshot();},
        query           : async (document, variables) => {
            if (document.includes('GetPullRequestId')) return {viewer: reviewer,
                homeRepository: {activationIssue: {id: 'I_activation', closedByPullRequestsReferences: {totalCount: 1,
                    pageInfo: {hasNextPage: false}, nodes: [{id: 'PR_activation', number: 15310,
                        state: 'MERGED', mergedAt: new Date(at(0)).toISOString(), baseRefName: 'dev'}]}}},
                targetRepository: {pullRequest: {...pullRequest(), id: 'PR_1512',
                    reviews: {nodes: reviews, pageInfo: {hasPreviousPage: false}}}}};
            if (!document.includes('AddPullRequestReview')) throw new Error('Unexpected review acquisition');
            mutations.push(variables);
            return {addPullRequestReview: {pullRequestReview: {id: 'PRR_new', state: 'CHANGES_REQUESTED',
                submittedAt: new Date(at(8)).toISOString(), url: 'https://github.com/neomjs/neo/pull/1512#pullrequestreview-1'}}};
        }
    };
    return {client, calls, deps, mutations, observedViewers};
}

/** @summary Supplies a causal repair receipt tied to the spending family's recorded review head. */
function repairReason(oldHead) {
    return `old-head: ${oldHead} | new-head: ${HEAD} | prior-fact: the defect did not exist at the reviewed head | repair-coordinate: ai/services/github-workflow/PullRequestService.mjs:1`;
}

test.describe('PullRequestService admitted family decision boundary', () => {
    let service;
    test.beforeAll(async () => {
        service = (await import('../../../../../../ai/services/github-workflow/PullRequestService.mjs')).default;
    });

    test('refuses unavailable family authority while preserving independently green checks', async () => {
        let   reads  = 0;
        const result = await service.getConversation({pr_number: 1512, projection: 'merge-readiness', identityAssertion}, {
            query           : async () => ({viewer, repository: {pullRequest: pullRequest()}}),
            rest            : async () => [],
            source          : {authProvider: 'github', providerBaseUrl: 'https://api.github.com'},
            now             : () => new Date('2026-07-29T08:00:00.000Z'),
            readFamilySource: async () => { reads++; return {state: 'unavailable', code: 'publication-fenced'}; }
        });
        expect(result.checksVerdict).toBe('green');
        expect(result.verdict).toBe('unavailable');
        expect(result.marker).toBeUndefined();
        expect(reads).toBe(1);
    });

    test('refuses a partial injected acquisition without using any of its transport', async () => {
        let   calls  = 0;
        const result = await service.getConversation({pr_number: 1512, projection: 'merge-readiness', identityAssertion}, {
            query: async () => { calls++; return {viewer, repository: {pullRequest: pullRequest()}}; },
            now  : () => new Date('2026-07-29T08:00:00.000Z')
        });
        expect(result.verdict).toBe('unavailable');
        expect(result.blockers[0].code).toBe('GITHUB_SOURCE_UNBOUND');
        expect(calls).toBe(0);
    });

    test('registered client supplies one revision per decision and preserves the complete return-swap interval', async () => {
        let   observations    = 0;
        const {client, calls} = sourceFixture({response: () => ({state: 'available',
            snapshot: familySnapshot({reviewerSwitched: observations++ > 0})})});
        const deps = {query: async () => ({viewer, repository: {pullRequest: pullRequest()}}), rest: async () => [],
            source: {authProvider: 'github', providerBaseUrl: 'https://api.github.com'},
            now   : () => new Date(at(8)), readFamilySource: () => client.readSnapshot()};
        try {
            const first = await service.getConversation({pr_number: 1512, projection: 'merge-readiness', identityAssertion}, deps);
            expect(first.familyVerdict).toMatchObject({revision: 3, authorFamilies: ['claude', 'gpt'],
                approvingFamilies: ['claude'], crossFamily: false});
            expect(first.marker).toBeUndefined();
            expect(observations).toBe(1);
            const next = await service.getConversation({pr_number: 1512, projection: 'merge-readiness', identityAssertion}, deps);
            expect(next.familyVerdict).toMatchObject({revision: 4, approvingFamilies: ['gemini'], crossFamily: true});
            expect(next.verdict).toBe('merge-ready-observed');
            expect(observations).toBe(2);
            expect(calls.filter(name => name === 'get_identity_publication_snapshot')).toHaveLength(2);
        } finally {await client.close(); client.destroy();}
    });

    test('review creation charges the prior RC to its submission family and reads one coherent source', async () => {
        const fixture = reviewFixture([priorReview(4)]);
        try {
            const result = await service.managePrReview({action: 'create', pr_number: 1512,
                state: 'REQUEST_CHANGES', body: reviewBody}, fixture.deps);
            expect(result.error, result.message).toBeUndefined();
            expect(result.reviewBudget).toMatchObject({outcome: 'within-budget', reviewerFamily: 'gemini',
                submittedRequestChanges: 1, familySubmittedRequestChanges: 0,
                familySource           : {state: 'available', revision: 4, foundingRevision: 1}});
            expect(fixture.mutations).toHaveLength(1);
            expect(fixture.mutations[0].body).toContain('[review-budget-managed]');
            expect(fixture.observedViewers).toEqual([{...reviewer, databaseId: '30'}]);
            expect(fixture.calls.filter(name => name === 'get_identity_publication_snapshot')).toHaveLength(1);
        } finally {await fixture.client.close(); fixture.client.destroy();}
    });

    test('a current-family historical RC exhausts the ordinary round without another mutation', async () => {
        const fixture = reviewFixture([priorReview(4), priorReview(7)]);
        try {
            const result = await service.managePrReview({action: 'create', pr_number: 1512,
                state: 'REQUEST_CHANGES', body: reviewBody}, fixture.deps);
            expect(result.code).toBe('PR_REVIEW_BUDGET_VALIDATION_FAILED');
            expect(result.reviewBudget).toMatchObject({reviewerFamily: 'gemini', submittedRequestChanges: 2,
                familySubmittedRequestChanges: 1});
            expect(fixture.mutations).toHaveLength(0);
            expect(fixture.observedViewers).toHaveLength(1);
        } finally {await fixture.client.close(); fixture.client.destroy();}
    });

    test('a prior Claude re-entry does not spend the later Gemini family exception', async () => {
        const fixture = reviewFixture([priorReview(4, {body: 'Prior re-entry.\n[review-budget-override]'}), priorReview(7)]);
        try {
            const result = await service.managePrReview({action: 'create', pr_number: 1512,
                state: 'REQUEST_CHANGES', body: repairBody, reviewBudgetOverrideReason: repairReason(GEMINI_HEAD)}, fixture.deps);
            expect(result.error, result.message).toBeUndefined();
            expect(result.reviewBudget).toMatchObject({outcome: 'disclosed-override', reviewerFamily: 'gemini',
                familySubmittedRequestChanges: 1, repairMintedReceipt: {'old-head': GEMINI_HEAD, 'new-head': HEAD}});
            expect(fixture.mutations).toHaveLength(1);
            expect(fixture.mutations[0].body.match(/^\[review-budget-override\]$/gm)).toHaveLength(1);
            expect(fixture.observedViewers).toHaveLength(1);
        } finally {await fixture.client.close(); fixture.client.destroy();}
    });

    test('a prior Gemini re-entry remains terminal after historical family resolution', async () => {
        const fixture = reviewFixture([priorReview(4), priorReview(7, {body: 'Prior re-entry.\n[review-budget-override]'})]);
        try {
            const result = await service.managePrReview({action: 'create', pr_number: 1512,
                state: 'REQUEST_CHANGES', body: repairBody, reviewBudgetOverrideReason: repairReason(GEMINI_HEAD)}, fixture.deps);
            expect(result.code).toBe('PR_REVIEW_BUDGET_VALIDATION_FAILED');
            expect(result.message).toContain('already used its one repair-minted re-entry');
            expect(result.reviewBudget).toMatchObject({reviewerFamily: 'gemini', priorRepairMintedReEntries: 1});
            expect(fixture.mutations).toHaveLength(0);
            expect(fixture.observedViewers).toHaveLength(1);
        } finally {await fixture.client.close(); fixture.client.destroy();}
    });

    for (const [label, oldHead, admitted] of [['Claude', CLAUDE_HEAD, false], ['Gemini', GEMINI_HEAD, true]]) {
        test('repair re-entry corroborates the ' + label + ' historical head against the spending family', async () => {
            const fixture = reviewFixture([priorReview(4), priorReview(7)]);
            try {
                const result = await service.managePrReview({action: 'create', pr_number: 1512,
                    state: 'REQUEST_CHANGES', body: repairBody, reviewBudgetOverrideReason: repairReason(oldHead)}, fixture.deps);
                if (admitted) {
                    expect(result.error, result.message).toBeUndefined();
                    expect(result.reviewBudget.outcome).toBe('disclosed-override');
                } else {
                    expect(result.code).toBe('PR_REVIEW_BUDGET_VALIDATION_FAILED');
                    expect(result.message).toContain('matches no head THIS family');
                }
                expect(fixture.mutations).toHaveLength(admitted ? 1 : 0);
                expect(fixture.observedViewers).toHaveLength(1);
            } finally {await fixture.client.close(); fixture.client.destroy();}
        });
    }

    test('missing historical submission time refuses a new round instead of charging the current family', async () => {
        const fixture = reviewFixture([{...priorReview(4), submittedAt: null}]);
        try {
            const result = await service.managePrReview({action: 'create', pr_number: 1512,
                state: 'REQUEST_CHANGES', body: reviewBody}, fixture.deps);
            expect(result.code).toBe('PR_REVIEW_BUDGET_VALIDATION_FAILED');
            expect(result.message).toContain('unresolved historical families');
            expect(fixture.mutations).toHaveLength(0);
            expect(fixture.observedViewers).toHaveLength(1);
        } finally {await fixture.client.close(); fixture.client.destroy();}
    });

    for (const [label, row] of [['null row', null], ['unknown state', {...priorReview(4), state: 'UNKNOWN'}],
        ['missing state', {...priorReview(4), state: undefined}], ['missing body', {...priorReview(4), body: undefined}]]) {
        test('malformed budget history refuses rather than disappearing: ' + label, async () => {
            const fixture = reviewFixture([row]);
            try {
                const result = await service.managePrReview({action: 'create', pr_number: 1512,
                    state: 'REQUEST_CHANGES', body: reviewBody}, fixture.deps);
                expect(result.code).toBe('PR_REVIEW_BUDGET_VALIDATION_FAILED');
                expect(fixture.mutations).toHaveLength(0);
            } finally {await fixture.client.close(); fixture.client.destroy();}
        });
    }

    for (const [label, damage] of [
        ['missing body', pr => {delete pr.body;}],
        ['missing commit nodes', pr => {delete pr.commitMessages.nodes;}],
        ['null commit nodes', pr => {pr.commitMessages.nodes = null;}],
        ['missing commit message', pr => {pr.commitMessages.nodes = [{commit: {}}];}]
    ]) {
        for (const path of ['batch', 'readiness']) {
            test(path + ' refuses incomplete outside disclosure: ' + label, async () => {
                const pr = {...pullRequest(), body: '', authorAssociation: 'CONTRIBUTOR',
                    author: {__typename: 'User', databaseId: 99, login: 'outside'}};
                damage(pr);
                const {client} = sourceFixture({response: () => ({state: 'available',
                    snapshot: familySnapshot({reviewerSwitched: true})})});
                const deps = {query: async () => ({viewer, repository: {pullRequest: pr, pullRequests: {nodes: [pr]}}}),
                    rest: async () => [], source: {authProvider: 'github', providerBaseUrl: 'https://api.github.com'},
                    now : () => new Date(at(8)), readFamilySource: () => client.readSnapshot()};
                try {
                    if (path === 'batch') {
                        const result = await service.listFamilyReviewSummaries({repo: 'neomjs/neo'}, deps)
                            .catch(error => ({code: error.code}));
                        if (Array.isArray(result)) {
                            expect(result).toHaveLength(1);
                            expect(result[0].familyVerdict).toMatchObject({qualified: false,
                                code: 'author-disclosure-unavailable'});
                        } else {
                            expect(result.code).toBe('GITHUB_SOURCE_UNBOUND');
                        }
                    } else {
                        const result = await service.getConversation({pr_number: 1512,
                            projection: 'merge-readiness', identityAssertion}, deps);
                        expect(result.verdict).toBe('unavailable');
                        expect(result.marker).toBeUndefined();
                        expect(result.blockers.some(blocker => ['PR_SOURCE_UNREADABLE', 'author-disclosure-unavailable']
                            .includes(blocker.code))).toBe(true);
                    }
                } finally {await client.close(); client.destroy();}
            });
        }
    }

    test('complete empty outside disclosure stays available in both batch and readiness', async () => {
        const pr = {...pullRequest(), body: '', authorAssociation: 'CONTRIBUTOR',
            author: {__typename: 'User', databaseId: 99, login: 'outside'}};
        const {client, calls} = sourceFixture({response: () => ({state: 'available',
            snapshot: familySnapshot({reviewerSwitched: true})})});
        const deps = {query: async () => ({viewer, repository: {pullRequest: pr, pullRequests: {nodes: [pr]}}}),
            rest: async () => [], source: {authProvider: 'github', providerBaseUrl: 'https://api.github.com'},
            now : () => new Date(at(8)), readFamilySource: () => client.readSnapshot()};
        try {
            const batch = await service.listFamilyReviewSummaries({repo: 'neomjs/neo'}, deps);
            expect(batch[0].familyVerdict).toMatchObject({qualified: true, outside: true,
                disclosureTruncated: false, authorFamilies: [], approvingFamilies: ['gemini']});
            const readiness = await service.getConversation({pr_number: 1512,
                projection: 'merge-readiness', identityAssertion}, deps);
            expect(readiness.verdict).toBe('merge-ready-observed');
            expect(calls.filter(name => name === 'get_identity_publication_snapshot')).toHaveLength(2);
        } finally {await client.close(); client.destroy();}
    });

    test('body-only review update preserves the existing transport and never acquires a family snapshot', async () => {
        const graphql       = (await import('../../../../../../ai/services/github-workflow/GraphqlService.mjs')).default;
        const originalQuery = graphql.query;
        const requests      = [];
        let   observations  = 0;
        const body          = reviewBody.replace('preserve historical family accounting', 'clarify historical family accounting');
        try {
            graphql.query = async (document, variables) => {
                requests.push(variables);
                if (document.includes('GetPullRequestReview')) return {node: {id: 'PRR_existing',
                    state: 'CHANGES_REQUESTED', body: reviewBody, pullRequest: {number: 1512}}};
                if (!document.includes('UpdatePullRequestReview')) throw new Error('Unexpected update acquisition');
                return {updatePullRequestReview: {pullRequestReview: {id: 'PRR_existing', body,
                    state: 'CHANGES_REQUESTED', url: 'https://github.com/neomjs/neo/pull/1512#pullrequestreview-1'}}};
            };
            const result = await service.managePrReview({action: 'update', review_id: 'PRR_existing', body}, {
                readFamilySource: async () => {observations++; throw new Error('Body editing must not spend another family round');}
            });
            expect(result.error, result.message).toBeUndefined();
            expect(result.reviewId).toBe('PRR_existing');
            expect(observations).toBe(0);
            expect(requests).toEqual([{reviewId: 'PRR_existing'}, {pullRequestReviewId: 'PRR_existing', body}]);
        } finally {graphql.query = originalQuery;}
    });

    for (const [label, options] of [
        ['identity', {identity: '@another'}],
        ['plane root', {servedTarget: {...target, dataRoot: '/another'}}],
        ['malformed', {response: () => ({state: 'available', snapshot: {...familySnapshot(), counts: {}}})}],
        ['fenced', {response: () => ({state: 'unavailable', code: 'publication-restore-fenced'})}]
    ]) test('registered source ' + label + ' cannot certify otherwise-green evidence', async () => {
        const {client} = sourceFixture(options);
        try {
            const result = await service.getConversation({pr_number: 1512, projection: 'merge-readiness', identityAssertion}, {
                query : async () => ({viewer, repository: {pullRequest: pullRequest()}}), rest: async () => [],
                source: {authProvider: 'github', providerBaseUrl: 'https://api.github.com'},
                now   : () => new Date(at(8)), readFamilySource: () => client.readSnapshot()
            });
            expect(result.checksVerdict).toBe('green');
            expect(result.verdict).toBe('unavailable');
            expect(result.marker).toBeUndefined();
        } finally {await client.close(); client.destroy();}
    });
});
