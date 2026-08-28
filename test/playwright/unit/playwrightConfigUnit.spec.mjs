import {expect, test} from '@playwright/test';
import fs             from 'node:fs';
import path           from 'node:path';

import {
    assertBrainTierForEnvironment,
    BRAIN_TIER_SETUP_GUIDANCE
} from '../playwright.config.unit.mjs';

const
    repoRoot     = path.resolve(import.meta.dirname, '../../..'),
    manifest     = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')),
    unitWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/brain-unit.yml'), 'utf8');

test.describe('Brain unit dependency setup guidance', () => {
    test('names only the root install and current CI native rebuild', () => {
        expect(BRAIN_TIER_SETUP_GUIDANCE).toContain('`npm ci`');
        expect(BRAIN_TIER_SETUP_GUIDANCE).toContain('`npm rebuild better-sqlite3`');
        expect(BRAIN_TIER_SETUP_GUIDANCE).not.toContain('install-brain');
        expect(BRAIN_TIER_SETUP_GUIDANCE).not.toContain('package.brain.json');

        for (const dependency of ['better-sqlite3', 'chromadb', '@chroma-core/default-embed']) {
            expect(manifest.dependencies[dependency], dependency).toBeTruthy()
        }

        expect(unitWorkflow).toContain('npm ci --ignore-scripts');
        expect(unitWorkflow).toContain('npm rebuild better-sqlite3')
    });

    test('keeps CI fail-closed before collection with the same recovery path', () => {
        expect(() => assertBrainTierForEnvironment({brainPresent: false, isCI: true}))
            .toThrow(BRAIN_TIER_SETUP_GUIDANCE);
        expect(() => assertBrainTierForEnvironment({brainPresent: false, isCI: false}))
            .not.toThrow()
    })
});
