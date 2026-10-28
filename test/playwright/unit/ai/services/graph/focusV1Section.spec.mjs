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

import {Buffer}       from 'node:buffer';
import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    CLOUD_PLANE_HOST_EDGE_ABSENT_REASON,
    FOCUS_V1_HEADING,
    FOCUS_V1_MARKER,
    FOCUS_V1_MAX_BYTES,
    FOCUS_V1_VIEW_KEYS,
    FocusSourceUnavailable,
    createFocusV1HostEdgeReader,
    evaluateViewReceipts,
    formatOperatorCandidateLine,
    isCleanNeedsLove,
    makeRefusingFocusV1Reader,
    parseRowStateLine,
    projectPublicBusinessRows,
    renderFocusV1Section,
    summarizeV1Rows
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

    test('AC-1 (absent-inputs arm): with every input absent, ## Focus (v1) still renders with unknown and explicit boundary reasons', () => {
        const section = renderFocusV1Section({capturedAt: CAPTURED_AT});

        expect(section).toContain(FOCUS_V1_HEADING);
        expect(section).toContain(`<!-- ${FOCUS_V1_MARKER} · captured: ${CAPTURED_AT_LABEL} -->`);
        expect(section).toContain(`v1: 0 of 5 rows passed · ready 0 · unknown 5 · failed 0 · missing: all (${CLOUD_PLANE_HOST_EDGE_ABSENT_REASON})`);
        expect(section).toContain(`views: swept 0 · needing love unknown · unassessed: ${FOCUS_V1_VIEW_KEYS.join(', ')} (${CLOUD_PLANE_HOST_EDGE_ABSENT_REASON})`);
        expect(section).toContain(`### v1\nas of ${CAPTURED_AT_LABEL} · candidate: cloud-plane`);
        expect(section).toContain(`- status: unknown (${CLOUD_PLANE_HOST_EDGE_ABSENT_REASON})`);
        expect(section).toContain(`- github reach: unknown (${CLOUD_PLANE_HOST_EDGE_ABSENT_REASON})`);
        expect(section).toContain('- outbound ledger: unknown (no public-flagged reach or outbound ledger rows supplied)');
        expect(section).toContain('- decisions outside pull requests: not covered by this read');
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
});
