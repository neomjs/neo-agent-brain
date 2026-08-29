import {test, expect} from '@playwright/test';

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

import {
    PLAN_STATUSES,
    planCourierPass,
    recordCourierOutcome,
    runCourierCli
} from '../../../../../../ai/daemons/wake/courierDrain.mjs';

import {
    deliverClaudeCourier,
    enqueueCourierEntry,
    listOutboxEntries
} from '../../../../../../ai/daemons/wake/claudeCourierTransport.mjs';

/**
 * The courier half. These arms exist because the spool hop is where a wake can quietly become a
 * *misdelivery* rather than a non-delivery: the entry snapshots how a seat looked at enqueue time,
 * and a drain that trusts that snapshot addresses whatever holds the pid now. The central arm is
 * therefore the one that restarts the seat between spooling and draining and demands the live
 * name — it fails if the implementation ever reads an address out of the entry.
 */

const
    GRACE_CWD = '/Users/Shared/claude/neomjs/neo',
    VEGA_CWD  = '/Users/Shared/opus-vega/neomjs/neo';

/**
 * @summary Fresh outbox/receipts pair under a real temp root, so the atomic write path runs.
 * @returns {{outboxDir: String, receiptsDir: String}}
 */
function makeDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-drain-'));

    return {outboxDir: path.join(root, 'outbox'), receiptsDir: path.join(root, 'receipts')}
}

/**
 * @summary Spools one entry in the shape the producer writes.
 * @param {String} outboxDir
 * @param {Object} [overrides]
 * @returns {String} The spool file path.
 */
function spool(outboxDir, overrides={}) {
    const entry = {
        schemaVersion : '1.0',
        eventId       : 'evt-1',
        subscriptionId: 'WAKE_SUB:x',
        targetIdentity: '@neo-opus-grace',
        targetCwd     : GRACE_CWD,
        targetPid     : 101,
        targetSocket  : '/tmp/cc-socks/101.sock',
        subject       : 'review requested',
        digest        : '[wake] review requested on #30',
        enqueuedAt    : new Date().toISOString(),
        ...overrides
    };

    return enqueueCourierEntry({outboxDir, entry, eventId: entry.eventId}).file
}

const session = (pid, cwd, name) => ({pid, cwd, name, socketPath: `/tmp/cc-socks/${pid}.sock`});

test.describe('courier drain — addressing', () => {

    test('re-resolves the live session name after the seat restarted, never the spooled snapshot', () => {
        const {outboxDir} = makeDirs();

        spool(outboxDir, {targetPid: 101});

        // Same seat, same cwd, new session: different pid AND a different derived name. A drain
        // that addressed by anything carried in the entry cannot produce 'neo-81' here.
        const plan = planCourierPass({outboxDir, sessions: [session(202, GRACE_CWD, 'neo-81')]});

        expect(plan.readyCount).toBe(1);
        expect(plan.entries[0].status).toBe('ready');
        expect(plan.entries[0].sessionName).toBe('neo-81');
        expect(plan.entries[0].pidNow).toBe(202);
        expect(plan.entries[0].pidAtEnqueue).toBe(101);
        expect(plan.entries[0].pidChanged).toBe(true);
        expect(plan.entries[0].message).toBe('[wake] review requested on #30')
    });

    test('does not route one seat\'s wake into another seat\'s session', () => {
        const {outboxDir} = makeDirs();

        spool(outboxDir);

        // Vega is live, Grace is not. The wake is Grace's; a prefix rule that leaked would hand a
        // seat's coordination traffic to the wrong maintainer.
        const plan = planCourierPass({outboxDir, sessions: [session(303, VEGA_CWD, 'neo-b2')]});

        expect(plan.entries[0].status).toBe('no-live-session');
        expect(plan.entries[0].sessionName).toBeUndefined();
        expect(plan.readyCount).toBe(0)
    });

    test('resolves a worktree session running inside the seat clone', () => {
        const {outboxDir} = makeDirs();

        spool(outboxDir);

        const plan = planCourierPass({
            outboxDir,
            sessions: [session(404, path.join(GRACE_CWD, '.claude/worktrees/lane-a'), 'neo-wt')]
        });

        expect(plan.entries[0].status).toBe('ready');
        expect(plan.entries[0].sessionName).toBe('neo-wt')
    });

    test('reports a tie instead of guessing between two equally deep sessions', () => {
        const {outboxDir} = makeDirs();

        spool(outboxDir);

        const plan = planCourierPass({
            outboxDir,
            sessions: [
                session(1, path.join(GRACE_CWD, '.claude/worktrees/a'), 'neo-a'),
                session(2, path.join(GRACE_CWD, '.claude/worktrees/b'), 'neo-b')
            ]
        });

        expect(plan.entries[0].status).toBe('ambiguous');
        expect(plan.entries[0].sessionName).toBeUndefined();
        expect(plan.entries[0].detail).toContain('1+2')
    });

    test('blocks an entry that carries no targetCwd rather than inferring one', () => {
        const {outboxDir} = makeDirs();
        const file        = spool(outboxDir);

        // Simulate a pre-`targetCwd` entry: the binding's authority lives on the route, so there is
        // nothing here to re-resolve against and guessing would re-derive it from a convention.
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete entry.targetCwd;
        fs.writeFileSync(file, JSON.stringify(entry));

        const plan = planCourierPass({outboxDir, sessions: [session(202, GRACE_CWD, 'neo-81')]});

        expect(plan.entries[0].status).toBe('unroutable-entry');
        expect(plan.entries[0].detail).toContain('targetCwd');
        expect(plan.blockedCount).toBe(1)
    });

    test('every plan status is a declared one', () => {
        const {outboxDir} = makeDirs();

        spool(outboxDir, {eventId: 'evt-live'});
        spool(outboxDir, {eventId: 'evt-dead', targetCwd: VEGA_CWD, targetIdentity: '@neo-opus-vega'});

        const plan = planCourierPass({outboxDir, sessions: [session(202, GRACE_CWD, 'neo-81')]});

        expect(plan.entries).toHaveLength(2);
        plan.entries.forEach(item => expect(PLAN_STATUSES).toContain(item.status))
    })
});

test.describe('courier drain — outcomes', () => {

    test('writes the receipt and retires the entry on a confirmed delivery', () => {
        const {outboxDir, receiptsDir} = makeDirs();
        const file                     = spool(outboxDir);

        const result = recordCourierOutcome({receiptsDir, file, eventId: 'evt-1', outcome: 'delivered', detail: 'sent to neo-81'});

        expect(result.retired).toBe(true);
        expect(listOutboxEntries({outboxDir})).toHaveLength(0);

        const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));

        expect(receipt.outcome).toBe('delivered');
        expect(receipt.eventId).toBe('evt-1');
        expect(receipt.detail).toBe('sent to neo-81')
    });

    test('keeps the entry on an error outcome so a transient failure is retried, not discarded', () => {
        const {outboxDir, receiptsDir} = makeDirs();
        const file                     = spool(outboxDir);

        const result = recordCourierOutcome({receiptsDir, file, eventId: 'evt-1', outcome: 'error', detail: 'no live session'});

        expect(result.retired).toBe(false);
        expect(listOutboxEntries({outboxDir})).toHaveLength(1);
        expect(JSON.parse(fs.readFileSync(result.receipt, 'utf8')).outcome).toBe('error')
    });

    test('writes the receipt BEFORE retiring, so a crash between the two loses no proof', () => {
        const {outboxDir, receiptsDir} = makeDirs();
        const file                     = spool(outboxDir);

        // Fail exactly at the retire step. If the order were reversed the receipt would never be
        // written and the wake would be both undelivered and unrecorded — the silent loss this
        // whole transport exists to remove.
        const exploding = {
            ...fs,
            rmSync() {
                throw new Error('crash during retire')
            }
        };

        expect(() => recordCourierOutcome({
            receiptsDir, file, eventId: 'evt-1', outcome: 'delivered', fs: exploding
        })).toThrow('crash during retire');

        expect(fs.existsSync(path.join(receiptsDir, 'evt-1.json'))).toBe(true);
        expect(listOutboxEntries({outboxDir})).toHaveLength(1)
    });

    test('rejects an outcome outside the declared vocabulary', () => {
        const {outboxDir, receiptsDir} = makeDirs();
        const file                     = spool(outboxDir);

        expect(() => recordCourierOutcome({receiptsDir, file, eventId: 'evt-1', outcome: 'probably-fine'}))
            .toThrow(/must be one of/);

        expect(listOutboxEntries({outboxDir})).toHaveLength(1)
    })
});

test.describe('courier drain — producer seam and CLI', () => {

    test('an entry the producer spools is drainable by the courier, end to end', async () => {
        const dirs = makeDirs();

        const result = await deliverClaudeCourier({
            digest : '[wake] end to end',
            effects: {
                courierDirs    : dirs,
                sessionRegistry: [session(101, GRACE_CWD, 'neo-at-enqueue')]
            },
            meta  : {},
            record: {
                eventId       : 'evt-seam',
                subscriptionId: 'WAKE_SUB:seam',
                route         : {
                    agentIdentity: '@neo-opus-grace',
                    adapterConfig: {courierIdentityCwdMap: [{identity: '@neo-opus-grace', cwd: GRACE_CWD}]}
                }
            }
        });

        expect(result.outcome).toBe('delivered');
        expect(result.outcomeReason).toBe('courier-spool-accepted');

        // The seam that matters: the producer must carry the stable cwd binding, or the courier
        // has nothing to re-resolve against and every wake lands as `unroutable-entry`.
        const plan = planCourierPass({outboxDir: dirs.outboxDir, sessions: [session(999, GRACE_CWD, 'neo-at-drain')]});

        expect(plan.entries[0].status).toBe('ready');
        expect(plan.entries[0].sessionName).toBe('neo-at-drain');
        expect(plan.entries[0].message).toBe('[wake] end to end')
    });

    test('the CLI maps --event-id onto eventId and records the outcome', () => {
        const {outboxDir, receiptsDir} = makeDirs();
        const file                     = spool(outboxDir);

        const code = runCourierCli([
            'complete', '--file', file, '--event-id', 'evt-1', '--outcome', 'delivered',
            '--receipts-dir', receiptsDir, '--outbox-dir', outboxDir
        ]);

        expect(code).toBe(0);
        expect(fs.existsSync(path.join(receiptsDir, 'evt-1.json'))).toBe(true);
        expect(listOutboxEntries({outboxDir})).toHaveLength(0)
    });

    test('the CLI refuses an incomplete or undeclared completion', () => {
        expect(runCourierCli(['complete', '--file', '/tmp/x'])).toBe(2);
        expect(runCourierCli(['complete', '--file', '/tmp/x', '--event-id', 'e', '--outcome', 'nope'])).toBe(2);
        expect(runCourierCli(['nonsense'])).toBe(2)
    })
});
