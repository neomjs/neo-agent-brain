import {setup} from '../../../../../setup.mjs';

const appName = 'HealthcheckBackupDetailsTest';

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
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

/**
 * The human-readable backup line in a composed healthcheck must be a RENDERING of the maintenance
 * verdict's reason codes, never a second producer of them.
 *
 * Operators and agents read this sentence rather than the structured block, so a wording assembled
 * beside the codes instead of from them would let the prose outlive a corrected verdict: the surface
 * would keep asserting a finding the scorer no longer makes, and correcting the scorer would leave
 * the reader's experience untouched.
 *
 * The arms assert derivation in both directions — codes reach the prose verbatim, and a code absent
 * from the verdict appears nowhere in any rendered line.
 */

const
    // Minimal composer inputs. Only the backup arm is exercised; every other degradation source is
    // held quiet so a detail line can originate from exactly one place.
    baseArgs = reasonCodes => ({
        health              : {status: 'healthy', details: []},
        memoryWalDrain      : {state: 'caught-up', pendingDrainDepth: 0, oldestPendingAgeMs: null, stallThresholdMs: 1},
        plane               : {id: 'test-plane', dataRoot: '/tmp/test-plane'},
        deploymentInspection: {
            ok      : true,
            status  : 'available',
            snapshot: {maintenance: {health: {status: 'degraded', reasonCodes, staleAfterMs: null}}}
        }
    }),

    backupDetailOf = composed => (composed.details || []).find(line => line.startsWith('Backup maintenance is degraded:')),

    compose = async reasonCodes => {
        const {composeMemoryCoreHealthcheck} = await import(
            '../../../../../../../ai/mcp/server/memory-core/toolService.mjs'
        );

        return composeMemoryCoreHealthcheck(baseArgs(reasonCodes))
    };

test.describe('memory-core healthcheck — the backup detail line derives from the verdict', () => {
    test('the rendered sentence is the verdict\'s reason codes, verbatim and in order', async () => {
        expect(backupDetailOf(await compose(['backup-retry-exhausted', 'backup-state-conflict']))).toBe(
            'Backup maintenance is degraded: backup-retry-exhausted, backup-state-conflict.'
        );
    });

    // The derivation arm proper: change the verdict, the prose must change with it. Reddens if any
    // detail line is ever built from something other than the verdict's reason codes.
    test('mutating the verdict mutates the prose', async () => {
        const
            conflict = backupDetailOf(await compose(['backup-state-conflict'])),
            negative = backupDetailOf(await compose(['backup-never-succeeded']));

        expect(conflict).toBe('Backup maintenance is degraded: backup-state-conflict.');
        expect(negative).toBe('Backup maintenance is degraded: backup-never-succeeded.');
        expect(conflict).not.toBe(negative);
    });

    // NO INDEPENDENT EMISSION PATH. This is the arm that catches a corrected scorer whose old
    // finding survives in the prose: with the definite negative absent from the verdict, it must be
    // absent from every rendered line — not merely from the backup line.
    test('a code absent from the verdict appears nowhere in details', async () => {
        const composed = await compose(['backup-retry-exhausted', 'backup-state-conflict']);

        expect(composed.details.join('\n')).not.toContain('backup-never-succeeded');
    });

    // Guards the fallback branch rather than assuming it never fires: a degraded verdict naming no
    // reason is still a real state, and the reader needs a pointer rather than a bare accusation.
    test('an empty reason-code list falls back to a pointer, not to a bare sentence', async () => {
        expect(backupDetailOf(await compose([]))).toBe(
            'Backup maintenance is degraded: see maintenance.backup.'
        );
    });

    // The operator's ruling: a serving Memory Core says so. A degraded backup is an advisory
    // beside the serving verdict, never the verdict itself; the all-clear line still withdraws.
    test('#557 — a degraded backup leaves status healthy, raises posture, and lists the advisory with its codes', async () => {
        const composed = await compose(['off-host-durability-unmet', 'backup-retry-exhausted']);

        expect(composed.status).toBe('healthy');
        expect(composed.posture).toBe('attention');
        expect(composed.advisories).toEqual([
            {axis: 'backup', state: 'degraded', reasonCodes: ['off-host-durability-unmet', 'backup-retry-exhausted']}
        ]);
        expect(composed.details).not.toContain('All features are operational');
        expect(backupDetailOf(composed)).toBe(
            'Backup maintenance is degraded: off-host-durability-unmet, backup-retry-exhausted.'
        );
    });

    test('#557 — a stalled WAL embed drain is a serving impairment and still reads degraded', async () => {
        const {composeMemoryCoreHealthcheck} = await import(
            '../../../../../../../ai/mcp/server/memory-core/toolService.mjs'
        );
        const composed = composeMemoryCoreHealthcheck({
            ...baseArgs([]),
            deploymentInspection: {ok: true, status: 'available', snapshot: {maintenance: {health: {status: 'healthy', reasonCodes: [], staleAfterMs: null}}}},
            memoryWalDrain      : {state: 'stalled', pendingDrainDepth: 3, oldestPendingAgeMs: 999, stallThresholdMs: 1}
        });

        expect(composed.status).toBe('degraded');
        expect(composed.posture).toBe('clear');
        expect(composed.advisories).toEqual([]);
        expect(composed.details.join('\n')).toContain('Memory WAL embed drain is stalled');
    });

    test('#1207 — AC-1 & AC-2: composeMemoryCoreHealthcheck projects backup from bridge receipt when local root is unmounted and reports reason + owner when neither exists', async () => {
        const {composeMemoryCoreHealthcheck} = await import(
            '../../../../../../../ai/mcp/server/memory-core/toolService.mjs'
        );

        const unmountedBackup = {
            observationStatus: 'unavailable',
            lastSuccessful   : null,
            lastCompleted    : null,
            count            : null,
            unusableCount    : null,
            unverifiedCount  : null
        };

        const withReceipt = composeMemoryCoreHealthcheck({
            ...baseArgs([]),
            health              : {status: 'healthy', details: [], backup: unmountedBackup},
            deploymentInspection: {
                ok      : true,
                status  : 'available',
                snapshot: {
                    maintenance: {
                        health    : {status: 'healthy', observationStatus: 'observed', reasonCodes: [], staleAfterMs: 90000000},
                        lastBackup: {
                            backup           : {durationMs: 53282, error: null, status: 'success'},
                            bundleCompletedAt: '2026-10-19T13:28:47.768Z',
                            bundleName       : 'backup-2026-10-19T13-27-54.488Z',
                            finishedAt       : '2026-10-19T13:28:47.770Z',
                            integrity        : {emptySubsystems: [], restorable: true}
                        }
                    }
                }
            }
        });

        expect(withReceipt.backup).toEqual({
            observationStatus: 'observed',
            source           : 'bridge-receipt',
            restorable       : true,
            lastSuccessful   : 'backup-2026-10-19T13-27-54.488Z',
            lastCompleted    : '2026-10-19T13:28:47.768Z',
            count            : null,
            unusableCount    : 0,
            unverifiedCount  : 0
        });

        const withoutReceipt = composeMemoryCoreHealthcheck({
            ...baseArgs([]),
            health              : {status: 'healthy', details: [], backup: unmountedBackup},
            deploymentInspection: {
                ok      : true,
                status  : 'available',
                snapshot: {
                    maintenance: {
                        health: {status: 'pending', observationStatus: 'partial', reasonCodes: [], staleAfterMs: 90000000}
                    }
                }
            }
        });

        expect(withoutReceipt.backup).toEqual({
            observationStatus: 'unavailable',
            reason           : 'no backup receipt in deployment state and no mounted backup root; the orchestrator owns backups',
            owner            : 'orchestrator',
            lastSuccessful   : null,
            lastCompleted    : null,
            count            : null,
            unusableCount    : null,
            unverifiedCount  : null
        });
    });

    test('#1207 — AC-3: maintenance.backup and backup never disagree on restorable for the same receipt', async () => {
        const {composeMemoryCoreHealthcheck} = await import(
            '../../../../../../../ai/mcp/server/memory-core/toolService.mjs'
        );
        const {describeBackupMaintenanceHealth, BACKUP_RETRY_PHASE} = await import(
            '../../../../../../../ai/daemons/orchestrator/scheduling/backup.mjs'
        );

        const unmountedBackup = {
            observationStatus: 'unavailable',
            lastSuccessful   : null,
            lastCompleted    : null,
            count            : null,
            unusableCount    : null,
            unverifiedCount  : null
        };

        for (const restorable of [true, false, null]) {
            const lastBackup = {
                backup           : {durationMs: 1200, error: null, status: 'success'},
                bundleCompletedAt: '2026-10-19T13:28:47.768Z',
                bundleName       : 'backup-2026-10-19T13-27-54.488Z',
                finishedAt       : '2026-10-19T13:28:47.770Z',
                integrity        : {
                    emptySubsystems: restorable === false ? ['kb', 'mc', 'graph'] : [],
                    restorable
                }
            };

            const maintenanceHealth = describeBackupMaintenanceHealth({
                backupIntervalMs: 86400000,
                durability      : {posture: 'configured'},
                lastBackup,
                retryState      : {
                    phase           : BACKUP_RETRY_PHASE.healthy,
                    lastSuccessAgeMs: 1000,
                    lastSuccessAt   : '2026-10-19T13:28:47.770Z'
                },
                retryWindowMs: 3600000
            });

            const composed = composeMemoryCoreHealthcheck({
                ...baseArgs([]),
                health              : {status: 'healthy', details: [], backup: unmountedBackup},
                deploymentInspection: {
                    ok      : true,
                    status  : 'available',
                    snapshot: {
                        maintenance: {
                            health: maintenanceHealth,
                            lastBackup
                        }
                    }
                }
            });

            expect(composed.backup.restorable).toBe(restorable);
            expect(composed.maintenance.backup.restorable).toBe(restorable);

            if (restorable === false) {
                expect(composed.backup.lastSuccessful).toBeNull();
                expect(composed.backup.unusableCount).toBe(1);
                expect(composed.maintenance.backup.status).toBe('degraded');
                expect(composed.maintenance.backup.reasonCodes).toContain('backup-bundle-not-restorable');
            } else {
                expect(composed.backup.lastSuccessful).toBe('backup-2026-10-19T13-27-54.488Z');
                expect(composed.maintenance.backup.status).toBe('healthy');
            }
        }
    });
});

