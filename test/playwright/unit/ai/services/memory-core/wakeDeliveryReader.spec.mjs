import {expect, test}    from '@playwright/test';
import fs                 from 'fs/promises';
import os                 from 'os';
import path               from 'path';
import {readWakeDelivery, defaultWakeReceiverDirs} from
    '../../../../../../ai/services/memory-core/wakeDeliveryReader.mjs';

/**
 * The reader's whole job is the distinction between "I looked and there is nothing" and "I could
 * not look". #17647 is the mirror-image sibling: off, dead and blind arriving as one payload. This
 * is the same conflation one level down — an absent records directory and an unreadable one are
 * different facts, and a reader that reports both as "no failures" is an instrument that cannot be
 * wrong, which is the property that let a 19-day delivery outage read healthy everywhere.
 */

const tmpRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'wake-delivery-reader-'));

async function writeRecord(directory, record) {
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, `${record.recordKey}.json`), JSON.stringify(record));
}

test.describe('readWakeDelivery — the I/O half of the delivery projection', () => {

    test('projects a real directory of records into per-subscription verdicts', async () => {
        const root    = await tmpRoot(),
              records = path.join(root, 'records');

        await writeRecord(records, {
            recordKey: 'k1', subscriptionId: 'WAKE_SUB:ok', state: 'delivered',
            acceptedAt: '2026-09-25T00:00:00.000Z', dispatchFinishedAt: '2026-09-25T00:00:01.000Z'
        });
        await writeRecord(records, {
            recordKey: 'k2', subscriptionId: 'WAKE_SUB:broken', state: 'failed',
            acceptedAt: '2026-09-25T00:00:00.000Z', dispatchFinishedAt: '2026-09-25T00:00:01.000Z',
            outcomeReason: "opencode-server envelope requires 'agentIdentity'"
        });

        const {deliveryReadable, deliveryReadReason, subscriptions} = await readWakeDelivery({recordsDir: records});

        expect(deliveryReadable).toBe(true);
        expect(deliveryReadReason).toBe('observed');
        expect(subscriptions['WAKE_SUB:ok'].state).toBe('reachable');
        expect(subscriptions['WAKE_SUB:broken'].state).toBe('unreachable');
        expect(subscriptions['WAKE_SUB:broken'].consecutiveFailures).toBe(1);
        expect(subscriptions['WAKE_SUB:broken'].lastOutcomeReason).toBe("opencode-server envelope requires 'agentIdentity'");

        await fs.rm(root, {recursive: true, force: true});
    });

    test('an ABSENT records directory is a measured absence, not a failure and not health', async () => {
        // Nothing has ever been dispatched from here. That is a fact about attempts, and it is
        // emphatically not evidence that any seat is reachable.
        const root = await tmpRoot();

        const {deliveryReadable, deliveryReadReason, subscriptions} =
            await readWakeDelivery({recordsDir: path.join(root, 'never-created')});

        expect(deliveryReadable, 'the directory was looked for and is not there — that IS readable').toBe(true);
        expect(deliveryReadReason).toBe('no-records');
        expect(subscriptions, 'no subscription may be invented out of an absence').toEqual({});

        await fs.rm(root, {recursive: true, force: true});
    });

    test('an UNREADABLE records directory reports unknown, never healthy', async () => {
        // A file where a directory is expected: readdir fails with ENOTDIR, which is NOT an
        // absence. The question could not be asked, so nothing here may resolve in the healthy
        // direction — this is the arm that keeps a permission wall from reading as a clean bill.
        const root = await tmpRoot();

        await fs.writeFile(path.join(root, 'records'), 'not a directory');

        const {deliveryReadable, deliveryReadReason, subscriptions} =
            await readWakeDelivery({recordsDir: path.join(root, 'records')});

        expect(deliveryReadable).toBe(false);
        expect(deliveryReadReason).toBe('unreadable');
        expect(subscriptions).toEqual({});

        await fs.rm(root, {recursive: true, force: true});
    });

    test('a malformed record is skipped, never guessed into a delivery', async () => {
        const root    = await tmpRoot(),
              records = path.join(root, 'records');

        await fs.mkdir(records, {recursive: true});
        await fs.writeFile(path.join(records, 'good.json'), JSON.stringify({
            recordKey: 'k1', subscriptionId: 'WAKE_SUB:a', state: 'delivered',
            acceptedAt: '2026-09-25T00:00:00.000Z', dispatchFinishedAt: '2026-09-25T00:00:01.000Z'
        }));
        await fs.writeFile(path.join(records, 'truncated.json'), '{"recordKey": "k2", "subscr');

        const {subscriptions} = await readWakeDelivery({recordsDir: records});

        expect(subscriptions['WAKE_SUB:a'].state, 'the parseable record still projects').toBe('reachable');

        await fs.rm(root, {recursive: true, force: true});
    });

    test('the conventional records directory matches the deployed host layout', async () => {
        // Pinned because the reader's default is a host CONVENTION rather than a declared contract
        // (see this module's header). If the deployment moves, this arm is the one that says so
        // instead of the projection quietly reporting zero subscriptions forever.
        const {recordsDir, stateDir} = defaultWakeReceiverDirs(() => '/home/seat');

        expect(stateDir).toBe('/home/seat/Library/Application Support/Neo/AgentOS/wake/state');
        expect(recordsDir).toBe('/home/seat/Library/Application Support/Neo/AgentOS/wake/state/records');
    });
});
