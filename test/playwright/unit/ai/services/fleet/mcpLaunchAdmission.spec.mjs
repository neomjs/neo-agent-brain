import {test, expect} from '@playwright/test';
import {
    LAUNCH_GRANT_ENV_VAR,
    LAUNCH_ISSUER_ENV_VAR,
    createLaunchRequest,
    isAdmissibleEnvName,
    isLaunchIdentity,
    launchRefusal,
    mintLaunchGrant,
    parseLaunchCapability,
    parseLaunchRequest,
    signLaunchResponse,
    verifyLaunchRequest,
    verifyLaunchResponse
} from '../../../../../../ai/services/fleet/mcpLaunchAdmission.mjs';
import {createManagedAgentWorkspacePlan, launchRowEnvNames} from '../../../../../../ai/services/fleet/managedAgentWorkspacePlan.mjs';

/** @summary One bound plan row as preparation returns it, for the canonical servers. */
function boundRow(key, {tenant = false, placement = {}} = {}) {
    const
        mcpMatrix = {'memory-core': true, 'knowledge-base': true, 'neural-link': true, 'github-workflow': true, 'gitlab-workflow': false},
        mcpTarget = tenant ? {kind: 'tenant', credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN', resources: {
            'memory-core': {url: 'https://plane.example.test/mc/mcp'}, 'knowledge-base': {url: 'https://plane.example.test/kb/mcp'}
        }} : null,
        row       = createManagedAgentWorkspacePlan({agent: {id: 'seat', harnessType: 'claude-desktop'}, mcpMatrix, mcpTarget}).mcpServers.find(server => server.key === key);

    // the binding adds every name Start resolved for a resident server, as bindManagedAgentWorkspacePlan does
    return {...row, runtimeEnv: [...new Set([...row.runtimeEnv, ...Object.keys(placement)])], requiredRuntimeEnv: [...new Set([...row.requiredRuntimeEnv, ...Object.keys(placement)])]}
}

test.describe('mcpLaunchAdmission: the launcher↔issuer wire', () => {
    test('a grant is an opaque id and a 256-bit secret; anything else is no grant', () => {
        const grant = mintLaunchGrant();

        expect(grant.capability).toBe(`${grant.id}.${grant.secret}`);
        expect(Buffer.from(grant.secret, 'base64url')).toHaveLength(32);
        expect(parseLaunchCapability(grant.capability)).toEqual({id: grant.id, secret: grant.secret});
        expect(mintLaunchGrant().id).not.toBe(grant.id);

        for (const value of [undefined, '', grant.id, `${grant.capability}.extra`, `${grant.id}.short`, `${grant.id}.${grant.secret.replace(/./, '+')}`]) {
            expect(parseLaunchCapability(value), String(value)).toBeNull()
        }
    });

    test('a request proves the secret without carrying it, and the proof binds server, identity and nonce', () => {
        const
            grant   = mintLaunchGrant(),
            request = createLaunchRequest({grant, server: 'memory-core', identity: 'neo-opus-ada'});

        expect(JSON.stringify(request)).not.toContain(grant.secret);
        expect(parseLaunchRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
        expect(verifyLaunchRequest(grant.secret, request)).toBe(true);
        expect(verifyLaunchRequest(mintLaunchGrant().secret, request)).toBe(false);

        for (const field of ['server', 'identity', 'nonce']) {
            const tampered = {...request, [field]: field === 'nonce' ? mintLaunchGrant().secret : field === 'server' ? 'neural-link' : 'someone-else'};

            expect(verifyLaunchRequest(grant.secret, tampered), field).toBe(false)
        }

        expect(parseLaunchRequest({...request, cwd: '/tmp'}), 'no caller-selected field rides along').toBeNull();
        expect(parseLaunchRequest({...request, server: '../memory-core'})).toBeNull();
        expect(parseLaunchRequest({...request, identity: '@neo-opus-ada'})).toBeNull()
    });

    test('only the grant\'s holder can sign an answer, and the signature binds the request it answers', () => {
        const
            grant    = mintLaunchGrant(),
            request  = createLaunchRequest({grant, server: 'github-workflow', identity: 'neo-opus-ada'}),
            payload  = {outcome: 'admitted', env: {GH_TOKEN: 'fixture-pat'}, args: ['/installed/ai/mcp/server/github-workflow/mcp-server.mjs']},
            response = JSON.parse(JSON.stringify(signLaunchResponse(grant.secret, request, payload)));

        expect(verifyLaunchResponse(grant.secret, request, response)).toEqual(payload);
        expect(verifyLaunchResponse(mintLaunchGrant().secret, request, response), 'another secret').toBeNull();
        expect(verifyLaunchResponse(grant.secret, createLaunchRequest({grant, server: 'github-workflow', identity: 'neo-opus-ada'}), response), 'another request').toBeNull();
        expect(verifyLaunchResponse(grant.secret, request, {...response, env: {GH_TOKEN: 'someone-elses'}}), 'a changed env').toBeNull();
        expect(verifyLaunchResponse(grant.secret, request, {...response, args: ['/elsewhere/payload.mjs']}), 'a changed target').toBeNull();
        expect(verifyLaunchResponse(grant.secret, request, launchRefusal('unknown-grant')), 'an unsigned answer').toBeNull()
    });

    test('a signature covers key order and leaves out what JSON leaves out', () => {
        const
            grant   = mintLaunchGrant(),
            request = createLaunchRequest({grant, server: 'neural-link', identity: 'neo-opus-ada'}),
            signed  = signLaunchResponse(grant.secret, request, {outcome: 'refused', code: 'revoked', reason: undefined});

        // the launcher parses what the issuer serialized: no `reason` key, keys in any order
        expect(verifyLaunchResponse(grant.secret, request, {mac: signed.mac, code: 'revoked', outcome: 'refused'})).toEqual({code: 'revoked', outcome: 'refused'})
    });

    test('an admitted name may never steer how the target process runs', () => {
        for (const name of ['GH_TOKEN', 'NEO_MCP_REMOTE_TOKEN', 'NEO_FLEET_BRIDGE_TOKEN', 'GEMINI_API_KEY']) expect(isAdmissibleEnvName(name), name).toBe(true);

        for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
            LAUNCH_GRANT_ENV_VAR, LAUNCH_ISSUER_ENV_VAR, 'lower_case', '1LEADING']) {
            expect(isAdmissibleEnvName(name), name).toBe(false)
        }

        expect([isLaunchIdentity('neo-opus-ada'), isLaunchIdentity('@neo-opus-ada'), isLaunchIdentity('')]).toEqual([true, false, false])
    });
});

test.describe('launchRowEnvNames: one name is literal or redeemed, never both', () => {
    test('a tenant row redeems exactly its credential slot, never what the descriptor calls secret', () => {
        expect(launchRowEnvNames(boundRow('memory-core', {tenant: true}))).toEqual({
            placement: [], redeemed: ['NEO_MCP_REMOTE_TOKEN'], required: ['NEO_MCP_REMOTE_TOKEN']
        })
    });

    test('a resident row keeps its plane placement literal and redeems every other name it declares', () => {
        const
            placement = {NEO_PLANE_DATA_ROOT: '/plane', NEO_MEMORY_WAL_DIR: '/plane/wal'},
            mc        = launchRowEnvNames(boundRow('memory-core', {placement: {...placement, GEMINI_API_KEY: 'fixture-key'}})),
            gw        = launchRowEnvNames(boundRow('github-workflow', {placement})),
            nl        = launchRowEnvNames(boundRow('neural-link', {placement}));

        expect(mc.placement).toEqual(['NEO_PLANE_DATA_ROOT', 'NEO_MEMORY_WAL_DIR']);
        // a provider key the descriptor declares is redeemed, and required once Start resolved it
        expect(mc.redeemed).toContain('GEMINI_API_KEY');
        expect(mc.required).toEqual(['GEMINI_API_KEY']);
        expect(gw).toEqual({placement: ['NEO_PLANE_DATA_ROOT', 'NEO_MEMORY_WAL_DIR'], redeemed: ['GH_TOKEN', 'GITHUB_TOKEN'], required: ['GH_TOKEN']});
        expect(nl.redeemed).toEqual(['NEO_FLEET_BRIDGE_TOKEN']);

        for (const names of [mc, gw, nl]) {
            expect(names.redeemed).not.toContain('NEO_AGENT_IDENTITY');
            expect(names.redeemed.filter(name => names.placement.includes(name))).toEqual([])
        }
    });

    test('a Node runtime slot the row sets literally is never redeemed', () => {
        const row = {...boundRow('neural-link'), environment: {ELECTRON_RUN_AS_NODE: '1'}, runtimeEnv: ['NEO_AGENT_IDENTITY', 'NEO_FLEET_BRIDGE_TOKEN', 'ELECTRON_RUN_AS_NODE']};

        expect(launchRowEnvNames(row).redeemed).toEqual(['NEO_FLEET_BRIDGE_TOKEN'])
    });
});
