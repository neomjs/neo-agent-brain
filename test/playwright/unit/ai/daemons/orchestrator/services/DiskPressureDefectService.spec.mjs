import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    CONTAINER_HEALTH_ACTION_CLASSES,
    ContainerHealthDiagnosisService
} from '../../../../../../../ai/daemons/orchestrator/services/ContainerHealthDiagnosisService.mjs';
import DiskPressureDefectService, {
    DISK_PRESSURE_DEFECT_TAGGED_CONCEPTS,
    DISK_PRESSURE_EPISODE_STATE_FILE
} from '../../../../../../../ai/daemons/orchestrator/services/DiskPressureDefectService.mjs';
import {
    defectNoteFingerprint,
    foldDefectObservations,
    inspectDefectNoteCapture,
    parseDefectNote
} from '../../../../../../../ai/services/memory-core/helpers/defectObservationFold.mjs';

const GIB         = 1024 ** 3,
      OBSERVED_AT = Date.parse('2026-11-15T07:00:00.000Z');

function createDiagnosisService() {
    return Neo.create(ContainerHealthDiagnosisService, {
        nowFn           : () => OBSERVED_AT,
        ollamaHostReader: () => 'http://local-model:11434'
    });
}

function buildEngineDiskSnapshot(diagnosisService, {
    usedPercent = 97.36,
    availableBytes = 0,
    imagesReclaimableBytes = 38_547_329_024,
    volumesReclaimableBytes = 34_252_361_728,
    reclaimableBuildCacheBytes = 1_589_137_899,
    mountPath = '/app/.neo-ai-data',
    status = 'available',
    errors = [],
    sustained = true
} = {}) {
    const totalBytes = 64 * GIB,
          usedBytes  = Math.round((usedPercent / 100) * totalBytes),
          freeBytes  = Math.max(0, totalBytes - usedBytes),
          statfs     = status === 'unavailable' ? null : {
              path          : mountPath,
              totalBytes,
              usedBytes,
              freeBytes,
              availableBytes: availableBytes ?? freeBytes,
              usedPercent
          },
          df         = status === 'unavailable' ? null : {
              images    : {totalSizeBytes: 40 * GIB, reclaimableBytes: imagesReclaimableBytes, totalCount: 8, activeCount: 2},
              volumes   : {totalSizeBytes: 32 * GIB, reclaimableBytes: volumesReclaimableBytes, totalCount: 6, activeCount: 1},
              buildCache: {
                  totalSizeBytes  : reclaimableBuildCacheBytes + Math.round(0.5 * GIB),
                  reclaimableBytes: reclaimableBuildCacheBytes,
                  totalCount      : 10,
                  inUseCount      : 2
              }
          },
          samples    = statfs ? (sustained
              ? [
                  {statfs, df, observedAtMs: OBSERVED_AT - 60_000},
                  {statfs, df, observedAtMs: OBSERVED_AT}
              ]
              : [{statfs, df, observedAtMs: OBSERVED_AT}]
          ) : [],
          diagnosis  = diagnosisService.diagnoseEngineDisk({
              targetId   : 'docker-engine',
              diskSample : samples.at(-1) || null,
              diskSamples: samples,
              readFailed : status !== 'available' || errors.length > 0,
              observedAt : OBSERVED_AT
          });

    return {
        schemaVersion : 1,
        recordType    : 'deployment-engine-disk-state',
        targetIdentity: {kind: 'engine', id: 'docker-engine'},
        observedAt    : OBSERVED_AT,
        status,
        statfs,
        df,
        diagnosis,
        errors
    };
}

function createDefectService({stateDir, hasObservationWriteAuthority = () => true, publishDefectNote}) {
    return Neo.create(DiskPressureDefectService, {
        stateDir,
        hasObservationWriteAuthority,
        publishDefectNote,
        nowFn: () => OBSERVED_AT
    });
}

test.describe('Neo.ai.daemons.orchestrator.services.DiskPressureDefectService (#1756)', () => {
    test('opens one stable-subject defect note on record routing and dedupes across polls and restarts', async () => {
        const stateDir         = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-defect-record-')),
              diagnosisService = createDiagnosisService(),
              publishedNotes   = [],
              service          = createDefectService({
                  stateDir,
                  publishDefectNote: async note => {
                      publishedNotes.push(note);
                      return {messageId: `MESSAGE:disk-${publishedNotes.length}`};
                  }
              });

        try {
            const engineDisk = buildEngineDiskSnapshot(diagnosisService);
            expect(engineDisk.diagnosis.actionClass).toBe(CONTAINER_HEALTH_ACTION_CLASSES.record);

            const outcomes = [{serviceKey: 'docker-engine', actionClass: 'record', status: 'recorded'}],
                  first    = await service.reconcile({engineDisk, outcomes});

            expect(first).toEqual({
                action : 'opened',
                subject: 'defect-note: docker-engine disk-pressure broke /app/.neo-ai-data: the build-cache prune cannot relieve it',
                trigger: 'record'
            });
            expect(publishedNotes).toHaveLength(1);
            expect(publishedNotes[0]).toEqual({
                subject       : 'defect-note: docker-engine disk-pressure broke /app/.neo-ai-data: the build-cache prune cannot relieve it',
                taggedConcepts: [...DISK_PRESSURE_DEFECT_TAGGED_CONCEPTS],
                body          : [
                    'Unrelieved Docker / data-mount disk pressure (record).',
                    '- mountPath: /app/.neo-ai-data',
                    '- usedPercent: 97.36%',
                    '- availableBytes: 0',
                    '- images.reclaimableBytes: 38547329024',
                    '- volumes.reclaimableBytes: 34252361728',
                    '- buildCache.reclaimableBytes: 1589137899',
                    '- reclaimableAboveWarmFloorBytes: 0'
                ].join('\n')
            });

            // Repeated poll while episode remains active is suppressed.
            expect(await service.reconcile({engineDisk, outcomes})).toEqual({action: 'noop'});
            expect(publishedNotes).toHaveLength(1);

            // Restarted service reading persisted state file also suppresses duplicate open.
            const restarted = createDefectService({
                stateDir,
                publishDefectNote: async note => {
                    publishedNotes.push(note);
                    return {messageId: 'MESSAGE:unexpected'};
                }
            });
            expect(await restarted.reconcile({engineDisk, outcomes})).toEqual({action: 'noop'});
            expect(publishedNotes).toHaveLength(1);
            restarted.destroy();
        } finally {
            service.destroy();
            fs.rmSync(stateDir, {recursive: true, force: true});
        }
    });

    test('stays quiet when prune-build-cache frees space, emits on prune-freed-nothing, and retries after publish failure', async () => {
        const stateDir         = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-defect-prune-')),
              diagnosisService = createDiagnosisService(),
              publishedNotes   = [];
        let   failPublishOnce = true;

        const service = createDefectService({
            stateDir,
            publishDefectNote: async note => {
                if (failPublishOnce) {
                    failPublishOnce = false;
                    throw new Error('transient mailbox failure');
                }
                publishedNotes.push(note);
                return {messageId: `MESSAGE:prune-${publishedNotes.length}`};
            }
        });

        try {
            const prunableDisk = buildEngineDiskSnapshot(diagnosisService, {
                usedPercent               : 95.5,
                availableBytes            : 2 * GIB,
                reclaimableBuildCacheBytes: Math.round(3.5 * GIB)
            });
            expect(prunableDisk.diagnosis.actionClass).toBe(CONTAINER_HEALTH_ACTION_CLASSES.pruneBuildCache);

            // Relieved prune: 0 notes, no state file written.
            const relieved = await service.reconcile({
                engineDisk: prunableDisk,
                outcomes  : [{
                    serviceKey     : 'docker-engine',
                    actionClass    : 'prune-build-cache',
                    status         : 'actuated',
                    actuatorOutcome: {status: 'applied', alarmOnly: false, reasonCode: null}
                }]
            });
            expect(relieved).toEqual({action: 'noop'});
            expect(publishedNotes).toEqual([]);
            expect(fs.existsSync(path.join(stateDir, DISK_PRESSURE_EPISODE_STATE_FILE))).toBe(false);

            // Unrelieved prune (`prune-freed-nothing`): first attempt rejects, leaving episode state unwritten.
            const unrelievedOutcomes = [{
                serviceKey     : 'docker-engine',
                actionClass    : 'prune-build-cache',
                status         : 'actuated',
                actuatorOutcome: {status: 'recorded', alarmOnly: true, reasonCode: 'prune-freed-nothing'}
            }];
            await expect(service.reconcile({engineDisk: prunableDisk, outcomes: unrelievedOutcomes}))
                .rejects.toThrow('transient mailbox failure');
            expect(publishedNotes).toEqual([]);
            expect(fs.existsSync(path.join(stateDir, DISK_PRESSURE_EPISODE_STATE_FILE))).toBe(false);

            // Next cycle retries cleanly and persists active episode state.
            const retried = await service.reconcile({engineDisk: prunableDisk, outcomes: unrelievedOutcomes});
            expect(retried).toEqual({
                action : 'opened',
                subject: 'defect-note: docker-engine disk-pressure broke /app/.neo-ai-data: the build-cache prune cannot relieve it',
                trigger: 'prune-freed-nothing'
            });
            expect(publishedNotes).toHaveLength(1);
            expect(publishedNotes[0].body).toContain('Unrelieved Docker / data-mount disk pressure (prune-freed-nothing).');
            expect(JSON.parse(fs.readFileSync(path.join(stateDir, DISK_PRESSURE_EPISODE_STATE_FILE), 'utf8'))).toMatchObject({
                active : true,
                trigger: 'prune-freed-nothing'
            });
        } finally {
            service.destroy();
            fs.rmSync(stateDir, {recursive: true, force: true});
        }
    });

    test('fences publication and mid-write atomic rename when observation-write authority is lost', async () => {
        const stateDir         = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-defect-fence-')),
              diagnosisService = createDiagnosisService(),
              publishedNotes   = [];
        let   authorityCalls = 0,
              service;

        try {
            const engineDisk = buildEngineDiskSnapshot(diagnosisService),
                  outcomes   = [{serviceKey: 'docker-engine', actionClass: 'record', status: 'recorded'}];

            // Authority absent before reconcile: neither publish nor state write occurs.
            const fencedUpFront = createDefectService({
                stateDir,
                hasObservationWriteAuthority: () => false,
                publishDefectNote           : async note => {
                    publishedNotes.push(note);
                    return {messageId: 'MESSAGE:fenced'};
                }
            });
            expect(await fencedUpFront.reconcile({engineDisk, outcomes})).toEqual({action: 'noop'});
            expect(publishedNotes).toEqual([]);
            expect(fs.existsSync(path.join(stateDir, DISK_PRESSURE_EPISODE_STATE_FILE))).toBe(false);
            fencedUpFront.destroy();

            // Authority lost between temp-file write and renameSync: temp file is removed and state file stays absent.
            // Call 1 (reconcile entry): true; Call 2 (pre-publish): true; Call 3 (writeEpisodeState pre-temp): true;
            // Call 4 (writeEpisodeState pre-rename): false.
            service = createDefectService({
                stateDir,
                hasObservationWriteAuthority: () => {
                    authorityCalls += 1;
                    return authorityCalls <= 3;
                },
                publishDefectNote: async note => {
                    publishedNotes.push(note);
                    return {messageId: 'MESSAGE:mid-fence'};
                }
            });

            const midFence = await service.reconcile({engineDisk, outcomes});
            expect(midFence.action).toBe('fenced');
            expect(fs.existsSync(path.join(stateDir, DISK_PRESSURE_EPISODE_STATE_FILE))).toBe(false);
            expect(fs.readdirSync(stateDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
        } finally {
            service?.destroy();
            fs.rmSync(stateDir, {recursive: true, force: true});
        }
    });

    test('folds red -> recovered -> red onto one fingerprint across materially different Episode-2 readings and ignores degraded samples', async () => {
        const stateDir         = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-defect-fold-')),
              diagnosisService = createDiagnosisService(),
              publishedNotes   = [],
              service          = createDefectService({
                  stateDir,
                  publishDefectNote: async note => {
                      publishedNotes.push(note);
                      return {messageId: `MESSAGE:ep-${publishedNotes.length}`};
                  }
              });

        try {
            // Episode 1: 97.36% used, availableBytes=0, 1.48 GiB build cache (below warm floor).
            const ep1Disk = buildEngineDiskSnapshot(diagnosisService, {
                usedPercent               : 97.36,
                availableBytes            : 0,
                imagesReclaimableBytes    : 38_547_329_024,
                volumesReclaimableBytes   : 34_252_361_728,
                reclaimableBuildCacheBytes: 1_589_137_899
            });
            const opened1 = await service.reconcile({
                engineDisk: ep1Disk,
                outcomes  : [{serviceKey: 'docker-engine', actionClass: 'record', status: 'recorded'}],
                now       : OBSERVED_AT
            });
            expect(opened1.action).toBe('opened');
            expect(publishedNotes).toHaveLength(1);

            // Unavailable, degraded, or error-carrying samples must never close the active episode.
            for (const nonFreshSample of [
                buildEngineDiskSnapshot(diagnosisService, {status: 'unavailable'}),
                buildEngineDiskSnapshot(diagnosisService, {status: 'degraded', usedPercent: 40, sustained: false}),
                buildEngineDiskSnapshot(diagnosisService, {
                    status     : 'available',
                    usedPercent: 40,
                    errors     : [{stage: 'statfs', message: 'stale'}],
                    sustained  : false
                })
            ]) {
                expect(await service.reconcile({engineDisk: nonFreshSample, outcomes: []})).toEqual({action: 'noop'});
            }
            expect(publishedNotes).toHaveLength(1);
            expect(service.readEpisodeState().active).toBe(true);

            // Recovery: fresh statfs reading drops below the 90% ceiling.
            const recoveredDisk = buildEngineDiskSnapshot(diagnosisService, {
                usedPercent               : 81.2,
                availableBytes            : 42_000_000_000,
                imagesReclaimableBytes    : 8_000_000_000,
                volumesReclaimableBytes   : 4_000_000_000,
                reclaimableBuildCacheBytes: 512_000_000,
                sustained                 : false
            });
            const recovered = await service.reconcile({
                engineDisk: recoveredDisk,
                outcomes  : [],
                now       : OBSERVED_AT + 120_000
            });
            expect(recovered).toEqual({
                action : 'recovered',
                subject: 'defect-note: [recovered] docker-engine disk-pressure broke /app/.neo-ai-data: the build-cache prune cannot relieve it'
            });
            expect(publishedNotes).toHaveLength(2);
            expect(publishedNotes[1]).toEqual({
                subject       : 'defect-note: [recovered] docker-engine disk-pressure broke /app/.neo-ai-data: the build-cache prune cannot relieve it',
                taggedConcepts: [...DISK_PRESSURE_DEFECT_TAGGED_CONCEPTS],
                body          : [
                    'Docker / data-mount disk usage dropped below 90%.',
                    '- mountPath: /app/.neo-ai-data',
                    '- usedPercent: 81.2%',
                    '- availableBytes: 42000000000',
                    '- images.reclaimableBytes: 8000000000',
                    '- volumes.reclaimableBytes: 4000000000',
                    '- buildCache.reclaimableBytes: 512000000'
                ].join('\n')
            });
            expect(service.readEpisodeState().active).toBe(false);

            // Episode 2: materially different percentage (94.5%), <6-digit availableBytes (52,428),
            // <6-digit image/volume bytes, and dead-band 2.5 GiB build cache.
            const ep2Disk = buildEngineDiskSnapshot(diagnosisService, {
                usedPercent               : 94.5,
                availableBytes            : 52_428,
                imagesReclaimableBytes    : 12_345,
                volumesReclaimableBytes   : 678,
                reclaimableBuildCacheBytes: 2_684_354_560
            });
            const opened2 = await service.reconcile({
                engineDisk: ep2Disk,
                outcomes  : [{serviceKey: 'docker-engine', actionClass: 'record', status: 'recorded'}],
                now       : OBSERVED_AT + 240_000
            });
            expect(opened2.action).toBe('opened');
            expect(publishedNotes).toHaveLength(3);
            expect(publishedNotes[2].body).toContain('- usedPercent: 94.5%');
            expect(publishedNotes[2].body).toContain('- availableBytes: 52428');
            expect(publishedNotes[2].body).toContain('- images.reclaimableBytes: 12345');
            expect(publishedNotes[2].body).toContain('- volumes.reclaimableBytes: 678');
            expect(publishedNotes[2].body).toContain('- buildCache.reclaimableBytes: 2684354560');
            expect(publishedNotes[2].body).not.toBe(publishedNotes[0].body);

            const [ep1Note, recoveryNote, ep2Note] = publishedNotes,
                  ep1Capture                       = inspectDefectNoteCapture({...ep1Note, to: 'AGENT:*'}),
                  recoveryCapture                  = inspectDefectNoteCapture({...recoveryNote, to: 'AGENT:*'}),
                  ep2Capture                       = inspectDefectNoteCapture({...ep2Note, to: 'AGENT:*'});

            expect(ep1Capture).toMatchObject({admitted: true, parseable: true});
            expect(recoveryCapture).toMatchObject({admitted: true, parseable: true});
            expect(ep2Capture).toMatchObject({admitted: true, parseable: true});
            expect(parseDefectNote(ep1Note.subject)).toMatchObject({parseable: true, recovered: false, surface: 'docker-engine disk-pressure'});
            expect(parseDefectNote(recoveryNote.subject)).toMatchObject({parseable: true, recovered: true, surface: 'docker-engine disk-pressure'});
            expect(parseDefectNote(ep2Note.subject)).toMatchObject({parseable: true, recovered: false, surface: 'docker-engine disk-pressure'});

            const fpEp1      = defectNoteFingerprint(ep1Note.subject),
                  fpRecovery = defectNoteFingerprint(recoveryNote.subject),
                  fpEp2      = defectNoteFingerprint(ep2Note.subject);

            expect(fpEp1).toMatch(/^[0-9a-f]{16}$/);
            expect(fpRecovery).toBe(fpEp1);
            expect(fpEp2).toBe(fpEp1);

            const foldNow = Date.parse('2026-11-15T07:05:00.000Z'),
                  records = [
                      {
                          from   : '@system',
                          sentAt : '2026-11-15T07:00:00.000Z',
                          subject: ep1Note.subject
                      },
                      {
                          from   : '@system',
                          sentAt : '2026-11-15T07:02:00.000Z',
                          subject: recoveryNote.subject
                      },
                      {
                          from   : '@system',
                          sentAt : '2026-11-15T07:04:00.000Z',
                          subject: ep2Note.subject
                      }
                  ];

            const afterOpen = foldDefectObservations(records.slice(0, 1), {now: foldNow});
            expect(afterOpen).toHaveLength(1);
            expect(afterOpen[0]).toMatchObject({
                fingerprint: fpEp1,
                surface    : 'docker-engine disk-pressure',
                symptom    : '/app/.neo-ai-data: the build-cache prune cannot relieve it',
                parseable  : true,
                state      : 'red',
                count      : 1
            });

            const afterRecovery = foldDefectObservations(records.slice(0, 2), {now: foldNow});
            expect(afterRecovery).toHaveLength(1);
            expect(afterRecovery[0]).toMatchObject({
                fingerprint: fpEp1,
                surface    : 'docker-engine disk-pressure',
                parseable  : true,
                state      : 'recovered',
                count      : 2
            });

            const afterReopen = foldDefectObservations(records, {now: foldNow});
            expect(afterReopen).toHaveLength(1);
            expect(afterReopen[0]).toMatchObject({
                fingerprint: fpEp1,
                surface    : 'docker-engine disk-pressure',
                parseable  : true,
                state      : 'red',
                count      : 3,
                lastSeenAt : '2026-11-15T07:04:00.000Z'
            });
        } finally {
            service.destroy();
            fs.rmSync(stateDir, {recursive: true, force: true});
        }
    });
});
