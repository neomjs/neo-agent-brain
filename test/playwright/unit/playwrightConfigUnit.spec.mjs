import {expect, test} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import * as yaml      from 'js-yaml';

import {CHROMA_CLI_ENTRYPOINT} from '../chromaProcess.mjs';
import {
    assertBrainTierForEnvironment,
    BRAIN_TIER_SETUP_GUIDANCE,
    brainTierRequirements,
    hasBrainTier,
    nativeSqliteArtifacts,
    sqliteHost
} from '../playwright.config.unit.mjs';
import {
    BRAIN_TIER,
    BRAIN_TIER_PACKAGES,
    readDeniedPackages
} from '../../../ai/scripts/diagnostics/denyCloudPlanePackages.loader.mjs';

const
    repoRoot     = path.resolve(import.meta.dirname, '../../..'),
    manifest     = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')),
    dependabot   = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/dependabot.yml'), 'utf8')),
    unitWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/brain-unit.yml'), 'utf8');

/**
 * @summary Builds a throwaway `node_modules` carrying the three tier packages, so a `hasBrainTier`
 * arm can name one package's layout and leave the other two complete.
 *
 * Every fixture creates all three package DIRECTORIES even when an arm wants a package to look
 * broken — {@link resolvePackageDir} walks UP from `rootDir`, so an omitted directory would be
 * answered by whatever install sits above the temp dir and the arm would measure this machine
 * instead of its fixture. Degrade a package by giving it fewer FILES, never by omitting it.
 *
 * Mutation-verify these arms ONE row at a time. `hasBrainTier` is an `every` over three packages,
 * so breaking two rows at once masks the second arm behind the first — two simultaneous mutations
 * made the chromadb arm below look dead when it is not.
 * @param {Object} layout Package name → package-relative files to create.
 * @returns {String} The fixture root to pass as `rootDir`.
 */
function tierFixture(layout) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tier-'));

    for (const [pkg, files] of Object.entries(layout)) {
        const packageDir = path.join(root, 'node_modules', pkg);

        fs.mkdirSync(packageDir, {recursive: true});

        for (const file of files) {
            const target = path.join(packageDir, file);

            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.writeFileSync(target, '')
        }
    }

    return root
}

const
    hostPrebuild  = nativeSqliteArtifacts(sqliteHost())[0],
    completeChroma = {
        [BRAIN_TIER.chroma]: ['dist/chromadb.mjs', CHROMA_CLI_ENTRYPOINT],
        [BRAIN_TIER.embed] : ['dist/default-embed.mjs']
    };

test.describe('Brain tier membership is written once', () => {
    test('every member is excluded from the dependabot all-deps group, so its bump gets its own pull request', () => {
        const
            npm     = dependabot.updates.find(update => update['package-ecosystem'] === 'npm'),
            exclude = npm.groups['all-deps']['exclude-patterns'];

        for (const pkg of BRAIN_TIER_PACKAGES) {
            expect(exclude, `${pkg} must be excluded from the all-deps group`).toContain(pkg)
        }
    });

    test('every member is a declared root dependency', () => {
        for (const pkg of BRAIN_TIER_PACKAGES) {
            expect(manifest.dependencies[pkg], pkg).toBeTruthy()
        }
    });

    test('the install gate has one requirement row per member and no other', () => {
        expect(Object.keys(brainTierRequirements()).sort()).toEqual([...BRAIN_TIER_PACKAGES].sort())
    });

    test('the denial loader defaults to the tier and yields to NEO_DENIED_PACKAGES', () => {
        expect(readDeniedPackages({})).toEqual([...BRAIN_TIER_PACKAGES]);
        expect(readDeniedPackages({NEO_DENIED_PACKAGES: ' foo , bar,, '})).toEqual(['foo', 'bar'])
    })
});

test.describe('Brain unit dependency setup guidance', () => {
    test('names only the root install and current CI native rebuild', () => {
        expect(BRAIN_TIER_SETUP_GUIDANCE).toContain('`npm ci`');
        expect(BRAIN_TIER_SETUP_GUIDANCE).toContain('`npm rebuild better-sqlite3`');
        expect(BRAIN_TIER_SETUP_GUIDANCE).not.toContain('install-brain');
        expect(BRAIN_TIER_SETUP_GUIDANCE).not.toContain('package.brain.json');

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

test.describe('hasBrainTier native-artifact admission', () => {
    test('admits a prebuild-only install, which is all better-sqlite3@13 ever produces', () => {
        const root = tierFixture({
            [BRAIN_TIER.sqlite]: ['lib/index.js', hostPrebuild],
            ...completeChroma
        });

        expect(hasBrainTier(root)).toBe(true)
    });

    test('admits a node-gyp install, which is all better-sqlite3@12 ever produces', () => {
        const root = tierFixture({
            [BRAIN_TIER.sqlite]: ['lib/index.js', 'build/Release/better_sqlite3.node'],
            ...completeChroma
        });

        expect(hasBrainTier(root)).toBe(true)
    });

    test('still rejects an entrypoint with no binary anywhere', () => {
        const root = tierFixture({
            [BRAIN_TIER.sqlite]: ['lib/index.js'],
            ...completeChroma
        });

        expect(hasBrainTier(root)).toBe(false)
    });

    test('keeps chromadb entrypoints REQUIRED rather than alternatives', () => {
        const root = tierFixture({
            [BRAIN_TIER.sqlite]: ['lib/index.js', hostPrebuild],
            [BRAIN_TIER.chroma]: ['dist/chromadb.mjs'],
            [BRAIN_TIER.embed] : ['dist/default-embed.mjs']
        });

        expect(hasBrainTier(root)).toBe(false)
    })
});

test.describe('nativeSqliteArtifacts', () => {
    test('names the loader-reachable locations in better-sqlite3 own search order', () => {
        expect(nativeSqliteArtifacts({arch: 'x64', isMusl: false, platform: 'linux'})).toEqual([
            path.join('prebuilds', 'linux-x64.node'),
            path.join('build', 'Release', 'better_sqlite3.node'),
            path.join('build', 'Debug', 'better_sqlite3.node')
        ])
    });

    test('selects the linuxmusl target, a different filename on the same platform and arch', () => {
        expect(nativeSqliteArtifacts({arch: 'x64', isMusl: true, platform: 'linux'})[0])
            .toBe(path.join('prebuilds', 'linuxmusl-x64.node'));
        expect(nativeSqliteArtifacts({arch: 'arm64', isMusl: true, platform: 'linux'})[0])
            .toBe(path.join('prebuilds', 'linuxmusl-arm64.node'));
        expect(nativeSqliteArtifacts({arch: 'arm64', isMusl: false, platform: 'darwin'})[0])
            .toBe(path.join('prebuilds', 'darwin-arm64.node'))
    })
});
