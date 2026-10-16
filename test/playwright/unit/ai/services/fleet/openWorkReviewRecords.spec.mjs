import {expect, test} from '@playwright/test';
import {normalizePullRequest, reduceOpenWork} from '../../../../../../ai/services/fleet/openWorkReducer.mjs';
import {projectOpenWork} from '../../../../../../ai/services/fleet/fleetOpenWorkSource.mjs';
import {createOpenWorkProducer} from '../../../../../../ai/services/fleet/openWorkProducer.mjs';
import {OPEN_WORK_SNAPSHOT, openWorkQueryCost} from '../../../../../../ai/services/github-workflow/queries/openWorkQueries.mjs';
import {planOpenWorkWakes} from '../../../../../../ai/services/fleet/openWorkWakes.mjs';

const API = 'https://api.github.com', REPO = 'acme/app', HEAD = 'h1';
const identities = {byLogin: login => `@${login}`, byName: name => name === 'Author' ? '@author' : null};
const actor = {id: 'U_AUTHOR', __typename: 'User', login: 'author'};
const reviewer = {id: 'U_REVIEWER', __typename: 'User', login: 'reviewer'};

/** @summary Fixed provider time, distinct from the observing pulse. @param {Number} second @returns {String} */
function at(second) {return `2026-10-16T10:00:${String(second).padStart(2, '0')}Z`}

/** @summary One original provider request or removal. @param {Object} overrides @returns {Object} */
function request(overrides = {}) {
    return {__typename: 'ReviewRequestedEvent', id: 'RRE_1', createdAt: at(1), actor, requestedReviewer: reviewer, ...overrides}
}

/** @summary One currently returned standing opinion. @param {Object} overrides @returns {Object} */
function opinion(overrides = {}) {
    return {id: 'PRR_1', submittedAt: at(5), state: 'APPROVED', author: reviewer, commit: {oid: HEAD}, ...overrides}
}

/** @summary An exact query-shaped PR with complete current-work lists. @param {Object} overrides @returns {Object} */
function node(overrides = {}) {
    return {
        id: 'PR_7', number: 7, title: 'A held pull request', headRefOid: HEAD, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
        body: 'Authored by Author (test fixture).', author: actor, repository: {nameWithOwner: REPO},
        reviewRequests: {pageInfo: {hasNextPage: false}, nodes: []},
        latestReviews: {pageInfo: {hasNextPage: false}, nodes: [opinion()]},
        latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: [opinion()]},
        timelineItems: {pageInfo: {hasPreviousPage: false, hasNextPage: false}, nodes: [request()]},
        commits: {nodes: [{commit: {oid: HEAD, statusCheckRollup: {state: 'SUCCESS'}}}]},
        ...overrides
    }
}

/** @summary Normalize through the production row entry point. @param {Object} value @param {String} apiBase @returns {Object} */
function row(value = node(), apiBase = API) {return normalizePullRequest(value, identities, {apiBase})}

/** @summary A timeline page whose prefix may be unread. @param {Object[]} nodes @param {Boolean} partial @returns {Object} */
function history(nodes, partial = false) {return {nodes, pageInfo: {hasPreviousPage: partial, hasNextPage: false}}}

/** @summary Feed a held-row sequence through the actual previous/current join. @param {Object[]} values @returns {Object[]} */
function sequence(values) {
    let previous = null;

    return values.map((value, i) => previous = reduceOpenWork({previous, observed: {rows: [value], complete: true},
        terminal: {rows: [], complete: true}, since: null, id: at(20 + i)}))
}

test('original facts survive normalization and projection without observation restamping', () => {
    const value = row(), packet = value.reviewRecords;

    expect(packet.source).toEqual({apiBase: API, repo: REPO, prId: 'PR_7', number: 7});
    expect(packet.historyCoverage).toBe('complete');
    expect(packet.opinionsComplete).toBe(true);
    expect(packet.events[0]).toEqual({kind: 'requested', id: 'RRE_1', at: at(1),
        actor: {id: 'U_AUTHOR', kind: 'User', login: 'author'}, reviewer: {id: 'U_REVIEWER', kind: 'User', login: 'reviewer'}, head: null});
    expect(packet.approvals[0]).toMatchObject({id: 'PRR_1', at: at(5), commit: HEAD, onHead: true,
        reviewer: {id: 'U_REVIEWER'}, requestState: 'paired', request: {id: 'RRE_1', at: at(1)}});
    const state = sequence([value])[0], projection = projectOpenWork({snapshot: state, observedAt: at(20), coverage: 'complete'}, {now: () => Date.parse(at(21))});
    expect(projection.awaitingMerge[0].reviewRecords).toEqual(packet);
    expect(projection.awaitingMerge[0].observedAt).toBe(at(20));
});

test('source, requester or recipient metadata is not inferred for legacy or malformed inputs', () => {
    expect(row({...node(), id: undefined}).reviewRecords).toBeNull();
    expect(row(node({number: undefined})).reviewRecords).toBeNull();
    expect(normalizePullRequest(node(), identities).reviewRecords).toBeNull();
    const packet = row(node({timelineItems: history([request({requestedReviewer: {login: 'reviewer'}})])})).reviewRecords;
    expect(packet.historyCoverage).toBe('unavailable');
    expect(packet.approvals[0].requestState).toBe('unknown');
});

for (const [name, events, expected] of [
    ['another reviewer', [request({requestedReviewer: {...reviewer, id: 'U_OTHER'}})], 'absent'],
    ['team instead of a member', [request({requestedReviewer: {id: 'T_1', __typename: 'Team', slug: 'team', organization: {login: 'acme'}}})], 'absent'],
    ['no request in exhausted history', [], 'absent'],
    ['a removal before approval', [request(), request({__typename: 'ReviewRequestRemovedEvent', id: 'RRE_REMOVE', createdAt: at(3)})], 'removed'],
    ['a request tied to approval time', [request({createdAt: at(5)})], 'ambiguous'],
    ['a removal tied to approval time', [request(), request({__typename: 'ReviewRequestRemovedEvent', id: 'RRE_REMOVE', createdAt: at(5)})], 'ambiguous'],
    ['a request after approval', [request({createdAt: at(6)})], 'absent']
]) test(`association: ${name}`, () => {
    const approval = row(node({timelineItems: history(events)})).reviewRecords.approvals[0];
    expect(approval.requestState).toBe(expected);
    expect(approval.request).toBeNull();
});

test('the latest preceding request wins; provider identity survives a login change', () => {
    const packet = row(node({timelineItems: history([request(), request({id: 'RRE_2', createdAt: at(3), requestedReviewer: {...reviewer, login: 'old-login'}})])})).reviewRecords;
    expect(packet.approvals[0]).toMatchObject({requestState: 'paired', request: {id: 'RRE_2', reviewer: {login: 'old-login'}}});
});

test('comments, change requests, re-requests, dismissal and head movement remain distinct', () => {
    const comment = {...opinion(), id: 'COMMENT', state: 'COMMENTED', submittedAt: at(7)};
    expect(row(node({latestReviews: {pageInfo: {hasNextPage: false}, nodes: [comment]}})).reviewRecords.approvals).toHaveLength(1);
    const changed = {pageInfo: {hasNextPage: false}, nodes: [opinion({state: 'CHANGES_REQUESTED'})]};
    expect(row(node({latestOpinionatedReviews: changed})).reviewRecords.approvals).toEqual([]);
    expect(row(node({timelineItems: history([request(), request({id: 'RRE_2', createdAt: at(6)})])})).reviewRecords.approvals[0].request.id).toBe('RRE_1');
    const dismissal = {__typename: 'ReviewDismissedEvent', id: 'RDE_1', createdAt: at(7), actor, review: {id: 'PRR_1'}};
    expect(row(node({timelineItems: history([request(), dismissal])})).reviewRecords.approvals).toEqual([]);
    expect(row(node({headRefOid: 'h2'})).reviewRecords.approvals[0]).toMatchObject({commit: HEAD, onHead: false});
});

test('history coverage never substitutes current-request or current-opinion coverage', () => {
    for (const timelineItems of [undefined, history([], true), {nodes: [], pageInfo: {}}, history([request({createdAt: 'invalid'})]), history([request({createdAt: '0'})])]) {
        const value = row(node({timelineItems}));
        expect(value.partial).toBe(false);
        expect(value.reviewRecords.approvals[0].requestState).toBe('unknown');
        const last = sequence([value])[0];
        const result = projectOpenWork({snapshot: last, observedAt: at(20), coverage: 'complete'}, {now: () => Date.parse(at(21))});
        expect(result.coverage).toBe('complete');
        expect(result.awaitingMerge[0].holder.role).toBe('operator');
    }
    const partialOpinion = row(node({latestOpinionatedReviews: {nodes: [], pageInfo: {hasNextPage: true}}}));
    expect(partialOpinion.reviewRecords).toMatchObject({opinionsComplete: false, approvals: []});
});

test('a shifted window retains only an exact current-approval witness and never fills a history gap', () => {
    const suffix = history([request({id: 'OTHER', createdAt: at(8), requestedReviewer: {...reviewer, id: 'U_OTHER'}})], true);
    const [first, second] = sequence([row(), row(node({timelineItems: suffix}))]);
    const packet = second.rows[`${REPO}#7`].reviewRecords;
    expect(packet.historyCoverage).toBe('partial');
    expect(packet.events.map(item => item.id)).toEqual(['OTHER']);
    expect(packet.approvals[0]).toMatchObject({requestState: 'paired', request: {id: 'RRE_1'}});
    expect(first.transitions).toEqual([]);
    expect(second.transitions).toEqual([]);
    const restored = JSON.parse(JSON.stringify(second));
    const third = reduceOpenWork({previous: restored, observed: {rows: [row(node({timelineItems: suffix}))], complete: true},
        terminal: {rows: [], complete: true}, since: null, id: at(22)});
    expect(third.rows[`${REPO}#7`].reviewRecords).toEqual(packet);
});

test('removed, replaced and foreign-source evidence cannot inherit a cached pair', () => {
    const suffix = history([], true), initial = row();
    for (const value of [
        row(node({latestOpinionatedReviews: {nodes: [], pageInfo: {hasNextPage: false}}, timelineItems: suffix})),
        row(node({latestOpinionatedReviews: {nodes: [opinion({id: 'PRR_NEW'})], pageInfo: {hasNextPage: false}}, timelineItems: suffix})),
        row(node({id: 'PR_OTHER', timelineItems: suffix})),
        row(node({repository: {nameWithOwner: 'acme/other'}, timelineItems: suffix})),
        row(node({timelineItems: suffix}), 'https://forge.example/api')
    ]) {
        const packet = sequence([initial, value])[1].rows[value.key].reviewRecords;
        expect(packet.approvals.every(item => item.request === null)).toBe(true);
    }
    const removed = row(node({timelineItems: history([request({__typename: 'ReviewRequestRemovedEvent', id: 'REMOVED', createdAt: at(3)})], true)}));
    expect(sequence([initial, removed])[1].rows[`${REPO}#7`].reviewRecords.approvals[0].requestState).toBe('removed');
});

test('approval after a re-request pairs that request rather than the earlier change-request round', () => {
    const changed = row(node({latestOpinionatedReviews: {nodes: [opinion({state: 'CHANGES_REQUESTED', submittedAt: at(3)})], pageInfo: {hasNextPage: false}}}));
    const approved = row(node({timelineItems: history([request(), request({id: 'RRE_NEW', createdAt: at(4)})]),
        latestOpinionatedReviews: {nodes: [opinion({id: 'PRR_NEW', submittedAt: at(7)})], pageInfo: {hasNextPage: false}}}));
    const packet = sequence([changed, approved])[1].rows[approved.key].reviewRecords;
    expect(packet.approvals[0]).toMatchObject({id: 'PRR_NEW', requestState: 'paired', request: {id: 'RRE_NEW'}});
});

test('packet-only changes are silent while a real verdict change still emits one transition', () => {
    const revised = row(node({timelineItems: history([request({actor: {...actor, login: 'renamed-author'}})], true)}));
    const [, metadata, verdict] = sequence([row(), revised, {...revised, verdict: 'CHANGES_REQUESTED'}]);
    expect(metadata.transitions).toEqual([]);
    expect(verdict.transitions.map(item => item.kind)).toEqual(['verdict']);
});

test('the existing producer supplies provider scope and persists bounded witnesses across reload', async () => {
    let saved = null, value = node(), time = 20;
    const store = {load: () => saved, save: state => saved = JSON.parse(JSON.stringify(state))};
    const options = {
        identities, store, repos: async () => [REPO], now: () => new Date(at(time++)),
        readers: async () => [{seat: '@author', login: 'author', apiBase: API,
            query: async (text, variables) => ({rateLimit: {cost: 1}, search: {
                nodes: text === OPEN_WORK_SNAPSHOT && variables.query.includes('author:author') ? [value] : [],
                pageInfo: {hasNextPage: false}
            }})}]
    };
    const first = await createOpenWorkProducer(options).pulse();
    expect(first.snapshot.rows[`${REPO}#7`].reviewRecords.approvals[0].request.id).toBe('RRE_1');
    value = node({timelineItems: history([], true)});
    const second = await createOpenWorkProducer(options).pulse();
    expect(second.coverage).toBe('complete');
    expect(second.snapshot.rows[`${REPO}#7`].reviewRecords).toMatchObject({historyCoverage: 'partial', approvals: [{requestState: 'paired'}]});
    expect(second.transitions).toEqual([]);
    expect(projectOpenWork(second, {now: () => Date.parse(at(22))}).awaitingMerge[0].reviewRecords.approvals[0].id).toBe('PRR_1');
    expect(openWorkQueryCost(OPEN_WORK_SNAPSHOT).formulaCost).toBe(3);
});

test('provider page bounds cap retained facts without certifying an evicted prefix', () => {
    const events = Array.from({length: 25}, (_, i) => request({id: `RRE_${i}`, createdAt: at(i), requestedReviewer: {...reviewer, id: `U_${i}`}}));
    const opinions = Array.from({length: 25}, (_, i) => opinion({id: `PRR_${i}`, author: {...reviewer, id: `U_${i}`}, submittedAt: at(30)}));
    const packet = row(node({timelineItems: history(events), latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: opinions}})).reviewRecords;
    expect(packet.events).toHaveLength(20);
    expect(packet.approvals).toHaveLength(20);
    expect(packet.historyCoverage).toBe('partial');
    expect(packet.opinionsComplete).toBe(false);
    const held = sequence([row(), row(node({timelineItems: history([], true), latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: opinions}}))])[1];
    expect(held.rows[`${REPO}#7`].reviewRecords.approvals).toHaveLength(20);
});

test('partial original history leaves the same current-review wake eligible', () => {
    const current = {reviewDecision: 'REVIEW_REQUIRED',
        reviewRequests: {nodes: [{requestedReviewer: reviewer}], pageInfo: {hasNextPage: false}},
        latestReviews: {nodes: [], pageInfo: {hasNextPage: false}}, latestOpinionatedReviews: {nodes: [], pageInfo: {hasNextPage: false}}};
    const pending = row(node({...current, commits: {nodes: [{commit: {oid: HEAD, statusCheckRollup: {state: 'PENDING'}}}]}}));
    const [baseline, ready] = sequence([pending, row(node(current))]);
    const envelope = (snapshot, second) => ({snapshot, observedAt: at(second), coverage: 'complete', transitions: []});
    const ledger = planOpenWorkWakes({state: envelope(baseline, 20), ledger: null, now: Date.parse(at(20))}).ledger;
    const ordinary = planOpenWorkWakes({state: envelope(ready, 21), ledger, now: Date.parse(at(21))});
    const partial = sequence([pending, row(node({...current, timelineItems: history([], true)}))])[1];
    const incompleteHistory = planOpenWorkWakes({state: envelope(partial, 21), ledger, now: Date.parse(at(21))});
    expect(ordinary.wakes).toHaveLength(1);
    expect(incompleteHistory).toEqual(ordinary);
});
