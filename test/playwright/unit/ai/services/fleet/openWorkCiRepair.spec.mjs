import {expect, test}                                                         from '@playwright/test';
import {normalizeCiRepair, retainCiRepairClassification, retainCiRepairTouch} from '../../../../../../ai/services/fleet/openWorkCiRepair.mjs';

const API        = 'https://api.github.com', REPO = 'acme/app', HEAD = 'a'.repeat(40);
const identities = {byLogin: login => login === 'maintainer' ? '@maintainer' : null};
const at         = second => '2026-11-16T10:00:' + String(second).padStart(2, '0') + 'Z';

/** @summary One original provider check, with source identities separate from display names. */
function check(overrides = {}) {
    return {__typename: 'CheckRun', id: 'CHECK_1', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE',
        startedAt: at(1), completedAt: at(2), checkSuite: {app: {id: 'APP_1', slug: 'actions'},
            workflowRun: {workflow: {id: 'WORKFLOW_1', name: 'CI'}}}, ...overrides};
}

/** @summary One source-bound PR observation using the existing query's connections. */
function node(checks = [check()], overrides = {}) {
    return {id: 'PR_7', number: 7, headRefOid: HEAD, repository: {nameWithOwner: REPO},
        comments: {nodes: [], pageInfo: {hasPreviousPage: false}},
        commits : {nodes: [{commit: {oid: HEAD, statusCheckRollup: {state: 'FAILURE',
            contexts: {nodes: checks, pageInfo: {hasNextPage: false}}}}}]}, ...overrides};
}

/** @summary Produces the public marker syntax without supplying maintainer or receipt authority. */
const marker = (key, kind = 'mechanical', head = HEAD) =>
    '<!-- neo-ci-repair-classification:v1 ' + JSON.stringify({head, evidenceKey: key, kind}) + ' -->';

/** @summary Original comment facts, independent of the marker's claims. */
function comment(body, overrides = {}) {
    return {id: 'COMMENT_1', url: 'https://github.com/acme/app/pull/7#issuecomment-1',
        createdAt: at(10), updatedAt: at(10), body, authorAssociation: 'MEMBER',
        author   : {__typename: 'User', id: 'USER_1', login: 'maintainer'}, ...overrides};
}

/** @summary Normalizes a row and joins only the previous admitted witness. */
function row(value, previous = null, options = {}) {
    const current = {head: value.headRefOid, ...normalizeCiRepair(value, options.identities ?? identities, {apiBase: options.apiBase ?? API})};
    current.ciRepairClassification = retainCiRepairClassification(current, previous, options.identities ?? identities);
    if (current.ciRepairRead) current.ciRepairRead = {...current.ciRepairRead,
        touch: retainCiRepairTouch(current, previous, options.identities ?? identities)};
    return current;
}

test('complete original failing evidence has a scoped deterministic fingerprint', () => {
    const first = row(node()), again = row(node());
    expect(first.ciRepairEvidence).toMatchObject({head: HEAD, key: expect.stringMatching(/^[a-f0-9]{64}$/), failedChecks: ['unit']});
    expect(again.ciRepairEvidence).toEqual(first.ciRepairEvidence);
    expect(row(node(), null, {apiBase: 'https://forge.example/api/v3'}).ciRepairEvidence.key).not.toBe(first.ciRepairEvidence.key);
    expect(row(node(undefined, {id: 'PR_OTHER'})).ciRepairEvidence.key).not.toBe(first.ciRepairEvidence.key);
});

test('a verified comment admits only provider-derived maintainer and receipt facts', () => {
    const first = row(node());
    const input = node(undefined, {comments: {nodes: [comment('Next owner: maintainer. Repair the fixture.\n\n' + marker(first.ciRepairEvidence.key))],
        pageInfo: {hasPreviousPage: false}}});
    const classified = row(input);
    expect(classified.ciRepairClassification).toMatchObject({head: HEAD, evidenceKey: first.ciRepairEvidence.key,
        kind: 'mechanical', maintainer: '@maintainer', receiptUrl: 'https://github.com/acme/app/pull/7#issuecomment-1'});
    expect(JSON.stringify(classified)).not.toContain('Repair the fixture');
});

test('H/E1 survives off-page and unknown evidence, recovers E1, then invalidates on E2', () => {
    const first    = row(node()), key = first.ciRepairEvidence.key;
    const admitted = row(node(undefined, {comments: {nodes: [comment(marker(key))], pageInfo: {hasPreviousPage: false}}}));
    const suffix   = {nodes: [comment('Later discussion', {id: 'COMMENT_2', url: 'https://github.com/acme/app/pull/7#issuecomment-2',
        createdAt: at(20), updatedAt: at(20)})], pageInfo: {hasPreviousPage: true}};
    const offPage = row(node(undefined, {comments: suffix}), admitted);
    expect(offPage.ciRepairClassification).toEqual(admitted.ciRepairClassification);
    const unknownNode = node(undefined, {comments: suffix});
    delete unknownNode.commits.nodes[0].commit.statusCheckRollup.contexts;
    const unknown = row(unknownNode, offPage);
    expect(unknown.ciRepairEvidence).toBeNull();
    expect(unknown.ciRepairClassification).toEqual(admitted.ciRepairClassification);
    const recovered = row(node(undefined, {comments: suffix}), JSON.parse(JSON.stringify(unknown)));
    expect(recovered.ciRepairClassification).toEqual(admitted.ciRepairClassification);
    const changed = row(node([check({id: 'CHECK_2', startedAt: at(25), completedAt: at(26)})], {comments: suffix}), recovered);
    expect(changed.ciRepairEvidence.key).not.toBe(key);
    expect(changed.ciRepairClassification).toBeNull();
});

test('admitted touch survives unknown, E2 and withdrawal without carrying classification authority', () => {
    const key      = row(node()).ciRepairEvidence.key;
    const admitted = row(node(undefined, {comments: {nodes: [comment(marker(key))], pageInfo: {hasPreviousPage: false}}}));
    expect(admitted.ciRepairRead.touch).toMatchObject({head: HEAD, commentId: 'COMMENT_1', maintainer: '@maintainer',
        receiptUrl: 'https://github.com/acme/app/pull/7#issuecomment-1', author: {id: 'USER_1', kind: 'User', login: 'maintainer'}});
    expect(admitted.ciRepairRead.touch).not.toHaveProperty('kind');
    expect(admitted.ciRepairRead.touch).not.toHaveProperty('evidenceKey');
    const unknownInput = node();
    delete unknownInput.commits.nodes[0].commit.statusCheckRollup.contexts;
    const unknown = row(unknownInput, admitted);
    expect(unknown.ciRepairEvidence).toBeNull();
    expect(unknown.ciRepairRead.touch).toEqual(admitted.ciRepairRead.touch);
    const changed = row(node([check({id: 'CHECK_2', startedAt: at(20), completedAt: at(21)})]), unknown);
    expect(changed.ciRepairClassification).toBeNull();
    expect(changed.ciRepairRead.touch).toEqual(admitted.ciRepairRead.touch);
    const withdrawn = row(node(undefined, {comments: {nodes: [comment('Withdrawn', {updatedAt: at(25)})],
        pageInfo: {hasPreviousPage: false}}}), admitted);
    expect(withdrawn.ciRepairClassification).toBeNull();
    expect(withdrawn.ciRepairRead.touch).toEqual(admitted.ciRepairRead.touch);
    expect(row(node(undefined, {id: 'OTHER_PR'}), admitted).ciRepairRead.touch).toBeNull();
    expect(row(node(), admitted, {identities: {byLogin: () => '@different'}}).ciRepairRead.touch).toBeNull();
    const stale = row(node(undefined, {comments: {nodes: [comment(marker('f'.repeat(64)))], pageInfo: {hasPreviousPage: false}}}));
    expect(stale.ciRepairRead.touch).toBeNull();
});

test('original failed names are not sanitized or clipped at the producer boundary', () => {
    const name = 'unit\n' + 'x'.repeat(150);
    expect(row(node([check({name})])).ciRepairEvidence.failedChecks).toEqual([name]);
    const checks = Array.from({length: 60}, (_, i) => check({id: 'CHECK_' + i, name: ' job ' + i + ' '}));
    expect(row(node(checks)).ciRepairEvidence.failedChecks).toEqual(checks.map(value => value.name).sort());
});

test('unrelated passing or pending check progress does not change the failing evidence key', () => {
    const passing    = check({id: 'PASS_1', name: 'lint', conclusion: 'SUCCESS'});
    const first      = row(node([check(), passing]));
    const discussion = {nodes: [comment(marker(first.ciRepairEvidence.key))], pageInfo: {hasPreviousPage: false}};
    const admitted   = row(node([check(), passing], {comments: discussion}));
    const pending    = check({id: 'PASS_2', name: 'lint', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null});
    const changed    = row(node([check(), passing, pending], {comments: {nodes: [], pageInfo: {hasPreviousPage: true}}}), admitted);
    expect(changed.ciRepairEvidence.key).toBe(first.ciRepairEvidence.key);
    expect(changed.ciRepairClassification).toEqual(admitted.ciRepairClassification);
    expect(row(node([check(), check({id: 'NEW_FAILURE', name: 'lint'})])).ciRepairEvidence.key)
        .not.toBe(first.ciRepairEvidence.key);
});

test('a short or malformed source head cannot mint classification evidence', () => {
    for (const head of ['h1', 'A'.repeat(40), 'a'.repeat(39), ' '.repeat(40)]) {
        const input = node();
        input.headRefOid = head;
        input.commits.nodes[0].commit.oid = head;
        expect(row(input).ciRepairEvidence).toBeNull();
    }
});

test('fingerprints bind original failing facts and preserve same-name app/workflow separation', () => {
    const baseline = row(node()).ciRepairEvidence.key;
    const variants = [
        check({id: 'OTHER_RUN'}), check({conclusion: 'TIMED_OUT'}),
        check({startedAt: at(0)}), check({completedAt: at(3)}),
        check({checkSuite: {app: {id: 'OTHER_APP', slug: 'actions'}, workflowRun: {workflow: {id: 'WORKFLOW_1', name: 'CI'}}}}),
        check({checkSuite: {app: {id: 'APP_1', slug: 'renamed'}, workflowRun: {workflow: {id: 'WORKFLOW_1', name: 'CI'}}}}),
        check({checkSuite: {app: {id: 'APP_1', slug: 'actions'}, workflowRun: {workflow: {id: 'OTHER_WORKFLOW', name: 'CI'}}}}),
        check({checkSuite: {app: {id: 'APP_1', slug: 'actions'}, workflowRun: {workflow: {id: 'WORKFLOW_1', name: 'Renamed'}}}})
    ];
    for (const value of variants) expect(row(node([value])).ciRepairEvidence.key).not.toBe(baseline);
    const other = check({id: 'OTHER', conclusion: 'SUCCESS', startedAt: at(5), completedAt: at(6),
        checkSuite: {app: {id: 'OTHER_APP', slug: 'actions'}, workflowRun: {workflow: {id: 'WORKFLOW_1', name: 'CI'}}}});
    expect(row(node([check(), other])).ciRepairEvidence.failedChecks).toEqual(['unit']);
    expect(row(node([other, check()])).ciRepairEvidence).toEqual(row(node([check(), other])).ciRepairEvidence);
});

test('latest reruns replace older failures, including a queued run without a start time', () => {
    const queued  = check({id: 'QUEUED', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null});
    const success = check({id: 'SUCCESS', conclusion: 'SUCCESS', startedAt: at(4), completedAt: at(5)});
    expect(row(node([check(), queued])).ciRepairEvidence.failedChecks).toEqual([]);
    expect(row(node([success, check()])).ciRepairEvidence.failedChecks).toEqual([]);
    expect(row(node([check(), success])).ciRepairEvidence).toEqual(row(node([success, check()])).ciRepairEvidence);
    const external = check({checkSuite: {app: {id: 'EXTERNAL', slug: null}, workflowRun: null}});
    expect(row(node([external])).ciRepairEvidence.failedChecks).toEqual(['unit']);
});

test('StatusContext original identity, timestamps and target bind the key', () => {
    const status = {__typename: 'StatusContext', id: 'STATUS_1', context: 'legacy-ci', state: 'FAILURE',
        createdAt: at(1), updatedAt: at(2), targetUrl: 'https://ci.example/run/1'};
    const first = row(node([status])).ciRepairEvidence;
    expect(first.failedChecks).toEqual(['legacy-ci']);
    for (const patch of [{id: 'STATUS_2'}, {updatedAt: at(3)}, {targetUrl: 'https://ci.example/run/2'}, {state: 'ERROR'}]) {
        expect(row(node([{...status, ...patch}])).ciRepairEvidence.key).not.toBe(first.key);
    }
    expect(row(node([status, {...status, id: 'STATUS_2', state: 'SUCCESS', createdAt: at(3), updatedAt: at(4)}]))
        .ciRepairEvidence.failedChecks).toEqual([]);
});

for (const [label, mutate] of [
    ['missing contexts', input => {delete input.commits.nodes[0].commit.statusCheckRollup.contexts;}],
    ['truncated contexts', input => {input.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;}],
    ['unknown coverage', input => {input.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo = {};}],
    ['wrong commit', input => {input.commits.nodes[0].commit.oid = 'b'.repeat(40);}],
    ['missing context id', input => {delete input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].id;}],
    ['unknown context type', input => {input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].__typename = 'Other';}],
    ['missing app identity', input => {delete input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].checkSuite.app.id;}],
    ['invalid provider time', input => {input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].startedAt = 'not-a-time';}],
    ['duplicate context id', input => {input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push(check());}],
    ['non-string name', input => {input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].name = ['unit'];}],
    ['inconsistent queued result', input => {input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].status = 'QUEUED';}],
    ['over-bound contexts', input => {input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes =
        Array.from({length: 101}, (_, i) => check({id: 'CHECK_' + i, name: 'job-' + i}));}]
]) test('unread or malformed evidence refuses: ' + label, () => {
    expect(row(node()).ciRepairEvidence).not.toBeNull();
    const input = node(); mutate(input);
    expect(row(input).ciRepairEvidence).toBeNull();
});

test('ambiguous latest original timestamps refuse rather than selecting by response order', () => {
    const other = check({id: 'TIED', conclusion: 'SUCCESS'});
    expect(row(node([check(), other])).ciRepairEvidence).toBeNull();
    expect(row(node([other, check()])).ciRepairEvidence).toBeNull();
});

for (const [label, wrap] of [
    ['fenced', value => String.fromCharCode(96).repeat(3) + '\n' + value + '\n' + String.fromCharCode(96).repeat(3)],
    ['tilde fenced', value => '~~~text\n' + value + '\n~~~'],
    ['quoted', value => '> ' + value],
    ['indented', value => '    ' + value],
    ['duplicate', value => value + '\n' + value],
    ['nested HTML comment', value => '<!--\n' + value + '\n-->'],
    ['unknown version', value => value.replace(':v1', ':v2')],
    ['extra authority field', value => value.replace('{"head"', '{"maintainer":"@forged","head"')],
    ['duplicate JSON key', value => value.replace('"kind":"mechanical"', '"kind":"content","kind":"mechanical"')],
    ['malformed JSON', value => value.replace('"kind":"mechanical"', '"kind":')],
    ['stale head', value => value.replace(HEAD, 'b'.repeat(40))],
    ['foreign evidence', value => value.replace(/"evidenceKey":"[a-f0-9]+"/, '"evidenceKey":"' + 'f'.repeat(64) + '"')]
]) test('unadmitted marker syntax: ' + label, () => {
    const key   = row(node()).ciRepairEvidence.key;
    const input = node(undefined, {comments: {nodes: [comment(wrap(marker(key)))], pageInfo: {hasPreviousPage: false}}});
    expect(row(input).ciRepairClassification).toBeNull();
    expect(row(input).ciRepairRead.touch).toBeNull();
});

for (const [label, patch] of [
    ['outside association', {authorAssociation: 'CONTRIBUTOR'}],
    ['bot', {author: {id: 'BOT', __typename: 'Bot', login: 'maintainer'}}],
    ['unresolved actor', {author: {id: 'OTHER', __typename: 'User', login: 'outside'}}],
    ['missing original actor id', {author: {__typename: 'User', login: 'maintainer'}}],
    ['foreign repository receipt', {url: 'https://github.com/acme/other/pull/7#issuecomment-1'}],
    ['foreign PR receipt', {url: 'https://github.com/acme/app/pull/8#issuecomment-1'}],
    ['foreign provider receipt', {url: 'https://evil.example/acme/app/pull/7#issuecomment-1'}],
    ['credential-bearing receipt', {url: 'https://name:secret@github.com/acme/app/pull/7#issuecomment-1'}],
    ['review receipt', {url: 'https://github.com/acme/app/pull/7#pullrequestreview-1'}],
    ['missing comment id', {id: null}]
]) test('original commenter authority refuses: ' + label, () => {
    const key    = row(node()).ciRepairEvidence.key;
    const result = row(node(undefined, {comments: {nodes: [comment(marker(key), patch)], pageInfo: {hasPreviousPage: false}}}));
    expect(result.ciRepairClassification).toBeNull();
    expect(result.ciRepairRead.touch).toBeNull();
});

test('visible withdrawal, malformed edit and known deletion revoke classification but retain admitted touch', () => {
    const key      = row(node()).ciRepairEvidence.key;
    const admitted = row(node(undefined, {comments: {nodes: [comment(marker(key))], pageInfo: {hasPreviousPage: false}}}));
    for (const comments of [
        {nodes: [comment('Withdrawn', {updatedAt: at(20)})], pageInfo: {hasPreviousPage: false}},
        {nodes: [comment(marker(key) + '\n' + marker(key), {updatedAt: at(20)})], pageInfo: {hasPreviousPage: false}},
        {nodes: [], pageInfo: {hasPreviousPage: false}},
        {nodes: [comment('Earlier visible comment', {id: 'COMMENT_0', url: 'https://github.com/acme/app/pull/7#issuecomment-2',
            createdAt: at(5), updatedAt: at(5)})], pageInfo: {hasPreviousPage: true}}
    ]) {
        const next = row(node(undefined, {comments}), admitted);
        expect(next.ciRepairClassification).toBeNull();
        expect(next.ciRepairRead.touch).toEqual(admitted.ciRepairRead.touch);
    }
});

test('a visible edited decision is re-admitted only against known current evidence', () => {
    const key      = row(node()).ciRepairEvidence.key;
    const admitted = row(node(undefined, {comments: {nodes: [comment(marker(key))], pageInfo: {hasPreviousPage: false}}}));
    const changed  = node(undefined, {comments: {nodes: [comment(marker(key, 'content'), {updatedAt: at(20)})],
        pageInfo: {hasPreviousPage: false}}});
    expect(row(changed, admitted).ciRepairClassification.kind).toBe('content');
    delete changed.commits.nodes[0].commit.statusCheckRollup.contexts;
    expect(row(changed, admitted).ciRepairClassification).toBeNull();
});

test('new head, provider, PR and resolver identity never inherit classification or touch', () => {
    const key      = row(node()).ciRepairEvidence.key;
    const admitted = row(node(undefined, {comments: {nodes: [comment(marker(key))], pageInfo: {hasPreviousPage: false}}}));
    const offpage  = {nodes: [], pageInfo: {hasPreviousPage: true}};
    const newHead  = node(undefined, {headRefOid: 'b'.repeat(40), comments: offpage});
    newHead.commits.nodes[0].commit.oid = newHead.headRefOid;
    const changes = [
        row(newHead, admitted),
        row(node(undefined, {id: 'PR_OTHER', comments: offpage}), admitted),
        row(node(undefined, {number: 8, comments: offpage}), admitted),
        row(node(undefined, {repository: {nameWithOwner: 'acme/other'}, comments: offpage}), admitted),
        row(node(undefined, {comments: offpage}), admitted, {apiBase: 'https://forge.example/api/v3'}),
        row(node(undefined, {comments: offpage}), admitted, {identities: {byLogin: () => '@different'}})
    ];
    for (const value of changes) {
        expect(value.ciRepairClassification).toBeNull();
        expect(value.ciRepairRead.touch).toBeNull();
    }
});

test('a more recently edited retained witness is not replaced by an older visible decision', () => {
    const key      = row(node()).ciRepairEvidence.key;
    const admitted = row(node(undefined, {comments: {nodes: [comment(marker(key), {updatedAt: at(25)})],
        pageInfo: {hasPreviousPage: false}}}));
    const older = comment(marker(key, 'content'), {id: 'COMMENT_2', url: 'https://github.com/acme/app/pull/7#issuecomment-2',
        createdAt: at(20), updatedAt: at(20)});
    expect(row(node(undefined, {comments: {nodes: [older], pageInfo: {hasPreviousPage: true}}}), admitted)
        .ciRepairClassification).toEqual(admitted.ciRepairClassification);
});

test('equal-time conflicting maintainer decisions remain unclassified', () => {
    const key   = row(node()).ciRepairEvidence.key;
    const other = comment(marker(key, 'content'), {id: 'COMMENT_2', url: 'https://github.com/acme/app/pull/7#issuecomment-2'});
    expect(row(node(undefined, {comments: {nodes: [comment(marker(key)), other], pageInfo: {hasPreviousPage: false}}}))
        .ciRepairClassification).toBeNull();
});

test('native identity spelling follows the existing wake vocabulary and GHES receipt scope', () => {
    const apiBase = 'https://forge.example/api/v3', resolver = {byLogin: () => '@Maintainer.ops_1'};
    const key     = row(node(), null, {apiBase}).ciRepairEvidence.key;
    const value   = row(node(undefined, {comments: {nodes: [comment(marker(key), {
        url: 'https://forge.example/acme/app/pull/7#issuecomment-1'})], pageInfo: {hasPreviousPage: false}}}),
    null, {apiBase, identities: resolver});
    expect(value.ciRepairClassification.maintainer).toBe('@Maintainer.ops_1');
    expect(value.ciRepairRead.touch.maintainer).toBe('@Maintainer.ops_1');
});

test('normalization and retention own their frozen output without freezing source input', () => {
    const input = node();
    const value = row(input);
    expect(Object.isFrozen(value.ciRepairEvidence)).toBe(true);
    expect(Object.isFrozen(value.ciRepairEvidence.failedChecks)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.commits.nodes)).toBe(false);
    expect(input.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].name).toBe('unit');
});
