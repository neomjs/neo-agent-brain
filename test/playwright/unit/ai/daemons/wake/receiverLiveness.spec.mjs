import {test, expect} from '@playwright/test';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';

import {
    createReceiverLiveness,
    projectReceiverLiveness,
    readReceiverLiveness,
    RECEIVER_LIVENESS_FILE
} from '../../../../../../ai/daemons/wake/receiverLiveness.mjs';

/**
 * The receiver's own liveness account: the fact a hung accept path hides. The records say what happened
 * to each wake, and nothing else can say the receiver has accepted none for hours.
 */
test.describe('ai/daemons/wake/receiverLiveness', () => {
    const
        HOUR = 60 * 60 * 1000,
        T0   = Date.parse('2026-10-04T16:00:00.000Z'),
        iso  = ms => new Date(ms).toISOString(),
        quiet = {error() {}};

    let dir;

    test.beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-wake-liveness-'))
    });

    test.afterEach(async () => {
        await fs.rm(dir, {recursive: true, force: true})
    });

    test('an absent account reads unknown, never fresh', async () => {
        expect(await readReceiverLiveness(dir)).toBeNull();
        expect(projectReceiverLiveness(null, T0)).toEqual({state: 'unknown'});

        await fs.writeFile(path.join(dir, RECEIVER_LIVENESS_FILE), '{not json');
        expect(await readReceiverLiveness(dir), 'a torn file is no evidence').toBeNull();
    });

    test('an account written 12 h ago reads 12 h old, with no start or stuck exit in the last hour', () => {
        const stale = {
            starts      : [iso(T0 - 12 * HOUR)],
            lastAcceptAt: iso(T0 - 12 * HOUR),
            lastSweepAt : iso(T0 - 12 * HOUR),
            stuckExits  : [{step: 'accept', at: iso(T0 - 12 * HOUR)}]
        };

        expect(projectReceiverLiveness(stale, T0)).toMatchObject({
            state             : 'observed',
            lastAcceptAgeMs   : 12 * HOUR,
            lastSweepAgeMs    : 12 * HOUR,
            startsLastHour    : 0,
            stuckExitsLastHour: 0,
            lastStuckExit     : {step: 'accept'}
        });
    });

    test('the writer stamps a start, an accept and a sweep, and a fresh account reads fresh with no stuck exit', async () => {
        let clock = T0;
        const liveness = createReceiverLiveness({recordsDir: dir, now: () => new Date(clock), logger: quiet});

        await liveness.start();
        clock += 1000;
        await liveness.accepted();
        clock += 1000;
        await liveness.swept();

        const projected = projectReceiverLiveness(await readReceiverLiveness(dir), clock);

        expect(projected).toMatchObject({
            state             : 'observed',
            startedAt         : iso(T0),
            lastAcceptAgeMs   : 1000,
            lastSweepAgeMs    : 0,
            startsLastHour    : 1,
            stuckExitsLastHour: 0,
            lastStuckExit     : null
        });
    });

    test('a stuck exit is on disk the moment the call returns, and the next start keeps it', async () => {
        let clock = T0;
        const first = createReceiverLiveness({recordsDir: dir, now: () => new Date(clock), logger: quiet});

        await first.start();
        clock += 5000;
        // no await: the process exits right after this call
        first.stuck({step: 'accept'});

        expect((await readReceiverLiveness(dir)).stuckExits).toEqual([{step: 'accept', at: iso(T0 + 5000)}]);

        clock += 10_000;
        await createReceiverLiveness({recordsDir: dir, now: () => new Date(clock), logger: quiet}).start();

        expect(projectReceiverLiveness(await readReceiverLiveness(dir), clock)).toMatchObject({
            startedAt         : iso(T0 + 15_000),
            startsLastHour    : 2,
            stuckExitsLastHour: 1,
            lastStuckExit     : {step: 'accept', at: iso(T0 + 5000)}
        });
    });

    test('a crash loop keeps the last twenty starts, not every one', async () => {
        let clock = T0;

        for (let i = 0; i < 25; i++) {
            clock += 1000;
            await createReceiverLiveness({recordsDir: dir, now: () => new Date(clock), logger: quiet}).start();
        }

        const account = await readReceiverLiveness(dir);

        expect(account.starts).toHaveLength(20);
        expect(account.starts.at(-1)).toBe(iso(clock));
    });
});
