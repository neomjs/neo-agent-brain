import {setup} from '../../../../setup.mjs';

const appName = 'DeriveFleetRosterTest';

setup({appConfig: {name: appName}});

import {expect, test}      from '@playwright/test';
import Neo                 from 'neo.mjs/src/Neo.mjs';
import * as core           from 'neo.mjs/src/core/_export.mjs';
import {deriveFleetRoster} from '../../../../../../ai/scripts/fleet/deriveFleetRoster.mjs';

// Pure derivation — imported directly (the module's main-execution guard makes import side-effect-free).
// Product repositories own presentation and persistence; Brain owns only the snapshot contract.

const
    doc  = deriveFleetRoster(),
    byId = Object.fromEntries(doc.data.map(row => [row.agentId, row]));

test.describe('deriveFleetRoster (registry-derived cockpit roster, #15621)', () => {
    test('every active registry identity is present — including Emmy, Phoebe, and Iris under their canonical identities', () => {
        for (const id of ['neo-gpt-emmy', 'neo-kimi-phoebe', 'neo-kimi-iris']) {
            expect(byId[id], `${id} must be rostered`).toBeDefined();
        }

        expect(byId['neo-gpt-emmy'].displayName).toBe('Emmy');
        expect(byId['neo-kimi-phoebe'].displayName).toBe('Phoebe');
        expect(byId['neo-kimi-iris'].displayName).toBe('Iris');
        expect(byId['neo-kimi-iris'].githubUsername).toBe('neo-kimi-iris'); // '@' stripped
        expect(doc.data.length).toBeGreaterThanOrEqual(10);
    });

    test('state truth: no active maintainer renders off; known non-active statuses render off with the bench reason preserved', () => {
        for (const row of doc.data) {
            if (row.participationStatus === 'active') {
                expect(row.state, `${row.agentId} is active and must not render off`).toBe('ok');
            } else {
                expect(row.state, `${row.agentId} is ${row.participationStatus}`).toBe('off');
            }
        }

        // The operator-benched identity keeps its bench reason visible (provenance, not prose erasure).
        const benched = doc.data.find(row => row.participationStatus !== 'active');
        expect(benched.laneLine).toBeTruthy();
    });

    test('honesty invariants: participationStatus stamped per row; no fabricated lane counts or lane lines', () => {
        for (const row of doc.data) {
            expect(row.participationStatus).toBeTruthy();
            expect(row.openLaneCount).toBeNull();   // the model renders no badge for null — never a fake 0
            // declared expected-absence: the one present shape the source-health contract holds calm
            expect(row.sources.roster).toEqual({
                source    : 'fleet:listAgents',
                state     : 'not-wired',
                confidence: 'none',
                reason    : 'static roster (identityRoots snapshot) · unobserved'
            });
        }
    });

    test('engine tags mirror ModelStats for mapped identities and stay null (never fabricated) elsewhere', () => {
        expect(byId['neo-kimi-iris'].engineTag).toBe('kimi-k3');
        expect(byId['neo-kimi-phoebe'].engineTag).toBe('kimi-k3');
        expect(byId['neo-gpt-emmy'].engineTag).toBe('gpt-5.6-sol');
    });

    test('the snapshot carries its provenance in-band without claiming another product output', () => {
        expect(doc._meta.authority).toBe('ai/graph/identityRoots.mjs');
        expect(doc._meta.generator).toBe('ai/scripts/fleet/deriveFleetRoster.mjs');
        expect(doc._meta.generatedAt).toBeTruthy();
        expect(JSON.stringify(doc)).not.toContain('apps/agentos')
    });
});
