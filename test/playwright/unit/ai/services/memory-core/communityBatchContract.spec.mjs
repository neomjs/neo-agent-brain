import {setup} from '../../../../setup.mjs';

const appName = 'CommunityBatchContractTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import * as yaml      from 'js-yaml';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {buildZodSchema} from '../../../../../../ai/mcp/validation/openApiValidator.mjs';
import {
    COMMUNITY_COVERAGE_BINDING_SCHEMA, COMMUNITY_GAP_ITEM_SCHEMA,
    bindCommunityCoverage, validateCommunityCoverage, validateCommunityGap
} from '../../../../../../ai/services/memory-core/communityCoverageContract.mjs';
import {
    BATCH_SCHEMA_VERSION, MAX_HOSTED_BATCH_BYTES, MAX_HOSTED_OBSERVATIONS, MAX_PROVIDER_STATE_BYTES,
    canonicalBatchDigest, carriesCredentialMaterial, validateBatch, validateHostedEnvelope,
    occurrenceIdentity, observationDigest
} from '../../../../../../ai/services/memory-core/communityBatchContract.mjs';

/**
 * @summary Contract witnesses for the community-activity-batch.v1 shape: the corruption digest with
 * its ordering decision, the stable occurrence identity, and full-shape validation.
 */
test.describe('community-activity-batch.v1 contract', () => {
    const observation = (entityId, over = {}) => ({
        providerEntityId    : entityId,
        occurrenceKind      : 'issue.opened',
        occurrenceCoordinate: `${entityId}:create`,
        occurredAt          : '2026-07-18T10:00:00Z',
        actorKind           : 'user',
        ...over
    });

    const batch = (over = {}) => ({
        schemaVersion             : BATCH_SCHEMA_VERSION,
        sourceInstanceId          : 'src-1',
        resourceFamily            : 'issues',
        adapterSchemaVersion      : 'github-issue.v1',
        providerStateSchemaVersion: 'gh-state.v1',
        registrationEpoch         : 2,
        baseCheckpointVersion     : 0,
        baseInventoryHash         : null,
        batchId                   : 'batch-1',
        observations              : [observation('e1'), observation('e2')],
        nextProviderState         : {cursor: 'x'},
        nextInventoryHash         : 'inv-1',
        coverage                  : {fromBasis: 'c1', toBasis: 'c9', complete: true},
        ...over
    });

    const hostedEnvelope = (over = {}) => {
        const {sourceInstanceId, registrationEpoch, ...authorityFreeBatch} = batch();

        return {
            source: {
                canonicalProviderHost: 'github.com',
                resourceKind         : 'repository',
                providerResourceId   : 'neomjs/neo'
            },
            batch: authorityFreeBatch,
            ...over
        }
    };

    const openApiDocument = yaml.load(fs.readFileSync(
        new URL('../../../../../../ai/mcp/server/memory-core/openapi.yaml', import.meta.url), 'utf8'
    ));
    const hostedOperation = Object.values(openApiDocument.paths).flatMap(Object.values)
        .find(operation => operation.operationId === 'admit_community_batch');
    const hostedSchema = buildZodSchema(openApiDocument, hostedOperation);

    const envelopeWithGap = gap => {
        const envelope = hostedEnvelope();

        envelope.batch.coverage = {fromBasis: 'c1', toBasis: 'c9', complete: false, gaps: [gap]};

        return envelope
    };

    // ------------------------------------------------------------------ the batch digest ordering

    test('reordering observations yields the SAME digest (retry, not corruption)', () => {
        const forward  = batch(),
              reversed = batch({observations: [...forward.observations].reverse()});

        expect(canonicalBatchDigest(reversed)).toBe(canonicalBatchDigest(forward));
    });

    test('mutating any observation field yields a DIFFERENT digest', () => {
        expect(canonicalBatchDigest(batch({observations: [observation('e1'), observation('e2', {occurrenceKind: 'issue.closed'})]})))
            .not.toBe(canonicalBatchDigest(batch()));
    });

    test('duplicate multiplicity stays digest-visible — normalization sorts, never dedupes', () => {
        expect(canonicalBatchDigest(batch({observations: [observation('e1'), observation('e1')]})))
            .not.toBe(canonicalBatchDigest(batch({observations: [observation('e1')]})));
    });

    test('the opaque nextProviderState and the base/next anchors participate in the digest', () => {
        expect(canonicalBatchDigest(batch({nextProviderState: {cursor: 'y'}}))).not.toBe(canonicalBatchDigest(batch()));
        expect(canonicalBatchDigest(batch({nextInventoryHash: 'inv-2'}))).not.toBe(canonicalBatchDigest(batch()));
        expect(canonicalBatchDigest(batch({resourceFamily: 'pulls'}))).not.toBe(canonicalBatchDigest(batch()));
    });

    // ------------------------------------------------------------------ occurrence identity

    test('occurrence identity is stable across batches and distinct per revision', () => {
        const create = observation('e1'),
              edit   = observation('e1', {occurrenceKind: 'issue.edited', occurrenceCoordinate: 'e1:edit-1'});

        expect(occurrenceIdentity('src-1', create), 'same coordinate -> same identity')
            .toBe(occurrenceIdentity('src-1', {...create}));
        expect(occurrenceIdentity('src-1', edit), 'a revision has its own identity')
            .not.toBe(occurrenceIdentity('src-1', create));
        expect(occurrenceIdentity('src-2', create), 'identity is tenant-source scoped')
            .not.toBe(occurrenceIdentity('src-1', create));
    });

    test('observation digest ignores server policy but tracks content', () => {
        const base = observation('e1');

        expect(observationDigest({...base, attentionDisposition: 'eligible'}), 'server policy is digest-external')
            .toBe(observationDigest(base));
        expect(observationDigest({...base, occurredAt: '2099-01-01T00:00:00Z'})).not.toBe(observationDigest(base));
    });

    // ------------------------------------------------------------------ validation (full v1 shape)

    test('a well-formed v1 batch validates', () => {
        expect(validateBatch(batch())).toEqual({valid: true, errors: []});
    });

    test('provider-neutral parent, state, and association metadata accept absent, null, or non-empty strings', () => {
        expect(validateBatch(batch({observations: [observation('e1', {
            parentProviderEntityId: 'pull-42',
            providerState         : 'CHANGES_REQUESTED',
            sourceAssociation     : 'MEMBER'
        })]}))).toEqual({valid: true, errors: []});
        expect(validateBatch(batch({observations: [observation('e1', {
            parentProviderEntityId: null,
            providerState         : null,
            sourceAssociation     : null
        })]}))).toEqual({valid: true, errors: []});

        const invalid = validateBatch(batch({observations: [observation('e1', {
            parentProviderEntityId: {},
            providerState         : '',
            sourceAssociation     : '   '
        })]}));

        expect(invalid.errors).toEqual(expect.arrayContaining([
            'OBSERVATION_0_PARENTPROVIDERENTITYID_INVALID',
            'OBSERVATION_0_PROVIDERSTATE_INVALID',
            'OBSERVATION_0_SOURCEASSOCIATION_INVALID'
        ]))
    });

    test('a reduced batch missing v1 authority fields is refused', () => {
        const {resourceFamily, baseCheckpointVersion, nextInventoryHash, ...reduced} = batch();
        const {valid, errors}                                                        = validateBatch(reduced);

        expect(valid).toBe(false);
        expect(errors).toEqual(expect.arrayContaining(['BATCH_MISSING_RESOURCEFAMILY', 'BATCH_MISSING_BASECHECKPOINTVERSION', 'BATCH_MISSING_NEXTINVENTORYHASH']));
    });

    test('an unsupported schema version is refused', () => {
        expect(validateBatch(batch({schemaVersion: 'community-activity-batch.v2'})).errors).toContain('BATCH_SCHEMA_VERSION_UNSUPPORTED');
    });

    test('an oversized nextProviderState is refused; prose in it is refused', () => {
        const huge = {blob: 'x'.repeat(MAX_PROVIDER_STATE_BYTES + 10)};
        expect(validateBatch(batch({nextProviderState: huge})).errors).toContain('BATCH_NEXT_PROVIDER_STATE_TOO_LARGE');
        expect(validateBatch(batch({nextProviderState: {title: 'a title'}})).errors).toContain('BATCH_NEXT_PROVIDER_STATE_CARRIES_PROSE_TITLE');
    });

    test('prose on an observation is REFUSED, not silently stripped', () => {
        expect(validateBatch(batch({observations: [observation('e1', {title: 'Crash'})]})).errors).toContain('OBSERVATION_0_CARRIES_PROSE_TITLE');
    });

    test('a connector may not self-assert a server-policy field', () => {
        expect(validateBatch(batch({observations: [observation('e1', {attentionDisposition: 'eligible'})]})).errors)
            .toContain('OBSERVATION_0_ASSERTS_SERVER_POLICY_ATTENTIONDISPOSITION');
    });

    test('an invalid provider actor kind is refused', () => {
        expect(validateBatch(batch({observations: [observation('e1', {actorKind: 'wizard'})]})).errors).toContain('OBSERVATION_0_ACTOR_KIND_INVALID');
    });

    test('a complete window cannot claim gaps, and an incomplete one must', () => {
        expect(validateBatch(batch({coverage: {fromBasis: 'c1', toBasis: 'c9', complete: true, gaps: [{fromBasis: 'c4', toBasis: 'c5'}]}})).errors)
            .toContain('COVERAGE_COMPLETE_CONTRADICTS_GAPS');
        expect(validateBatch(batch({coverage: {fromBasis: 'c1', toBasis: 'c9', complete: false}})).errors)
            .toContain('COVERAGE_INCOMPLETE_WITHOUT_GAPS');
    });

    test('deleted requires explicit provider evidence', () => {
        expect(validateBatch(batch({observations: [observation('e1', {absence: 'deleted'})]})).errors).toContain('OBSERVATION_0_DELETED_WITHOUT_EVIDENCE');
        expect(validateBatch(batch({observations: [observation('e1', {absence: 'deleted', deletionEvidence: {tombstoneId: 't1'}})]})).valid).toBe(true);
    });

    test('missing required identity is refused', () => {
        expect(validateBatch(batch({sourceInstanceId: null})).errors).toContain('BATCH_MISSING_SOURCEINSTANCEID');
        expect(validateBatch(null)).toEqual({valid: false, errors: ['BATCH_NOT_AN_OBJECT']});
    });

    // ------------------------------------------------------------------ hosted authority + volume boundary

    test('hosted gap items use the complete shared closed definition without schema drift', () => {
        expect(openApiDocument.components.schemas.CommunityCoverageGap).toEqual(COMMUNITY_GAP_ITEM_SCHEMA);
        expect(openApiDocument.components.schemas.HostedCommunityCoverage.properties.gaps.items)
            .toEqual({$ref: '#/components/schemas/CommunityCoverageGap'});
    });

    test('hosted and public coverage bindings preserve the full catalogue-derived schema', () => {
        expect(openApiDocument.components.schemas.CommunityCoverageContract).toEqual(COMMUNITY_COVERAGE_BINDING_SCHEMA);

        const {nullable, ...publicBinding} = openApiDocument.components.schemas.CommunityFamilyCoverage.properties.contract;
        expect(nullable).toBe(true);
        expect(publicBinding).toEqual(COMMUNITY_COVERAGE_BINDING_SCHEMA);
    });

    test('prototype property names are unrecognized coverage families without throwing', () => {
        for (const resourceFamily of ['constructor', '__proto__']) {
            const coverage = bindCommunityCoverage('issues', {fromBasis: 'genesis', toBasis: 'end', complete: true});
            coverage.contract.resourceFamily = resourceFamily;
            let result;

            expect(() => { result = validateCommunityCoverage(coverage) }).not.toThrow();
            expect(result).toMatchObject({valid: false, qualified: false, errors: ['COVERAGE_CONTRACT_UNRECOGNIZED']});
        }
    });

    test('null gaps and contradictory acquisition claims cannot qualify a bound declaration', () => {
        const complete = bindCommunityCoverage('issues', {fromBasis: 'genesis', toBasis: 'end', complete: true});
        expect(validateCommunityCoverage(complete)).toMatchObject({valid: true, qualified: true});

        for (const [coverage, error] of [
            [{...complete, gaps: null}, 'COVERAGE_GAPS_NOT_AN_ARRAY'],
            [{...complete, gaps: [{axis: 'comments', issueId: 'I_1'}]}, 'COVERAGE_ACQUISITION_CONTRADICTION'],
            [{...complete, fromBasis: 'resume-cursor'}, 'COVERAGE_WINDOW_NOT_EXHAUSTIVE']
        ]) {
            expect(validateCommunityCoverage(coverage)).toMatchObject({
                valid: false, qualified: false, errors: expect.arrayContaining([error])
            });
        }

        const suffix = bindCommunityCoverage('issues', {fromBasis: 'resume-cursor', toBasis: 'end', complete: true});
        expect(suffix).toMatchObject({complete: false, gaps: [{axis: 'root-traversal', reason: 'not-from-beginning'}]});
        expect(validateCommunityCoverage(suffix)).toMatchObject({valid: true, qualified: false});
    });

    test('a provider declaration must retain the exact required limitation set', () => {
        const complete = bindCommunityCoverage('issues', {fromBasis: 'genesis', toBasis: 'end', complete: true}),
              declarations = complete.providerLimitations;

        for (const providerLimitations of [
            declarations.slice(0, -1),
            [declarations[0], declarations[0], declarations[2]],
            [...declarations, {axis: 'unrecognized-history', reason: 'not-in-contract'}]
        ]) {
            expect(validateCommunityCoverage({...complete, providerLimitations})).toMatchObject({
                valid: false, qualified: false, errors: expect.arrayContaining(['COVERAGE_LIMITATIONS_MISMATCH'])
            });
        }
    });

    test('producer gap evidence survives neutral validation and compiled hosted parsing unchanged', () => {
        const gaps = [
            {axis: 'issues', afterCursor: null},
            {axis: 'issues', afterCursor: 'ISSUES_1'},
            {axis: 'comments', issueId: 'I_1'},
            {axis: 'timeline', issueId: 'I_1'},
            {axis: 'inventory-access', providerEntityId: 'I_hidden'},
            {axis: 'pull-requests', afterCursor: null, reason: 'page-cap'},
            {axis: 'pull-requests', afterCursor: 'ROOT_1', reason: 'page-cap'},
            {axis: 'pull-request-census', reason: 'root-count-mismatch', expected: 2, fetched: 1},
            {axis: 'pull-request-census', reason: 'root-count-mismatch', expected: 2.5, fetched: 0},
            {axis: 'content-edits', pullRequestId: 'PR_1', providerEntityId: 'C_1', reason: 'page-cap'},
            {axis: 'discussion-conversation', discussionId: 'D_1', reason: 'page-cap'},
            {axis: 'review-deletions', reason: 'github-does-not-expose-exhaustive-review-deletion-tombstones'},
            {axis: 'discussion-state-history', reason: 'github-has-no-discussion-lifecycle-connection'}
        ];

        for (const gap of gaps) {
            const envelope = envelopeWithGap(gap), label = JSON.stringify(gap);

            expect(validateCommunityGap(gap), label).toEqual({valid: true, errors: []});
            expect(validateHostedEnvelope(envelope), label).toMatchObject({valid: true, errors: []});
            expect(hostedSchema.parse(envelope).batch.coverage.gaps, label).toEqual([gap]);
        }
    });

    test('legacy optional range items remain valid through the hosted boundary', () => {
        for (const gap of [{fromBasis: 'c4', toBasis: 'c5'}, {fromBasis: 'c4'}, {toBasis: 'c5'}, {}]) {
            const envelope = envelopeWithGap(gap);

            expect(validateCommunityGap(gap)).toEqual({valid: true, errors: []});
            expect(validateHostedEnvelope(envelope)).toMatchObject({valid: true, errors: []});
            expect(hostedSchema.parse(envelope).batch.coverage.gaps).toEqual([gap]);
        }
    });

    test('malformed, unknown and prose gap metadata is refused rather than stripped', () => {
        const gaps = [
            null, [], 'not-an-object',
            {axis: 42}, {reason: null}, {afterCursor: 5},
            {issueId: 1}, {pullRequestId: 1}, {providerEntityId: 1}, {discussionId: 1},
            {fromBasis: null}, {toBasis: []},
            {expected: '2'}, {expected: Number.POSITIVE_INFINITY}, {expected: Number.NaN},
            {fetched: -1}, {fetched: 0.5},
            {axis: 'issues', extra: 1},
            {axis: 'issues', body: 'provider prose must not disappear'},
            {axis: 'issues', title: 'provider prose must not disappear'}
        ];

        for (const gap of gaps) {
            const envelope = envelopeWithGap(gap), label = JSON.stringify(gap);

            expect(validateCommunityGap(gap).valid, label).toBe(false);
            expect(validateHostedEnvelope(envelope).valid, label).toBe(false);
            expect(hostedSchema.safeParse(envelope).success, label).toBe(false);
        }
    });

    test('hosted gap validation leaves the fixed legacy digest and local replay path intact', () => {
        const legacy = {
            ...hostedEnvelope().batch,
            adapterSchemaVersion      : 'github-pull-request.v1',
            baseCheckpointVersion     : 0,
            batchId                   : 'fixture-gap',
            coverage                  : {fromBasis: 'genesis', toBasis: 'c1', complete: true},
            nextInventoryHash         : null,
            nextProviderState         : null,
            observations              : [],
            providerStateSchemaVersion: 'github-pull-request-state.v1',
            registrationEpoch         : 1,
            resourceFamily            : 'pulls',
            sourceInstanceId          : 'legacy-source'
        };

        expect(canonicalBatchDigest(legacy))
            .toBe('sha256:e587a8ae9728064aa1a829051b0719be64092df480943e01990d611da2092db3');

        const legacyGap = {legacyUnknown: 'preserve-replay-structural-path'},
              replay = {...legacy, coverage: {fromBasis: 'genesis', toBasis: 'c1', complete: false, gaps: [legacyGap]}};

        expect(validateBatch(replay)).toEqual({valid: true, errors: []});
        expect(validateHostedEnvelope(envelopeWithGap(legacyGap)).valid).toBe(false);
    });

    test('a hosted envelope carries neutral source identity but no tenant, source id, or epoch', () => {
        expect(validateHostedEnvelope(hostedEnvelope())).toMatchObject({valid: true, errors: []});

        expect(validateHostedEnvelope(hostedEnvelope({tenantId: 'forged'})).errors)
            .toContain('HOSTED_AUTHORITY_FIELDS_FORBIDDEN');
        expect(validateHostedEnvelope(hostedEnvelope({batch: batch()})).errors)
            .toContain('HOSTED_AUTHORITY_FIELDS_FORBIDDEN');

        const nestedForgery = hostedEnvelope();
        nestedForgery.batch.observations[0].tenantId = 'forged';
        expect(validateHostedEnvelope(nestedForgery).errors)
            .toContain('HOSTED_AUTHORITY_FIELDS_FORBIDDEN');
    });

    test('credential-shaped material is refused rather than stripped or echoed', () => {
        const envelope = hostedEnvelope();
        envelope.batch.nextProviderState = {accessToken: 'do-not-store'};

        expect(carriesCredentialMaterial(envelope)).toBe(true);
        expect(validateHostedEnvelope(envelope).errors).toContain('HOSTED_CREDENTIAL_MATERIAL_FORBIDDEN');
    });

    test('hosted validation runs the canonical contract before OpenAPI can strip prose', () => {
        const envelope = hostedEnvelope();
        envelope.batch.observations[0].title = 'must not disappear';

        expect(validateHostedEnvelope(envelope).errors).toContain('OBSERVATION_0_CARRIES_PROSE_TITLE');
    });

    test('hosted ingress enforces both observation-count and serialized-byte bounds', () => {
        const tooMany = hostedEnvelope();
        tooMany.batch.observations = Array.from({length: MAX_HOSTED_OBSERVATIONS + 1}, (_, index) => observation(`e${index}`));

        expect(validateHostedEnvelope(tooMany).errors).toContain('HOSTED_BATCH_OBSERVATIONS_EXCEEDED');

        const tooLarge = hostedEnvelope();
        tooLarge.batch.nextProviderState = {cursor: 'x'.repeat(MAX_HOSTED_BATCH_BYTES)};

        expect(validateHostedEnvelope(tooLarge).errors).toContain('HOSTED_BATCH_BYTES_EXCEEDED');
    });
});
