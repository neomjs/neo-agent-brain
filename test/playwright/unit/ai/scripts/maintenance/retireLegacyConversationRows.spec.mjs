import {setup} from '../../../../setup.mjs';

setup({
    appConfig: {
        name: 'AiRetireLegacyConversationRowsTest'
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

import {
    APPLY_CONFIRMATION_TOKEN,
    buildRetirementPlan,
    failureReport,
    runRetirement
} from '../../../../../../ai/scripts/maintenance/retireLegacyConversationRows.mjs';

const scope = {tenantId: 'neo-shared', repoSlug: 'neo'};

/**
 * @summary The ingestion authority's observation of the canonical corpus: configured, accepted, current.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function corpus(overrides = {}) {
    return {
        repoSlug          : 'github-content-sync',
        extractionIdentity: 'identity-1',
        manifest          : {
            source            : 'graph',
            updatedAt         : 1700000000000,
            extractionSnapshot: {extractionIdentity: 'identity-1', proof: {attemptId: 'attempt-1', envelopeDigest: 'digest-1', recordedAt: 1700000000001}}
        },
        ...overrides
    }
}

/**
 * @summary Evaluates the subset of Chroma `where` operators the script emits.
 * @param {Object} metadata
 * @param {Object} where
 * @returns {Boolean}
 */
function matches(metadata, where) {
    if (where.$and) {
        return where.$and.every(clause => matches(metadata, clause))
    }

    const [[key, condition]] = Object.entries(where),
          value              = metadata[key];

    if ('$eq' in condition) return value === condition.$eq;
    if ('$in' in condition) return condition.$in.includes(value);

    throw new Error(`unsupported where: ${JSON.stringify(where)}`)
}

/**
 * @summary An in-memory stand-in for a Chroma collection: paged `get` and `delete` by ids.
 * @param {Object[]} rows `{id, ...metadata}`
 * @param {Object}   [hooks]
 * @param {Function} [hooks.onDelete] Replaces the default delete; receives the store, the ids and the call number.
 * @param {Function} [hooks.onGet] Runs before each get; receives the call number.
 * @returns {Object}
 */
function fakeCollection(rows, {onDelete, onGet} = {}) {
    const store = new Map(rows.map(({id, ...metadata}) => [id, metadata]));

    let deletes = 0,
        gets    = 0;

    return {
        store,
        get deletes() {return deletes},
        async get({where, include = [], limit, offset = 0}) {
            onGet?.(++gets);

            const hits = [...store].filter(([, metadata]) => matches(metadata, where)).slice(offset, offset + limit);

            return {
                ids      : hits.map(([id]) => id),
                metadatas: include.includes('metadatas') ? hits.map(([, metadata]) => metadata) : null
            }
        },
        async delete({ids}) {
            deletes++;
            onDelete ? onDelete(store, ids, deletes) : ids.forEach(id => store.delete(id))
        }
    }
}

/**
 * @summary The plane's shape in miniature: frozen mirror rows and code rows under the default stamp, the
 * corpus tenant's conversation rows, an unrelated repository with conversation rows, and another tenant.
 * @param {Object}  [options]
 * @param {Boolean} [options.withCorpusRows=true]
 * @returns {Object[]}
 */
function planeRows({withCorpusRows = true} = {}) {
    return [
        {id: 'legacy-ticket-1', tenantId: 'neo-shared', repoSlug: 'neo', type: 'ticket',     source: 'resources/content/issues/chunk-1/issue-1.md'},
        {id: 'legacy-ticket-2', tenantId: 'neo-shared', repoSlug: 'neo', type: 'ticket',     source: 'resources/content/archive/v12/issues/issue-2.md'},
        {id: 'legacy-pull-1',   tenantId: 'neo-shared', repoSlug: 'neo', type: 'pull',       source: 'resources/content/pulls/chunk-1/pr-3.md'},
        {id: 'legacy-disc-1',   tenantId: 'neo-shared', repoSlug: 'neo', type: 'discussion', source: 'resources/content/discussions/chunk-1/discussion-4.md'},
        {id: 'engine-src-1',    tenantId: 'neo-shared', repoSlug: 'neo', type: 'src',        source: 'src/component/Base.mjs'},
        {id: 'engine-concept',  tenantId: 'neo-shared', repoSlug: 'neo', type: 'concept',    source: 'resources/content/concepts/reactivity.md'},
        {id: 'engine-test-1',   tenantId: 'neo-shared', repoSlug: 'neo', type: 'test',       source: 'test/playwright/unit/Foo.spec.mjs'},
        ...(withCorpusRows ? [{id: 'corpus-ticket-1', tenantId: 'neo-shared', repoSlug: 'github-content-sync', type: 'ticket', source: 'neo/issues/chunk-1/issue-1.md'}] : []),
        {id: 'unrelated-ticket', tenantId: 'neo-shared', repoSlug: 'unrelated-repository', type: 'ticket', source: 'issues/issue-7.md'},
        {id: 'other-ticket-1',   tenantId: 'acme',       repoSlug: 'neo',                  type: 'ticket', source: 'resources/content/issues/issue-9.md'}
    ]
}

const apply = {apply: true, confirmation: APPLY_CONFIRMATION_TOKEN};

test.describe('retireLegacyConversationRows.mjs', () => {
    test('a dry run reports the stamp and the replacement evidence, and deletes nothing', async () => {
        const collection = fakeCollection(planeRows()),
              receipt    = await runRetirement({collection, scope, replacement: corpus(), pageSize: 2});

        expect(receipt.apply).toBe(false);
        expect(receipt.before).toEqual({scopeTotal: 7, preserved: 3, conversationByType: {ticket: 2, pull: 1, discussion: 1}});
        expect(receipt.replacement).toEqual({
            repoSlug : 'github-content-sync', manifestUpdatedAt: 1700000000000, extractionIdentity: 'identity-1',
            attemptId: 'attempt-1', envelopeDigest: 'digest-1', recordedAt: 1700000000001
        });
        expect(receipt.refusals).toEqual([]);
        expect(collection.deletes).toBe(0)
    });

    test('apply without the confirmation token refuses before reading', async () => {
        const collection = fakeCollection(planeRows());

        await expect(runRetirement({collection, scope, replacement: corpus(), apply: true, confirmation: 'yes'}))
            .rejects.toMatchObject({code: 'KB_LEGACY_RETIRE_UNCONFIRMED'});
        expect(collection.deletes).toBe(0)
    });

    test('with the canonical corpus, apply retires exactly the stamp\'s conversation rows and proves the preserved count', async () => {
        const collection = fakeCollection(planeRows()),
              receipt    = await runRetirement({collection, scope, replacement: corpus(), pageSize: 2, ...apply});

        expect(receipt.retired).toBe(4);
        expect(receipt.after).toEqual({scopeTotal: 3, preserved: 3, conversation: 0});
        expect([...collection.store.keys()].sort()).toEqual([
            'corpus-ticket-1', 'engine-concept', 'engine-src-1', 'engine-test-1', 'other-ticket-1', 'unrelated-ticket'
        ])
    });

    test('an unrelated repository\'s conversation rows do not stand in for the corpus', async () => {
        const collection = fakeCollection(planeRows({withCorpusRows: false})),
              receipt    = await runRetirement({collection, scope, replacement: corpus(), ...apply});

        expect(receipt.refusals.map(refusal => refusal.code)).toEqual(['KB_LEGACY_RETIRE_NO_REPLACEMENT_CORPUS']);
        expect(collection.deletes).toBe(0)
    });

    for (const [name, replacement, code] of [
        ['an unreadable corpus configuration',         {error: 'graph unavailable'},                                         'KB_LEGACY_RETIRE_CORPUS_UNREADABLE'],
        ['no configured corpus repository',            {repoSlug: null},                                                     'KB_LEGACY_RETIRE_CORPUS_UNCONFIGURED'],
        ['a corpus that resolves to the legacy stamp', corpus({repoSlug: 'neo'}),                                            'KB_LEGACY_RETIRE_CORPUS_IS_LEGACY_STAMP'],
        ['a corpus without an accepted manifest',      corpus({manifest: {source: 'empty', extractionSnapshot: null}}),      'KB_LEGACY_RETIRE_CORPUS_MANIFEST_ABSENT'],
        ['a manifest from another extraction profile', corpus({extractionIdentity: 'identity-2'}),                           'KB_LEGACY_RETIRE_CORPUS_MANIFEST_STALE']
    ]) {
        test(`${name} refuses with zero deletes`, async () => {
            const collection = fakeCollection(planeRows()),
                  receipt    = await runRetirement({collection, scope, replacement, ...apply});

            expect(receipt.refusals.map(refusal => refusal.code)).toEqual([code]);
            expect(collection.deletes).toBe(0)
        })
    }

    test('a selected row outside resources/content/ refuses the run without deleting', async () => {
        const rows       = [...planeRows(), {id: 'mistyped-code', tenantId: 'neo-shared', repoSlug: 'neo', type: 'ticket', source: 'src/manager/Ticket.mjs'}],
              collection = fakeCollection(rows),
              plan       = await buildRetirementPlan({collection, scope, replacement: corpus()});

        expect(plan.refusals.map(refusal => refusal.code)).toEqual(['KB_LEGACY_RETIRE_SOURCE_OUTSIDE_LEGACY_ROOT']);
        expect(plan.refusals[0].sample).toEqual([{id: 'mistyped-code', type: 'ticket', source: 'src/manager/Ticket.mjs'}]);
        expect(collection.deletes).toBe(0)
    });

    test('a second delete page that rejects leaves the partial receipt on the error and in the CLI report', async () => {
        const collection = fakeCollection(planeRows(), {
            onDelete(store, ids, call) {
                if (call === 2) throw new Error('INJECTED_PAGE_FAILURE');
                ids.forEach(id => store.delete(id))
            }
        });

        const error  = await runRetirement({collection, scope, replacement: corpus(), pageSize: 2, ...apply}).catch(e => e),
              report = failureReport(error);

        expect(error.code).toBe('KB_LEGACY_RETIRE_INTERRUPTED');
        expect(report.receipt.retired).toBe(2);
        expect(report.receipt.failure).toEqual({stage: 'delete', confirmedPages: 1, uncertainRows: 2, message: 'INJECTED_PAGE_FAILURE'});
        expect(collection.store.has('legacy-ticket-1')).toBe(false);
        expect(collection.store.has('legacy-pull-1')).toBe(true)
    });

    test('a recount that fails after every page is confirmed still reports the retired rows', async () => {
        let deletesDone = false;

        const collection = fakeCollection(planeRows(), {
            onDelete(store, ids) {
                ids.forEach(id => store.delete(id));
                deletesDone = true
            },
            onGet() {
                if (deletesDone) throw new Error('INJECTED_RECOUNT_FAILURE')
            }
        });

        const error = await runRetirement({collection, scope, replacement: corpus(), ...apply}).catch(e => e);

        expect(error.code).toBe('KB_LEGACY_RETIRE_INTERRUPTED');
        expect(failureReport(error).receipt).toMatchObject({retired: 4, after: null, failure: {stage: 'recount', message: 'INJECTED_RECOUNT_FAILURE'}})
    });

    test('a delete that takes a preserved row fails loud with the receipt', async () => {
        const collection = fakeCollection(planeRows(), {
            onDelete(store, ids) {
                ids.forEach(id => store.delete(id));
                store.delete('engine-src-1')
            }
        });

        const error = await runRetirement({collection, scope, replacement: corpus(), ...apply}).catch(e => e);

        expect(error.code).toBe('KB_LEGACY_RETIRE_PRESERVATION_VIOLATED');
        expect(failureReport(error).receipt.after).toEqual({scopeTotal: 2, preserved: 2, conversation: 0})
    })
});
