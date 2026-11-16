import {expect, test} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {load as yaml} from 'js-yaml';

const
    WORKFLOW_PATH = path.resolve(process.cwd(), '.github/workflows/claim-responder.yml'),
    REPO_OWNER    = 'neomjs',
    REPO_NAME     = 'neo-agent-brain',
    AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * @summary Creates a temporary workspace carrying the two rule modules checked out from neomjs/neo@dev.
 * @returns {String} Temporary workspace root; callers remove it in a finally block.
 */
function createRuleWorkspace() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-responder-wf-'));
    const utilDir   = path.join(workspace, 'buildScripts/util');

    fs.mkdirSync(utilDir, {recursive: true});

    fs.writeFileSync(path.join(utilDir, 'claimResponse.mjs'), `
export const CURATED_LABELS      = Object.freeze(['good first issue', 'help wanted']);
export const TEAM_ASSOCIATIONS   = Object.freeze(['COLLABORATOR', 'MEMBER', 'OWNER']);
export const TEAM_PERMISSIONS    = Object.freeze(['admin', 'maintain', 'write']);
export const CLAIM_RELEASE_SINCE = null;
export function isTeamPermission(permission) {
    return TEAM_PERMISSIONS.includes(permission);
}
export function isOutsideHuman(comment) {
    return comment?.user?.type !== 'Bot' && !TEAM_ASSOCIATIONS.includes(comment?.author_association);
}
export function isClaim(body = '') {
    return /\\/claim|\\bwork on\\b|\\bclaim\\b/i.test(body);
}
export function curatedLabel(issue) {
    const names = new Set((issue?.labels || []).map(l => typeof l === 'string' ? l : l.name));
    return CURATED_LABELS.find(label => names.has(label)) || null;
}
export function closeTargets(body = '') {
    return [...new Set([...String(body).matchAll(/\\b(?:resolves|closes|fixes):?\\s+#(\\d+)/gi)].map(m => Number(m[1])))];
}
export function changedCloseTargets({action, pullRequest, changes}) {
    const current = closeTargets(pullRequest?.body || '');
    if (action !== 'edited') return {added: current, removed: []};
    const prior = closeTargets(changes?.body?.from || '');
    return {
        added  : current.filter(n => !prior.includes(n)),
        removed: prior.filter(n => !current.includes(n))
    };
}
export function decideTargetRemoval({pullRequest, issue, comments = []}) {
    const login = pullRequest?.user?.login;
    const assigned = (issue?.assignees || []).some(a => a.login.toLowerCase() === String(login).toLowerCase());
    const provenance = comments.some(c => c.user?.login === login && /claim/i.test(c.body));
    return assigned && !provenance ? {unassign: true, assignee: login} : {unassign: false};
}
export function decidePullRequestTarget({issue, mergedPullRequests = [], prComments = [], pullRequest, heldByAuthor = [], claimLimit = 1}) {
    if (!curatedLabel(issue)) return null;
    if (issue.state === 'closed' || mergedPullRequests.length > 0) {
        const merged = mergedPullRequests[0]?.number;
        if (prComments.some(c => c.body.includes(\`heldBy: pr:\${merged}\`))) return null;
        return {assign: false, prNotice: \`Residual-scope review needed for #\${issue.number} (heldBy: pr:\${merged})\`};
    }
    if ((issue.assignees || []).length > 0 || heldByAuthor.length >= (claimLimit === 2 ? 2 : 1)) {
        return {assign: false, prNotice: \`Overlap notice on #\${issue.number}\`};
    }
    return {assign: true, unassign: []};
}
export function decidePullRequestRelease({issue, openPullRequests = [], pullRequest, releaseSince}) {
    if (!releaseSince || !curatedLabel(issue) || issue.state !== 'open') return null;
    if (!pullRequest?.closed_at || Date.parse(pullRequest.closed_at) < Date.parse(releaseSince)) return null;
    if ((issue.assignees || []).length > 0 || openPullRequests.some(pr => pr.number !== pullRequest.number)) return null;
    return {body: \`PR #\${pullRequest.number} closed without merge; #\${issue.number} has no current holder.\`};
}
export function decideClaim({comment, issue, comments = [], heldByClaimant = [], claimLimit = 1, repoUrl}) {
    if (!curatedLabel(issue) || !isOutsideHuman(comment) || !isClaim(comment.body)) return null;
    const priorRefusal = comments.findLast(item => item.user?.type === 'Bot' && item.body.includes(\`claim-refused:\${comment.user.login}\`));
    if (heldByClaimant.length >= (claimLimit === 2 ? 2 : 1)) {
        const body = \`Already holds #\${heldByClaimant.join(', #')}\\n<!-- claim-refused:\${comment.user.login} -->\`;
        return priorRefusal ? {assign: false, body, updateCommentId: priorRefusal.id} : {assign: false, body};
    }
    const stale = (issue.assignees || []).map(a => a.login).filter(login => login.toLowerCase() !== comment.user.login.toLowerCase());
    return {
        assign      : true,
        assignedBody: \`Assigned to @\${comment.user.login} on \${repoUrl}\`,
        body        : \`First in line @\${comment.user.login} on \${repoUrl}\`,
        unassign    : stale
    };
}
`.trimStart());

    fs.writeFileSync(path.join(utilDir, 'contributorStanding.mjs'), `
export function claimLimit(count) {
    return Number.isSafeInteger(count) && count >= 5 ? 2 : 1;
}
`.trimStart());

    return workspace;
}

/**
 * @summary Parses the workflow YAML and compiles its github-script body.
 * @returns {{doc: Object, raw: String, runStep: Function}}
 */
function loadWorkflow() {
    const
        raw     = fs.readFileSync(WORKFLOW_PATH, 'utf8'),
        doc     = yaml(raw),
        step    = doc.jobs.respond.steps.find(item => item.with?.script),
        runStep = new AsyncFunction('github', 'context', 'core', step.with.script);

    return {doc, raw, runStep};
}

test.describe('Step 1: issue_comment decideClaim assignment & read-back', () => {
    test('workflow serializes at job level and sparse-checks out both Engine rule modules', () => {
        const {doc}    = loadWorkflow();
        const checkout = doc.jobs.respond.steps[0];

        expect(doc.concurrency).toBeUndefined();
        expect(doc.jobs.respond.concurrency).toEqual({
            group               : 'claim-responder',
            'cancel-in-progress': false,
            queue               : 'max'
        });
        expect(checkout.uses).toBe('actions/checkout@v7');
        expect(checkout.with.repository).toBe('neomjs/neo');
        expect(checkout.with.ref).toBe('dev');
        expect(checkout.with['persist-credentials']).toBe(false);
        expect(checkout.with['sparse-checkout-cone-mode']).toBe(false);
        expect(checkout.with['sparse-checkout'].trim().split(/\s+/)).toEqual([
            'buildScripts/util/claimResponse.mjs',
            'buildScripts/util/contributorStanding.mjs'
        ]);
    });

    test('assigns unclaimed curated issue on verified read-back, falls back safely on empty attach, enforces cap, and edits prior refusals', async () => {
        const {runStep} = loadWorkflow();
        const workspace = createRuleWorkspace();
        const prevWs    = process.env.GITHUB_WORKSPACE;

        const invoke = async ({
            addAssigneesResult = args => ({data: {assignees: args.assignees.map(login => ({login}))}}),
            assignedIssues     = [],
            comments           = [],
            comment            = {id: 101, body: '/claim', user: {id: 1, login: 'outside-dev', type: 'User'}, author_association: 'NONE'},
            issue              = {number: 1631, state: 'open', labels: [{name: 'help wanted'}], assignees: []},
            mergedCount        = {total_count: 0, incomplete_results: false}
        } = {}) => {
            const assigned = [], unassigned = [], created = [], updated = [], warnings = [];

            const github = {
                graphql : async () => ({repository: {issue: {closedByPullRequestsReferences: {nodes: []}}}}),
                paginate: async fn => {
                    if (fn === github.rest.issues.listComments) return comments;
                    if (fn === github.rest.issues.listEvents)   return [];
                    if (fn === github.rest.issues.listForRepo)  return assignedIssues;
                    throw new Error('unexpected paginate call');
                },
                rest: {
                    issues: {
                        addAssignees   : async args => { assigned.push(args); return addAssigneesResult(args) },
                        createComment  : async args => { created.push(args); return {data: {}} },
                        get            : async ()   => ({data: issue}),
                        listComments   : Symbol('listComments'),
                        listEvents     : Symbol('listEvents'),
                        listForRepo    : Symbol('listForRepo'),
                        removeAssignees: async args => { unassigned.push(args); return {data: {}} },
                        updateComment  : async args => { updated.push(args); return {data: {}} }
                    },
                    search: {
                        issuesAndPullRequests: async ({q}) => q.startsWith('org:')
                            ? {data: mergedCount}
                            : {data: {items: [{number: 1688}]}}
                    }
                }
            };

            process.env.GITHUB_WORKSPACE = workspace;
            try {
                await runStep(
                    github,
                    {eventName: 'issue_comment', payload: {comment, issue: {number: issue.number}}, repo: {owner: REPO_OWNER, repo: REPO_NAME}},
                    {info: () => {}, warning: msg => warnings.push(msg)}
                );
            } finally {
                process.env.GITHUB_WORKSPACE = prevWs;
            }

            return {assigned, created, unassigned, updated, warnings};
        };

        try {
            // 1. Verified auto-assignment clears stale assignee and uses assignedBody
            const verified = await invoke({
                issue: {number: 1631, state: 'open', labels: [{name: 'help wanted'}], assignees: [{login: 'stale-user'}]}
            });

            expect(verified.assigned).toEqual([{assignees: ['outside-dev'], issue_number: 1631, owner: REPO_OWNER, repo: REPO_NAME}]);
            expect(verified.unassigned).toEqual([{assignees: ['stale-user'], issue_number: 1631, owner: REPO_OWNER, repo: REPO_NAME}]);
            expect(verified.created[0].body).toContain('Assigned to @outside-dev');
            expect(verified.warnings).toEqual([]);

            // 2. Empty read-back posts fallback body and warns without unassigning
            const unattached = await invoke({
                addAssigneesResult: () => ({data: {assignees: []}}),
                issue             : {number: 1631, state: 'open', labels: [{name: 'help wanted'}], assignees: [{login: 'stale-user'}]}
            });

            expect(unattached.unassigned).toEqual([]);
            expect(unattached.created[0].body).toContain('First in line @outside-dev');
            expect(unattached.warnings).toHaveLength(1);

            // 3. Standing >= 5 lifts cap to 2; holding 1 still assigns, while edited refusal updates existing bot comment
            const returningSecond = await invoke({
                assignedIssues: [{number: 1555, labels: [{name: 'help wanted'}]}],
                mergedCount   : {total_count: 5, incomplete_results: false}
            });

            expect(returningSecond.assigned).toHaveLength(1);
            expect(returningSecond.created[0].body).toContain('Assigned to @outside-dev');

            const retryRefusal = await invoke({
                assignedIssues: [{number: 1555, labels: [{name: 'help wanted'}]}],
                comments      : [{id: 55, user: {login: 'github-actions[bot]', type: 'Bot'}, body: 'Already holds #1555\n<!-- claim-refused:outside-dev -->'}],
                mergedCount   : {total_count: 1, incomplete_results: false}
            });

            expect(retryRefusal.assigned).toEqual([]);
            expect(retryRefusal.created).toEqual([]);
            expect(retryRefusal.updated).toEqual([{
                body      : 'Already holds #1555\n<!-- claim-refused:outside-dev -->',
                comment_id: 55,
                owner     : REPO_OWNER,
                repo      : REPO_NAME
            }]);
        } finally {
            fs.rmSync(workspace, {force: true, recursive: true});
        }
    });
});

test.describe('Step 2: pull_request_target claim, provenance, and activation-boundary gate', () => {
    test('workflow YAML enforces trusted checkout, permissions, job serialization, and head exclusion', () => {
        const {doc, raw} = loadWorkflow();
        const checkout   = doc.jobs.respond.steps[0];
        const scriptStep = doc.jobs.respond.steps[1];

        expect(doc.on.pull_request_target.types).toEqual(['opened', 'reopened', 'edited', 'closed']);
        expect(doc.permissions).toEqual({
            contents       : 'read',
            issues         : 'write',
            'pull-requests': 'write'
        });
        expect(doc.jobs.respond.concurrency).toEqual({
            group               : 'claim-responder',
            'cancel-in-progress': false,
            queue               : 'max'
        });
        expect(checkout.with.repository).toBe('neomjs/neo');
        expect(checkout.with.ref).toBe('dev');
        expect(checkout.with['persist-credentials']).toBe(false);
        expect(scriptStep.env.NEO_CLAIM_RELEASE_SINCE).toBe('${{ vars.NEO_CLAIM_RELEASE_SINCE }}');
        expect(raw).not.toContain('github.event.pull_request.head');
    });

    test('fails closed on incomplete author/state, attaches outside PR authors cleanly, respects removal provenance, and enforces release activation gate', async () => {
        const {runStep} = loadWorkflow();
        const workspace = createRuleWorkspace();
        const prevWs    = process.env.GITHUB_WORKSPACE;
        const prevSince = process.env.NEO_CLAIM_RELEASE_SINCE;

        const runPr = async ({
            action             = 'opened',
            addAssigneesResult = args => ({data: {assignees: args.assignees.map(login => ({login}))}}),
            assignedIssues     = [],
            changes,
            graphqlHasNextPage = false,
            issue              = {number: 1631, state: 'open', labels: [{name: 'help wanted'}], assignees: []},
            issueComments      = [],
            nextIssueRead,
            openPullRequests   = [],
            permission         = 'read',
            prComments         = [],
            pullDetails        = new Map(),
            pullRequest        = {
                number            : 2150,
                body              : 'Resolves #1631',
                merged            : false,
                author_association: 'NONE',
                user              : {id: 42, login: 'pr-author', type: 'User'},
                closed_at         : '2026-11-16T02:00:00Z'
            },
            releaseSince       = undefined
        } = {}) => {
            const assigned   = [], unassigned = [], created = [], warnings = [];
            let   issueReads = 0;

            const github = {
                graphql: async () => ({
                    repository: {
                        issue: {
                            closedByPullRequestsReferences: {
                                nodes   : openPullRequests,
                                pageInfo: {hasNextPage: graphqlHasNextPage}
                            }
                        }
                    }
                }),
                paginate: async (fn, args) => {
                    if (fn === github.rest.issues.listComments) {
                        return args.issue_number === pullRequest.number ? [...prComments] : [...issueComments];
                    }
                    if (fn === github.rest.issues.listEvents)  return [];
                    if (fn === github.rest.issues.listForRepo) return assignedIssues;
                    throw new Error('unexpected paginate call');
                },
                rest: {
                    issues: {
                        addAssignees : async args => { assigned.push(args); return addAssigneesResult(args) },
                        createComment: async args => { created.push(args); return {data: {}} },
                        get          : async ()   => {
                            issueReads++;
                            if (issueReads > 1 && nextIssueRead) return {data: nextIssueRead()};
                            return {data: issue};
                        },
                        listComments   : Symbol('listComments'),
                        listEvents     : Symbol('listEvents'),
                        listForRepo    : Symbol('listForRepo'),
                        removeAssignees: async args => { unassigned.push(args); return {data: {}} }
                    },
                    pulls: {
                        get: async ({pull_number}) => ({data: pullDetails.get(pull_number)})
                    },
                    repos: {
                        getCollaboratorPermissionLevel: async () => ({data: {permission}})
                    },
                    search: {
                        issuesAndPullRequests: async ({q}) => q.startsWith('org:')
                            ? {data: {total_count: 0, incomplete_results: false}}
                            : {data: {items: [{number: 1688}]}}
                    }
                }
            };

            process.env.GITHUB_WORKSPACE = workspace;
            if (releaseSince === undefined) delete process.env.NEO_CLAIM_RELEASE_SINCE;
            else process.env.NEO_CLAIM_RELEASE_SINCE = releaseSince;

            try {
                await runStep(
                    github,
                    {eventName: 'pull_request_target', payload: {action, changes, pull_request: pullRequest}, repo: {owner: REPO_OWNER, repo: REPO_NAME}},
                    {info: () => {}, warning: msg => warnings.push(msg)}
                );
            } finally {
                process.env.GITHUB_WORKSPACE = prevWs;
                if (prevSince === undefined) delete process.env.NEO_CLAIM_RELEASE_SINCE;
                else process.env.NEO_CLAIM_RELEASE_SINCE = prevSince;
            }

            return {assigned, created, unassigned, warnings};
        };

        try {
            // 1. Fail closed on incomplete author identity & truncated GraphQL state
            await expect(runPr({
                pullRequest: {number: 2150, body: 'Resolves #1631', author_association: 'NONE', user: {login: 'no-id', type: 'User'}}
            })).rejects.toThrow('Incomplete pull request author identity');

            await expect(runPr({graphqlHasNextPage: true})).rejects.toThrow('Incomplete state read for #1631');

            // 2. Hidden collaborator is ignored cleanly
            const teamPr = await runPr({permission: 'write'});

            expect(teamPr.assigned).toEqual([]);
            expect(teamPr.created).toEqual([]);

            // 3. Unclaimed outside PR requests assignment cleanly; unattachable author warns without failing
            const attached = await runPr();

            expect(attached.assigned).toEqual([{assignees: ['pr-author'], issue_number: 1631, owner: REPO_OWNER, repo: REPO_NAME}]);
            expect(attached.created).toEqual([]);
            expect(attached.warnings).toEqual([]);

            const unattachable = await runPr({addAssigneesResult: () => ({data: {assignees: []}})});

            expect(unattachable.created).toEqual([]);
            expect(unattachable.warnings).toHaveLength(1);

            // 4. Held issue receives overlap notice on PR; merged close sends residual notice to other open PR
            const held = await runPr({
                issue: {number: 1631, state: 'open', labels: [{name: 'help wanted'}], assignees: [{login: 'other-user'}]}
            });

            expect(held.assigned).toEqual([]);
            expect(held.created).toEqual([{issue_number: 2150, owner: REPO_OWNER, repo: REPO_NAME, body: 'Overlap notice on #1631'}]);

            const mergedPr = await runPr({
                action          : 'closed',
                openPullRequests: [{number: 2151, state: 'OPEN', merged: false, author: {login: 'second-dev'}, repository: {nameWithOwner: `${REPO_OWNER}/${REPO_NAME}`}}],
                pullDetails     : new Map([[2151, {number: 2151, body: 'Resolves #1631', author_association: 'NONE', user: {id: 77, login: 'second-dev', type: 'User'}}]]),
                pullRequest     : {number: 2150, body: 'Resolves #1631', merged: true, author_association: 'NONE', user: {id: 42, login: 'pr-author', type: 'User'}}
            });

            expect(mergedPr.created[0]).toMatchObject({issue_number: 2151, owner: REPO_OWNER, repo: REPO_NAME});
            expect(mergedPr.created[0].body).toContain('Residual-scope review needed for #1631 (heldBy: pr:2150)');

            // 5. Target removal unassigns only when no independent claim comment exists
            const removed = await runPr({
                action     : 'edited',
                changes    : {body: {from: 'Resolves #1631'}},
                issue      : {number: 1631, state: 'open', labels: [{name: 'help wanted'}], assignees: [{login: 'pr-author'}]},
                pullRequest: {number: 2150, body: 'unrelated', author_association: 'NONE', user: {id: 42, login: 'pr-author', type: 'User'}}
            });

            expect(removed.unassigned).toEqual([{assignees: ['pr-author'], issue_number: 1631, owner: REPO_OWNER, repo: REPO_NAME}]);

            const keptClaim = await runPr({
                action       : 'edited',
                changes      : {body: {from: 'Resolves #1631'}},
                issue        : {number: 1631, state: 'open', labels: [{name: 'help wanted'}], assignees: [{login: 'pr-author'}]},
                issueComments: [{user: {login: 'pr-author', type: 'User'}, body: 'I would like to claim this'}],
                pullRequest  : {number: 2150, body: 'unrelated', author_association: 'NONE', user: {id: 42, login: 'pr-author', type: 'User'}}
            });

            expect(keptClaim.unassigned).toEqual([]);

            // 6. Unmerged closed respects activation boundary and race re-check, and catches closed errors via warning
            const preActivation = await runPr({action: 'closed'});

            expect(preActivation.created).toEqual([]);

            const postActivation = await runPr({action: 'closed', releaseSince: '2026-11-16T01:00:00Z'});

            expect(postActivation.created).toEqual([{
                body        : 'PR #2150 closed without merge; #1631 has no current holder.',
                issue_number: 1631,
                owner       : REPO_OWNER,
                repo        : REPO_NAME
            }]);

            const raceSuppressed = await runPr({
                action       : 'closed',
                nextIssueRead: () => ({number: 1631, state: 'open', labels: [{name: 'help wanted'}], assignees: [{login: 'new-holder'}]}),
                releaseSince : '2026-11-16T01:00:00Z'
            });

            expect(raceSuppressed.created).toEqual([]);

            const closedWarned = await runPr({action: 'closed', graphqlHasNextPage: true, releaseSince: '2026-11-16T01:00:00Z'});

            expect(closedWarned.warnings[0]).toContain('Closed-event claim handling skipped for PR #2150');
        } finally {
            fs.rmSync(workspace, {force: true, recursive: true});
        }
    });
});
