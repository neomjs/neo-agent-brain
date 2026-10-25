import {Buffer}        from 'node:buffer';
import {test, expect}  from '@playwright/test';
import {execFile}      from 'node:child_process';
import fs              from 'fs-extra';
import os              from 'os';
import path            from 'path';
import {fileURLToPath} from 'node:url';
import {promisify}     from 'node:util';

import {
    headingToSectionSlug,
    readSandmanHandoff,
    splitSandmanHandoffSections
} from '../../../../../../../ai/services/memory-core/helpers/sandmanHandoffStore.mjs';

const REALISTIC_HANDOFF_FIXTURE = [
    '# Autonomous Handoff (Dream Pipeline & Golden Path)',
    '',
    'The Native Edge Graph has audited the codebase structurally. The following architectural coverage gaps currently exist natively within the SQLite matrix.',
    '',
    '### 🧪 Critical Test Constraints (`5` of `548` items)',
    '- **`adr-0001`**: The CLASS \'ADR 0001: Engine Contract\' lacks corresponding automated validation suites (Playwright) with precise test-file evidence within the test/ directory.',
    '- **`adr-0002`**: The CLASS \'Decision Record 0002\' lacks corresponding automated validation suites (Playwright) with precise test-file evidence within the test/ directory.',
    '- **`brain-1210`**: The CLASS \'Brain #1210\' lacks corresponding automated validation suites (Playwright) with precise test-file evidence within the test/ directory.',
    '- **`fleet-lifecycle-service`**: The CLASS \'FleetLifecycleService#startGateRefusal\' lacks corresponding automated validation suites (Playwright) with precise test-file evidence within the test/ directory.',
    '- **`turn-presence-config`**: The CLASS \'TurnPresenceConfig\' lacks corresponding automated validation suites (Playwright) with precise test-file evidence within the test/ directory.',
    '',
    '### 🗺️ Guide Disconnects (`5` of `12` items)',
    '- **`data-layer`**: The CONCEPT \'Data Layer\' lacks a corresponding architectural Guide (no EXPLAINED_BY edge in the concept ontology).',
    '- **`zero-build-dev`**: The CONCEPT \'Zero-Build Development Mode\' lacks a corresponding architectural Guide (no EXPLAINED_BY edge in the concept ontology).',
    '',
    '### 💡 Example Disconnects (`5` of `17` items)',
    '- **`agent-os`**: The CONCEPT \'Whole-System Agent OS\' is documented but lacks a working example (no EXEMPLIFIED_BY edge in the concept ontology).',
    '',
    '### ⚠️ Orphaned Concepts (`5` of `16` items)',
    '- **`agent-os`**: The CONCEPT \'Whole-System Agent OS\' has no IMPLEMENTED_BY edge — either anchor it to a source file or retire the concept from nodes.jsonl if aspirational/stale.',
    '',
    '### Concept Reverification Queue (`5` of `2237` items)',
    '- **`codex-native-wake`**: The CONCEPT \'Codex Native Wake Adapter\' has verifiedAt=null and needs source-grounded re-verification.',
    '',
    '## Consolidation Gaps',
    '',
    '*Consolidation-liveness: sessions the dream has NOT yet laid as trails. A lost walk is visibly lost, never silently absent — a fresh handoff must not read healthy over an undigested backlog.*',
    '',
    '⚠️ **179 session(s) undigested** (`graphDigested !== true`), showing 5:',
    '- `summary_019ef100-77a2-7781-a83f-4f064a3c1aca` — Implement recoveryRunStateStore helper and unit tests',
    '- `summary_92a31f1c-88fd-4e2c-8d39-fbc3807674fd` — PR Review and Branch Rebase Synchronization',
    '',
    '## Computed Golden Path (Strategic Recommendation)',
    '',
    'Captured at: 2026-10-25 02:40 UTC',
    '',
    'Based on the latest Tri-Vector Synthesis and Topological Priorities, the following tasks are mathematically recommended as the next immediate focus:',
    '',
    '1. **issue-17844**: Score 148.82 (Semantic: 0.91, Structural: 147.00)',
    '   - *Run the dock NL whitebox battery against the external Brain runtime*',
    '2. **issue-19482**: Score 8.40 (Semantic: 1.05, Structural: 6.30)',
    '   - *Sweep the 13.2 notes\' merges since cec2fcce84*',
    '3. **issue-9853**: Score 7.98 (Semantic: 0.99, Structural: 6.00)',
    '   - *Blog Post: The Cyborg Factor — How One Developer Resolved 650 Tickets in 30 Days*',
    '',
    '> **Strategic Interpretation:**',
    '> The priority is driven by the massive structural weight of issue-17844, requiring immediate focus on validating the external Brain runtime.',
    ''
].join('\n');

test.describe('sandmanHandoffStore (#15599, #1251)', () => {
    test('the MCP dispatch reads the Memory Core provider path, defaults to goldenPath only, and forwards sections (#451, #1251)', async () => {
        const dir      = await fs.mkdtemp(path.join(os.tmpdir(), 'sandman-handoff-binding-')),
              filePath = path.join(dir, 'handoff.md'),
              written  = new Date(Date.now() - 120_000);

        await fs.writeFile(filePath, REALISTIC_HANDOFF_FIXTURE, 'utf8');
        await fs.utimes(filePath, written, written);

        try {
            const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
                import 'neo.mjs/src/Neo.mjs';
                import 'neo.mjs/src/core/_export.mjs';
                const {callTool} = await import('./ai/mcp/server/memory-core/toolService.mjs');
                const defaultRead = await callTool('get_sandman_handoff', {staleAfterMs: 60_000});
                const allRead     = await callTool('get_sandman_handoff', {staleAfterMs: 60_000, sections: 'all'});
                const unknownRead = await callTool('get_sandman_handoff', {sections: ['goldenPath', 'nonExistentSlug']});
                console.log('DEFAULT_READ=' + JSON.stringify(defaultRead));
                console.log('ALL_READ=' + JSON.stringify(allRead));
                console.log('UNKNOWN_READ=' + JSON.stringify(unknownRead));
                process.exit(0);
            `], {
                cwd     : fileURLToPath(new URL('../../../../../../../', import.meta.url)),
                encoding: 'utf8',
                timeout : 15_000,
                env     : {...process.env, UNIT_TEST_MODE: 'true', NEO_HANDOFF_FILE_PATH_TEST: filePath}
            });

            const lines       = stdout.split('\n');
            const defaultRead = JSON.parse(lines.find(line => line.startsWith('DEFAULT_READ=')).slice('DEFAULT_READ='.length));
            const allRead     = JSON.parse(lines.find(line => line.startsWith('ALL_READ=')).slice('ALL_READ='.length));
            const unknownRead = JSON.parse(lines.find(line => line.startsWith('UNKNOWN_READ=')).slice('UNKNOWN_READ='.length));

            // AC-1: default returns only the ## Computed Golden Path section inside the freshness envelope (< 1,000 tokens / 4,000 bytes).
            expect(defaultRead).toMatchObject({
                content          : null,
                path             : filePath,
                reason           : null,
                stale            : true,
                staleAfterMs     : 60_000,
                availableSections: ['gaps', 'consolidation', 'goldenPath'],
                missingSections  : []
            });
            expect(Object.keys(defaultRead.sections)).toEqual(['goldenPath']);
            expect(defaultRead.sections.goldenPath.content).toMatch(/^## Computed Golden Path \(Strategic Recommendation\)/);
            expect(defaultRead.sections.goldenPath.content).not.toContain('Critical Test Constraints');
            expect(defaultRead.sections.goldenPath.content).not.toContain('Consolidation Gaps');
            expect(defaultRead.sections.goldenPath.bytes).toBe(Buffer.byteLength(defaultRead.sections.goldenPath.content, 'utf8'));
            expect(Buffer.byteLength(JSON.stringify(defaultRead), 'utf8')).toBeLessThan(4000);
            expect(defaultRead.mtimeMs).toBeGreaterThan(0);
            expect(defaultRead.ageMs).toBeGreaterThanOrEqual(120_000);

            // AC-2: sections: 'all' returns content byte-identical to whole-file read.
            expect(allRead.content).toBe(REALISTIC_HANDOFF_FIXTURE);
            expect(allRead.availableSections).toEqual(['gaps', 'consolidation', 'goldenPath']);

            // Contract Ledger row 1: unknown slug -> sections[slug] = null + listed in missingSections.
            expect(unknownRead.sections.goldenPath.content).toContain('issue-17844');
            expect(unknownRead.sections.nonExistentSlug).toBeNull();
            expect(unknownRead.missingSections).toEqual(['nonExistentSlug']);
        } finally {
            await fs.remove(dir);
        }
    });

    test('AC-1..AC-3: section filtering, availableSections discovery, and byte-identical whole-file reads', async () => {
        const dir      = await fs.mkdtemp(path.join(os.tmpdir(), 'sandman-handoff-')),
              filePath = path.join(dir, 'sandman_handoff.md'),
              now      = Date.now();

        await fs.writeFile(filePath, REALISTIC_HANDOFF_FIXTURE, 'utf8');
        await fs.utimes(filePath, new Date(now - 60_000), new Date(now - 60_000));

        try {
            // AC-1: default sections = ['goldenPath']
            const defaultRead = await readSandmanHandoff({filePath, now});

            expect(defaultRead.reason).toBeNull();
            expect(defaultRead.content).toBeNull();
            expect(defaultRead.path).toBe(filePath);
            expect(defaultRead.mtimeMs).toBeGreaterThan(0);
            expect(defaultRead.ageMs).toBeGreaterThanOrEqual(59_000);
            expect(defaultRead.staleAfterMs).toBe(36 * 60 * 60 * 1000);
            expect(defaultRead.stale).toBe(false);
            expect(defaultRead.availableSections).toEqual(['gaps', 'consolidation', 'goldenPath']);
            expect(defaultRead.missingSections).toEqual([]);
            expect(Object.keys(defaultRead.sections)).toEqual(['goldenPath']);
            expect(defaultRead.sections.goldenPath.content).toContain('issue-17844');
            expect(defaultRead.sections.goldenPath.bytes).toBeLessThan(1500);

            // AC-2: sections: 'all' and ['*'] return byte-identical content
            const allRead  = await readSandmanHandoff({filePath, now, sections: 'all'});
            const starRead = await readSandmanHandoff({filePath, now, sections: ['*']});

            expect(allRead.content).toBe(REALISTIC_HANDOFF_FIXTURE);
            expect(allRead.sections).toBeUndefined();
            expect(starRead.content).toBe(REALISTIC_HANDOFF_FIXTURE);

            // AC-3: sections: ['gaps', 'consolidation'] returns those two and lists goldenPath in availableSections without its content
            const auditRead = await readSandmanHandoff({filePath, now, sections: ['gaps', 'consolidation']});

            expect(auditRead.content).toBeNull();
            expect(Object.keys(auditRead.sections)).toEqual(['gaps', 'consolidation']);
            expect(auditRead.sections.gaps.content).toContain('### 🧪 Critical Test Constraints');
            expect(auditRead.sections.consolidation.content).toContain('## Consolidation Gaps');
            expect(auditRead.sections.goldenPath).toBeUndefined();
            expect(auditRead.availableSections).toEqual(['gaps', 'consolidation', 'goldenPath']);
            expect(auditRead.missingSections).toEqual([]);
        } finally {
            await fs.remove(dir);
        }
    });

    test('a file without the Golden Path heading returns sections.goldenPath: null and lists availableSections', async () => {
        const dir      = await fs.mkdtemp(path.join(os.tmpdir(), 'sandman-handoff-')),
              filePath = path.join(dir, 'sandman_handoff.md'),
              now      = Date.now();

        await fs.writeFile(filePath, '# Legacy handoff without the strategic section\n\n### 🧪 Critical Test Constraints\n- item\n', 'utf8');
        await fs.utimes(filePath, new Date(now - 30_000), new Date(now - 30_000));

        try {
            const read = await readSandmanHandoff({filePath, now});

            expect(read.reason).toBeNull();
            expect(read.content).toBeNull();
            expect(read.sections).toEqual({goldenPath: null});
            expect(read.availableSections).toEqual(['gaps']);
            expect(read.missingSections).toEqual(['goldenPath']);
        } finally {
            await fs.remove(dir);
        }
    });

    test('splitSandmanHandoffSections preserves exact byte slices and maps future producer headings like ## Focus (v1) to focus', () => {
        const withFocus                           = `${REALISTIC_HANDOFF_FIXTURE}\n## Focus (v1)\n\n- Primary outcome: boot token reduction\n`;
        const {sectionsBySlug, availableSections} = splitSandmanHandoffSections(withFocus);

        expect(availableSections).toEqual(['gaps', 'consolidation', 'goldenPath', 'focus']);
        expect(sectionsBySlug.focus.content).toBe('## Focus (v1)\n\n- Primary outcome: boot token reduction\n');
        expect(headingToSectionSlug('Focus (v1)')).toBe('focus');
        expect(headingToSectionSlug('Computed Golden Path (Strategic Recommendation)')).toBe('goldenPath');
        expect(headingToSectionSlug('Consolidation Gaps')).toBe('consolidation');

        const reconstructed = availableSections.map(slug => sectionsBySlug[slug].content).join('');
        expect(reconstructed).toBe(withFocus);
    });

    test('missing handoff returns an explicit null-reason payload, never a throw', async () => {
        const dir      = await fs.mkdtemp(path.join(os.tmpdir(), 'sandman-handoff-')),
              filePath = path.join(dir, 'does-not-exist.md');

        const read = await readSandmanHandoff({filePath});

        expect(read).toMatchObject({
            content: null,
            path   : filePath,
            mtimeMs: null,
            stale  : true,
            reason : 'handoff-not-found'
        });
    });

    test('unconfigured path fails with an explicit reason code', async () => {
        await expect(readSandmanHandoff({filePath: undefined})).resolves.toMatchObject({
            content: null,
            reason : 'handoff-path-unconfigured'
        });
    });

    test('stale flag fires past the freshness window; per-call override and <=0 disable it', async () => {
        const dir        = await fs.mkdtemp(path.join(os.tmpdir(), 'sandman-handoff-')),
              filePath   = path.join(dir, 'sandman_handoff.md'),
              now        = Date.now(),
              twoDaysAgo = now - 48 * 60 * 60 * 1000;

        await fs.writeFile(filePath, 'old handoff\n', 'utf8');
        await fs.utimes(filePath, new Date(twoDaysAgo), new Date(twoDaysAgo));

        await expect(readSandmanHandoff({filePath, now})).resolves.toMatchObject({
            stale : true,
            reason: null
        });

        // Per-call override: a generous window reclassifies the same file as fresh.
        await expect(readSandmanHandoff({filePath, now, staleAfterMs: 72 * 60 * 60 * 1000})).resolves.toMatchObject({
            stale: false
        });

        // <=0 disables stale classification by construction.
        await expect(readSandmanHandoff({filePath, now, staleAfterMs: 0})).resolves.toMatchObject({
            stale: false
        });
    });

    test('honors a custom resolved path (the NEO_HANDOFF_FILE_PATH leaf override flow)', async () => {
        const dir        = await fs.mkdtemp(path.join(os.tmpdir(), 'sandman-handoff-')),
              customPath = path.join(dir, 'custom', 'override-handoff.md');

        await fs.ensureDir(path.dirname(customPath));
        await fs.writeFile(customPath, '## Computed Golden Path\n\noverride location\n', 'utf8');

        const read = await readSandmanHandoff({filePath: customPath});

        expect(read.reason).toBeNull();
        expect(read.path).toBe(customPath);
        expect(read.sections.goldenPath.content).toContain('override location');
    });

    test('oversized handoff returns an explicit too-large reason with size details', async () => {
        const dir      = await fs.mkdtemp(path.join(os.tmpdir(), 'sandman-handoff-')),
              filePath = path.join(dir, 'sandman_handoff.md');

        await fs.writeFile(filePath, 'x'.repeat(1024), 'utf8');

        await expect(readSandmanHandoff({filePath, maxBytes: 128})).resolves.toMatchObject({
            content: null,
            reason : 'handoff-too-large',
            details: {size: 1024, maxBytes: 128}
        });
    });
});
