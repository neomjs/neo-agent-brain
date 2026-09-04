import {test, expect}                  from '@playwright/test';
import Neo                             from 'neo.mjs/src/Neo.mjs';
import * as core                       from 'neo.mjs/src/core/_export.mjs';
import {wireDeploymentStateReadSource} from '../../../../../../ai/services/fleet/wireDeploymentStateReadSource.mjs';

test.describe('wireDeploymentStateReadSource — the fleet-server boot injection of the deployment-state reader (#314)', () => {
    test('wires deploymentStateSource with a read-source built from the three resolved leaves', () => {
        const bridge       = {deploymentStateSource: null},
              seen         = [],
              stubSource   = {produceDeploymentState: async () => ({state: 'unavailable', services: []})},
              createSource = options => { seen.push(options); return stubSource };

        const wired = wireDeploymentStateReadSource({path: '/plane/deployment-state/snapshot.json', staleAfterMs: 120000, maxBytes: 262144, bridge, createSource});

        expect(seen).toEqual([{path: '/plane/deployment-state/snapshot.json', staleAfterMs: 120000, maxBytes: 262144}]); // the leaves reach the reader untouched
        expect(bridge.deploymentStateSource).toBe(stubSource); // the bridge seam is now wired
        expect(wired).toBe(stubSource);
    });

    test('an absent / empty path leaves deploymentStateSource UNWIRED — the honest unavailable, never a fabricated source', () => {
        const bridge = {deploymentStateSource: null};

        expect(wireDeploymentStateReadSource({path: '', staleAfterMs: 1, maxBytes: 1, bridge})).toBeNull();
        expect(wireDeploymentStateReadSource({bridge})).toBeNull();
        expect(bridge.deploymentStateSource).toBeNull(); // untouched — the seam degrades to unavailable
    });
});
