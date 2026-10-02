import {expect, test}     from '@playwright/test';
import Neo                from 'neo.mjs/src/Neo.mjs';
import * as core          from 'neo.mjs/src/core/_export.mjs';
import {execFileSync}     from 'child_process';
import fs                 from 'fs/promises';
import os                 from 'os';
import path               from 'path';
import {pathToFileURL}    from 'url';
import {readWakeDelivery} from '../../../../../../ai/services/memory-core/wakeDeliveryReader.mjs';

/**
 * The reader's whole job is the distinction between "I looked and there is nothing" and "I could
 * not look". Its mirror image is off, dead and blind arriving as one payload, and this is the same
 * conflation one level down — an absent records directory and an unreadable one are
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

    test('an undeclared records directory reads unconfigured, distinct from a declared empty one', async () => {
        const result = await readWakeDelivery({recordsDir: ''});

        expect(result).toEqual({deliveryReadable: false, deliveryReadReason: 'unconfigured', subscriptions: {}})
    });

    test('with no declaration the reader reads the config leaf, never a guessed home path', async () => {
        // A record planted where the old home convention looked: a reader that still guessed would
        // read it and answer `observed`. The config resolves its env once, in the process that loads
        // it, so each case runs in a child with exactly the env under test.
        const
            home    = await tmpRoot(),
            guessed = path.join(home, 'Library/Application Support/Neo/AgentOS/wake/state/records'),
            reader  = pathToFileURL(path.resolve('ai/services/memory-core/wakeDeliveryReader.mjs')).href,
            script  = [
                "await import('neo.mjs/src/Neo.mjs');",
                "await import('neo.mjs/src/core/_export.mjs');",
                `const {readWakeDelivery} = await import(${JSON.stringify(reader)});`,
                "process.stdout.write('\\nDELIVERY=' + JSON.stringify(await readWakeDelivery()));"
            ].join('\n'),
            readIn  = env => {
                const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
                    encoding: 'utf8',
                    env     : {PATH: process.env.PATH, HOME: home, UNIT_TEST_MODE: 'true', ...env}
                });

                return JSON.parse(output.slice(output.lastIndexOf('DELIVERY=') + 'DELIVERY='.length))
            };

        await writeRecord(guessed, {
            recordKey: 'k1', subscriptionId: 'WAKE_SUB:home', state: 'delivered',
            acceptedAt: '2026-09-25T00:00:00.000Z', dispatchFinishedAt: '2026-09-25T00:00:01.000Z'
        });

        expect(readIn({}).deliveryReadReason, 'nothing declared').toBe('unconfigured');
        expect(readIn({NEO_WAKE_RECEIVER_RECORDS_DIR: path.join(home, 'declared-absent')}).deliveryReadReason, 'declared, absent').toBe('no-records');
        expect(readIn({NEO_WAKE_RECEIVER_RECORDS_DIR: guessed}).deliveryReadReason, 'declared, with records').toBe('observed');

        await fs.rm(home, {recursive: true, force: true});
    });
});
