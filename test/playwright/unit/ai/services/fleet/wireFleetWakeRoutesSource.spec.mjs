import {test, expect}              from '@playwright/test';
import Neo                         from 'neo.mjs/src/Neo.mjs';
import * as core                   from 'neo.mjs/src/core/_export.mjs';
import {wireFleetWakeRoutesSource} from '../../../../../../ai/services/fleet/wireFleetWakeRoutesSource.mjs';

/**
 * @summary The wake-routes wiring installs the composed source with the read paths it was handed. The
 * entrypoint's own call is the running-devFleetServer e2e's concern; this pins the forwarding with an
 * injected bridge and factory.
 */
test.describe('Neo.ai.services.fleet.wireFleetWakeRoutesSource', () => {
    test('a missing required collaborator leaves the bridge unwired', () => {
        const bridge = {wakeRoutesSource: 'UNTOUCHED'};

        expect(wireFleetWakeRoutesSource({bridge, listAgents: () => [], createSource: () => ({})})).toBeNull();
        expect(bridge.wakeRoutesSource).toBe('UNTOUCHED');
    });

    test('the Fleet\'s arming reader reaches the source beside the manifest path', () => {
        const
            bridge          = {},
            readFleetArming = agentId => ({state: 'unarmed', reason: agentId}),
            created         = {readWakeRoutes() {}};
        let captured = null;

        const result = wireFleetWakeRoutesSource({
            bridge,
            listAgents              : () => [],
            resolveViewerIdentity   : () => '@viewer',
            wakeReceiverManifestPath: '/host/wake/routes.json',
            readFleetArming,
            createSource            : options => { captured = options; return created }
        });

        expect(result).toBe(created);
        expect(bridge.wakeRoutesSource).toBe(created);
        expect(captured.readFleetArming).toBe(readFleetArming);
        expect(captured.wakeReceiverManifestPath).toBe('/host/wake/routes.json');
    });
});
