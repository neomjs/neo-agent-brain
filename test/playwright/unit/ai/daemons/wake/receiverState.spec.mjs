import {test, expect} from '@playwright/test';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';

import {
    getWakeRecordKey,
    RECORD_RETENTION_MS,
    RETIRED_INDEX_FILE,
    WakeReceiverState
} from '../../../../../../ai/daemons/wake/receiverState.mjs';

const DAY = 24 * 60 * 60 * 1000;

test.describe('ai/daemons/wake/receiverState', () => {
    let state, stateDir;

    test.beforeEach(async () => {
        stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-wake-receiver-state-'));
        state    = new WakeReceiverState({stateDir});
        await state.init();
    });

    test.afterEach(async () => {
        await fs.rm(stateDir, {recursive: true, force: true});
    });

    const accept = (overrides = {}) => state.accept({
        subscriptionId: 'WAKE_SUB:test',
        eventId       : 'wake-digest:event-1',
        sourceEventIds: ['MESSAGE:1'],
        envelope      : {eventId: 'wake-digest:event-1'},
        route         : {agentIdentity: '@neo-gpt', harnessTargetMetadata: {adapter: 'test'}},
        ...overrides
    });

    test('stable source ids determine the retry-safe record key independent of order/event id', () => {
        const first = getWakeRecordKey({
            subscriptionId: 'WAKE_SUB:test',
            eventId       : 'event-a',
            sourceEventIds: ['MESSAGE:2', 'MESSAGE:1']
        });
        const second = getWakeRecordKey({
            subscriptionId: 'WAKE_SUB:test',
            eventId       : 'event-b',
            sourceEventIds: ['MESSAGE:1', 'MESSAGE:2']
        });

        expect(first).toBe(second);
        expect(first).toMatch(/^[a-f0-9]{64}$/);
    });

    test('accepts once, fsyncs a 0600 pending record, and dedupes retries', async () => {
        const first  = await accept();
        const second = await accept({eventId: 'wake-digest:retry'});
        const stat   = await fs.stat(state.getRecordPath(first.record.recordKey));

        expect(first.status).toBe('accepted');
        expect(second.status).toBe('duplicate');
        expect(second.record.recordKey).toBe(first.record.recordKey);
        expect(first.record.state).toBe('pending');
        expect(stat.mode & 0o777).toBe(0o600);
        expect(await state.list()).toHaveLength(1);
    });

    test('restart preserves pending records but terminalizes interrupted dispatch as unknown', async () => {
        const pending     = await accept();
        const interrupted = await accept({
            eventId       : 'wake-digest:event-2',
            sourceEventIds: ['MESSAGE:2']
        });

        await state.transition(interrupted.record.recordKey, 'pending', 'dispatching');
        expect(await state.recoverInterrupted()).toBe(1);

        expect((await state.read(pending.record.recordKey)).state).toBe('pending');
        expect((await state.read(interrupted.record.recordKey))).toMatchObject({
            state        : 'unknown',
            outcomeReason: 'receiver-restarted-during-non-idempotent-dispatch'
        });
    });

    test('restart replays only an interrupted native attempt for receipt reconciliation', async () => {
        const native = await accept({eventId: 'native', sourceEventIds: [],
            route: {agentIdentity: '@neo-gpt', harnessTargetMetadata: {adapter: 'primary-session'}}});
        await state.transition(native.record.recordKey, 'pending', 'dispatching');
        expect(await state.recoverInterrupted()).toBe(1);
        expect(await state.read(native.record.recordKey)).toMatchObject({state: 'pending', outcomeReason: 'receiver-restarted-native-reconciliation'});
    });

    test('a stale expected state cannot regress a terminal record', async () => {
        const accepted = await accept();
        await state.transition(accepted.record.recordKey, 'pending', 'dispatching');
        await state.transition(accepted.record.recordKey, 'dispatching', 'delivered');

        expect(await state.transition(accepted.record.recordKey, 'pending', 'dispatching')).toBeNull();
        expect((await state.read(accepted.record.recordKey)).state).toBe('delivered');
    });

    test('a terminal record is final: no transition starts from a terminal state', async () => {
        // The Memory Core's wake delivery reader holds terminal records by file name and never
        // re-reads them, so a rewrite of one would go unseen. The refusal keeps that hold honest.
        const accepted = await accept();
        await state.transition(accepted.record.recordKey, 'pending', 'dispatching');
        await state.transition(accepted.record.recordKey, 'dispatching', 'failed');

        await expect(state.transition(accepted.record.recordKey, 'failed', 'pending')).rejects.toThrow("A 'failed' record is final");
        expect((await state.read(accepted.record.recordKey)).state).toBe('failed');
    });

    test('dispatching returns to pending on a context-gate deferral (#16682), keeping the wake replayable', async () => {
        const accepted = await accept();
        await state.transition(accepted.record.recordKey, 'pending', 'dispatching');

        const deferred = await state.transition(accepted.record.recordKey, 'dispatching', 'pending', {
            deferCount         : 1,
            deferReason        : 'context-gate:700000>250000',
            probedContextTokens: 700_000
        });

        expect(deferred).toMatchObject({
            state              : 'pending',
            deferCount         : 1,
            deferReason        : 'context-gate:700000>250000',
            probedContextTokens: 700_000
        });

        // The deferred record stays in the only replayable state: the next drain picks it up…
        expect(await state.list('pending')).toHaveLength(1);
        // …a boot recovery does NOT terminalize it (only crash-interrupted dispatches are)…
        expect(await state.recoverInterrupted()).toBe(0);
        // …and it can re-enter dispatch cleanly when the session shrinks or rotates.
        expect(await state.transition(accepted.record.recordKey, 'pending', 'dispatching')).not.toBeNull();
    });

    test.describe('retention (#1931)', () => {
        const now     = Date.now(),
              expired = new Date(now - RECORD_RETENTION_MS - DAY).toISOString(),
              recent  = new Date(now - DAY).toISOString();

        const acceptDelivered = async overrides => {
            const accepted = await accept(overrides);

            await state.transition(accepted.record.recordKey, 'pending', 'delivered');
            return accepted.record.recordKey
        };

        const exists = filePath => fs.access(filePath).then(() => true, () => false);

        test('retires a terminal record past the window into the archive and keeps every other file', async () => {
            const old          = await acceptDelivered({acceptedAt: expired, sourceEventIds: ['MESSAGE:old']}),
                  young        = await acceptDelivered({acceptedAt: recent, sourceEventIds: ['MESSAGE:young']}),
                  stalePending = (await accept({acceptedAt: expired, sourceEventIds: ['MESSAGE:pending']})).record.recordKey,
                  dispatching  = (await accept({acceptedAt: expired, sourceEventIds: ['MESSAGE:dispatching']})).record.recordKey,
                  liveness     = path.join(state.recordsDir, 'receiver.liveness');

            await state.transition(dispatching, 'pending', 'dispatching');
            await fs.writeFile(liveness, '{}');

            expect(await state.pruneRecords({now})).toBe(1);
            expect(await exists(state.getRecordPath(old))).toBe(false);
            expect(JSON.parse(await fs.readFile(state.getArchivePath(old), 'utf8')).state).toBe('delivered');

            for (const kept of [young, stalePending, dispatching]) {
                expect(await exists(state.getRecordPath(kept))).toBe(true);
            }
            expect(await exists(liveness)).toBe(true);
            expect((await fs.stat(state.archiveDir)).mode & 0o777).toBe(0o700);
        });

        test('keeps each retired fate in the retired index, never its envelope or route, and never as a record', async () => {
            await acceptDelivered({acceptedAt: expired, sourceEventIds: ['MESSAGE:a', 'MESSAGE:b']});
            await acceptDelivered({acceptedAt: expired, eventId: 'wake:event-only', sourceEventIds: []});

            expect(await state.pruneRecords({now})).toBe(2);

            const indexPath = path.join(state.recordsDir, RETIRED_INDEX_FILE),
                  lines     = (await fs.readFile(indexPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

            // the event-only record names no message, so no verdict could read a line for it
            expect(lines).toEqual([{state: 'delivered', sourceEventIds: ['MESSAGE:a', 'MESSAGE:b'], acceptedAt: expired, updatedAt: expect.any(String)}]);
            expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o600);
            expect(await state.list()).toHaveLength(0);
        });

        test('a retired key answers duplicate for an event-id key and a source-set key before staging anything', async () => {
            const byEvent     = await acceptDelivered({acceptedAt: expired, eventId: 'wake:event-only', sourceEventIds: []}),
                  bySource    = await acceptDelivered({acceptedAt: expired}),
                  writeSynced = state._writeSynced.bind(state),
                  staged      = [];

            expect(await state.pruneRecords({now})).toBe(2);

            state._writeSynced = (filePath, text) => {
                staged.push(filePath);
                return writeSynced(filePath, text)
            };

            const replayedEvent  = await accept({eventId: 'wake:event-only', sourceEventIds: []}),
                  replayedSource = await accept({eventId: 'wake-digest:re-derived'});

            expect(replayedEvent).toMatchObject({status: 'duplicate', record: {recordKey: byEvent, state: 'delivered'}});
            expect(replayedSource).toMatchObject({status: 'duplicate', record: {recordKey: bySource, state: 'delivered'}});
            expect(staged).toEqual([]);
            expect(await state.list()).toHaveLength(0);
        });

        test('every directory on the archive path and the index are durable before the live file goes', async () => {
            const key           = await acceptDelivered({acceptedAt: expired}),
                  live          = state.getRecordPath(key),
                  syncDirectory = state._syncDirectory.bind(state),
                  appendRetired = state._appendRetired.bind(state),
                  steps         = [];

            state._syncDirectory = async (directory = state.recordsDir, options = {}) => {
                steps.push({sync: directory, strict: Boolean(options.strict), live: await exists(live)});
                return syncDirectory(directory, options)
            };
            state._appendRetired = async records => {
                steps.push({index: records.length, live: await exists(live)});
                return appendRetired(records)
            };

            expect(await state.pruneRecords({now})).toBe(1);
            expect(steps).toEqual([
                {sync: path.dirname(state.getArchivePath(key)), strict: true, live: true},
                {sync: state.archiveDir,                        strict: true, live: true},
                {sync: stateDir,                                strict: true, live: true},
                {index: 1,                                                    live: true},
                {sync: state.recordsDir,                        strict: false, live: false}
            ]);
        });

        test('a strict sync that fails or is unsupported keeps the live file, and the next pass finishes', async () => {
            const key           = await acceptDelivered({acceptedAt: expired}),
                  syncDirectory = state._syncDirectory.bind(state);

            state._syncDirectory = async (directory = state.recordsDir, options = {}) => {
                if (options.strict && directory === state.archiveDir) {
                    throw Object.assign(new Error('directory fsync unsupported'), {code: 'ENOTSUP'})
                }
                return syncDirectory(directory, options)
            };

            await expect(state.pruneRecords({now})).rejects.toThrow('directory fsync unsupported');
            expect(await exists(state.getRecordPath(key))).toBe(true);
            expect(await exists(path.join(state.recordsDir, RETIRED_INDEX_FILE))).toBe(false);

            state._syncDirectory = syncDirectory;

            expect(await state.pruneRecords({now})).toBe(1);
            expect(await exists(state.getRecordPath(key))).toBe(false);
            expect(await exists(state.getArchivePath(key))).toBe(true);
        });

        test('an accept racing a retirement answers duplicate: the archive check and the link hold one lock', async () => {
            const key         = await acceptDelivered({acceptedAt: expired}),
                  readRetired = state._readRetired.bind(state);
            let checked, release;

            const inCheck = new Promise(resolve => {checked = resolve}),
                  gate    = new Promise(resolve => {release = resolve});

            // The check reads the archive, then waits before the link: the window a retirement must not enter.
            state._readRetired = async recordKey => {
                const retired = await readRetired(recordKey);

                checked();
                await gate;
                return retired
            };

            const accepting = accept({eventId: 'wake-digest:re-derived'});

            await inCheck;

            const pruning = state.pruneRecords({now});

            // Without the lock the whole retirement fits inside the window, and the link then lands in an
            // empty slot. With it, the retirement waits for the link.
            await Promise.race([pruning, new Promise(resolve => setTimeout(resolve, 200))]);
            release();

            expect((await accepting).status).toBe('duplicate');
            expect(await pruning).toBe(1);
            expect(await state.list('pending')).toHaveLength(0);
            expect(await exists(state.getArchivePath(key))).toBe(true);
        });

        test('a pass interrupted after the archive link finishes the move on the next pass', async () => {
            const key = await acceptDelivered({acceptedAt: expired});

            await fs.mkdir(path.dirname(state.getArchivePath(key)), {recursive: true});
            await fs.link(state.getRecordPath(key), state.getArchivePath(key));

            expect(await state.pruneRecords({now})).toBe(1);
            expect(await exists(state.getRecordPath(key))).toBe(false);
            expect(await exists(state.getArchivePath(key))).toBe(true);
        });
    });
});
