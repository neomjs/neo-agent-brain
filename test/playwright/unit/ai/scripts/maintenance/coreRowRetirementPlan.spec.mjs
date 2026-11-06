import {test, expect}                                                                          from '@playwright/test';
import {parse}                                                                                 from 'acorn';
import {readFileSync}                                                                          from 'node:fs';
import crypto                                                                                  from 'node:crypto';
import {resolveEmbeddingAdmissionBand}                                                         from '../../../../../../ai/embeddingSafeBand.mjs';
import {bytesToTokens}                                                                         from '../../../../../../ai/services/memory-core/helpers/consumerFrictionHelper.mjs';
import {buildEmbeddingInputHeader, buildEmbeddingInputText}                                    from '../../../../../../ai/services/knowledge-base/helpers/embeddingInputFormat.mjs';
import {buildChunkRowMetadata}                                                                 from '../../../../../../ai/services/knowledge-base/helpers/chunkRowMetadata.mjs';
import {buildCoreRowRetirementPlan, coreRowProtectionReason, fingerprint, metadataFingerprint} from '../../../../../../ai/scripts/maintenance/coreRowRetirementPlan.mjs';

const SCOPE = {tenantId: 'fixture-shared-tenant', repoSlug: 'legacy-core'};
const REPOS = ['neo', 'neo-agent-brain'];

/** @summary Exercises actual vector-owner methods without importing its connect-on-init singleton. */
function vectorOwner(split = false) {
    const text  = readFileSync(new URL('../../../../../../ai/services/knowledge-base/VectorService.mjs', import.meta.url), 'utf8');
    const tree  = parse(text, {ecmaVersion: 'latest', sourceType: 'module'});
    const cls   = tree.body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'VectorService');
    const names = ['expandOversizedEmbeddingChunks', 'splitOversizedEmbeddingChunk', 'createSplitChunkHash',
        'splitTextByByteBudget', 'splitLongStringByByteBudget', 'measureEmbeddingInput', 'createTenantAwareChunkId', 'applyTenantStamp'];
    const methods = names.map(name => {
        const node = cls.body.body.find(method => method.key?.name === name);
        if (!node) throw new Error(`Missing vector owner method ${name}`);
        return text.slice(node.start, node.end);
    });
    const owner = new Function('crypto', 'resolveEmbeddingAdmissionBand', 'buildEmbeddingInputHeader', 'bytesToTokens',
        `return ({${methods.join(',\n')}})`)(crypto, resolveEmbeddingAdmissionBand, buildEmbeddingInputHeader, bytesToTokens);
    owner.buildEmbeddingInputText = buildEmbeddingInputText;
    owner.resolveEmbeddingGuardrail = () => ({contextLimitTokens: split ? 256 : 32768, safeProcessingLimitTokens: split ? 256 : 28672});
    owner.validateTenantStamp = () => {}; // Stamping policy is separate; these fixtures pass only server-derived fields.
    return owner;
}

/** @summary Creates physically stored metadata through the real expansion, ID and metadata-writer owners. */
function derivation(split) {
    const owner = vectorOwner(split);
    return (chunk, stamp) => owner.expandOversizedEmbeddingChunks([chunk]).map(child => {
        const stored = owner.applyTenantStamp(child, {...stamp, tenantConfigVersion: 0, ingestedAt: 123});
        return {id: stored.id, metadata: buildChunkRowMetadata(stored)};
    });
}

/** @summary Binds exact artifact bytes and full observed snapshots; only the old tuple has no profile identity. */
function fixture({sharedPath = false, targetRepo = 'neo', split = false, content, description, derive} = {}) {
    const sourcePath       = 'src/Base.mjs', body = content ?? (split ? 'unicode😀 line\n'.repeat(200) : 'return 1;');
    const deriveStoredRows = derive || derivation(split);
    const chunks           = REPOS.map((repoSlug, index) => {
        const relative = repoSlug === targetRepo || sharedPath ? sourcePath : 'src/Other.mjs';
        return {
            type       : repoSlug === 'neo' ? 'src' : 'brain-source', kind: 'method', name: 'Base.run', className: 'Neo.Base',
            content    : body, description: description ?? body, sourcePath: relative,
            source     : repoSlug === 'neo' ? `node_modules/neo.mjs/${relative}` : relative,
            extractorId: 'ApiSource', extractorVersion: '1', extractionIdentity: String(index + 1).repeat(64),
            hash       : String(index + 3).repeat(64), rootKind: repoSlug === 'neo' ? 'neo-workspace' : 'external-source',
            line_start : 10, line_end: 20
        };
    });
    const files     = chunks.map((chunk, index) => ({path: `/fixture/core.${REPOS[index]}.jsonl`, text: `${JSON.stringify(chunk)}\n`}));
    const artifacts = files.map((file, index) => ({
        tenantId          : SCOPE.tenantId, repoSlug: REPOS[index], revision: String(index + 5).repeat(40),
        extractionIdentity: chunks[index].extractionIdentity, path: file.path, sha256: fingerprint(file.text), count: 1
    }));
    const manifestText = JSON.stringify({schemaVersion: 'neo.shared-core-corpus-profiles/v1', artifacts});
    const targetIndex  = REPOS.indexOf(targetRepo), chunk = chunks[targetIndex];
    const legacy       = {id: 'captured-old-id', metadata: {
        tenantId : SCOPE.tenantId, repoSlug: SCOPE.repoSlug, type: 'src', kind: 'method', name: chunk.name,
        className: chunk.className, content: chunk.content, description: chunk.description,
        source   : sourcePath, hash: 'f'.repeat(64), inheritanceChain: '[]', line_start: 1, line_end: 4
    }};
    const target = index => ({
        repoSlug          : REPOS[index], revision: artifacts[index].revision, artifactSha256: artifacts[index].sha256,
        extractionIdentity: artifacts[index].extractionIdentity, source: chunks[index].source, sourcePath: chunks[index].sourcePath,
        type              : chunks[index].type, kind: chunks[index].kind, name: chunks[index].name,
        conversions       : [
            {field: 'source', from: legacy.metadata.source, to: chunks[index].source},
            {field: 'sourcePath', from: null, to: chunks[index].sourcePath},
            {field: 'type', from: legacy.metadata.type, to: chunks[index].type}
        ]
    });
    const entry = {oldId: legacy.id, metadataDigest: metadataFingerprint(legacy.metadata), targets: [target(targetIndex)],
        sourceFamilyAuthority: {citation: 'https://example.invalid/review/419', note: 'Selection is not redundancy proof'}};
    const census = [legacy, ...chunks.flatMap((part, index) => deriveStoredRows(part, {tenantId: SCOPE.tenantId, repoSlug: REPOS[index]})
        .map(row => ({...row, metadata: {...row.metadata, inheritanceChain: '[]'}})))];
    const args = {collectionId: 'fixture-collection-uuid', scope: SCOPE, manifest: {text: manifestText, sha256: fingerprint(manifestText)},
        artifacts: files, census, correspondence: null, deriveStoredRows, protectedIds: ['unfetched-tenant-id']};
    const setEntries = entries => {
        const text = JSON.stringify({entries});
        args.correspondence = {text, sha256: fingerprint(text)};
    };
    setEntries([entry]);
    return {args, legacy, entry, target, chunks, artifacts, setEntries, plan: () => buildCoreRowRetirementPlan(args)};
}

test('an exact all-fields landed replacement certifies a hash-changed legacy ID and binds preservation', () => {
    const f = fixture(), plan = f.plan();
    expect(plan.executable).toBe(true);
    expect(plan.retirementIds).toEqual([f.legacy.id]);
    expect(plan.candidates).toHaveLength(1);
    const replacement = plan.candidates[0].replacements[0];
    expect(replacement.rows).toEqual(replacement.ids.map(id => ({id, metadataDigest: metadataFingerprint(f.args.census.find(row => row.id === id).metadata)})));
    expect(plan.preservation.ids).toContain('unfetched-tenant-id');
    expect(plan.preservation.ids).not.toContain(f.legacy.id);
    expect(plan.preservation.digest).toBe(fingerprint(plan.preservation.ids));
    expect(plan.binding.populationIdDigest).toBe(fingerprint([...plan.preservation.ids, ...plan.retirementIds].sort()));
    expect(plan.candidates[0]).not.toHaveProperty('metadata');
    const {planDigest, ...body} = plan;
    expect(planDigest).toBe(fingerprint(body));
});

test('same-path identical Engine and Brain facts retire with both actual replacement sets', () => {
    const f = fixture({sharedPath: true});
    f.entry.targets.push(f.target(1));
    Object.assign(f.entry, {approved: true, originTrusted: true});
    f.setEntries([f.entry]);
    const plan = f.plan();
    expect(plan.retirementIds).toEqual([f.legacy.id]);
    expect(plan.candidates[0].replacements.map(item => item.repoSlug)).toEqual(REPOS);
    expect(new Set(plan.candidates[0].replacements.flatMap(item => item.ids)).size).toBe(2);
});

test('a missing alternative is reported without blocking a fully landed equal replacement', () => {
    const f = fixture({sharedPath: true});
    f.entry.targets.push(f.target(1));
    f.setEntries([f.entry]);
    f.args.census = f.args.census.filter(row => row.metadata.repoSlug !== 'neo-agent-brain');
    const plan = f.plan();
    expect(plan.executable).toBe(true);
    expect(plan.retirementIds).toEqual([f.legacy.id]);
    expect(plan.candidates[0].replacements).toHaveLength(1);
    expect(plan.candidates[0].alternatives[0].reason).toContain('not landed');
});

test('old Brain path/type changes require the exact declared conversion; no origin flag is consulted', () => {
    const f = fixture({targetRepo: 'neo-agent-brain'});
    f.legacy.metadata.source = 'src/ai/Base.mjs';
    f.entry.metadataDigest = metadataFingerprint(f.legacy.metadata);
    f.entry.targets[0].conversions[0].from = f.legacy.metadata.source;
    f.setEntries([f.entry]);
    expect(f.plan().retirementIds).toEqual([f.legacy.id]);
    f.entry.targets[0].conversions = [];
    f.setEntries([f.entry]);
    expect(f.plan().retirementIds).toEqual([]);
});

test('a generic one-line chunk cannot cross-map to another file outside the reviewed path conversion', () => {
    const f         = fixture();
    const wrongFile = f.target(1);
    wrongFile.conversions = f.entry.targets[0].conversions;
    f.entry.targets = [wrongFile];
    f.setEntries([f.entry]);
    expect(f.plan().retirementIds).toEqual([]);
    expect(f.plan().retained.find(row => row.id === f.legacy.id).alternatives[0].reason).toContain('payload differs');
});

for (const field of ['content', 'params', 'unknownMeaningField']) {
    test(`changed ${field} retains rather than accepting name/path/hash agreement`, () => {
        const f = fixture();
        f.legacy.metadata[field] = 'changed meaning';
        f.entry.metadataDigest = metadataFingerprint(f.legacy.metadata);
        f.setEntries([f.entry]);
        expect(f.plan().retirementIds).toEqual([]);
        expect(f.plan().executable).toBe(true);
    });
}

test('actual landed inheritance enrichment participates in equality but extra fields do not break artifact validation', () => {
    const f = fixture();
    expect(f.plan().retirementIds).toEqual([f.legacy.id]);
    f.args.census.find(row => row.id !== f.legacy.id && row.metadata.repoSlug === 'neo').metadata.inheritanceChain = '[{"className":"DifferentParent"}]';
    expect(f.plan().retirementIds).toEqual([]);
    f.legacy.metadata.inheritanceChain = '[{"className":"DifferentParent"}]';
    f.entry.metadataDigest = metadataFingerprint(f.legacy.metadata);
    f.setEntries([f.entry]);
    expect(f.plan().retirementIds).toEqual([f.legacy.id]);
});

test('real owner split children reassemble contiguous Unicode content and preserve actual names and ranges', () => {
    const f = fixture({split: true}), plan = f.plan();
    expect(plan.retirementIds).toEqual([f.legacy.id]);
    expect(plan.candidates[0].replacements[0].ids.length).toBeGreaterThan(1);
    const children = plan.candidates[0].replacements[0].ids;
    f.args.census = f.args.census.filter(row => row.id !== children[1]);
    expect(f.plan().retirementIds).toEqual([]);
});

test('same stored target ID with tampered body is not a landed replacement', () => {
    const f = fixture({split: true});
    f.args.census.find(row => row.id !== f.legacy.id).metadata.content = 'tampered';
    expect(f.plan().retirementIds).toEqual([]);
});

test('a derivation accidentally omitting a child cannot certify a partial reassembly', () => {
    const actual = derivation(true);
    const f      = fixture({split: true, derive: (chunk, stamp) => actual(chunk, stamp).slice(0, -1)});
    const plan   = f.plan();
    expect(plan.retirementIds).toEqual([]);
    expect(plan.retained.find(row => row.id === f.legacy.id).alternatives[0].reason).toContain('Split');
});

for (const field of ['oversizedSplitCharStart', 'name', 'description']) {
    test(`split reassembly rejects invalid ${field} even when adapter and observed rows agree`, () => {
        const actual = derivation(true);
        const f      = fixture({split: true, derive: (chunk, stamp) => actual(chunk, stamp).map((row, index) => index ? row : ({...row, metadata: {...row.metadata,
            [field]: field === 'oversizedSplitCharStart' ? 1 : 'invalid'}}))});
        expect(f.plan().retirementIds).toEqual([]);
    });
}

test('split overwrite cannot fill an original lost description from the unlanded artifact', () => {
    const f    = fixture({split: true, description: 'A distinct description not present in any child. '.repeat(200)});
    const plan = f.plan();
    expect(plan.retirementIds).toEqual([]);
    expect(plan.retained.find(row => row.id === f.legacy.id).alternatives[0].reason).toContain('not reconstructible');
});

test('coordinates and timestamps are provenance, while the original snapshots remain byte-bound', () => {
    const f      = fixture();
    const target = f.args.census.find(row => row.id !== f.legacy.id);
    target.metadata.line_start = 999;
    target.metadata.line_end = 1000;
    target.metadata.ingestedAt = 456;
    const plan = f.plan();
    expect(plan.retirementIds).toEqual([f.legacy.id]);
    expect(plan.census.find(row => row.id === target.id).metadata.line_start).toBe(999);
    expect(plan.candidates[0].replacements[0].rows[0].metadataDigest).toBe(metadataFingerprint(target.metadata));
});

test('forbidden old families, foreign rows, fresh profiles and explicitly protected IDs refuse globally', () => {
    const f             = fixture();
    const protectedRows = ['ticket', 'pull', 'discussion', 'concept', 'skill', 'release', 'ReleaseNote', 'unknown-family'].map(type => ({
        id: `keep-${type}`, metadata: {...f.legacy.metadata, type}
    }));
    protectedRows.push({id: 'foreign', metadata: {...f.legacy.metadata, tenantId: 'other'}});
    protectedRows.push(f.args.census.find(row => row.id !== f.legacy.id));
    f.args.census.push(...protectedRows.slice(0, -1));
    f.args.protectedIds.push('protected-no-metadata');
    f.setEntries([...protectedRows.map(row => ({...f.entry, oldId: row.id, metadataDigest: metadataFingerprint(row.metadata)})),
        {...f.entry, oldId: 'protected-no-metadata'}]);
    const plan = f.plan();
    expect(plan.executable).toBe(false);
    expect(plan.refusals).toHaveLength(protectedRows.length + 1);
    expect(plan.retirementIds).toEqual([]);
    expect(coreRowProtectionReason(f.legacy.metadata, SCOPE)).toBe(null);
    expect(coreRowProtectionReason({...f.legacy.metadata, type: 'release'}, SCOPE)).toBe('PROTECTED_FAMILY');
});

test('a forbidden replacement attempt blocks the whole plan even beside a proven alternative', () => {
    const f = fixture();
    f.entry.targets.push({...f.target(1), type: 'concept'});
    f.setEntries([f.entry]);
    const plan = f.plan();
    expect(plan.candidates).toHaveLength(1);
    expect(plan.refusals[0].code).toBe('FORBIDDEN_REPLACEMENT');
    expect(plan.executable).toBe(false);
});

test('a foreign replacement tuple cannot borrow a same-named repository artifact', () => {
    const f = fixture();
    f.entry.targets[0].tenantId = 'foreign-tenant';
    f.setEntries([f.entry]);
    expect(f.plan().executable).toBe(false);
    expect(f.plan().retirementIds).toEqual([]);
});

test('old metadata changes refuse; ordinary unmatched rows remain preserved beside a certified subset', () => {
    const f = fixture();
    f.args.census.push({id: 'unmatched', metadata: {...f.legacy.metadata, source: 'src/NotMapped.mjs'}});
    const plan = f.plan();
    expect(plan.retirementIds).toEqual([f.legacy.id]);
    expect(plan.executable).toBe(true);
    expect(plan.preservation.ids).toContain('unmatched');
    f.legacy.metadata.ingestedAt = 999;
    expect(f.plan().refusals[0].code).toBe('OLD_METADATA_CHANGED');
    expect(f.plan().executable).toBe(false);
});

test('every identity binding rejects stale or tampered bytes and target receipts', () => {
    for (const part of ['manifest', 'correspondence']) {
        const f = fixture();
        f.args[part].text += ' ';
        expect(() => f.plan()).toThrow('bytes');
    }
    const f = fixture();
    f.args.artifacts[0].text += ' ';
    expect(() => f.plan()).toThrow('Artifact bytes');
    const g = fixture();
    g.entry.targets[0].revision = '0'.repeat(40);
    g.setEntries([g.entry]);
    expect(g.plan().retirementIds).toEqual([]);
});

test('a changed replacement fingerprint changes the immutable plan, enabling apply-time refusal', () => {
    const f = fixture(), before = f.plan();
    f.args.census.find(row => row.id !== f.legacy.id).metadata.ingestedAt = 999;
    const after = f.plan();
    expect(after.retirementIds).toEqual(before.retirementIds);
    expect(after.candidates[0].replacements[0].rows).not.toEqual(before.candidates[0].replacements[0].rows);
    expect(after.planDigest).not.toBe(before.planDigest);
});

test('plan order is stable, input bodies appear only in census, and full population is immutable and deduplicated', () => {
    const f = fixture(), before = f.plan();
    f.args.census.reverse();
    f.args.protectedIds.push('unfetched-tenant-id');
    expect(f.plan()).toEqual(before);
    expect(Object.isFrozen(before.census[0].metadata)).toBe(true);
    expect(() => before.retirementIds.push('unproven')).toThrow(TypeError);
    f.legacy.metadata.content = 'input still mutable';
    expect(before.census.find(row => row.id === f.legacy.id).metadata.content).toBe('return 1;');
    const g = fixture();
    g.args.collectionId = 'another-collection';
    expect(g.plan().planDigest).not.toBe(before.planDigest);
});

test('duplicate or uncaptured old IDs cannot imply a stable retirement population', () => {
    const f = fixture();
    f.args.census.push(f.legacy);
    expect(() => f.plan()).toThrow('duplicate census');
    const g = fixture();
    g.setEntries([g.entry, g.entry]);
    expect(() => g.plan()).toThrow('old-ID correspondence');
    const h = fixture();
    h.entry.oldId = 'not-in-census';
    h.setEntries([h.entry]);
    expect(h.plan().executable).toBe(false);
});

test('many captured versions of one fact prepare the same landed replacement only once', () => {
    const f            = fixture(), actual = f.args.deriveStoredRows;
    let   preparations = 0;
    f.args.deriveStoredRows = (...args) => {preparations++; return actual(...args);};
    const entries = [f.entry];
    for (let index = 0; index < 40; index++) {
        const row = {id: `old-version-${index}`, metadata: {...f.legacy.metadata, hash: fingerprint({index})}};
        f.args.census.push(row);
        entries.push({...f.entry, oldId: row.id, metadataDigest: metadataFingerprint(row.metadata)});
    }
    f.setEntries(entries);
    const plan = f.plan();
    expect(plan.retirementIds).toHaveLength(41);
    expect(preparations).toBe(1);
});
