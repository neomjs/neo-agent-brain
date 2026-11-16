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
export const CURATED_LABELS = Object.freeze(['good first issue', 'help wanted']);
export function isOutsideHuman(comment) {
    return comment?.user?.type !== 'Bot' && !['COLLABORATOR', 'MEMBER', 'OWNER'].includes(comment?.author_association);
}
export function isClaim(body = '') {
    return /\\/claim|\\bwork on\\b|\\bclaim\\b/i.test(body);
}
export function curatedLabel(issue) {
    const names = new Set((issue?.labels || []).map(l => typeof l === 'string' ? l : l.name));
    return CURATED_LABELS.find(label => names.has(label)) || null;
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
