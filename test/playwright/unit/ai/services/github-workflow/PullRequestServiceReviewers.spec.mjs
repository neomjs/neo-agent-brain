import {test, expect}  from '@playwright/test';
import fs              from 'fs';
import path            from 'path';
import {fileURLToPath} from 'url';
import * as yaml       from 'js-yaml';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/**
 * @summary Coverage for `PullRequestService.managePrReviewers` — verifies it builds the REST
 * `requested_reviewers` command (needs only the `repo` scope) rather than the prior
 * `gh pr edit --add/remove-reviewer` path (which resolves logins via GraphQL → requires `read:org`,
 * a scope agent tokens routinely lack, so it failed for every agent on that credential class), AND
 * that it reports the **effect** rather than the request.
 *
 * The method exposes an `execFn` injection seam (default `execAsync`), so the command is captured
 * here without shelling out — mirroring the `buildCheckoutPullRequest` test-seam pattern.
 *
 * The effect-verification cases exist because a false-success shipped past a suite that asserted only
 * the command string: `manage_pr_reviewers` echoed its own arguments back as success, so requesting a
 * nonexistent login reported "Successfully requested" while the PR kept zero reviewers.
 * Measured against the live API, GitHub accepts an unknown login, answers 200 with the full PR
 * object, and seats nobody — the exit code and the absence of an exception prove nothing. Fixtures
 * below therefore mirror the real 200 payload; a bare `{}` stub would reproduce the blind spot.
 */

/**
 * @summary Builds a `requested_reviewers` REST response in GitHub's real shape.
 * @param {String[]} [users=[]] Logins GitHub reports as seated.
 * @param {String[]} [teams=[]] Team slugs GitHub reports as seated.
 * @returns {Object} An `execFn`-shaped result whose `stdout` is the JSON payload.
 */
function reviewerResponse(users = [], teams = []) {
    return {stdout: JSON.stringify({
        number            : 42,
        // The endpoint answers with the whole PR object; these two arrays are the post-mutation truth.
        requested_reviewers: users.map((login, id) => ({login, id, type: 'User'})),
        requested_teams    : teams.map((slug,  id) => ({slug,  id, name: slug}))
    })};
}

/**
 * @summary Builds the source-owned PR coordinate read before an `add` reviewer mutation.
 * @param {Boolean|null} mergeable GitHub REST mergeability value.
 * @param {Object} [options]
 * @returns {Object} An `execFn`-shaped pull-request response.
 */
function mergeabilityResponse(mergeable, {
    headSha        = 'reviewed-head',
    baseSha        = 'current-dev',
    mergeableState = 'clean'
} = {}) {
    return {stdout: JSON.stringify({
        mergeable,
        mergeable_state: mergeableState,
        head           : {sha: headSha},
        base           : {sha: baseSha}
    })};
}

test.describe('PullRequestService.managePrReviewers — REST requested_reviewers', () => {
    let PullRequestService;

    /**
     * @summary Supplies positive mergeability by default while preserving each test's reviewer-mutation seam.
     * @param {Object} options Runtime method options.
     * @param {Object} [seams] Test seams.
     * @returns {Promise<Object>}
     */
    const managePrReviewers = (options, seams = {}) => {
        const {
            execFn                = async() => reviewerResponse(),
            mergeabilityResponses = [mergeabilityResponse(true)],
            onMergeabilityRead    = () => {},
            waitFn                = async() => {},
            ...dependencies
        } = seams;
        let mergeabilityIndex = 0;

        return PullRequestService.managePrReviewers(options, {
            ...dependencies,
            waitFn,
            execFn: async(command, config) => {
                if (command.includes('/requested_reviewers')) {
                    return execFn(command, config);
                }

                onMergeabilityRead(command);

                const response = mergeabilityResponses[Math.min(
                    mergeabilityIndex++,
                    mergeabilityResponses.length - 1
                )];

                if (response instanceof Error) throw response;

                return response;
            }
        });
    };

    test.beforeAll(async () => {
        PullRequestService = (await import('../../../../../../ai/services/github-workflow/PullRequestService.mjs')).default;
    });

    test('add → REST POST requested_reviewers (not gh pr edit), login @-stripped', async () => {
        let captured;
        const res = await managePrReviewers(
            {pr_number: 42, reviewers: ['@neo-gpt'], action: 'add'},
            {execFn: async cmd => { captured = cmd; return reviewerResponse(['neo-gpt']); }}
        );

        expect(captured).toContain('pulls/42/requested_reviewers -X POST');
        expect(captured).toContain("-f 'reviewers[]=neo-gpt'");   // leading @ stripped
        expect(captured).not.toContain('gh pr edit');
        expect(captured).not.toContain('--add-reviewer');
        expect(res.message).toContain('requested');
    });

    test('#17420: an explicit target qualifies the requested_reviewers REST path', async () => {
        let captured;

        await managePrReviewers(
            {repo: 'devindex', pr_number: 3, reviewers: ['neo-gpt'], action: 'add'},
            {execFn: async command => { captured = command; return reviewerResponse(['neo-gpt']) }}
        );

        expect(captured).toContain('gh api repos/neomjs/devindex/pulls/3/requested_reviewers');
        expect(captured).not.toContain('repos/neomjs/neo/pulls/3');
    });

    test('remove → REST DELETE; team slugs are bare (no owner prefix)', async () => {
        let captured;
        await managePrReviewers(
            {pr_number: 7, team_reviewers: ['core'], action: 'remove'},
            {execFn: async cmd => { captured = cmd; return reviewerResponse(); }}
        );

        expect(captured).toContain('pulls/7/requested_reviewers -X DELETE');
        expect(captured).toContain("-f 'team_reviewers[]=core'");
        expect(captured).not.toContain('neomjs/core');            // REST takes bare slugs, unlike gh pr edit
    });

    test('guards: unknown action + empty reviewer set', async () => {
        expect((await managePrReviewers({pr_number: 1, action: 'nope', reviewers: ['x']})).code).toBe('INVALID_ARGUMENTS');
        expect((await managePrReviewers({pr_number: 1, action: 'add'})).code).toBe('MISSING_ARGUMENTS');
    });

    test('#17692: confirmed conflict refuses add before the reviewer mutation', async () => {
        let mutationCalls = 0,
            mergeabilityCommand;
        const res = await managePrReviewers(
            {repo: 'devindex', pr_number: 17670, reviewers: ['neo-gpt'], action: 'add'},
            {
                execFn               : async() => { mutationCalls++; return reviewerResponse(['neo-gpt']) },
                mergeabilityResponses: [mergeabilityResponse(false, {
                    headSha       : 'conflicting-head',
                    baseSha       : 'moved-dev',
                    mergeableState: 'dirty'
                })],
                onMergeabilityRead: command => { mergeabilityCommand = command }
            }
        );

        expect(mergeabilityCommand).toBe('gh api repos/neomjs/devindex/pulls/17670');
        expect(mutationCalls).toBe(0);
        expect(res).toMatchObject({
            code                : 'PR_MERGE_CONFLICT',
            pr_number           : 17670,
            headSha             : 'conflicting-head',
            baseSha             : 'moved-dev',
            mergeabilityAttempts: 1
        });
        expect(res.message).toContain('Rebase or resolve conflicts');
    });

    test('#17692: unresolved null exhausts the bounded poll and never mutates', async () => {
        let   mutationCalls = 0;
        const delays        = [];
        const res           = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], action: 'add'},
            {
                execFn               : async() => { mutationCalls++; return reviewerResponse(['neo-gpt']) },
                mergeabilityResponses: Array.from({length: 4}, () => mergeabilityResponse(null)),
                waitFn               : async delay => { delays.push(delay) }
            }
        );

        expect(mutationCalls).toBe(0);
        expect(delays).toEqual([250, 500, 1000]);
        expect(res).toMatchObject({
            code                : 'PR_MERGEABILITY_UNAVAILABLE',
            mergeabilityAttempts: 4,
            headSha             : 'reviewed-head',
            baseSha             : 'current-dev'
        });
        expect(res.message).toContain('unavailable is not evidence');
    });

    test('#17692: an unreadable mergeability response is unavailable, never clean', async () => {
        let   mutationCalls = 0;
        const res           = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], action: 'add'},
            {
                execFn               : async() => { mutationCalls++; return reviewerResponse(['neo-gpt']) },
                mergeabilityResponses: [{stdout: '{}'}]
            }
        );

        expect(mutationCalls).toBe(0);
        expect(res.code).toBe('PR_MERGEABILITY_UNAVAILABLE');
        expect(res.mergeabilityAttempts).toBe(1);
        expect(res.headSha).toBeUndefined();
        expect(res.baseSha).toBeUndefined();
    });

    for (const mergeableState of ['blocked', 'behind', 'unstable']) {
        test(`#17692: positive mergeability remains admissible when mergeable_state=${mergeableState}`, async () => {
            let   mutationCalls = 0;
            const res           = await managePrReviewers(
                {pr_number: 42, reviewers: ['neo-gpt'], action: 'add'},
                {
                    execFn               : async() => { mutationCalls++; return reviewerResponse(['neo-gpt']) },
                    mergeabilityResponses: [mergeabilityResponse(true, {mergeableState})]
                }
            );

            expect(mutationCalls).toBe(1);
            expect(res.code).toBeUndefined();
            expect(res.verifiedReviewers).toEqual(['neo-gpt']);
        });
    }

    test('#17692: remove stays available without any mergeability source read', async () => {
        let mergeabilityReads = 0,
            mutationCalls     = 0;
        const res = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], action: 'remove'},
            {
                execFn            : async() => { mutationCalls++; return reviewerResponse() },
                onMergeabilityRead: () => { mergeabilityReads++ }
            }
        );

        expect(mergeabilityReads).toBe(0);
        expect(mutationCalls).toBe(1);
        expect(res.code).toBeUndefined();
        expect(res.message).toContain('removed');
    });

    test('a nonexistent login must NOT report success (#16394)', async () => {
        // The live reproduction: GitHub returns 200 with an empty reviewer set, `gh` exits 0.
        const res = await managePrReviewers(
            {pr_number: 16385, reviewers: ['neo-gpt-euclid'], action: 'add'},
            {execFn: async () => reviewerResponse()}
        );

        expect(res.code).toBe('REVIEWER_NOT_SEATED');
        expect(res.error).toBeTruthy();
        expect(res.unseated).toEqual(['neo-gpt-euclid']);
        expect(res.message).toContain('neo-gpt-euclid');
        // The exact regression: the old code returned this string for the same response.
        expect(res.message).not.toContain('Successfully');
    });

    test('partial seating fails and names only the login that was not seated', async () => {
        const res = await managePrReviewers(
            {pr_number: 99, reviewers: ['neo-gpt', 'neo-gpt-euclid'], action: 'add'},
            {execFn: async () => reviewerResponse(['neo-gpt'])}
        );

        expect(res.code).toBe('REVIEWER_NOT_SEATED');
        expect(res.unseated).toEqual(['neo-gpt-euclid']);
        expect(res.unseated).not.toContain('neo-gpt');
        expect(res.verifiedReviewers).toEqual(['neo-gpt']);
    });

    test('an unseated team reviewer fails the same way', async () => {
        const res = await managePrReviewers(
            {pr_number: 99, team_reviewers: ['ghost-team'], action: 'add'},
            {execFn: async () => reviewerResponse([], [])}
        );

        expect(res.code).toBe('REVIEWER_NOT_SEATED');
        expect(res.unseated).toEqual(['ghost-team']);
    });

    test('verifiedReviewers comes from the response, never echoed from the arguments', async () => {
        // The falsifier for an echo: GitHub reports a reviewer that was never requested here
        // (seated by an earlier call). An implementation echoing its input cannot produce it.
        const res = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], team_reviewers: ['core'], action: 'add'},
            {execFn: async () => reviewerResponse(['neo-gpt', 'neo-opus-grace'], ['core'])}
        );

        expect(res.code).toBeUndefined();
        expect(res.verifiedReviewers).toContain('neo-opus-grace');
        expect(res.verifiedReviewers).toContain('neo-gpt');
        expect(res.verifiedTeamReviewers).toEqual(['core']);
        expect(res.message).toContain('Successfully');
    });

    test('login comparison is case-insensitive (GitHub seats logins case-folded)', async () => {
        const res = await managePrReviewers(
            {pr_number: 42, reviewers: ['@Neo-GPT'], action: 'add'},
            {execFn: async () => reviewerResponse(['neo-gpt'])}
        );

        // A case-sensitive compare would report a genuinely seated reviewer as unseated.
        expect(res.code).toBeUndefined();
        expect(res.message).toContain('Successfully');
    });

    test('remove verifies ABSENCE — a reviewer still present is a failure', async () => {
        const res = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], action: 'remove'},
            {execFn: async () => reviewerResponse(['neo-gpt'])}   // still there → removal did not happen
        );

        expect(res.code).toBe('REVIEWER_STILL_REQUESTED');
        expect(res.unseated).toEqual(['neo-gpt']);
        expect(res.message).not.toContain('Successfully');
    });

    test('a failed remove describes the state GitHub returned, not the inverse', async () => {
        // The two actions fail into opposite observed states. A shared add-shaped envelope told the
        // caller of a failed REMOVE that the reviewer was "not seated" and sent them to check the
        // roster for a nonexistent login — while GitHub had just reported that exact login holding
        // the seat. Every assertion here is about the caller being routed at the real state.
        const removeFailed = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], action: 'remove'},
            {execFn: async () => reviewerResponse(['neo-gpt'])}
        );

        expect(removeFailed.error).toBe('Reviewer still requested');
        expect(removeFailed.message).toContain('remain requested reviewers');
        // The inverted claim and the remediation it implies — the actual defect, pinned by name.
        expect(removeFailed.error)  .not.toContain('not seated');
        expect(removeFailed.message).not.toContain('not seated');
        expect(removeFailed.message).not.toContain('identityRoots');
        expect(removeFailed.message).not.toContain('does not exist');
        // The seat is occupied; the caller must not read this as "free".
        expect(removeFailed.verifiedReviewers).toEqual(['neo-gpt']);

        // Positive control on the same axis: the add path must KEEP the roster remediation, or this
        // could have been "fixed" by deleting the guidance from both branches.
        const addFailed = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt-euclid'], action: 'add'},
            {execFn: async () => reviewerResponse([])}
        );

        expect(addFailed.code)   .toBe('REVIEWER_NOT_SEATED');
        expect(addFailed.error)  .toBe('Reviewer not seated');
        expect(addFailed.message).toContain('were not seated');
        expect(addFailed.message).toContain('identityRoots');

        // Neither envelope may state a status as the endpoint's general contract; the measured 200
        // belongs to the unknown-login receipt, and GitHub documents add as 201 / remove as 200.
        expect(removeFailed.message).not.toContain('HTTP 200');
        expect(addFailed   .message).not.toContain('HTTP 200');
    });

    test('remove succeeds when the reviewer is gone from the returned state', async () => {
        const res = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], action: 'remove'},
            {execFn: async () => reviewerResponse(['neo-opus-grace'])}
        );

        expect(res.code).toBeUndefined();
        expect(res.message).toContain('removed');
        expect(res.verifiedReviewers).toEqual(['neo-opus-grace']);
    });

    test('an unverifiable response is a failure, not a success', async () => {
        // Missing arrays: proves nothing about who is seated. Treating absent as empty would
        // resurrect the false-success — and `{}` was the old fixture, so this pins it directly.
        const missing = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], action: 'add'},
            {execFn: async () => ({stdout: '{}'})}
        );

        expect(missing.code).toBe('REVIEWER_STATE_UNVERIFIABLE');
        expect(missing.message).not.toContain('Successfully');

        const unparseable = await managePrReviewers(
            {pr_number: 42, reviewers: ['neo-gpt'], action: 'add'},
            {execFn: async () => ({stdout: 'not json'})}
        );

        expect(unparseable.code).toBe('REVIEWER_STATE_UNVERIFIABLE');
        expect(unparseable.message).not.toContain('Successfully');
    });

    test('the OpenAPI contract publishes what the runtime promises', async () => {
        // A tool description that promises verification fields is prose; the generated MCP contract is
        // what a client can actually discover. Before this, `ManagePrReviewersResponse` had no `required`
        // list — so `{}` satisfied the declared success schema — and the 422 pointed at the generic
        // `ErrorResponse`, which carries none of `pr_number` / `unseated` / the verified arrays.
        const doc     = yaml.load(fs.readFileSync(path.join(repoRoot, 'ai/mcp/server/github-workflow/openapi.yaml'), 'utf8')),
              schemas = doc.components.schemas,
              op      = Object.values(doc.paths).flatMap(p => Object.values(p)).find(o => o?.operationId === 'manage_pr_reviewers');

        expect(op, 'manage_pr_reviewers operation must exist').toBeTruthy();
        expect(op.description.length, 'modified MCP operation description stays within the 1024-byte budget')
            .toBeLessThanOrEqual(1024);

        const okRef  = op.responses['200'].content['application/json'].schema.$ref,
              errRef = op.responses['422'].content['application/json'].schema.$ref;

        expect(okRef) .toBe('#/components/schemas/ManagePrReviewersResponse');
        expect(errRef).toBe('#/components/schemas/ManagePrReviewersErrorResponse');

        // Success: every verification field is REQUIRED, so an empty object no longer validates.
        expect(schemas.ManagePrReviewersResponse.required)
            .toEqual(expect.arrayContaining(['message', 'pr_number', 'verifiedReviewers', 'verifiedTeamReviewers']));

        // Failure: the structured fields are discoverable from the schema, not only from prose.
        const errSchema = schemas.ManagePrReviewersErrorResponse;

        expect(Object.keys(errSchema.properties))
            .toEqual(expect.arrayContaining([
                'code',
                'pr_number',
                'headSha',
                'baseSha',
                'mergeabilityAttempts',
                'unseated',
                'verifiedReviewers',
                'verifiedTeamReviewers'
            ]));
        expect(errSchema.required).toEqual(expect.arrayContaining(['error', 'message', 'code', 'pr_number']));
        // `unseated` and the verified arrays are deliberately NOT required: on
        // REVIEWER_STATE_UNVERIFIABLE the response carried no reviewer arrays, and publishing empty
        // ones would assert "GitHub reports nobody seated" — a definite claim about the unknown.
        expect(errSchema.required).not.toContain('unseated');
        expect(errSchema.required).not.toContain('headSha');

        // The lock that keeps this from rotting: every failure code the METHOD can return must appear
        // in the enum. A fourth code added to the service without a schema update fails here.
        const source  = fs.readFileSync(path.join(repoRoot, 'ai/services/github-workflow/PullRequestService.mjs'), 'utf8'),
              start   = source.indexOf('async managePrReviewers('),
              body    = source.slice(start, source.indexOf('\n    async ', start + 1) + 1 || undefined),
              runtime = [...new Set(body.match(/'((?:REVIEWER|PR)_[A-Z_]+)'/g) || [])].map(m => m.slice(1, -1));

        // Positive control: the slice must actually contain the method, or an empty `runtime` would
        // make the arrayContaining below pass while checking nothing.
        expect(start).toBeGreaterThan(-1);
        expect(runtime.length).toBeGreaterThanOrEqual(5);
        expect(errSchema.properties.code.enum).toEqual(expect.arrayContaining(runtime));
    });
});

test.describe('PullRequestService.managePrReview — live mergeability gate on APPROVED after invitation (#1899)', () => {
    const
        REVIEW_ORIGIN_SESSION_ID = '8c622ae9-0ef1-4bf1-9a27-5dfe228b4fac',
        REVIEWED_HEAD            = '1111111111111111111111111111111111111111',
        CLEAN_BASE               = '2222222222222222222222222222222222222222',
        MOVED_BASE               = '3333333333333333333333333333333333333333',
        VALID_APPROVAL_BODY      = [
            '# PR Micro-Review',
            '',
            '**Class:** micro — narrow mergeability-gate fixture; no subsystem or schema drift.',
            '',
            '**Verdict:** APPROVED',
            '',
            '**Glance:** Premise and shape hold on the reviewed head.',
            '',
            `- **Origin Session ID:** ${REVIEW_ORIGIN_SESSION_ID}`
        ].join('\n'),
        VALID_COMMENT_BODY       = VALID_APPROVAL_BODY.replace('**Verdict:** APPROVED', '**Verdict:** COMMENT'),
        VALID_RC_BODY            = [
            '# PR Review Summary',
            '',
            '**Status:** Request Changes',
            '',
            '### 🪜 Strategic-Fit Decision',
            '- Decision: Request Changes',
            '',
            '### 🧭 Patch-Blind Premise Snapshot',
            '* **Inputs Read Before Patch:** ticket, changed-file list, current dev source.',
            '* **Expected Solution Shape:** gate requested-reviewer wakes and approvals on live mergeability.',
            '* **Patch Verdict:** matches the expected shape.',
            '* **Premise Coherence:** coheres: flat-peer-team unaffected.',
            '',
            '### 🕸️ Context & Graph Linking',
            '* **Target Epic / Issue ID:** Resolves #1899',
            '* **Related Graph Nodes:** #759',
            `* **Origin Session ID:** ${REVIEW_ORIGIN_SESSION_ID}`,
            '',
            '### 🔬 Depth Floor',
            '- Documented search: scanned holderOf and managePrReview surfaces.',
            '',
            '### 🧠 Graph Ingestion Notes',
            '* **`[KB_GAP]`**: N/A.',
            '* **`[TOOLING_GAP]`**: N/A.',
            '* **`[RETROSPECTIVE]`**: Budget control fixture.',
            '',
            '### 📋 Required Actions',
            '',
            '- [ ] rebase onto moved base before approval',
            '',
            '### 📊 Evaluation Metrics',
            '[ARCH_ALIGNMENT]: 80 - structural fit',
            '[CONTENT_COMPLETENESS]: 80 - covers AC matrix',
            '[EXECUTION_QUALITY]: 80 - tests pass',
            '[PRODUCTIVITY]: 70 - bounded scope',
            '[IMPACT]: 60 - localized fix',
            '[COMPLEXITY]: 40 - mechanical change',
            '[EFFORT_PROFILE]: Quick Win'
        ].join('\n');

    let GraphqlService, PullRequestService, RepositoryService, originalQuery, originalViewerLogin;

    test.beforeAll(async () => {
        GraphqlService      = (await import('../../../../../../ai/services/github-workflow/GraphqlService.mjs')).default;
        PullRequestService  = (await import('../../../../../../ai/services/github-workflow/PullRequestService.mjs')).default;
        RepositoryService   = (await import('../../../../../../ai/services/github-workflow/RepositoryService.mjs')).default;
        originalQuery       = GraphqlService.query.bind(GraphqlService);
        originalViewerLogin = RepositoryService.viewerLogin;
    });

    test.afterAll(() => {
        GraphqlService.query          = originalQuery;
        RepositoryService.viewerLogin = originalViewerLogin;
    });

    test.beforeEach(() => {
        RepositoryService.viewerLogin = 'neo-gpt-emmy';
    });

    test('reviewer invited on clean base, then base moves before approval: conflict and unavailable refuse without mutating, and fresh positive submits one approval', async () => {
        let reviewMutations   = 0,
            reviewerMutations = 0,
            remoteHeadOid     = REVIEWED_HEAD,
            remoteBaseSha     = CLEAN_BASE;
        const reviewCalls     = [];

        GraphqlService.query = async (query, variables) => {
            if (query.includes('GetPullRequestId')) {
                return {
                    repository: {
                        activationIssue: null,
                        pullRequest    : {
                            body          : 'Resolves #1899',
                            createdAt     : '2026-11-22T15:00:00Z',
                            headRefOid    : REVIEWED_HEAD,
                            id            : 'PR_kwDOUBzDFM1899',
                            reviewDecision: 'REVIEW_REQUIRED',
                            reviews       : {nodes: [], pageInfo: {hasPreviousPage: false}}
                        }
                    }
                };
            }
            if (query.includes('AddPullRequestReview')) {
                reviewMutations++;
                reviewCalls.push({query, variables, remoteHeadAtWrite: remoteHeadOid, remoteBaseAtWrite: remoteBaseSha});
                return {
                    addPullRequestReview: {
                        pullRequestReview: {
                            id         : 'PRR_kwDOUBzDFM1899',
                            url        : 'https://github.com/neomjs/neo-agent-brain/pull/1900#pullrequestreview-1',
                            state      : 'APPROVED',
                            submittedAt: '2026-11-22T22:20:00Z',
                            databaseId : 1
                        }
                    }
                };
            }
            return null;
        };

        const invite = await PullRequestService.managePrReviewers(
            {repo: 'neo-agent-brain', pr_number: 1900, reviewers: ['neo-gpt-emmy'], action: 'add'},
            {
                waitFn: async () => {},
                execFn: async command => {
                    if (command.includes('/requested_reviewers')) {
                        reviewerMutations++;
                        return reviewerResponse(['neo-gpt-emmy']);
                    }
                    return mergeabilityResponse(true, {headSha: REVIEWED_HEAD, baseSha: CLEAN_BASE});
                }
            }
        );
        expect(invite.verifiedReviewers).toEqual(['neo-gpt-emmy']);
        expect(reviewerMutations).toBe(1);

        const runApproval = (responses, waitFn = async () => {}) => {
            let idx = 0;
            return PullRequestService.managePrReview(
                {repo: 'neo-agent-brain', action: 'create', pr_number: 1900, state: 'APPROVED', body: VALID_APPROVAL_BODY},
                {
                    waitFn,
                    execFn: async command => {
                        if (command.includes('/requested_reviewers')) reviewerMutations++;
                        const next = responses[Math.min(idx++, responses.length - 1)];
                        if (next instanceof Error) throw next;
                        return next;
                    }
                }
            );
        };

        const conflicted = await runApproval([
            mergeabilityResponse(false, {headSha: REVIEWED_HEAD, baseSha: MOVED_BASE, mergeableState: 'dirty'})
        ]);
        expect(conflicted).toMatchObject({
            code                : 'PR_MERGE_CONFLICT',
            pr_number           : 1900,
            headSha             : REVIEWED_HEAD,
            baseSha             : MOVED_BASE,
            mergeabilityAttempts: 1
        });
        expect(reviewMutations).toBe(0);
        expect(reviewerMutations).toBe(1);

        const delays      = [];
        const pendingNull = await runApproval(
            Array.from({length: 4}, () => mergeabilityResponse(null, {headSha: REVIEWED_HEAD, baseSha: MOVED_BASE})),
            async delay => { delays.push(delay); }
        );
        expect(delays).toEqual([250, 500, 1000]);
        expect(pendingNull).toMatchObject({
            code                : 'PR_MERGEABILITY_UNAVAILABLE',
            pr_number           : 1900,
            headSha             : REVIEWED_HEAD,
            baseSha             : MOVED_BASE,
            mergeabilityAttempts: 4
        });
        expect(reviewMutations).toBe(0);

        const malformed = await runApproval([{stdout: '{}'}]);
        expect(malformed.code).toBe('PR_MERGEABILITY_UNAVAILABLE');
        expect(malformed.mergeabilityAttempts).toBe(1);
        expect(malformed.headSha).toBeUndefined();
        expect(reviewMutations).toBe(0);

        const transportError = await runApproval([
            mergeabilityResponse(null, {headSha: REVIEWED_HEAD, baseSha: MOVED_BASE}),
            new Error('REST 502')
        ]);
        expect(transportError).toMatchObject({
            code                : 'PR_MERGEABILITY_UNAVAILABLE',
            pr_number           : 1900,
            headSha             : REVIEWED_HEAD,
            baseSha             : MOVED_BASE,
            mergeabilityAttempts: 2
        });
        expect(reviewMutations).toBe(0);

        const OTHER_HEAD  = '4'.repeat(40);
        const headDrifted = await runApproval([
            mergeabilityResponse(true, {headSha: OTHER_HEAD, baseSha: MOVED_BASE})
        ]);
        expect(headDrifted).toMatchObject({
            code                : 'PR_MERGEABILITY_UNAVAILABLE',
            pr_number           : 1900,
            headSha             : OTHER_HEAD,
            baseSha             : MOVED_BASE,
            mergeabilityAttempts: 1
        });
        expect(reviewMutations).toBe(0);

        const conflictingOtherHead = await runApproval([
            mergeabilityResponse(false, {headSha: OTHER_HEAD, baseSha: MOVED_BASE, mergeableState: 'dirty'})
        ]);
        expect(conflictingOtherHead).toMatchObject({
            code                : 'PR_MERGEABILITY_UNAVAILABLE',
            pr_number           : 1900,
            headSha             : OTHER_HEAD,
            baseSha             : MOVED_BASE,
            mergeabilityAttempts: 1
        });
        expect(reviewMutations).toBe(0);

        const LATER_PUSHED_HEAD = '5'.repeat(40),
              LATER_BASE        = '6'.repeat(40);
        const approved = await PullRequestService.managePrReview(
            {repo: 'neo-agent-brain', action: 'create', pr_number: 1900, state: 'APPROVED', body: VALID_APPROVAL_BODY},
            {
                waitFn: async () => {},
                execFn: async () => {
                    const response = mergeabilityResponse(true, {headSha: REVIEWED_HEAD, baseSha: MOVED_BASE, mergeableState: 'behind'});
                    // Simulate a concurrent push and base advance immediately after the final REST read
                    // before AddPullRequestReview executes: commitOID binds the approval to REVIEWED_HEAD,
                    // while the separate-read base limitation remains explicit.
                    remoteHeadOid = LATER_PUSHED_HEAD;
                    remoteBaseSha = LATER_BASE;
                    return response;
                }
            }
        );
        expect(approved.code).toBeUndefined();
        expect(approved.state).toBe('APPROVED');
        expect(reviewMutations).toBe(1);
        expect(reviewerMutations).toBe(1);
        expect(reviewCalls).toHaveLength(1);
        expect(reviewCalls[0].query).toContain('$commitOID: GitObjectID');
        expect(reviewCalls[0].query).toContain('commitOID: $commitOID');
        expect(reviewCalls[0].remoteHeadAtWrite).toBe(LATER_PUSHED_HEAD);
        expect(reviewCalls[0].remoteBaseAtWrite).toBe(LATER_BASE);
        expect(reviewCalls[0].variables).toEqual({
            pullRequestId: 'PR_kwDOUBzDFM1899',
            body         : VALID_APPROVAL_BODY,
            event        : 'APPROVE',
            commitOID    : REVIEWED_HEAD
        });
    });

    test('COMMENT, REQUEST_CHANGES, review updates, and unacknowledged-RC approvals retain existing paths without REST mergeability reads', async () => {
        let   mergeabilityReads    = 0;
        const nonApprovalVariables = [],
              failIfRead           = {execFn: async () => { mergeabilityReads++; throw new Error('unexpected mergeability read'); }};

        GraphqlService.query = async (query, variables) => {
            if (query.includes('GetPullRequestId')) {
                return {
                    repository: {
                        activationIssue: {
                            id                            : 'I_kwDOUBzDFM15257',
                            closedByPullRequestsReferences: {
                                totalCount: 1,
                                nodes     : [{id: 'PR_act', number: 15310, state: 'MERGED', mergedAt: '2026-07-16T13:57:03Z', baseRefName: 'dev'}],
                                pageInfo  : {hasNextPage: false}
                            }
                        },
                        pullRequest: {
                            body          : 'Resolves #1899',
                            createdAt     : '2026-11-22T15:00:00Z',
                            headRefOid    : REVIEWED_HEAD,
                            id            : 'PR_kwDOUBzDFM1899',
                            reviewDecision: 'CHANGES_REQUESTED',
                            reviews       : {
                                nodes: [{
                                    id         : 'PRR_rc1',
                                    state      : 'CHANGES_REQUESTED',
                                    submittedAt: '2026-11-22T16:00:00Z',
                                    body       : '# PR Review Summary\n\n### 📋 Required Actions\n\n- [ ] fix conflict',
                                    author     : {login: 'neo-gpt-emmy'},
                                    commit     : {oid: REVIEWED_HEAD}
                                }, {
                                    id         : 'PRR_rc2',
                                    state      : 'CHANGES_REQUESTED',
                                    submittedAt: '2026-11-22T16:05:00Z',
                                    body       : '# PR Review Summary\n\n### 📋 Required Actions\n\n- [ ] second round',
                                    author     : {login: 'neo-gpt-euclid'},
                                    commit     : {oid: REVIEWED_HEAD}
                                }],
                                pageInfo: {hasPreviousPage: false}
                            }
                        }
                    }
                };
            }
            if (query.includes('GetPullRequestReview')) {
                return {
                    node: {
                        id         : 'PRR_existing',
                        state      : 'COMMENTED',
                        body       : VALID_COMMENT_BODY,
                        pullRequest: {number: 1900, repository: {nameWithOwner: 'neomjs/neo-agent-brain'}, reviews: {nodes: []}}
                    }
                };
            }
            if (query.includes('AddPullRequestReview')) {
                nonApprovalVariables.push(variables);
                return {addPullRequestReview: {pullRequestReview: {id: 'PRR_new', url: 'https://example.test/1', state: 'COMMENTED', submittedAt: '2026-11-22T22:21:00Z', databaseId: 2}}};
            }
            if (query.includes('UpdatePullRequestReview')) {
                return {updatePullRequestReview: {pullRequestReview: {id: 'PRR_existing', url: 'https://example.test/1', state: 'COMMENTED', submittedAt: '2026-11-22T22:22:00Z'}}};
            }
            return null;
        };

        const unack = await PullRequestService.managePrReview(
            {repo: 'neo-agent-brain', action: 'create', pr_number: 1900, state: 'APPROVED', body: VALID_APPROVAL_BODY},
            failIfRead
        );
        expect(unack.code).toBe('PR_REVIEW_STATE_VALIDATION_FAILED');

        const overBudgetRc = await PullRequestService.managePrReview(
            {repo: 'neo-agent-brain', action: 'create', pr_number: 1900, state: 'REQUEST_CHANGES', body: VALID_RC_BODY},
            failIfRead
        );
        expect(overBudgetRc.code).toBe('PR_REVIEW_BUDGET_VALIDATION_FAILED');

        const comment = await PullRequestService.managePrReview(
            {repo: 'neo-agent-brain', action: 'create', pr_number: 1900, state: 'COMMENT', body: VALID_COMMENT_BODY},
            failIfRead
        );
        expect(comment.code).toBeUndefined();
        expect(nonApprovalVariables).toEqual([{
            pullRequestId: 'PR_kwDOUBzDFM1899',
            body         : VALID_COMMENT_BODY,
            event        : 'COMMENT'
        }]);

        const update = await PullRequestService.managePrReview(
            {repo: 'neo-agent-brain', action: 'update', review_id: 'PRR_existing', body: VALID_COMMENT_BODY},
            failIfRead
        );
        expect(update.code).toBeUndefined();
        expect(mergeabilityReads).toBe(0);
    });

    test('OpenAPI documents manage_pr_review 422 mergeability refusals within the 1024-byte description budget', () => {
        const doc       = yaml.load(fs.readFileSync(path.join(repoRoot, 'ai/mcp/server/github-workflow/openapi.yaml'), 'utf8')),
              op        = Object.values(doc.paths).flatMap(p => Object.values(p)).find(o => o?.operationId === 'manage_pr_review'),
              errSchema = doc.components.schemas.ManagePrReviewApprovalErrorResponse;

        expect(op.description.length).toBeLessThanOrEqual(1024);
        expect(op.responses['422'].content['application/json'].schema.$ref)
            .toBe('#/components/schemas/ManagePrReviewApprovalErrorResponse');
        expect(errSchema.required).toEqual(expect.arrayContaining(['error', 'message', 'code', 'pr_number', 'mergeabilityAttempts']));
        expect(errSchema.properties.code.enum).toEqual(['PR_MERGE_CONFLICT', 'PR_MERGEABILITY_UNAVAILABLE']);
    });
});
