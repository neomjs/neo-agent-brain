import fs                                              from 'node:fs';
import {fileURLToPath}                                 from 'node:url';
import {test, expect}                                  from '@playwright/test';
import Neo                                             from 'neo.mjs/src/Neo.mjs';
import * as core                                       from 'neo.mjs/src/core/_export.mjs';
import OrchestratorInstance, {resolveCloudOnlyEnabled} from '../../../../../../ai/daemons/orchestrator/Orchestrator.mjs';
import {findSharedConfigMutations}                     from '../../../../../../ai/scripts/lint/check-aiconfig-test-mutation.mjs';

const KEY       = 'composeServiceRecoveryEnabled';
const SPEC_PATH = fileURLToPath(import.meta.url);

test.describe('Neo.ai.daemons.Orchestrator cloudOnly mode-gate (#14150 composeServiceRecoveryEnabled)', () => {
    let snapshot;

    test.beforeEach(() => {
        snapshot = OrchestratorInstance.createConfigSnapshot();
    });

    test.afterEach(() => {
        snapshot = null;
    });

    test('mode-gate default: cloud → B1 enabled, local → B1 disabled', () => {
        snapshot.orchestrator.cloudOnly[KEY] = null; // profile default (the leaf default)

        snapshot.orchestrator.deploymentMode = 'cloud';
        expect(resolveCloudOnlyEnabled(KEY, snapshot)).toBe(true);

        snapshot.orchestrator.deploymentMode = 'local';
        expect(resolveCloudOnlyEnabled(KEY, snapshot)).toBe(false);
    });

    test('explicit override beats the deployment default (opt-in local / opt-out cloud)', () => {
        snapshot.orchestrator.deploymentMode = 'local';
        snapshot.orchestrator.cloudOnly[KEY] = true;  // operator opts B1 in for a local smoke test
        expect(resolveCloudOnlyEnabled(KEY, snapshot)).toBe(true);

        snapshot.orchestrator.deploymentMode = 'cloud';
        snapshot.orchestrator.cloudOnly[KEY] = false; // operator opts B1 out in a cloud deployment
        expect(resolveCloudOnlyEnabled(KEY, snapshot)).toBe(false);
    });

    test('resolveCloudOnlyEnabled ignores OrchestratorInstance.configSnapshot when called without an explicit config argument', () => {
        const baseline = resolveCloudOnlyEnabled(KEY);
        snapshot.orchestrator.deploymentMode = baseline ? 'local' : 'cloud';
        snapshot.orchestrator.cloudOnly[KEY] = !baseline;
        OrchestratorInstance.configSnapshot  = snapshot;

        try {
            expect(resolveCloudOnlyEnabled(KEY)).toBe(baseline);
            expect(resolveCloudOnlyEnabled(KEY, snapshot)).toBe(!baseline);
        } finally {
            OrchestratorInstance.configSnapshot = null;
        }
    });

    test('self-check: spec contains zero shared-config singleton writes (B4)', () => {
        const source = fs.readFileSync(SPEC_PATH, 'utf8');
        expect(findSharedConfigMutations(source)).toEqual([]);
    });
});
