import {setup} from '../../../../setup.mjs';

setup({appConfig: {name: 'ReviewFamilyProjectionCompositionTest'}});

import {test, expect}                    from '@playwright/test';
import fs                                from 'node:fs';
import os                                from 'node:os';
import path                              from 'node:path';
import childProcess                      from 'node:child_process';
import {syncBuiltinESMExports}           from 'node:module';
import {promisify}                       from 'node:util';
import Neo                               from 'neo.mjs/src/Neo.mjs';
import * as core                         from 'neo.mjs/src/core/_export.mjs';
import AiConfig                          from '../../../../../../ai/config.template.mjs';
import {Orchestrator}                    from '../../../../../../ai/daemons/orchestrator/Orchestrator.mjs';
import GoldenPathSynthesizer             from '../../../../../../ai/services/graph/GoldenPathSynthesizer.mjs';
import GraphqlService                    from '../../../../../../ai/services/github-workflow/GraphqlService.mjs';
import {compileFoundingFamilySeed}       from '../../../../../../ai/graph/identityFoundingSeed.mjs';
import {createIdentityPublicationClient} from '../../../../../../ai/services/shared/identityPublicationClient.mjs';
import {collectFocusV1Projection, createFocusV1ProjectionReader, renderFocusV1Section}
    from '../../../../../../ai/services/graph/focusV1Section.mjs';
import {renderRecentOpenPrSummary} from '../../../../../../ai/services/graph/activePrCycleSection.mjs';
import {snapshotAiConfig}          from '../memory-core/util.mjs';

const NOW     = '2026-11-16T17:00:00.000Z', HEAD = 'a'.repeat(40);
const TARGET  = {planeId: 'projection-fixture', dataRoot: '/fixture/projection'};
const VIEWER  = {__typename: 'User', databaseId: 10, login: 'fixture-viewer'};
const subject = id => ({authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: String(id)});

/** @summary Builds a complete founding-only carrier, independent of static roster logins. */
function snapshot() {
    const founding = compileFoundingFamilySeed({
        identities: [[20, 'gpt'], [30, 'claude']].map(([id, family]) => ({id: '@projection-' + id,
            type: 'AgentIdentity', properties: {accountType: 'agent', modelFamily: family}})),
        subjects: [20, 30].map(id => ({identityKey: '@projection-' + id, subject: subject(id)}))
    });
    return {version: 1, target: TARGET, revision: 1, baselineSince: 0, founding, foundingRevision: 1,
        foundingProvenance: {sourceRevision: 'fixture', installedAt: 1, issuer: 'fixture-fleet', lineageHead: 'identity-family-lineage-head-' + 'b'.repeat(64)},
        counts            : {subjects: 2, admittedSubjects: 0, memberships: 0, declarations: 0, corrections: 0},
        subjects          : [20, 30].map(id => ({subject: subject(id), membershipRevision: 0, admissionRevision: 0, bindings: [],
            source: {baselineSince: 0, revision: 1, memberships: [], declarations: [], corrections: []}}))};
}

/** @summary Supplies complete otherwise-ready GitHub connections for the real readiness acquisition. */
function pullRequest(number = 7) {
    return {number, title: 'Qualified projection', url: 'https://github.com/example/repo/pull/' + number,
        state         : 'OPEN', mergedAt: null, baseRefName: 'dev', headRefOid: HEAD, createdAt: '2026-11-16T10:00:00.000Z',
        updatedAt     : '2026-11-16T16:00:00.000Z', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', isDraft: false,
        author        : {__typename: 'User', databaseId: 20, login: 'unrostered-author'}, authorAssociation: 'MEMBER', body: '',
        commitMessages: {nodes: [], pageInfo: {hasNextPage: false}},
        reviews       : {nodes: [{state: 'APPROVED', author: {__typename: 'User', databaseId: 30, login: 'unrostered-reader'},
            submittedAt: '2026-11-16T16:00:00.000Z', commit: {oid: HEAD}}], pageInfo: {hasPreviousPage: false}},
        reviewRequests: {nodes: [], pageInfo: {hasNextPage: false}}, comments: {nodes: [], pageInfo: {hasPreviousPage: false}},
        commits       : {nodes: [{commit: {oid: HEAD, statusCheckRollup: {contexts: {nodes: [], totalCount: 0, pageInfo: {hasNextPage: false}}}}}]}};
}

test.describe('qualified family projection production composition', () => {
    test.describe.configure({mode: 'serial'});
    let restoreConfig, originalAcquire, originalExecFile, directory, orchestrator, calls;

    test.beforeEach(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-projection-composition-'));
        restoreConfig = snapshotAiConfig(AiConfig, {
            'seat.planeBase'                                        : 'https://plane.fixture.example', 'seat.planeBearer': 'fixture-only',
            'seat.planeTarget'                                      : [TARGET.planeId, TARGET.dataRoot],
            'orchestrator.localOnly.goldenPathRepoEnrichmentEnabled': true
        });
        originalAcquire = GraphqlService.createOperationClient;
        originalExecFile = childProcess.execFile;
        calls = {acquisitions: 0, queries: 0, rules: 0, tools: [], clients: [], closes: 0};
        GraphqlService.createOperationClient = async () => {
            calls.acquisitions++;
            return {source: {authProvider: 'github', providerBaseUrl: 'https://api.github.com'},
                query: async (query, variables) => {
                    calls.queries++;
                    expect(variables.owner).toBe('example'); expect(variables.repo).toBe('repo');
                    return {viewer: VIEWER, repository: {pullRequest: pullRequest(), pullRequests: {nodes: [pullRequest(), pullRequest(8)]}}};
                },
                rest: async (method, route) => {
                    calls.rules++;
                    expect(method).toBe('GET'); expect(route).toContain('/repos/example/repo/rules/branches/dev');
                    return [];
                }};
        };
        orchestrator = Neo.create(Orchestrator, {dataDir: directory, logFile: null});
        orchestrator.authorityProfile = 'host-edge';
        await orchestrator.ready();
    });

    test.afterEach(() => {
        orchestrator?.destroy();
        GraphqlService.createOperationClient = originalAcquire;
        childProcess.execFile = originalExecFile;
        syncBuiltinESMExports();
        restoreConfig?.();
        fs.rmSync(directory, {recursive: true, force: true});
    });

    /** @summary Keeps the real daemon reader and registered client; substitutes only the remote MCP session. */
    function installPlane(mode) {
        orchestrator.readFamilySource = viewer => Orchestrator.prototype.readFamilySource.call(orchestrator, viewer, {
            createClient: options => {
                calls.clients.push(options);
                return createIdentityPublicationClient({...options, createSession: () => ({
                    client: {async connect() {}, async close() {calls.closes++;}, async callTool({name}) {
                        calls.tools.push(name);
                        let payload;
                        if (name === 'list_permissions') payload = {identity: mode === 'wrong-identity' ? '@other' : '@fixture-viewer'};
                        else if (name === 'healthcheck') payload = {plane: {id: mode === 'wrong-plane' ? 'other-plane' : TARGET.planeId, dataRoot: TARGET.dataRoot}};
                        else {
                            expect(name).toBe('get_identity_publication_snapshot');
                            payload = mode === 'fenced' ? {state: 'unavailable', code: 'publication-restore-fenced'} :
                                {state: 'available', snapshot: snapshot()};
                        }
                        return {structuredContent: payload};
                    }}, transport: {async terminateSession() {}}
                })});
            }
        });
    }

    for (const mode of ['available', 'fenced', 'wrong-plane', 'wrong-identity', 'unconfigured', 'malformed-target']) {
        test(`host collector writes and renders the ${mode} source through its actual composed readers`, async () => {
            installPlane(mode);
            if (mode === 'unconfigured') snapshotAiConfig(AiConfig, {'seat.planeBearer': ''});
            if (mode === 'malformed-target') snapshotAiConfig(AiConfig, {'seat.planeTarget': []});
            orchestrator.initFocusV1ProjectionCollector();
            const collect = orchestrator.focusV1ProjectionCollector;
            expect(collect).toBe(collectFocusV1Projection);
            orchestrator.focusV1ProjectionCollector = options => collect({...options,
                readV1Rows      : async () => ({rows: []}), readViewsReceipts: async () => ({receipts: []}),
                readReachTraffic: async () => ({stars: 5}), readPrivateLedger: async () => ({rows: []}),
                execGh          : async args => {
                    expect(args.slice(0, 2)).toEqual(['search', 'prs']);
                    return JSON.stringify([{number: 7, repository: {nameWithOwner: 'example/repo'}, url: pullRequest().url}]);
                }});
            const projectionPath = path.join(directory, 'projection.json');
            const written        = await orchestrator.refreshFocusV1ProjectionIfDue(Date.parse(NOW), {projectionPath, outboundLedgerPath: ''});
            expect(written.projectionPath).toBe(projectionPath);
            const inputs     = await createFocusV1ProjectionReader({projectionPath}).readFocusV1Inputs({now: new Date(NOW)});
            const projection = inputs.operatorWord.candidates[0].projection;
            const rendered   = renderFocusV1Section(inputs);
            expect(calls.acquisitions).toBe(1); expect(calls.queries).toBe(2); expect(calls.rules).toBe(2);
            if (mode === 'unconfigured' || mode === 'malformed-target') {
                expect(calls.clients).toHaveLength(0);
                expect(calls.tools).toHaveLength(0);
            } else {
                expect(calls.clients[0]).toMatchObject({expectedIdentity: '@fixture-viewer', expectedTarget: TARGET,
                    credential: 'fixture-only', baseUrl: 'https://plane.fixture.example/mc/mcp'});
                expect(calls.closes).toBe(1);
            }
            expect(projection.marker).toBeUndefined();
            expect(projection.certification.outcome).toBe('read-only-observation');
            if (mode === 'available') {
                expect(projection.familyVerdict).toMatchObject({sourceState: 'available', qualified: true, crossFamily: true});
                expect(rendered).toContain('`ready for the operator`');
                expect(calls.tools.filter(name => name === 'get_identity_publication_snapshot')).toHaveLength(1);
            } else {
                expect(projection.verdict).toBe('unavailable');
                expect(projection.familyVerdict.qualified).toBe(false);
                expect(rendered).toContain('readiness unverified: ' + projection.familyVerdict.code);
                expect(rendered).not.toContain('`ready for the operator`');
                if (mode.startsWith('wrong-')) expect(calls.tools).not.toContain('get_identity_publication_snapshot');
            }
            expect(inputs.reach.stars).toBe(5);
        });
    }

    for (const mode of ['available', 'wrong-plane']) {
        test(`GoldenPath actual fetch qualifies every row from one ${mode} snapshot`, async () => {
            installPlane(mode);
            childProcess.execFile = (command, args, options, callback) => {
                expect(command).toBe('gh'); expect(args).toEqual(['repo', 'view', '--json', 'nameWithOwner']);
                callback(null, JSON.stringify({nameWithOwner: 'example/repo'}), '');
            };
            childProcess.execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
                childProcess.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({stdout, stderr}));
            });
            syncBuiltinESMExports();
            const rows = await GoldenPathSynthesizer.fetchOpenPRs({readFamilySource: viewer => orchestrator.readFamilySource(viewer), now: new Date(NOW)});
            expect(rows).toHaveLength(2);
            expect(calls.acquisitions).toBe(1); expect(calls.queries).toBe(1); expect(calls.rules).toBe(0);
            expect(calls.clients).toHaveLength(1); expect(calls.closes).toBe(1);
            const rendered = renderRecentOpenPrSummary(rows, {limit: 5});
            if (mode === 'available') {
                expect(rows.every(row => row.familyVerdict.crossFamily === true)).toBe(true);
                expect(calls.tools.filter(name => name === 'get_identity_publication_snapshot')).toHaveLength(1);
                expect(rendered.match(/cross-family reviewed: yes/g)).toHaveLength(2);
            } else {
                expect(rows.every(row => row.familyVerdict.qualified === false)).toBe(true);
                expect(rendered.match(/cross-family reviewed: unavailable/g)).toHaveLength(2);
                expect(calls.tools).not.toContain('get_identity_publication_snapshot');
            }
        });
    }
});
