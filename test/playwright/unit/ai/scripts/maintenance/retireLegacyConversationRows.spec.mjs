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
    runRetirement
} from '../../../../../../ai/scripts/maintenance/retireLegacyConversationRows.mjs';

const scope = {tenantId: 'neo-shared', repoSlug: 'neo'};

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
    if ('$ne' in condition) return value !== condition.$ne;
    if ('$in' in condition) return condition.$in.includes(value);

    throw new Error(`unsupported where: ${JSON.stringify(where)}`)
}

/**
 * @summary An in-memory stand-in for a Chroma collection: paged `get` and `delete` by ids.
 * @param {Object[]} rows `{id, ...metadata}`
 * @param {Function} [onDelete] Replaces the default delete, for the preservation-violation arm.
 * @returns {Object}
 */
function fakeCollection(rows, onDelete) {
    const store = new Map(rows.map(({id, ...metadata}) => [id, metadata]));

    return {
        store,
        async get({where, include = [], limit, offset = 0}) {
            const hits = [...store].filter(([, metadata]) => matches(metadata, where)).slice(offset, offset + limit);

            return {
                ids      : hits.map(([id]) => id),
                metadatas: include.includes('metadatas') ? hits.map(([, metadata]) => metadata) : null
            }
        },
        async delete({ids}) {
            onDelete ? onDelete(store, ids) : ids.forEach(id => store.delete(id))
        }
    }
}

/**
 * @summary The plane's shape in miniature: frozen mirror rows and code rows under the default stamp,
 * the corpus tenant's conversation rows, the Brain profile and another tenant.
 * @returns {Object[]}
 */
function planeRows() {
    return [
        {id: 'legacy-ticket-1', tenantId: 'neo-shared', repoSlug: 'neo', type: 'ticket',     source: 'resources/content/issues/chunk-1/issue-1.md'},
        {id: 'legacy-ticket-2', tenantId: 'neo-shared', repoSlug: 'neo', type: 'ticket',     source: 'resources/content/archive/v12/issues/issue-2.md'},
        {id: 'legacy-pull-1',   tenantId: 'neo-shared', repoSlug: 'neo', type: 'pull',       source: 'resources/content/pulls/chunk-1/pr-3.md'},
        {id: 'legacy-disc-1',   tenantId: 'neo-shared', repoSlug: 'neo', type: 'discussion', source: 'resources/content/discussions/chunk-1/discussion-4.md'},
        {id: 'engine-src-1',    tenantId: 'neo-shared', repoSlug: 'neo', type: 'src',        source: 'src/component/Base.mjs'},
        {id: 'engine-concept',  tenantId: 'neo-shared', repoSlug: 'neo', type: 'concept',    source: 'resources/content/concepts/reactivity.md'},
        {id: 'engine-test-1',   tenantId: 'neo-shared', repoSlug: 'neo', type: 'test',       source: 'test/playwright/unit/Foo.spec.mjs'},
        {id: 'corpus-ticket-1', tenantId: 'neo-shared', repoSlug: 'github-content-sync', type: 'ticket', source: 'neo/issues/chunk-1/issue-1.md'},
        {id: 'brain-src-1',     tenantId: 'neo-shared', repoSlug: 'neo-agent-brain',     type: 'src',    source: 'ai/Agent.mjs'},
        {id: 'other-ticket-1',  tenantId: 'acme',       repoSlug: 'neo',                 type: 'ticket', source: 'resources/content/issues/issue-9.md'}
    ]
}

test.describe('retireLegacyConversationRows.mjs', () => {
    test('a dry run reports the stamp and deletes nothing', async () => {
        const collection = fakeCollection(planeRows()),
              receipt    = await runRetirement({collection, scope, pageSize: 2});

        expect(receipt.apply).toBe(false);
        expect(receipt.before).toEqual({scopeTotal: 7, preserved: 3, conversationByType: {ticket: 2, pull: 1, discussion: 1}});
        expect(receipt.refusals).toEqual([]);
        expect(receipt.retired).toBe(0);
        expect(collection.store.size).toBe(10)
    });

    test('apply without the confirmation token refuses before reading', async () => {
        const collection = fakeCollection(planeRows());

        await expect(runRetirement({collection, scope, apply: true, confirmation: 'yes'}))
            .rejects.toMatchObject({code: 'KB_LEGACY_RETIRE_UNCONFIRMED'});
        expect(collection.store.size).toBe(10)
    });

    test('apply retires exactly the stamp\'s conversation rows and proves the preserved count', async () => {
        const collection = fakeCollection(planeRows()),
              receipt    = await runRetirement({collection, scope, apply: true, confirmation: APPLY_CONFIRMATION_TOKEN, pageSize: 2});

        expect(receipt.retired).toBe(4);
        expect(receipt.after).toEqual({scopeTotal: 3, preserved: 3, conversation: 0});
        expect([...collection.store.keys()].sort()).toEqual([
            'brain-src-1', 'corpus-ticket-1', 'engine-concept', 'engine-src-1', 'engine-test-1', 'other-ticket-1'
        ])
    });

    test('a selected row outside resources/content/ refuses the run without deleting', async () => {
        const rows = [...planeRows(), {id: 'mistyped-code', tenantId: 'neo-shared', repoSlug: 'neo', type: 'ticket', source: 'src/manager/Ticket.mjs'}],
              collection = fakeCollection(rows),
              receipt    = await runRetirement({collection, scope, apply: true, confirmation: APPLY_CONFIRMATION_TOKEN});

        expect(receipt.refusals.map(refusal => refusal.code)).toEqual(['KB_LEGACY_RETIRE_SOURCE_OUTSIDE_LEGACY_ROOT']);
        expect(receipt.refusals[0].sample).toEqual([{id: 'mistyped-code', type: 'ticket', source: 'src/manager/Ticket.mjs'}]);
        expect(receipt.retired).toBe(0);
        expect(collection.store.size).toBe(11)
    });

    test('without replacement conversation rows elsewhere in the tenant the run refuses', async () => {
        const collection = fakeCollection(planeRows().filter(row => row.repoSlug !== 'github-content-sync')),
              plan       = await buildRetirementPlan({collection, scope});

        expect(plan.refusals.map(refusal => refusal.code)).toEqual(['KB_LEGACY_RETIRE_NO_REPLACEMENT_CORPUS'])
    });

    test('a delete that takes a preserved row fails loud with the receipt', async () => {
        const collection = fakeCollection(planeRows(), (store, ids) => {
            ids.forEach(id => store.delete(id));
            store.delete('engine-src-1')
        });

        const error = await runRetirement({collection, scope, apply: true, confirmation: APPLY_CONFIRMATION_TOKEN}).catch(e => e);

        expect(error.code).toBe('KB_LEGACY_RETIRE_PRESERVATION_VIOLATED');
        expect(error.receipt.after).toEqual({scopeTotal: 2, preserved: 2, conversation: 0})
    })
});
