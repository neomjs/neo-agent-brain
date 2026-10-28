import {setup} from '../../../../setup.mjs';

const appName = 'FocusV1SectionTest';

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

import {Buffer}               from 'node:buffer';
import fs                     from 'node:fs';
import os                     from 'node:os';
import path                   from 'node:path';
import {parseDocument}        from 'yaml';
import {test, expect}         from '@playwright/test';
import Neo                    from 'neo.mjs/src/Neo.mjs';
import * as core              from 'neo.mjs/src/core/_export.mjs';
import {applyHostEdgePosture} from '../../../../../../ai/daemons/orchestrator/hostEdge.mjs';
import McConfigBase           from '../../../../../../ai/mcp/server/memory-core/configBase.mjs';
import {
    HOST_EDGE_STATE_DIR_ENV
} from '../../../../../../src/composition/orchestrator/hostEdgeProfile.mjs';
import {
    CLOUD_PLANE_HOST_EDGE_ABSENT_REASON,
    FOCUS_V1_HEADING,
    FOCUS_V1_MARKER,
    FOCUS_V1_MAX_BYTES,
    FOCUS_V1_PROJECTION_SCHEMA,
    FOCUS_V1_READER_ABSENT_REASON,
    FOCUS_V1_VIEW_KEYS,
    FocusSourceUnavailable,
    collectAndWriteFocusV1Projection,
    collectFocusV1Projection,
    createFocusV1HostEdgeReader,
    createFocusV1ProjectionReader,
    evaluateCandidateMergeReadiness,
    evaluateViewReceipts,
    formatOperatorCandidateLine,
    isCleanNeedsLove,
    makeRefusingFocusV1Reader,
    parseRoadmapV1RowEpics,
    parseRowStateLine,
    parseViewsReceiptComments,
    projectPublicBusinessRows,
    renderFocusV1Section,
    summarizeV1Rows,
    writeFocusV1Projection
} from '../../../../../../ai/services/graph/focusV1Section.mjs';
import {
    headingToSectionSlug,
    splitSandmanHandoffSections
} from '../../../../../../ai/services/memory-core/helpers/sandmanHandoffSections.mjs';

const CAPTURED_AT       = '2026-10-28T03:00:00.000Z';
const CAPTURED_AT_LABEL = '2026-10-28 03:00 UTC';

test.describe('focusV1Section — Sandman handoff ## Focus (v1) producer contract (#957)', () => {
    test('AC-1: renders ## Focus (v1) with focus.v1 marker, four blocks, opening answer lines, and <= 2,000 UTF-8 bytes', () => {
        const section = renderFocusV1Section({
            capturedAt: CAPTURED_AT,
            candidate : '0.2.0+abc1234',
            v1        : {
                asOf     : CAPTURED_AT,
                candidate: '0.2.0+abc1234',
                rows     : [
                    {row: 1, epic: '#364', rawLine: 'Row state: passed — packaged smoke green'},
                    {row: 2, epic: '#501', rawLine: 'Row state: ready — 6/6 leaves closed · plan: run smoke'},
                    {row: 3, epic: '#502', rawLine: 'Row state: passed — seats boot cleanly'},
                    {row: 4, epic: '#503', rawLine: 'Row state: failed — wake socket timeout'},
                    {row: 5, epic: '#504', body: 'Epic description without a row state line'}
                ],
                moduleLines: ['cockpit: ready · bridge: passed']
            },
            views: {
                asOf     : CAPTURED_AT,
                candidate: '0.2.0+abc1234',
                receipts : [
                    {
                        viewKey   : 'fleet',
                        needsLove : 'none observed',
                        buildClass: 'installed 0.2.0',
                        profile   : 'own-mode',
                        observedAt: '2026-10-27T12:00:00Z',
                        seat      : '@neo-opus-vega'
                    },
                    {
                        viewKey         : 'goldenPath',
                        needsLove       : 'route badge contrast in narrow dock',
                        buildClass      : 'installed 0.2.0',
                        profile         : 'own-mode',
                        observedAt      : '2026-10-27T14:00:00Z',
                        seat            : '@neo-gemini-maryam',
                        openDesignLeaves: ['#912']
                    }
                ]
            },
            reach: {
                asOf      : CAPTURED_AT,
                candidate : 'host-edge',
                traffic   : {views: 1840, uniques: 310, delta: 220},
                stars     : {count: 1495, delta: 12},
                forks     : {count: 215, delta: 3},
                publicRows: [
                    {
                        category         : 'social_Posts',
                        publicFlag       : true,
                        count            : 4,
                        lastPostAt       : '2026-10-26',
                        lastInteractionAt: '2026-10-27',
                        repliesWaiting   : 1,
                        overdue          : false,
                        falsifyingQuery  : 'probe:social_Posts'
                    }
                ]
            },
            operatorWord: {
                asOf      : CAPTURED_AT,
                candidate : 'host-edge',
                candidates: [
                    {
                        repo      : 'neomjs/neo-agent-skills',
                        number    : 227,
                        url       : 'https://github.com/neomjs/neo-agent-skills/pull/227',
                        approvedAt: '2026-10-28T02:25:00Z',
                        projection: {verdict: 'ready'}
                    }
                ]
            }
        });

        expect(section.startsWith(`${FOCUS_V1_HEADING}\n`)).toBe(true);
        expect(section).toContain(`<!-- ${FOCUS_V1_MARKER} · captured: ${CAPTURED_AT_LABEL} -->`);
        expect(section).toContain('v1: 2 of 5 rows passed · ready 1 · unknown 1 · failed 1 · missing: r2:ready, r4:failed, r5:unknown');
        expect(section).toContain('views: swept 2 · needing love 1 · unassessed:');
        expect(section).toContain('### v1\n');
        expect(section).toContain('### views\n');
        expect(section).toContain('### reach and outbound\n');
        expect(section).toContain("### what waits for the operator's word\n");
        expect(section).toContain('- decisions outside pull requests: not covered by this read');
        expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(FOCUS_V1_MAX_BYTES);

        // Verify sandmanHandoffSections slug mapping so get_sandman_handoff({sections: ['focus']}) works.
        expect(headingToSectionSlug('Focus (v1)')).toBe('focus');
        const split = splitSandmanHandoffSections(`# Autonomous Handoff\n\n### 🧪 Critical Test Constraints\n- gap\n\n${section}\n## Consolidation Gaps\n- none\n`);
        expect(split.sectionsBySlug.focus.content).toContain('## Focus (v1)');
        expect(split.sectionsBySlug.focus.content).toContain('### what waits for the operator\'s word');
        expect(split.sectionsBySlug.gaps.content).toContain('### 🧪 Critical Test Constraints');
    });

    test('AC-1 (absent-inputs arm): with every input absent, ## Focus (v1) still renders with unknown and a plane-neutral reason', () => {
        const section = renderFocusV1Section({capturedAt: CAPTURED_AT});

        expect(section).toContain(FOCUS_V1_HEADING);
        expect(section).toContain(`<!-- ${FOCUS_V1_MARKER} · captured: ${CAPTURED_AT_LABEL} -->`);
        expect(section).toContain(`v1: 0 of 5 rows passed · ready 0 · unknown 5 · failed 0 · missing: all (${FOCUS_V1_READER_ABSENT_REASON})`);
        expect(section).toContain(`views: swept 0 · needing love unknown · unassessed: ${FOCUS_V1_VIEW_KEYS.join(', ')} (${FOCUS_V1_READER_ABSENT_REASON})`);
        expect(section).toContain(`### v1\nas of ${CAPTURED_AT_LABEL} · candidate: unscoped`);
        expect(section).toContain(`- status: unknown (${FOCUS_V1_READER_ABSENT_REASON})`);
        expect(section).toContain(`- github reach: unknown (${FOCUS_V1_READER_ABSENT_REASON})`);
        expect(section).toContain('- outbound ledger: unknown (no public-flagged reach or outbound ledger rows supplied)');
        expect(section).toContain('- decisions outside pull requests: not covered by this read');
        expect(section).not.toContain('cloud-plane');
        expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(FOCUS_V1_MAX_BYTES);
    });

    test('AC-2: Row state words are copied raw and truncated at plan:; ready is never promoted to passed', () => {
        const parsed = parseRowStateLine(
            '### Status\n**Row state:** ready — 6/6 leaves closed · as of 2026-10-16 · plan: run packaged smoke on macOS'
        );

        expect(parsed).toEqual({
            found    : true,
            rawLine  : 'Row state: ready — 6/6 leaves closed · as of 2026-10-16',
            stateWord: 'ready'
        });
        expect(parsed.rawLine).not.toContain('plan:');

        const summary = summarizeV1Rows([
            {row: 1, epic: '#501', body: 'Row state: ready — 6/6 leaves closed · plan: await smoke'},
            {row: 2, epic: '#502', body: 'Row state: passed — verified on installed build'},
            {row: 3, epic: '#503', body: 'Row state: failed — 1 blocker open'},
            {row: 4, epic: '#504', body: 'No row state line yet'},
            {row: 5, epic: '#505', body: 'Row state: ready — code merged'}
        ]);

        expect(summary.passed).toBe(1);
        expect(summary.ready).toBe(2);
        expect(summary.failed).toBe(1);
        expect(summary.unknown).toBe(1);
        expect(summary.missing).toEqual(['r1:ready', 'r3:failed', 'r4:unknown', 'r5:ready']);

        const rendered = renderFocusV1Section({
            capturedAt: CAPTURED_AT,
            v1        : {
                rows: [{row: 1, epic: '#501', body: 'Row state: ready — 6/6 leaves closed · plan: next step'}]
            }
        });

        expect(rendered).toContain('v1: 0 of 5 rows passed · ready 1 · unknown 4 · failed 0');
        expect(rendered).toContain('- row 1 (#501): Row state: ready — 6/6 leaves closed');
        expect(rendered).not.toContain('Row state: passed');
        expect(rendered).not.toContain('plan: next step');
    });

    test('AC-3: negative publicFlag test — private ledger rows without publicFlag: true and BUSINESS_GOAL nodes never appear', () => {
        const seededRows = [
            {
                id        : 'business-goal-focus',
                type      : 'BUSINESS_GOAL',
                publicFlag: true,
                category  : 'revenue_goal',
                value     : 500000,
                target    : 'SECRET_REVENUE_TARGET'
            },
            {
                id        : 'metric-private-false',
                type      : 'BUSINESS_METRIC',
                publicFlag: false,
                category  : 'private_pipeline',
                value     : 99,
                client    : 'ACME_SECRET_CLIENT'
            },
            {
                id      : 'metric-missing-flag',
                type    : 'BUSINESS_METRIC',
                category: 'unflagged_channel',
                value   : 42
            },
            {
                id        : 'metric-string-flag',
                type      : 'BUSINESS_METRIC',
                publicFlag: 'true',
                category  : 'string_flagged_channel',
                value     : 17
            },
            {
                id        : 'metric-public-valid',
                type      : 'BUSINESS_METRIC',
                publicFlag: true,
                properties: {
                    metricName     : 'blog_Published',
                    publicFlag     : true,
                    count          : 3,
                    lastPublishDate: '2026-10-20',
                    cadence        : '14d',
                    falsifyingQuery: 'ls learn/blog/*.md',
                    // Attempted private field injection on a public row must be stripped:
                    target    : 'SECRET_QUARTERLY_GOAL',
                    revenue   : '999999',
                    clientName: 'CONFIDENTIAL_CORP'
                }
            }
        ];

        const projected = projectPublicBusinessRows(seededRows, {
            allowlist: 'blog_Published,social_Posts'
        });

        expect(projected).toEqual([
            {
                category       : 'blog_Published',
                publicFlag     : true,
                count          : 3,
                lastPublishDate: '2026-10-20',
                cadence        : '14d',
                falsifyingQuery: 'ls learn/blog/*.md'
            }
        ]);

        const section = renderFocusV1Section({
            capturedAt: CAPTURED_AT,
            reach     : {
                ledgerRows: seededRows,
                allowlist : 'blog_Published,social_Posts'
            }
        });

        expect(section).toContain('- outbound `blog_Published`: count: 3 · last publish: 2026-10-20 · cadence: 14d · falsifyingQuery: `ls learn/blog/*.md`');
        expect(section).not.toContain('business-goal-focus');
        expect(section).not.toContain('revenue_goal');
        expect(section).not.toContain('SECRET_REVENUE_TARGET');
        expect(section).not.toContain('private_pipeline');
        expect(section).not.toContain('ACME_SECRET_CLIENT');
        expect(section).not.toContain('unflagged_channel');
        expect(section).not.toContain('string_flagged_channel');
        expect(section).not.toContain('SECRET_QUARTERLY_GOAL');
        expect(section).not.toContain('CONFIDENTIAL_CORP');
    });

    test('views receipt evaluation enforces installed-over-source precedence and counts canonical none observed as swept only', () => {
        expect(isCleanNeedsLove('none observed')).toBe(true);
        expect(isCleanNeedsLove('None Observed.')).toBe(true);
        expect(isCleanNeedsLove('header contrast needs work')).toBe(false);

        const evaluation = evaluateViewReceipts([
            {
                viewKey   : 'goldenPath',
                needsLove : 'clipped badge in narrow dock',
                buildClass: 'installed 0.2.0',
                profile   : 'own-mode',
                observedAt: '2026-10-26T10:00:00Z',
                seat      : '@neo-opus-vega'
            },
            {
                viewKey   : 'goldenPath',
                needsLove : 'none observed',
                buildClass: 'source dev@9f8e7d6',
                profile   : 'dev',
                observedAt: '2026-10-27T10:00:00Z',
                seat      : '@neo-gpt-euclid'
            },
            {
                viewKey   : 'fleet',
                needsLove : 'none observed',
                buildClass: 'installed 0.2.0',
                profile   : 'own-mode',
                observedAt: '2026-10-27T11:00:00Z',
                seat      : '@neo-opus-grace'
            }
        ]);

        // Both keys were swept (2), but only `goldenPath` needs love (1) because its governing
        // installed receipt is not resolved by the newer source receipt, while `fleet` is clean.
        expect(evaluation.swept).toBe(2);
        expect(evaluation.needingLove).toBe(1);
        expect(evaluation.byKey.goldenPath.status).toBe('needs-love');
        expect(evaluation.byKey.goldenPath.governing.buildClass).toBe('installed');
        expect(evaluation.byKey.goldenPath.newerSourceLine).toMatchObject({
            buildClass: 'source',
            needsLove : 'none observed'
        });
        expect(evaluation.byKey.fleet.status).toBe('clean');

        const rendered = renderFocusV1Section({
            capturedAt: CAPTURED_AT,
            views     : {
                receipts: [
                    {
                        viewKey   : 'goldenPath',
                        needsLove : 'clipped badge in narrow dock',
                        buildClass: 'installed 0.2.0',
                        profile   : 'own-mode',
                        observedAt: '2026-10-26T10:00:00Z'
                    },
                    {
                        viewKey   : 'goldenPath',
                        needsLove : 'none observed',
                        buildClass: 'source dev@9f8e7d6',
                        profile   : 'dev',
                        observedAt: '2026-10-27T10:00:00Z'
                    }
                ]
            }
        });

        expect(rendered).toContain('- `goldenPath`: needs love: clipped badge in narrow dock (installed 0.2.0 · own-mode · 2026-10-26T10:00:00Z)');
        expect(rendered).toContain('↳ source 2026-10-27T10:00:00Z · needs love: none observed (does not resolve installed line)');
    });

    test('operatorWord formats ready, not_ready, and unavailable merge-readiness projection verdicts', () => {
        expect(formatOperatorCandidateLine({
            repo      : 'neomjs/neo-agent-brain',
            number    : 1326,
            approvedAt: '2026-10-28T01:00:00Z',
            projection: {verdict: 'ready'}
        })).toBe('- neomjs/neo-agent-brain#1326 · approved 2026-10-28T01:00:00Z · `ready for the operator` (projection: ready)');

        expect(formatOperatorCandidateLine({
            repo      : 'neomjs/neo-agent-skills',
            number    : 228,
            projection: {verdict: 'not_ready', reasons: ['ci-pending', 'head-mismatch']}
        })).toBe('- neomjs/neo-agent-skills#228 · `approved · not ready: ci-pending, head-mismatch`');

        expect(formatOperatorCandidateLine({
            repo      : 'neomjs/neo-stage',
            number    : 452,
            projection: {verdict: 'unavailable', missingInput: 'mergeStateStatus absent'}
        })).toBe('- neomjs/neo-stage#452 · `approved · readiness unverified: mergeStateStatus absent`');
    });

    test('AC-5: host-edge reader supplies GitHub blocks on the host plane and makeRefusingFocusV1Reader degrades to unknown with reason on the cloud plane', async () => {
        const refusing = makeRefusingFocusV1Reader('cloud-plane has no GitHub host-edge');

        await expect(refusing()).rejects.toBeInstanceOf(FocusSourceUnavailable);

        const cloudReader = createFocusV1HostEdgeReader({
            readV1Rows       : refusing,
            readViewsReceipts: refusing,
            readReachTraffic : async () => {
                throw new Error('upstream failed with Bearer ghp_secretTokenValue123456789');
            },
            readOperatorWord : refusing
        });

        const cloudInputs  = await cloudReader.readFocusV1Inputs({now: new Date(CAPTURED_AT)});
        const cloudSection = renderFocusV1Section(cloudInputs);

        expect(cloudInputs.v1).toEqual({
            status     : 'unknown',
            unavailable: true,
            reason     : 'cloud-plane has no GitHub host-edge'
        });
        expect(cloudInputs.reach.reason).toContain('Bearer [REDACTED]');
        expect(cloudInputs.reach.reason).not.toContain('ghp_secretTokenValue123456789');
        expect(cloudSection).toContain('- status: unknown (cloud-plane has no GitHub host-edge)');
        expect(cloudSection).not.toContain('ghp_secretTokenValue123456789');

        const hostReader = createFocusV1HostEdgeReader({
            readV1Rows: async () => ({
                asOf     : CAPTURED_AT,
                candidate: '0.2.0+host',
                rows     : [{row: 1, epic: '#364', rawLine: 'Row state: passed — verified'}]
            }),
            readViewsReceipts: async () => ({
                asOf     : CAPTURED_AT,
                candidate: '0.2.0+host',
                receipts : [{viewKey: 'fleet', needsLove: 'none observed', buildClass: 'installed 0.2.0', observedAt: CAPTURED_AT}]
            }),
            readReachTraffic: async () => ({
                asOf   : CAPTURED_AT,
                traffic: {views: 900, uniques: 150},
                stars  : 1500,
                forks  : 210
            }),
            readOperatorWord: async () => ({
                asOf      : CAPTURED_AT,
                candidates: [{repo: 'neomjs/neo-agent-brain', number: 957, projection: {verdict: 'ready'}}]
            }),
            readPrivateLedger: async () => ({
                rows: [
                    {id: 'business-goal-1', type: 'BUSINESS_GOAL', publicFlag: true, category: 'secret', value: 1},
                    {id: 'metric-1', type: 'BUSINESS_METRIC', publicFlag: true, category: 'social_Posts', count: 5}
                ]
            })
        });

        const hostInputs  = await hostReader.readFocusV1Inputs({now: new Date(CAPTURED_AT)});
        const hostSection = renderFocusV1Section(hostInputs);

        expect(hostSection).toContain('v1: 1 of 5 rows passed');
        expect(hostSection).toContain('views: swept 1 · needing love 0');
        expect(hostSection).toContain('traffic 14d: 900 views, 150 uniques · stars: 1500 · forks: 210');
        expect(hostSection).toContain('- outbound `social_Posts`: count: 5');
        expect(hostSection).not.toContain('business-goal-1');
        expect(hostSection).toContain('- neomjs/neo-agent-brain#957 · `ready for the operator` (projection: ready)');
    });

    test('AC-5 (default host-edge block readers arm): createFocusV1HostEdgeReader({useDefaultHostReaders: true, execGh}) parses ROADMAP rows, #505 receipts, traffic, and open approved PRs', async () => {
        const roadmapMarkdown = [
            '| # | Journey | Anchors | Steward | Done signal | State |',
            '|---|---|---|---|---|---|',
            '| 1 | First run | #351 | Clio | cold run | the `Row state:` line on [#351](https://github.com/neomjs/neo-agent-institution/issues/351) |',
            '| 2 | Truthful state | #477 | Clio | provoked | the `Row state:` line on [#477](https://github.com/neomjs/neo-agent-institution/issues/477) |',
            '| 3 | Observatory | #312 | Vega | walk | the `Row state:` line on [#312](https://github.com/neomjs/neo-agent-institution/issues/312) |',
            '| 4 | Workflow | #414 | Grace | end-to-end | the `Row state:` line on [#414](https://github.com/neomjs/neo-agent-institution/issues/414) |',
            '| 5 | Recovery | #424 | Ada | recovered | the `Row state:` line on [#424](https://github.com/neomjs/neo-agent-institution/issues/424) |'
        ].join('\n');

        expect(parseRoadmapV1RowEpics(roadmapMarkdown)).toEqual([
            {row: 1, repo: 'neomjs/neo-agent-institution', number: 351, epic: '#351'},
            {row: 2, repo: 'neomjs/neo-agent-institution', number: 477, epic: '#477'},
            {row: 3, repo: 'neomjs/neo-agent-institution', number: 312, epic: '#312'},
            {row: 4, repo: 'neomjs/neo-agent-institution', number: 414, epic: '#414'},
            {row: 5, repo: 'neomjs/neo-agent-institution', number: 424, epic: '#424'}
        ]);

        const epicBodies = {
            351: 'Row state: passed · 2026-10-20 · plan: done',
            477: 'Row state: ready · 2026-10-21 · plan: run smoke',
            312: 'Row state: passed · 2026-10-22',
            414: 'Row state: failed · 2026-10-23',
            424: 'No row state line yet'
        };

        const comments505 = [
            {
                createdAt: '2026-10-14T10:00:00Z',
                author   : {login: 'neo-fable-clio'},
                url      : 'https://github.com/neomjs/neo-agent-institution/issues/505#issuecomment-1',
                body     : [
                    '## Design sweep · `detail`',
                    '| Field | Value |',
                    '|---|---|',
                    '| build | `installed candidate 20261013 · e5aa4238` |',
                    '| profile | team instance |',
                    '',
                    '`view: detail · needs love: column comes back empty after restore`'
                ].join('\n')
            },
            {
                createdAt: '2026-10-15T14:00:00Z',
                author   : {login: 'neo-gpt-emmy'},
                url      : 'https://github.com/neomjs/neo-agent-institution/issues/505#issuecomment-2',
                body     : [
                    '## Design sweep · `detail`',
                    '| Field | Value |',
                    '|---|---|',
                    '| build | Source preview. Clean dev head |',
                    '| profile | Disposable source fixture |',
                    '',
                    '`view: detail · needs love: none observed`'
                ].join('\n')
            },
            {
                createdAt: '2026-10-16T14:00:00Z',
                author   : {login: 'neo-fable-mnemosyne'},
                url      : 'https://github.com/neomjs/neo-agent-institution/issues/505#issuecomment-3',
                body     : [
                    '## Design sweep · `fleet`',
                    '| Field | Value |',
                    '|---|---|',
                    '| build | installed candidate 2026-10-14 |',
                    '| profile | operator team profile |',
                    '',
                    'view: fleet · needs love: none observed'
                ].join('\n')
            }
        ];

        const parsedReceipts = parseViewsReceiptComments(comments505);
        expect(parsedReceipts).toHaveLength(3);

        const execGh = async args => {
            const key = args.join(' ');
            if (key.includes('contents/ROADMAP.md')) {
                return Buffer.from(roadmapMarkdown, 'utf8').toString('base64');
            }
            if (args[0] === 'issue' && args[1] === 'view' && args[2] === '505') {
                return JSON.stringify({
                    number  : 505,
                    url     : 'https://github.com/neomjs/neo-agent-institution/issues/505',
                    comments: comments505
                });
            }
            if (args[0] === 'issue' && args[1] === 'view') {
                const num = Number(args[2]);
                return JSON.stringify({
                    number: num,
                    body  : epicBodies[num] || ''
                });
            }
            if (key === 'api repos/neomjs/neo/traffic/views') {
                return JSON.stringify({count: 2450, uniques: 410});
            }
            if (key === 'api repos/neomjs/neo') {
                return JSON.stringify({stargazers_count: 1512, forks_count: 218});
            }
            if (args[0] === 'search' && args[1] === 'prs') {
                return JSON.stringify([
                    {
                        number    : 228,
                        repository: {nameWithOwner: 'neomjs/neo-agent-skills'},
                        url       : 'https://github.com/neomjs/neo-agent-skills/pull/228',
                        updatedAt : '2026-10-28T03:00:00Z'
                    }
                ]);
            }
            if (args[0] === 'pr' && args[1] === 'view' && args[2] === '228') {
                return JSON.stringify({
                    number          : 228,
                    url             : 'https://github.com/neomjs/neo-agent-skills/pull/228',
                    state           : 'OPEN',
                    mergedAt        : null,
                    isDraft         : false,
                    mergeStateStatus: 'CLEAN',
                    headRefOid      : '6c41b1d',
                    author          : {login: 'neo-gemini-pro'},
                    body            : 'Authored by Julia (`@neo-gemini-pro`, Gemini 4 Argon, Antigravity).',
                    reviewDecision  : 'APPROVED',
                    reviewRequests  : [],
                    reviews         : [
                        {
                            author     : {login: 'neo-opus-grace'},
                            state      : 'APPROVED',
                            submittedAt: '2026-10-28T02:55:00Z',
                            commit     : {oid: '6c41b1d'}
                        }
                    ],
                    comments         : [],
                    statusCheckRollup: [{name: 'skills-lint', conclusion: 'SUCCESS'}],
                    updatedAt        : '2026-10-28T03:00:00Z'
                });
            }
            throw new Error(`Unexpected gh invocation: ${key}`);
        };

        const reader  = createFocusV1HostEdgeReader({useDefaultHostReaders: true, execGh});
        const inputs  = await reader.readFocusV1Inputs({now: new Date(CAPTURED_AT)});
        const section = renderFocusV1Section(inputs);

        expect(inputs.v1.status).toBe('ok');
        expect(inputs.views.status).toBe('ok');
        expect(inputs.reach.status).toBe('ok');
        expect(inputs.operatorWord.status).toBe('ok');

        expect(section).toContain('v1: 2 of 5 rows passed · ready 1 · unknown 1 · failed 1 · missing: r2:ready, r4:failed, r5:unknown');
        expect(section).toContain('views: swept 2 · needing love 1');
        expect(section).toContain('- `detail`: needs love: column comes back empty after restore');
        expect(section).toContain('↳ source 2026-10-15T14:00:00Z · needs love: none observed (does not resolve installed line)');
        expect(section).toContain('traffic 14d: 2450 views, 410 uniques · stars: 1512 · forks: 218');
        expect(section).toContain('[neomjs/neo-agent-skills#228](https://github.com/neomjs/neo-agent-skills/pull/228) · approved 2026-10-28T02:55:00Z · `ready for the operator` (projection: ready)');
        expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(FOCUS_V1_MAX_BYTES);

        // Verify evaluateCandidateMergeReadiness fails closed when fields are missing
        expect(evaluateCandidateMergeReadiness({number: 999})).toEqual({
            verdict     : 'unavailable',
            missingInput: 'merge-readiness fields incomplete'
        });
    });

    test('host-edge collectAndWriteFocusV1Projection writes a dated focus-v1-projection.v1 file and createFocusV1ProjectionReader consumes it in-plane without spawning gh (#1333)', async () => {
        const tmpDir         = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-v1-projection-'));
        const projectionPath = path.join(tmpDir, 'focus-v1-projection.json');

        try {
            // 1. Missing projection file degrades all 4 blocks to unknown with the absent reason
            const missingReader = createFocusV1ProjectionReader({projectionPath});
            const missingInputs = await missingReader.readFocusV1Inputs({now: new Date(CAPTURED_AT)});

            expect(missingInputs.v1).toEqual({
                status     : 'unknown',
                unavailable: true,
                reason     : FOCUS_V1_READER_ABSENT_REASON
            });
            expect(missingInputs.views.status).toBe('unknown');
            expect(missingInputs.reach.status).toBe('unknown');
            expect(missingInputs.operatorWord.status).toBe('unknown');

            // 2. Host-edge collector writes the dated projection (including a partial-block failure + private ledger filtering)
            const {projection} = await collectAndWriteFocusV1Projection({
                projectionPath,
                now       : new Date(CAPTURED_AT),
                readV1Rows: async () => ({
                    asOf     : CAPTURED_AT,
                    candidate: '0.2.0+host-edge',
                    rows     : [
                        {row: 1, epic: '#351', rawLine: 'Row state: passed · 2026-10-20'},
                        {row: 2, epic: '#477', rawLine: 'Row state: ready · 2026-10-21'}
                    ]
                }),
                readViewsReceipts: async () => ({
                    asOf     : CAPTURED_AT,
                    candidate: '0.2.0+host-edge',
                    receipts : [
                        {viewKey: 'fleet', needsLove: 'none observed', buildClass: 'installed 0.2.0', observedAt: CAPTURED_AT}
                    ]
                }),
                readReachTraffic: async () => {
                    throw new Error('traffic API 403 with token ghp_secretHostEdgeToken999');
                },
                readOperatorWord: async () => ({
                    asOf      : CAPTURED_AT,
                    candidates: [
                        {repo: 'neomjs/neo-agent-brain', number: 1332, approvedAt: CAPTURED_AT, projection: {verdict: 'ready'}}
                    ]
                }),
                readPrivateLedger: async () => ({
                    rows: [
                        {id: 'business-goal-9', type: 'BUSINESS_GOAL', publicFlag: true, category: 'secret_goal', value: 100},
                        {id: 'metric-2', type: 'BUSINESS_METRIC', publicFlag: true, category: 'blog_Articles', count: 4, target: 'secret'}
                    ]
                })
            });

            expect(projection.schemaVersion).toBe(FOCUS_V1_PROJECTION_SCHEMA);
            expect(fs.existsSync(projectionPath)).toBe(true);

            // 3. Container-plane projection reader consumes the written projection without spawning gh
            const inPlaneReader = createFocusV1ProjectionReader({projectionPath});
            const inPlaneInputs = await inPlaneReader.readFocusV1Inputs({now: new Date('2026-10-28T06:00:00Z')});
            const rendered      = renderFocusV1Section(inPlaneInputs);

            expect(inPlaneInputs.capturedAt).toBe('2026-10-28 03:00 UTC');
            expect(inPlaneInputs.v1.status).toBe('ok');
            expect(inPlaneInputs.views.status).toBe('ok');
            // Traffic failed on the host edge, so github reach degrades with sanitized reason while publicRows survive
            expect(inPlaneInputs.reach.status).toBe('ok');
            expect(inPlaneInputs.reach.reason).toContain('[REDACTED]');
            expect(inPlaneInputs.reach.reason).not.toContain('ghp_secretHostEdgeToken999');
            expect(inPlaneInputs.reach.publicRows).toEqual([{category: 'blog_Articles', publicFlag: true, count: 4}]);
            expect(inPlaneInputs.operatorWord.status).toBe('ok');

            expect(rendered).toContain('v1: 1 of 5 rows passed · ready 1 · unknown 3 · failed 0');
            expect(rendered).toContain('views: swept 1 · needing love 0');
            expect(rendered).toContain('- outbound `blog_Articles`: count: 4');
            expect(rendered).not.toContain('secret_goal');
            expect(rendered).toContain('- neomjs/neo-agent-brain#1332 · approved 2026-10-28T03:00:00.000Z · `ready for the operator` (projection: ready)');

            // 4. Corrupt or wrong-schema projection file degrades cleanly to unknown
            fs.writeFileSync(projectionPath, JSON.stringify({schemaVersion: 'wrong.v0'}), 'utf8');
            const badSchemaInputs = await inPlaneReader.readFocusV1Inputs({now: new Date(CAPTURED_AT)});
            expect(badSchemaInputs.v1).toEqual({
                status     : 'unknown',
                unavailable: true,
                reason     : 'unsupported Focus (v1) projection schema: wrong.v0'
            });
        } finally {
            fs.rmSync(tmpDir, {recursive: true, force: true});
        }
    });

    test('deployed local-agent-os topology resolves host-edge writer and container-plane readers to the same physical file (#1333)', async () => {
        const hostEdgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-v1-host-edge-state-'));
        const leafSpec    = McConfigBase.config.data.focusV1ProjectionPath;

        expect(leafSpec).toMatchObject({
            default: '',
            env    : 'NEO_FOCUS_V1_PROJECTION_PATH',
            type   : 'string'
        });
        expect(typeof leafSpec.parse).toBe('function');
        expect('focusV1ProjectionPathOverride' in McConfigBase.config.data).toBe(false);
        expect('focusV1ProjectionPath' in (McConfigBase.config.formulas ?? {})).toBe(false);

        try {
            // 1. Writer side: resolve the host-edge process environment the way `ai/daemons/orchestrator/hostEdge.mjs`
            //    does when supervised by launchd with `NEO_AI_ORCHESTRATOR_DIR` set to the host-edge state directory,
            //    then decode the `focusV1ProjectionPath` leaf through its own `parse` hook.
            const hostEdgeEnv = applyHostEdgePosture({
                env: {[HOST_EDGE_STATE_DIR_ENV]: hostEdgeDir}
            });
            const writerProjectionPath = leafSpec.parse(leafSpec.env, {env: hostEdgeEnv}) ?? leafSpec.default;

            expect(writerProjectionPath).toBe(path.join(hostEdgeDir, 'focus-v1-projection.json'));

            // 2. Reader side: parse `deploy/cloud/docker-compose.local-agent-os.yml`, decode each container reader's
            //    `focusV1ProjectionPath` leaf from its declared service environment, and map that container path
            //    through its declared read-only bind mount back to the host filesystem.
            const overlayPath = path.resolve(process.cwd(), 'deploy/cloud/docker-compose.local-agent-os.yml');
            const overlay     = parseDocument(fs.readFileSync(overlayPath, 'utf8')).toJS();

            function resolveContainerProjectionOnHost(serviceName) {
                const service                 = overlay.services?.[serviceName];
                const containerProjectionPath = leafSpec.parse(leafSpec.env, {env: service?.environment ?? {}}) ?? leafSpec.default;
                const bindMount               = (service?.volumes ?? []).find(
                    volume => typeof volume === 'object' &&
                        volume.type === 'bind' &&
                        volume.read_only === true &&
                        typeof volume.target === 'string' &&
                        containerProjectionPath?.startsWith(`${volume.target}/`)
                );

                expect(containerProjectionPath, `${serviceName} must declare ${leafSpec.env}`).toBe('/app/host-edge/focus-v1-projection.json');
                expect(bindMount, `${serviceName} must bind-mount /app/host-edge read-only`).toBeDefined();
                expect(bindMount.source).toBe('${NEO_HOST_EDGE_STATE_DIR:-${HOME}/Library/Application Support/Neo/AgentOS/host-edge}');

                // Substitute `NEO_HOST_EDGE_STATE_DIR` with `hostEdgeDir` the way Compose interpolation does:
                const resolvedHostBindSource = hostEdgeDir;
                const relativeInsideMount    = path.posix.relative(bindMount.target, containerProjectionPath);

                return path.join(resolvedHostBindSource, relativeInsideMount);
            }

            const orchestratorPhysicalPath = resolveContainerProjectionOnHost('orchestrator');
            const mcServerPhysicalPath     = resolveContainerProjectionOnHost('mc-server');

            expect(orchestratorPhysicalPath).toBe(writerProjectionPath);
            expect(mcServerPhysicalPath).toBe(writerProjectionPath);

            // 3. Write through the host-edge writer path and read through the container-plane mapped path
            //    (with `absentReason: CLOUD_PLANE_HOST_EDGE_ABSENT_REASON`, matching `orchestrator` where `repoEnrichmentEnabled === false`).
            await collectAndWriteFocusV1Projection({
                projectionPath   : writerProjectionPath,
                now              : new Date(CAPTURED_AT),
                readV1Rows       : async () => ({asOf: CAPTURED_AT, rows: [{row: 1, epic: '#351', rawLine: 'Row state: passed · 2026-10-20'}]}),
                readViewsReceipts: async () => ({asOf: CAPTURED_AT, receipts: [{viewKey: 'fleet', needsLove: 'none observed', buildClass: 'installed 0.2.0', observedAt: CAPTURED_AT}]}),
                readReachTraffic : async () => ({asOf: CAPTURED_AT, traffic: {views: 900, uniques: 140}, stars: 1510, forks: 215}),
                readOperatorWord : async () => ({asOf: CAPTURED_AT, candidates: [{repo: 'neomjs/neo-agent-brain', number: 1332, approvedAt: CAPTURED_AT, projection: {verdict: 'ready'}}]}),
                readPrivateLedger: async () => ({rows: []})
            });

            const containerOrchestratorReader = createFocusV1ProjectionReader({
                projectionPath: orchestratorPhysicalPath,
                absentReason  : CLOUD_PLANE_HOST_EDGE_ABSENT_REASON
            });
            const containerInputs = await containerOrchestratorReader.readFocusV1Inputs({now: new Date(CAPTURED_AT)});

            expect(containerInputs.v1.status).toBe('ok');
            expect(containerInputs.views.status).toBe('ok');
            expect(containerInputs.reach.status).toBe('ok');
            expect(containerInputs.operatorWord.status).toBe('ok');
        } finally {
            fs.rmSync(hostEdgeDir, {recursive: true, force: true});
        }
    });
});
