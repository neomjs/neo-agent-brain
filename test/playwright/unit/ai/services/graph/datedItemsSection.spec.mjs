import {setup} from '../../../../setup.mjs';

const appName = 'DatedItemsSectionTest';

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

import fs               from 'node:fs';
import os               from 'node:os';
import path             from 'node:path';
import {test, expect}   from '@playwright/test';
import Neo              from 'neo.mjs/src/Neo.mjs';
import * as core        from 'neo.mjs/src/core/_export.mjs';
import memoryCoreConfig from '../../../../../../ai/mcp/server/memory-core/config.template.mjs';
import {
    DATED_ITEMS_NEXT_LIMIT,
    DATED_ITEMS_SCHEMA,
    computeDaysOverdue,
    readDatedItems,
    toUtcDateString
} from '../../../../../../ai/services/graph/datedItemsSection.mjs';
import {
    DATED_ITEMS_OVERDUE_RULE_SENTENCE,
    buildOverdueMessage,
    formatOverdueRowLine,
    getDueTask,
    hasRunOnUtcDate,
    normalizeOwnerHandle,
    runDatedItemsOverdue
} from '../../../../../../ai/daemons/orchestrator/scheduling/datedItemsOverdue.mjs';
import {TASK_REGISTRY}                  from '../../../../../../ai/daemons/orchestrator/scheduling/registry.mjs';
import {
    CONTINUOUS_TASK_REGISTRY,
    ORCHESTRATOR_AUTHORITY_CLASS,
    ORCHESTRATOR_AUTHORITY_PROFILE,
    TARGET_ORCHESTRATOR_AUTHORITY_PROFILES,
    auditAuthorityTopology,
    buildAuthorityLaneInventory,
    buildAuthorityReceipt,
    getTaskAuthorityClass
} from '../../../../../../ai/daemons/orchestrator/taskAuthority.mjs';

const TODAY    = '2026-11-10';
const TOMORROW = '2026-11-11';

function writeRegisterFixture(dir, payload, name = 'dated-items.json') {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
}

test.describe('datedItemsSection & dated-items-overdue lane (#1576)', () => {
    let tmpDir;

    test.beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dated-items-'));
    });

    test.afterAll(() => {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    });

    test('AC-1: readDatedItems partitions fixture rows into overdue, next (3 soonest), and missing; receipted rows leave regardless of receipt text; another schema is unreadable with reason', () => {
        const fixture = {
            schema: DATED_ITEMS_SCHEMA,
            asOf  : '2026-11-10',
            rule  : 'Only state=receipted lets a row leave.',
            rows  : [
                {
                    id         : 'past-open-row',
                    kind       : 'commitment',
                    item       : 'Past-dated open row in fixture',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-05',
                    state      : 'open',
                    owner      : 'neo-fable-mnemosyne',
                    due        : '2026-11-07',
                    receiptRule: 'PR merged',
                    receipt    : 'non-empty receipt text does not clear an open row'
                },
                {
                    id         : 'past-receipted-row',
                    kind       : 'commitment',
                    item       : 'Past-dated receipted row leaves the buckets',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-05',
                    state      : 'receipted',
                    owner      : 'neo-fable-mnemosyne',
                    due        : '2026-11-02',
                    receiptRule: 'PR merged',
                    receipt    : null
                },
                {
                    id         : 'due-later-4',
                    kind       : 'calendar-gate',
                    item       : 'Fourth upcoming row (excluded by 3-soonest cap)',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-10',
                    state      : 'open',
                    owner      : 'neo-opus-ada',
                    due        : '2026-11-20',
                    receiptRule: 'Cut complete',
                    receipt    : null
                },
                {
                    id         : 'due-today-1',
                    kind       : 'calendar-gate',
                    item       : 'Row due today is next, not overdue',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-10',
                    state      : 'in-lane',
                    owner      : 'neo-gemini-maryam',
                    due        : '2026-11-10',
                    receiptRule: 'Lane shipped',
                    receipt    : null
                },
                {
                    id         : 'due-soon-3',
                    kind       : 'calendar-gate',
                    item       : 'Third soonest row',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-10',
                    state      : 'open',
                    owner      : 'neo-fable-clio',
                    due        : '2026-11-15',
                    receiptRule: 'Guide published',
                    receipt    : null
                },
                {
                    id         : 'due-soon-2',
                    kind       : 'calendar-gate',
                    item       : 'Second soonest row',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-10',
                    state      : 'open',
                    owner      : 'neo-gpt-euclid',
                    due        : '2026-11-12',
                    receiptRule: 'Spec verified',
                    receipt    : null
                },
                {
                    id         : 'missing-due-row',
                    kind       : 'date-missing',
                    item       : 'Row with null due date',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-06',
                    lastNamed  : '2026-11-10',
                    state      : 'open',
                    owner      : 'unowned',
                    due        : null,
                    receiptRule: 'Assign date',
                    receipt    : null
                },
                {
                    id         : 'missing-due-receipted',
                    kind       : 'date-missing',
                    item       : 'Receipted row with null due date is excluded',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-06',
                    lastNamed  : '2026-11-10',
                    state      : 'receipted',
                    owner      : 'unowned',
                    due        : null,
                    receiptRule: 'Closed',
                    receipt    : 'done'
                }
            ]
        };

        const file = writeRegisterFixture(tmpDir, fixture, 'ac1-valid.json');
        const read = readDatedItems({sourcePath: file, now: '2026-11-10T12:00:00.000Z'});

        expect(read.status).toBe('ok');
        expect(read.today).toBe(TODAY);
        expect(read.overdue.map(r => r.id)).toEqual(['past-open-row']);
        expect(read.next).toHaveLength(DATED_ITEMS_NEXT_LIMIT);
        expect(read.next.map(r => r.id)).toEqual(['due-today-1', 'due-soon-2', 'due-soon-3']);
        expect(read.missing.map(r => r.id)).toEqual(['missing-due-row']);

        const wrongSchemaFile = writeRegisterFixture(tmpDir, {schema: 'dated-items.v0', rows: []}, 'ac1-wrong-schema.json');
        const wrongSchemaRead = readDatedItems({sourcePath: wrongSchemaFile, now: TODAY});

        expect(wrongSchemaRead.status).toBe('unreadable');
        expect(wrongSchemaRead.reason).toContain('unexpected schema: dated-items.v0');
        expect(wrongSchemaRead.overdue).toEqual([]);
        expect(wrongSchemaRead.next).toEqual([]);
        expect(wrongSchemaRead.missing).toEqual([]);

        const missingFileRead = readDatedItems({sourcePath: path.join(tmpDir, 'nonexistent.json'), now: TODAY});
        expect(missingFileRead.status).toBe('unreadable');
        expect(missingFileRead.reason).toBe('ENOENT');
    });

    test('AC-2: with an empty leaf the lane reads nothing, sends nothing, and logs no error; default datedItemsSourcePath is empty', async () => {
        expect(memoryCoreConfig.datedItemsSourcePath).toBe('');

        const unconfiguredRead = readDatedItems({
            sourcePath: '',
            now       : TODAY,
            readFile  : () => {
                throw new Error('readFile must not be called when sourcePath is empty');
            }
        });

        expect(unconfiguredRead).toEqual({
            status    : 'unconfigured',
            sourcePath: '',
            today     : TODAY,
            overdue   : [],
            next      : [],
            missing   : []
        });

        expect(getDueTask({state: {}, now: TODAY, sourcePath: ''})).toBeNull();

        const descriptor = TASK_REGISTRY.find(entry => entry.taskName === 'dated-items-overdue');
        expect(descriptor).toBeTruthy();
        expect(descriptor.getDueTask({
            state: {},
            now  : Date.parse(`${TODAY}T08:00:00.000Z`),
            hooks: {datedItemsSourcePath: ''}
        })).toBeNull();

        const logs      = [];
        let   sendCalls = 0;

        const outcome = await runDatedItemsOverdue({
            sourcePath: '',
            now       : TODAY,
            readFile  : () => {
                throw new Error('readFile must not be called when leaf is empty');
            },
            sendMessage: async () => {
                sendCalls++;
            },
            writeLog   : (level, message) => {
                logs.push({level, message});
            }
        });

        expect(outcome).toEqual({
            status     : 'unconfigured',
            today      : TODAY,
            sentCount  : 0,
            failedCount: 0,
            messages   : []
        });
        expect(sendCalls).toBe(0);
        expect(logs).toEqual([]);
    });

    test('AC-3: two overdue rows of one owner and one overdue unowned row send one direct message to that owner and one AGENT:* message; a second run on the same day sends nothing', async () => {
        const fixture = {
            schema: DATED_ITEMS_SCHEMA,
            asOf  : TODAY,
            rule  : 'Only state=receipted lets a row leave.',
            rows  : [
                {
                    id         : 'mnemosyne-row-1',
                    kind       : 'commitment',
                    item       : 'First overdue row for Mnemosyne',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-05',
                    state      : 'open',
                    owner      : 'neo-fable-mnemosyne',
                    due        : '2026-11-05',
                    receiptRule: 'Receipt posted',
                    receipt    : null
                },
                {
                    id         : 'mnemosyne-row-2',
                    kind       : 'commitment',
                    item       : 'Second overdue row for Mnemosyne',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-02',
                    lastNamed  : '2026-11-08',
                    state      : 'in-lane',
                    owner      : 'neo-fable-mnemosyne',
                    due        : '2026-11-08',
                    receiptRule: 'PR merged',
                    receipt    : null
                },
                {
                    id         : 'unowned-overdue-row',
                    kind       : 'hygiene-sweep',
                    item       : 'Unowned overdue row',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-07',
                    state      : 'open',
                    owner      : 'unowned',
                    due        : '2026-11-07',
                    receiptRule: 'Owner claimed or receipted',
                    receipt    : null
                },
                {
                    id         : 'mnemosyne-receipted',
                    kind       : 'commitment',
                    item       : 'Already receipted row',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-01',
                    lastNamed  : '2026-11-04',
                    state      : 'receipted',
                    owner      : 'neo-fable-mnemosyne',
                    due        : '2026-11-04',
                    receiptRule: 'PR merged',
                    receipt    : 'neomjs/neo-agent-brain#1572'
                },
                {
                    id         : 'future-row',
                    kind       : 'calendar-gate',
                    item       : 'Due tomorrow',
                    surface    : 'neomjs/business#41',
                    firstNamed : '2026-11-06',
                    lastNamed  : '2026-11-10',
                    state      : 'open',
                    owner      : 'neo-fable-mnemosyne',
                    due        : TOMORROW,
                    receiptRule: 'Gate met',
                    receipt    : null
                }
            ]
        };

        const file  = writeRegisterFixture(tmpDir, fixture, 'ac3-overdue.json');
        const state = {'dated-items-overdue': {}};
        const sent  = [];
        const logs  = [];

        expect(getDueTask({state, now: TODAY, sourcePath: file})).toEqual({
            taskName: 'dated-items-overdue',
            source  : 'daily-dated-items-overdue',
            reason  : `daily-dated-items-overdue:${TODAY}`
        });

        const firstRun = await runDatedItemsOverdue({
            sourcePath : file,
            now        : `${TODAY}T08:00:00.000Z`,
            state,
            sendMessage: async payload => {
                sent.push(payload);
            },
            writeLog   : (level, message) => {
                logs.push({level, message});
            }
        });

        expect(firstRun.status).toBe('ok');
        expect(firstRun.today).toBe(TODAY);
        expect(firstRun.sentCount).toBe(2);
        expect(firstRun.failedCount).toBe(0);
        expect(logs).toEqual([]);
        expect(sent).toEqual([
            {
                to     : '@neo-fable-mnemosyne',
                subject: '[overdue · 2 rows]',
                body   : [
                    'mnemosyne-row-1 · due 2026-11-05 · 5 days',
                    'mnemosyne-row-2 · due 2026-11-08 · 2 days',
                    DATED_ITEMS_OVERDUE_RULE_SENTENCE
                ].join('\n')
            },
            {
                to     : 'AGENT:*',
                subject: '[overdue · 1 rows]',
                body   : [
                    'unowned-overdue-row · due 2026-11-07 · 3 days',
                    DATED_ITEMS_OVERDUE_RULE_SENTENCE
                ].join('\n')
            }
        ]);

        // Second run on the same UTC day sends nothing and is not due.
        expect(getDueTask({state, now: `${TODAY}T18:30:00.000Z`, sourcePath: file})).toBeNull();

        const secondRun = await runDatedItemsOverdue({
            sourcePath : file,
            now        : `${TODAY}T18:30:00.000Z`,
            state,
            sendMessage: async payload => {
                sent.push(payload);
            }
        });

        expect(secondRun.status).toBe('already-ran-today');
        expect(secondRun.sentCount).toBe(0);
        expect(sent).toHaveLength(2);

        // Next UTC day: due again, and a failed send is logged and retried on the following day.
        expect(getDueTask({state, now: `${TOMORROW}T08:00:00.000Z`, sourcePath: file})).toEqual({
            taskName: 'dated-items-overdue',
            source  : 'daily-dated-items-overdue',
            reason  : `daily-dated-items-overdue:${TOMORROW}`
        });

        const failedDayLogs = [];
        const failedRun     = await runDatedItemsOverdue({
            sourcePath : file,
            now        : `${TOMORROW}T08:00:00.000Z`,
            state,
            sendMessage: async () => {
                throw new Error('simulated mailbox transport failure');
            },
            writeLog   : (level, message) => {
                failedDayLogs.push({level, message});
            }
        });

        expect(failedRun.status).toBe('ok');
        expect(failedRun.sentCount).toBe(0);
        expect(failedRun.failedCount).toBe(2);
        expect(failedDayLogs).toHaveLength(2);
        expect(failedDayLogs[0].level).toBe('ERROR');
    });

    test('AC-4: the authority audit at boot lists dated-items-overdue with class container-plane and exactly one owner', () => {
        expect(getTaskAuthorityClass('dated-items-overdue')).toBe(ORCHESTRATOR_AUTHORITY_CLASS.containerPlane);

        const lanes = buildAuthorityLaneInventory({
            continuousRegistry: CONTINUOUS_TASK_REGISTRY,
            scheduledRegistry : TASK_REGISTRY
        });
        const ownership = auditAuthorityTopology({
            lanes,
            profiles: TARGET_ORCHESTRATOR_AUTHORITY_PROFILES
        });
        const laneOwnership = ownership.find(entry => entry.task === 'dated-items-overdue');

        expect(laneOwnership).toEqual({
            task          : 'dated-items-overdue',
            kind          : 'scheduled',
            authorityClass: 'container-plane',
            effectiveOwner: 'container-plane'
        });

        const containerReceipt = buildAuthorityReceipt({
            profile           : ORCHESTRATOR_AUTHORITY_PROFILE.containerPlane,
            continuousRegistry: CONTINUOUS_TASK_REGISTRY,
            scheduledRegistry : TASK_REGISTRY
        });
        const hostReceipt = buildAuthorityReceipt({
            profile           : ORCHESTRATOR_AUTHORITY_PROFILE.hostEdge,
            continuousRegistry: CONTINUOUS_TASK_REGISTRY,
            scheduledRegistry : TASK_REGISTRY
        });

        const containerTask = containerReceipt.tasks.find(entry => entry.task === 'dated-items-overdue');
        const hostTask      = hostReceipt.tasks.find(entry => entry.task === 'dated-items-overdue');

        expect(containerTask).toMatchObject({
            task          : 'dated-items-overdue',
            authorityClass: 'container-plane',
            effectiveOwner: 'container-plane',
            active        : true
        });
        expect(hostTask).toMatchObject({
            task          : 'dated-items-overdue',
            authorityClass: 'container-plane',
            effectiveOwner: 'container-plane',
            active        : false
        });
    });

    test('helper edge cases: unknown owners route to AGENT:* and hasRunOnUtcDate ignores an in-flight running state', async () => {
        expect(normalizeOwnerHandle('neo-gemini-maryam')).toBe('@neo-gemini-maryam');
        expect(normalizeOwnerHandle('@neo-gemini-maryam')).toBe('@neo-gemini-maryam');
        expect(normalizeOwnerHandle('unowned')).toBeNull();
        expect(normalizeOwnerHandle('')).toBeNull();
        expect(toUtcDateString('2026-11-10')).toBe('2026-11-10');
        expect(computeDaysOverdue('2026-11-05', '2026-11-10')).toBe(5);
        expect(formatOverdueRowLine({id: 'row-1', due: '2026-11-05'}, '2026-11-10')).toBe('row-1 · due 2026-11-05 · 5 days');
        expect(buildOverdueMessage({
            to   : '@neo-gemini-maryam',
            rows : [{id: 'row-1', due: '2026-11-05'}],
            today: '2026-11-10'
        }).subject).toBe('[overdue · 1 rows]');

        const inFlightState = {running: true, lastRunAt: Date.parse('2026-11-10T08:00:00.000Z')};
        expect(hasRunOnUtcDate(inFlightState, TODAY)).toBe(false);

        const completedState = {running: false, lastRunAt: Date.parse('2026-11-10T08:00:00.000Z')};
        expect(hasRunOnUtcDate(completedState, TODAY)).toBe(true);

        const unknownOwnerFile = writeRegisterFixture(tmpDir, {
            schema: DATED_ITEMS_SCHEMA,
            rows  : [{
                id   : 'stranger-row',
                state: 'open',
                owner: 'not-a-registered-seat',
                due  : '2026-11-01'
            }]
        }, 'unknown-owner.json');

        const sent = [];
        await runDatedItemsOverdue({
            sourcePath     : unknownOwnerFile,
            now            : TODAY,
            knownIdentities: ['@neo-fable-mnemosyne'],
            sendMessage    : async msg => sent.push(msg)
        });

        expect(sent).toEqual([{
            to     : 'AGENT:*',
            subject: '[overdue · 1 rows]',
            body   : [
                'stranger-row · due 2026-11-01 · 9 days',
                DATED_ITEMS_OVERDUE_RULE_SENTENCE
            ].join('\n')
        }]);
    });
});
