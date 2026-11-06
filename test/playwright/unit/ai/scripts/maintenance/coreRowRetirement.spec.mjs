import {test, expect} from '@playwright/test';
import {
    applyCoreRowRetirement,
    readCollectionIds,
    validateCoreRetirementPlan
} from '../../../../../../ai/scripts/maintenance/coreRowRetirement.mjs';
import {
    fingerprint,
    metadataFingerprint
} from '../../../../../../ai/scripts/maintenance/coreRowRetirementPlan.mjs';

const scope = {tenantId: 'test-shared', repoSlug: 'legacy-core'};

/** @summary Seals a plan independently of the planner, for executor boundary tests. */
function seal(body) {
    return {...body, planDigest: fingerprint(body)};
}

/** @summary A captured old population, its replacement, and two unrelated preservation controls. */
function fixture({onDelete, onPersist} = {}) {
    const old  = id => ({id, metadata: {...scope, type: 'src', source: 'src/Fact.mjs', name: 'Fact', content: 'same fact', hash: id}});
    const rows = [
        old('old-a'), old('old-b'),
        {id: 'replacement', metadata: {...scope, repoSlug: 'current-core', extractionIdentity: 'e'.repeat(64), type: 'src', source: 'src/Fact.mjs', name: 'Fact', content: 'same fact', hash: 'replacement'}},
        {id: 'concept', metadata: {...scope, type: 'concept', source: 'concept/Fact.md', content: 'must stay'}},
        {id: 'foreign', metadata: {tenantId: 'other', repoSlug: 'other', type: 'src', content: 'must stay'}}
    ];
    const store      = new Map(rows.map(row => [row.id, structuredClone(row.metadata)]));
    const census     = rows.map(row => ({...structuredClone(row), metadataDigest: metadataFingerprint(row.metadata)}));
    const censusById = new Map(census.map(row => [row.id, row]));
    const ids        = rows.map(row => row.id).sort();
    const preserved  = ids.filter(id => !id.startsWith('old-'));
    const candidates = ['old-a', 'old-b'].map(id => ({
        id, metadataDigest: censusById.get(id).metadataDigest,
        replacements: [{
            repoSlug: 'current-core',
            ids     : ['replacement'],
            rows    : [{id: 'replacement', metadataDigest: censusById.get('replacement').metadataDigest}]
        }]
    }));
    const plan = seal({
        schemaVersion: 'neo.legacy-core-retirement/v1',
        binding      : {collectionId: 'fixture-collection', scope, protectedIds: [], populationIdDigest: fingerprint(ids)},
        census, censusDigest: fingerprint(census), candidates,
        retirementIds: ['old-a', 'old-b'],
        preservation : {ids: preserved, count: preserved.length, digest: fingerprint(preserved)},
        refusals     : [], executable: true
    });
    let   progress   = null, deletes = 0, gets = 0;
    const calls      = [];
    const collection = {
        id: 'fixture-collection',
        async count() {return store.size;},
        async get({ids: selected, include, limit, offset = 0}) {
            gets++;
            const hits = [...store].filter(([id]) => !selected || selected.includes(id)).slice(offset, offset + limit);
            return {ids: hits.map(([id]) => id), metadatas: include.includes('metadatas') ? hits.map(([, metadata]) => structuredClone(metadata)) : null};
        },
        async delete({ids: selected}) {
            deletes++;
            calls.push([...selected]);
            expect(progress.pending).toEqual(selected);
            if (onDelete) return onDelete({store, ids: selected, calls: deletes});
            selected.forEach(id => store.delete(id));
        }
    };
    const options = {
        collection, plan, confirmation: plan.planDigest, pageSize: 1,
        revalidate   : async () => plan.planDigest,
        readProgress : async () => structuredClone(progress),
        writeProgress: async value => {
            await onPersist?.(value);
            progress = structuredClone(value);
        }
    };
    return {store, plan, options, calls, get progress() {return progress;}, get deletes() {return deletes;}, get gets() {return gets;}};
}

test('only the frozen old IDs retire and the exact preservation population remains', async () => {
    const f       = fixture(), before = structuredClone([...f.store]);
    const receipt = await applyCoreRowRetirement(f.options);
    expect(f.calls).toEqual([['old-a'], ['old-b']]);
    expect([...f.store.keys()].sort()).toEqual(f.plan.preservation.ids);
    for (const [id, metadata] of before.filter(([id]) => !id.startsWith('old-'))) expect(f.store.get(id)).toEqual(metadata);
    expect(receipt).toMatchObject({complete: true, retiredConfirmed: 2, pendingCount: 0, alreadyComplete: false});
    expect(receipt.preservation).toEqual({count: f.plan.preservation.count, digest: f.plan.preservation.digest});
});

test('confirmation binds the exact plan before collection or journal access', async () => {
    const f = fixture();
    await expect(applyCoreRowRetirement({...f.options, confirmation: 'some-other-plan'})).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_UNCONFIRMED');
    expect(f.gets).toBe(0);
    expect(f.deletes).toBe(0);
    expect(f.progress).toBeNull();
});

test('a caller mutating its original plan during revalidation cannot extend the delete set', async () => {
    const f              = fixture();
    const originalDigest = f.plan.planDigest;
    const receipt        = await applyCoreRowRetirement({...f.options, revalidate: async captured => {
        expect(captured).not.toBe(f.plan);
        f.plan.retirementIds.push('foreign');
        return originalDigest;
    }});
    expect(receipt.complete).toBe(true);
    expect(f.calls).toEqual([['old-a'], ['old-b']]);
    expect(f.store.has('foreign')).toBe(true);
});

test('revalidation cannot mutate the captured plan before deletion', async () => {
    const f = fixture();
    await expect(applyCoreRowRetirement({...f.options, revalidate: async captured => {
        captured.retirementIds.push('foreign');
        return captured.planDigest;
    }})).rejects.toMatchObject({code: 'KB_CORE_RETIRE_INTERRUPTED', receipt: {stage: 'revalidate'}});
    expect(f.deletes).toBe(0);
    expect(f.progress).toBeNull();
    expect(f.store.has('foreign')).toBe(true);
});

test('the persistence callback cannot add a protected ID to the pending delete batch', async () => {
    const f = fixture({onPersist(value) {
        if (value.pending.length) value.pending.push('foreign');
    }});
    await expect(applyCoreRowRetirement(f.options)).rejects.toMatchObject({
        code: 'KB_CORE_RETIRE_INTERRUPTED', receipt: {stage: 'persist-pending'}
    });
    expect(f.deletes).toBe(0);
    expect(f.store.has('foreign')).toBe(true);
});

test('retained journal snapshots stay immutable while internal progress advances', async () => {
    const snapshots = [];
    const f         = fixture({onPersist(value) {snapshots.push(value);}});
    await applyCoreRowRetirement(f.options);
    const pending = snapshots.find(value => value.pending.length);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.pending)).toBe(true);
    expect(pending.pending).toEqual(['old-a']);
    expect(pending.confirmed).toEqual([]);
    expect(f.progress.complete).toBe(true);
});

test('a changed input proof refuses before persisting progress or deleting', async () => {
    const f = fixture();
    await expect(applyCoreRowRetirement({...f.options, revalidate: async () => 'changed-manifest-or-map'})).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_PROOF_CHANGED');
    expect(f.deletes).toBe(0);
    expect(f.progress).toBeNull();
});

for (const mutation of ['missing', 'content']) {
    test('a replacement ' + mutation + ' change refuses even when the caller reports the same proof digest', async () => {
        const f = fixture();
        mutation === 'missing' ? f.store.delete('replacement') : f.store.get('replacement').content = 'changed fact';
        await expect(applyCoreRowRetirement(f.options)).rejects.toHaveProperty('code',
            mutation === 'missing' ? 'KB_CORE_RETIRE_POPULATION_CHANGED' : 'KB_CORE_RETIRE_REPLACEMENT_CHANGED');
        expect(f.deletes).toBe(0);
        expect(f.progress).toBeNull();
    });
}

test('a non-candidate seeded into a re-sealed plan still refuses before store access', async () => {
    const f = fixture(), {planDigest, ...body} = structuredClone(f.plan);
    body.retirementIds.push('concept');
    body.candidates.push({id: 'concept', metadataDigest: body.census.find(row => row.id === 'concept').metadataDigest, replacements: body.candidates[0].replacements});
    body.retirementIds.sort();
    body.preservation.ids = body.preservation.ids.filter(id => id !== 'concept');
    body.preservation.count--;
    body.preservation.digest = fingerprint(body.preservation.ids);
    expect(() => validateCoreRetirementPlan(seal(body))).toThrow('KB_CORE_RETIRE_PROTECTED_CANDIDATE');
    expect(f.deletes).toBe(0);
    expect(f.gets).toBe(0);
});

test('a deleted pending batch with a lost acknowledgement is adopted by read, never replayed', async () => {
    const f = fixture({
        onDelete({store, ids, calls}) {
            ids.forEach(id => store.delete(id));
            if (calls === 2) throw new Error('lost acknowledgement');
        }
    });
    await expect(applyCoreRowRetirement(f.options)).rejects.toMatchObject({
        code   : 'KB_CORE_RETIRE_INTERRUPTED',
        receipt: {stage: 'delete', retiredConfirmed: 1, pendingCount: 1}
    });
    expect(f.progress.pending).toEqual(['old-b']);
    const resumed = await applyCoreRowRetirement(f.options);
    expect(resumed).toMatchObject({complete: true, retiredConfirmed: 2, pendingCount: 0});
    expect(f.deletes).toBe(2);
    expect(f.progress.complete).toBe(true);
});

test('a partially applied pending batch retries only the still-present captured IDs', async () => {
    const f = fixture({
        onDelete({store, ids, calls}) {
            if (calls === 1) {
                store.delete(ids[0]);
                throw new Error('partial application');
            }
            ids.forEach(id => store.delete(id));
        }
    });
    const options = {...f.options, pageSize: 2};
    await expect(applyCoreRowRetirement(options)).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_INTERRUPTED');
    await applyCoreRowRetirement(options);
    expect(f.calls).toEqual([['old-a', 'old-b'], ['old-b']]);
    expect(f.progress.confirmed).toEqual(['old-a', 'old-b']);
});

test('pending persistence failure authorizes zero deletes', async () => {
    const f = fixture({onPersist(value) {if (value.pending.length) throw new Error('cannot persist accepted batch');}});
    await expect(applyCoreRowRetirement(f.options)).rejects.toMatchObject({
        code: 'KB_CORE_RETIRE_INTERRUPTED', receipt: {stage: 'persist-pending', retiredConfirmed: 0}
    });
    expect(f.deletes).toBe(0);
    expect(f.store.has('old-a')).toBe(true);
    expect(f.progress.pending).toEqual([]);
});

for (const phase of ['confirmed', 'complete']) {
    test('a lost ' + phase + ' journal acknowledgement resumes without repeating confirmed deletes', async () => {
        let   fail = true;
        const f    = fixture({onPersist(value) {
            const reached = phase === 'complete' ? value.complete : value.confirmed.length === 1 && !value.pending.length;
            if (fail && reached) {
                fail = false;
                throw new Error('journal write acknowledgement unavailable');
            }
        }});
        await expect(applyCoreRowRetirement(f.options)).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_INTERRUPTED');
        const before = f.calls.map(ids => [...ids]);
        await applyCoreRowRetirement(f.options);
        expect(f.calls.flat()).toEqual(['old-a', 'old-b']);
        expect(f.calls.slice(0, before.length)).toEqual(before);
        expect(f.progress).toMatchObject({complete: true, confirmed: ['old-a', 'old-b']});
    });
}

test('changed old metadata and a foreign population change both refuse before deletion', async () => {
    const a = fixture();
    a.store.get('old-a').content = 'changed';
    await expect(applyCoreRowRetirement(a.options)).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_OLD_ROW_CHANGED');
    expect(a.deletes).toBe(0);
    const b = fixture();
    b.store.delete('foreign');
    await expect(applyCoreRowRetirement(b.options)).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_POPULATION_CHANGED');
    expect(b.deletes).toBe(0);
});

test('post-delete preservation failure is explicit and never triggers an automatic restore', async () => {
    const f = fixture({
        onDelete({store, ids, calls}) {
            ids.forEach(id => store.delete(id));
            if (calls === 2) store.delete('foreign');
        }
    });
    await expect(applyCoreRowRetirement(f.options)).rejects.toMatchObject({
        code: 'KB_CORE_RETIRE_PRESERVATION_CHANGED', receipt: {stage: 'preservation', complete: false}
    });
    expect(f.calls.flat()).toEqual(['old-a', 'old-b']);
    expect(f.progress.complete).toBe(false);
});

test('replacement metadata changing during deletion cannot produce a completed receipt from equal ID populations', async () => {
    const f = fixture({onDelete({store, ids, calls}) {
        ids.forEach(id => store.delete(id));
        if (calls === 2) store.get('replacement').content = 'changed while applying';
    }});
    await expect(applyCoreRowRetirement(f.options)).rejects.toMatchObject({
        code: 'KB_CORE_RETIRE_REPLACEMENT_CHANGED', receipt: {stage: 'replacement-preservation', complete: false}
    });
    expect([...f.store.keys()].sort()).toEqual(f.plan.preservation.ids);
    expect(f.progress.complete).toBe(false);
});

test('a completed retry performs no delete; a resurrected confirmed ID refuses', async () => {
    const f = fixture();
    await applyCoreRowRetirement(f.options);
    const retry = await applyCoreRowRetirement(f.options);
    expect(retry.alreadyComplete).toBe(true);
    expect(f.deletes).toBe(2);
    f.store.set('old-a', structuredClone(f.plan.census.find(row => row.id === 'old-a').metadata));
    await expect(applyCoreRowRetirement(f.options)).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_POPULATION_CHANGED');
    expect(f.deletes).toBe(2);
});

test('invalid page sizes refuse before a paginated read can loop', async () => {
    const f = fixture();
    await expect(readCollectionIds(f.options.collection, 0)).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_PAGE_SIZE_INVALID');
    expect(f.gets).toBe(0);
});
