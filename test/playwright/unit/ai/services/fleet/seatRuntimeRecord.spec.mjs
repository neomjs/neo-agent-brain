import {expect, test} from '@playwright/test';
import {createSeatRuntimeRecord, isSeatRuntimeRecord, isSeatRuntimeSnapshot, seatRuntimeSnapshot}
    from '../../../../../../ai/services/fleet/seatRuntimeRecord.mjs';
import {createManagedAgentWorkspacePlan}                                                     from '../../../../../../ai/services/fleet/managedAgentWorkspacePlan.mjs';
import path                                                                                  from 'node:path';
import {createAntigravityLaunchBinding, createDesktopLaunchBinding}                          from '../../../../../../ai/services/fleet/launchProfileCustody.mjs';
import {generateAntigravityMcpFiles}                                                         from '../../../../../../ai/services/fleet/generateAntigravityMcpFiles.mjs';
import {mintLaunchGrant}                                                                     from '../../../../../../ai/services/fleet/mcpLaunchAdmission.mjs';
import {isAdmissionSnapshot}                                                                 from '../../../../../../ai/services/fleet/launchAdmissionJournal.mjs';
import {SEAT_LIFECYCLE_READ_ONLY_STATES, SEAT_LIFECYCLE_ROW_FALLBACK, SEAT_LIFECYCLE_STATES} from 'neo-agent-brain/fleet-contract';

/** @summary A fresh observed Start with deliberately noisy internal fields that must never persist. */
function fixture(harnessType = 'codex-desktop') {
    const id = 'a'.repeat(64), directory = `/runtime/${id}`;
    return {id: 'seat', harnessType, pid: 42, pidStartedAt: 'Wed Oct 14 10:00:00 2026',
        startedAt        : '2026-10-14T08:00:00Z', cwd: '/managed/seat/repo', instanceHome: '/managed/seat/profile',
        launchCommand    : '/apps/harness', profileArg: '--user-data-dir=/managed/seat/profile',
        runtimeGeneration: {id, directory, runtimeRoot: `${directory}/host.runtime/organism`,
            executable: `${directory}/host.runtime/node`, payloadDigest: 'b'.repeat(64)},
        bridgeAuthority: {version: 1, source: 'registry-file', registryRoot: '/registry', publicKeySha256: 'e'.repeat(64)},
        state          : 'running', env: {GH_TOKEN: 'fixture-secret'}, child: {private: true}};
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
    expect(snapshot.start.bridgeAuthority).toEqual(record.bridgeAuthority);
    for (const authority of [null, {...record.bridgeAuthority, token: 'fixture-secret'}, {...record.bridgeAuthority, publicKeySha256: 'invalid'}]) {
        expect(isSeatRuntimeRecord({...snapshot.start, bridgeAuthority: authority})).toBe(false);
    }
    snapshot.start.runtime.id = 'c'.repeat(64);
    expect(record.runtimeStart.runtime.id).toBe('a'.repeat(64));
});

test('the snapshot state is the public seat lifecycle contract: every written word and the read-only word pass, a sixth word fails (#1201)', () => {
    const record = fixture();
    record.runtimeStart = createSeatRuntimeRecord({record, identity: 'seat-login', plan: [{key: 'memory-core'}], leaseRequired: true});
    const snapshot = seatRuntimeSnapshot(record);
    for (const state of [...SEAT_LIFECYCLE_STATES, ...SEAT_LIFECYCLE_READ_ONLY_STATES]) {
        expect(isSeatRuntimeSnapshot({...snapshot, state}), state).toBe(true);
    }
    for (const state of [SEAT_LIFECYCLE_ROW_FALLBACK, 'exploded', 'Running', '', null, undefined]) {
        expect(isSeatRuntimeSnapshot({...snapshot, state}), String(state)).toBe(false);
    }
});

test('Antigravity Starts require their exact native profile and workspace binding in the shared journal codec', () => {
    const record = {...fixture('antigravity'), admissionGeneration: 'original-admission'};
    const grant  = mintLaunchGrant(), identity = 'seat-login', issuer = 'http://127.0.0.1:47123';
    const rows   = {'neo-mjs-memory-core': {command: record.runtimeGeneration.executable,
        args: [path.join(record.runtimeGeneration.runtimeRoot, 'ai/mcp/client/fleetMcpLauncher.mjs'), '--server', 'memory-core'],
        env : {NEO_AGENT_IDENTITY: identity, NEO_FLEET_LAUNCH_ISSUER: issuer, NEO_FLEET_LAUNCH_GRANT: grant.capability}}};
    const generated = generateAntigravityMcpFiles({profileHome: record.instanceHome, rows, processEnvironment: {}});
    const profile   = createAntigravityLaunchBinding({identity, issuer, instanceHome: record.instanceHome,
        workspaceRoot: record.cwd, files: generated.files});
    const options = {record, identity, plan: [], leaseRequired: true, profile};
    record.runtimeStart = createSeatRuntimeRecord(options);
    expect(isAdmissionSnapshot({version: 6, generations: [], seats: [seatRuntimeSnapshot(record)]})).toBe(true);
    for (const changed of [null, {...profile, instanceHome: '/other/profile'}, {...profile, workspaceRoot: '/other/workspace'},
        createDesktopLaunchBinding({rows, identity, issuer})]) {
        expect(() => createSeatRuntimeRecord({...options, profile: changed})).toThrow(/incomplete or invalid/);
    }
    expect(() => createSeatRuntimeRecord({...options, record: {...record, harnessType: 'claude-desktop'}})).toThrow(/incomplete or invalid/);
    expect(JSON.stringify(record.runtimeStart)).not.toContain(grant.secret);
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
    const record  = {...fixture('claude-desktop'), admissionGeneration: 'original-admission'};
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

test('fixed target capture preserves required and absent optional slots without persisting their values', () => {
    const record = fixture(), runtime = record.runtimeGeneration;
    const plan   = createManagedAgentWorkspacePlan({agent: {id: 'seat', harnessType: 'claude-desktop'}, mcpMatrix: {
        'memory-core': true, 'knowledge-base': false, 'neural-link': true, 'github-workflow': true, 'gitlab-workflow': false
    }, mcpTarget: {kind: 'tenant', credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN', resources: {
        'memory-core': {url: 'https://plane.example.test/mc/mcp'}, 'knowledge-base': {url: 'https://plane.example.test/kb/mcp'}
    }}}).mcpServers.map(row => ({...row, sourceRoot: runtime.runtimeRoot, command: runtime.executable,
        args: [path.join(runtime.runtimeRoot, row.entrypoint), ...(row.key === 'neural-link' ? ['--cwd', runtime.runtimeRoot] : [])]}));
    const owner   = {resolve: () => 'fixture-secret', prove: async () => ({verdict: 'proved'})};
    const options = {record, identity: 'seat-login', plan, leaseRequired: true,
        env   : {GH_TOKEN: 'fixture-pat', NEO_FLEET_BRIDGE_TOKEN: 'fixture-token'},
        owners: {GH_TOKEN: owner, NEO_MCP_REMOTE_TOKEN: owner}};
    const value = createSeatRuntimeRecord(options);
    expect(value.targets.map(target => target.key)).toEqual(['memory-core', 'neural-link', 'github-workflow']);
    expect(value.targets[0]).toEqual({key: 'memory-core', target: 'tenant',
        args: [path.join(runtime.runtimeRoot, 'ai/mcp/client/stdioToStreamableHttp.mjs'), '--url',
            'https://plane.example.test/mc/mcp', '--token-env', 'NEO_MCP_REMOTE_TOKEN'],
        slots: [{name: 'NEO_MCP_REMOTE_TOKEN', required: true, state: 'owner'}]});
    expect(value.targets[2].slots).toEqual([
        {name: 'GH_TOKEN', required: true, state: 'owner'}, {name: 'GITHUB_TOKEN', required: false, state: 'absent'}
    ]);
    expect(value.targets[1].slots).toEqual([
        {name: 'NEO_NL_PORT', required: false, state: 'absent'},
        {name: 'NEO_FLEET_BRIDGE_TOKEN', required: true, state: 'held'}
    ]);
    expect(JSON.stringify(value)).not.toMatch(/fixture-(?:secret|pat|token)/);
    options.env.GITHUB_TOKEN = 'a-later-ambient-alias';
    expect(value.targets[2].slots[1].state).toBe('absent');
    for (const mutate of [
        row => row.targets[0].args[2] = 'https://user:secret@plane.example.test/mc/mcp',
        row => row.targets[0].args[2] = 'https://plane.example.test/mc/mcp?token=secret',
        row => row.targets[1].args[0] = '/another/runtime/entry.mjs',
        row => row.targets[2].slots[0].value = 'secret',
        row => row.targets.push(row.targets[0])
    ]) {
        const changed = structuredClone(value);
        mutate(changed);
        expect(isSeatRuntimeRecord(changed)).toBe(false);
    }
    expect(() => createSeatRuntimeRecord({...options, plan: plan.map(row => ({...row, command: '/other/node'}))}))
        .toThrow(/does not bind its runtime/);
});
