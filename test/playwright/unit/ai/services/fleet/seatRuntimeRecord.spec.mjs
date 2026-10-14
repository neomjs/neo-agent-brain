import {expect, test} from '@playwright/test';
import {createSeatRuntimeRecord, isSeatRuntimeRecord, isSeatRuntimeSnapshot, seatRuntimeSnapshot}
    from '../../../../../../ai/services/fleet/seatRuntimeRecord.mjs';

/** @summary A fresh observed Start with deliberately noisy internal fields that must never persist. */
function fixture(harnessType = 'codex-desktop') {
    const id = 'a'.repeat(64), directory = `/runtime/${id}`;
    return {id: 'seat', harnessType, pid: 42, pidStartedAt: 'Wed Oct 14 10:00:00 2026',
        startedAt: '2026-10-14T08:00:00Z', cwd: '/managed/seat/repo', instanceHome: '/managed/seat/profile',
        launchCommand: '/apps/harness', profileArg: '--user-data-dir=/managed/seat/profile',
        runtimeGeneration: {id, directory, runtimeRoot: `${directory}/host.runtime/organism`,
            executable: `${directory}/host.runtime/node`, payloadDigest: 'b'.repeat(64)},
        state: 'running', env: {GH_TOKEN: 'fixture-secret'}, child: {private: true}};
}

test('original Start custody is closed metadata, detached from the live process and its secrets', () => {
    const record = fixture();
    record.runtimeStart = createSeatRuntimeRecord({record, identity: 'seat-login', plan: [{key: 'memory-core'}], leaseRequired: true});
    const snapshot = seatRuntimeSnapshot(record);
    expect(isSeatRuntimeSnapshot(snapshot)).toBe(true);
    expect(snapshot.start.runtime.id).toBe('a'.repeat(64));
    expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
    expect(snapshot.start).not.toHaveProperty('env');
    expect(snapshot.start).not.toHaveProperty('child');
    expect(isSeatRuntimeRecord({...snapshot.start, env: {GH_TOKEN: 'fixture-secret'}})).toBe(false);
    snapshot.start.runtime.id = 'c'.repeat(64);
    expect(record.runtimeStart.runtime.id).toBe('a'.repeat(64));
});

test('lease-required records need observed birth; malformed or absent original process facts cannot be filled from a pin', () => {
    for (const change of [{pid: null}, {pidStartedAt: null}, {cwd: null}, {instanceHome: 'relative'}, {startedAt: 'invalid'}]) {
        expect(() => createSeatRuntimeRecord({record: {...fixture(), ...change}, identity: 'seat-login', plan: [], leaseRequired: true}))
            .toThrow(/incomplete or invalid/);
    }
    const record = {...fixture(), pidStartedAt: null};
    expect(isSeatRuntimeRecord(createSeatRuntimeRecord({record, identity: 'seat-login', plan: [], leaseRequired: false}))).toBe(true);
});

test('a Desktop admission binds the exact profile digest and grants, and rejects extra secret-bearing profile data', () => {
    const record = {...fixture('claude-desktop'), admissionGeneration: 'original-admission'};
    const profile = {version: 1, identity: 'seat-login', issuer: 'http://127.0.0.1:47123', projectionSha256: 'c'.repeat(64),
        grants: {'memory-core': {id: 'a'.repeat(22), sha256: 'd'.repeat(64)}}};
    const options = {record, identity: 'seat-login', plan: [{key: 'memory-core'}], leaseRequired: true, profile};
    expect(createSeatRuntimeRecord(options).profile).toEqual(profile);
    for (const changed of [null, {...profile, identity: 'another-seat'}, {...profile, env: {GH_TOKEN: 'secret'}}]) {
        expect(() => createSeatRuntimeRecord({...options, profile: changed})).toThrow(/incomplete or invalid/);
    }
    expect(createSeatRuntimeRecord(options).planSha256)
        .not.toBe(createSeatRuntimeRecord({...options, plan: [{key: 'neural-link'}]}).planSha256);
});
