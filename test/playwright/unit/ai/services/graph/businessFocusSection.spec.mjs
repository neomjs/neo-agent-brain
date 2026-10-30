import {setup} from '../../../../setup.mjs';

const appName = 'BusinessFocusSectionTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {Buffer}                         from 'node:buffer';
import {createHash}                     from 'node:crypto';
import fs                               from 'node:fs';
import os                               from 'node:os';
import path                             from 'node:path';
import {test, expect}                   from '@playwright/test';
import Neo                              from 'neo.mjs/src/Neo.mjs';
import * as core                        from 'neo.mjs/src/core/_export.mjs';
import {validateBusinessGoalProperties} from '../../../../../../ai/graph/businessSchema.mjs';
import {
    BUSINESS_FOCUS_END_MARKER,
    BUSINESS_FOCUS_HEADING,
    BUSINESS_FOCUS_MAX_BYTES,
    BUSINESS_FOCUS_NODE_ID,
    BUSINESS_FOCUS_SECTION_MAX_BYTES,
    BUSINESS_FOCUS_SLUG,
    buildBusinessFocusNode,
    demoteHeadings,
    readBusinessFocusBlock,
    renderBusinessFocusSection,
    resolveBusinessFocus
} from '../../../../../../ai/services/graph/businessFocusSection.mjs';
import {projectPublicBusinessRows} from '../../../../../../ai/services/graph/focusV1Section.mjs';
import {
    DEFAULT_HANDOFF_SECTIONS,
    KNOWN_HANDOFF_SECTION_SLUGS,
    headingToSectionSlug,
    splitSandmanHandoffSections
} from '../../../../../../ai/services/memory-core/helpers/sandmanHandoffSections.mjs';

const AS_OF         = '2026-10-30T19:00:00.000Z';
const COMMIT        = 'abc1234abc1234abc1234abc1234abc1234abc12';
const resolveCommit = () => COMMIT;

const FIRST_SCREEN = [
    '# Business dashboard',
    '',
    'PRIVATE · Oct 30 · the lead.',
    '',
    '## READ THIS FIRST',
    '',
    'The question of the day and its decision rule, with the date. The money events: Dec 1 the first offer, Nov 20 the quote.',
    '',
    '| Seat | Next work |',
    '|---|---|',
    '| Mnemosyne | the YC text: reads Sat 12:00, frozen Sun 18:00 |',
    ''
].join('\n');

const TRAILS = [
    '## Read only when needed',
    '',
    '- the decision record · the hygiene map · the areas',
    ''
].join('\n');

function writeDashboard(dir, content, name = 'DASHBOARD.md') {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'utf8');
    return file;
}

test.describe('businessFocusSection — the dashboard first screen as node and ## Business focus section (#1253)', () => {
    let tmpDir;

    test.beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-focus-'));
    });

    test.afterAll(() => {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    });

    test('AC-1: the block is the text before the end marker, bound to the file sha256 and the commit; the node validates with publicFlag false', () => {
        const content = FIRST_SCREEN + BUSINESS_FOCUS_END_MARKER + '\n' + TRAILS;
        const file    = writeDashboard(tmpDir, content, 'marker.md');
        const read    = readBusinessFocusBlock({sourcePath: file, resolveCommit});

        expect(read.status).toBe('ok');
        expect(read.markerFound).toBe(true);
        expect(read.block).toBe(FIRST_SCREEN.trimEnd() + '\n');
        expect(read.bytes).toBe(Buffer.byteLength(read.block, 'utf8'));
        expect(read.bytes).toBeLessThanOrEqual(BUSINESS_FOCUS_MAX_BYTES);
        expect(read.sha256).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
        expect(read.sourceCommit).toBe(COMMIT);

        const node = buildBusinessFocusNode({...read, asOf: AS_OF});

        expect(node.id).toBe(BUSINESS_FOCUS_NODE_ID);
        expect(node.id).toBe('business-goal-focus');
        expect(node.type).toBe('BUSINESS_GOAL');
        expect(node.properties.publicFlag).toBe(false);
        expect(node.properties.lifecycle).toBe('active');
        expect(node.properties.block).toBe(read.block);
        expect(node.properties.falsifyingQuery).toContain(read.sha256);
        expect(node.properties.falsifyingQuery).toContain(COMMIT);
        expect(validateBusinessGoalProperties(node.properties).valid).toBe(true);
    });

    test('AC-1 (over-cap arm): a 1,300-byte block truncates nothing, writes no node, and renders the previous in-cap block flagged stale: over-cap with the byte count and the source', () => {
        const filler  = 'x'.repeat(1300 - Buffer.byteLength('# Dashboard\n\n', 'utf8') - 1);
        const content = `# Dashboard\n\n${filler}\n${BUSINESS_FOCUS_END_MARKER}\n${TRAILS}`;
        const file    = writeDashboard(tmpDir, content, 'over-cap.md');
        const read    = readBusinessFocusBlock({sourcePath: file, resolveCommit});

        expect(read.status).toBe('over-cap');
        expect(read.bytes).toBe(1300);
        expect(read.block.length).toBeGreaterThan(BUSINESS_FOCUS_MAX_BYTES); // nothing truncated

        const previous = {
            id        : BUSINESS_FOCUS_NODE_ID,
            type      : 'BUSINESS_GOAL',
            properties: {
                block       : '**Business dashboard**\n\nThe previous week in one screen.\n',
                bytes       : 56,
                sha256      : 'f'.repeat(64),
                sourceCommit: 'def5678def5678def5678def5678def5678def56',
                sourcePath  : file,
                asOf        : '2026-10-29T19:00:00.000Z'
            }
        };

        const resolved = resolveBusinessFocus({sourcePath: file, previousNode: previous, now: AS_OF, readBlock: options => readBusinessFocusBlock({...options, resolveCommit})});

        expect(resolved.status).toBe('over-cap');
        expect(resolved.node).toBeNull();
        expect(resolved.section).toContain('- status: stale: over-cap (1300 B at over-cap.md @ abc1234abc12; cap 1200 B)');
        expect(resolved.section).toContain('showing the previous in-cap block (56 B at over-cap.md @ def5678def56, as of 2026-10-29T19:00:00.000Z)');
        expect(resolved.section).toContain('The previous week in one screen.');
        expect(resolved.section).not.toContain(filler.slice(0, 40));

        const withoutPrevious = renderBusinessFocusSection({read, previousNode: null, asOf: AS_OF});

        expect(withoutPrevious).toContain('- status: unknown (over-cap: 1300 B at over-cap.md @ abc1234abc12; cap 1200 B; no prior in-cap block)');
    });

    test('a file without the marker is read whole, so an over-cap map reports honestly instead of guessing a boundary', () => {
        const content = FIRST_SCREEN + TRAILS;
        const file    = writeDashboard(tmpDir, content, 'no-marker.md');
        const read    = readBusinessFocusBlock({sourcePath: file, resolveCommit});

        expect(read.markerFound).toBe(false);
        expect(read.block).toBe(content.trimEnd() + '\n');
    });

    test('AC-8 (the optional source): an empty leaf value is unconfigured — no section, no node, no reason; a configured unreadable path is unknown with its reason', () => {
        const unconfigured = resolveBusinessFocus({sourcePath: '', now: AS_OF});

        expect(unconfigured.status).toBe('unconfigured');
        expect(unconfigured.section).toBe('');
        expect(unconfigured.node).toBeNull();
        expect(renderBusinessFocusSection({read: {status: 'unconfigured'}, asOf: AS_OF})).toBe('');

        const missing = path.join(tmpDir, 'does-not-exist.md');
        const read    = readBusinessFocusBlock({sourcePath: missing, resolveCommit});

        expect(read.status).toBe('unreadable');
        expect(read.reason).toBe('ENOENT');

        const section = renderBusinessFocusSection({read, asOf: AS_OF});

        expect(section.startsWith(BUSINESS_FOCUS_HEADING + '\n')).toBe(true);
        expect(section).toContain(`- status: unknown (source ${missing} unreadable: ENOENT)`);
    });

    test('AC-2: the section is one level-two heading, the block\'s own headings demoted, so the handoff splitter yields exactly one businessFocus slug; the default section set is untouched', () => {
        const content   = FIRST_SCREEN + BUSINESS_FOCUS_END_MARKER + '\n' + TRAILS;
        const file      = writeDashboard(tmpDir, content, 'split.md');
        const {section} = resolveBusinessFocus({sourcePath: file, now: AS_OF, readBlock: options => readBusinessFocusBlock({...options, resolveCommit})});

        expect(section.startsWith(`${BUSINESS_FOCUS_HEADING}\n\n- as of: ${AS_OF} · source: split.md @ abc1234abc12 · `)).toBe(true);
        expect(section).toContain('**Business dashboard**');
        expect(section).toContain('**READ THIS FIRST**');
        expect(section.match(/^## /gm)).toHaveLength(1);

        const handoff                             = `# Autonomous Handoff\n\nThe gap audit.\n\n### 🧪 Critical Test Constraints\n- one\n\n${section}\n## Consolidation Gaps\n\n- none\n\n## Computed Golden Path (Strategic Recommendation)\n\n1. go\n`;
        const {sectionsBySlug, availableSections} = splitSandmanHandoffSections(handoff);

        expect(availableSections).toEqual(['gaps', BUSINESS_FOCUS_SLUG, 'consolidation', 'goldenPath']);
        expect(sectionsBySlug[BUSINESS_FOCUS_SLUG].content).toBe(section + '\n');
        expect(availableSections.map(slug => sectionsBySlug[slug].content).join('')).toBe(handoff);
        expect(headingToSectionSlug('Business focus')).toBe(BUSINESS_FOCUS_SLUG);
        expect(KNOWN_HANDOFF_SECTION_SLUGS).toContain(BUSINESS_FOCUS_SLUG);
        expect(DEFAULT_HANDOFF_SECTIONS).toEqual(['goldenPath']);
    });

    test('AC-4: a block at the cap renders a section under the 400-token budget', () => {
        const block = '# Focus\n\n' + 'y'.repeat(BUSINESS_FOCUS_MAX_BYTES - Buffer.byteLength('# Focus\n\n\n', 'utf8'));
        const read  = {
            status      : 'ok',
            sourcePath  : '/mirror/strategy/DASHBOARD.md',
            bytes       : Buffer.byteLength(block + '\n', 'utf8'),
            maxBytes    : BUSINESS_FOCUS_MAX_BYTES,
            block       : block + '\n',
            sha256      : 'a'.repeat(64),
            sourceCommit: COMMIT,
            markerFound : true
        };

        expect(read.bytes).toBe(BUSINESS_FOCUS_MAX_BYTES);

        const section = renderBusinessFocusSection({read, asOf: AS_OF});

        expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(BUSINESS_FOCUS_SECTION_MAX_BYTES);
    });

    test('AC-3 (negative projection): the public business-row projection never admits the node, by type, by id, or by flag', () => {
        const content = FIRST_SCREEN + BUSINESS_FOCUS_END_MARKER + '\n' + TRAILS;
        const file    = writeDashboard(tmpDir, content, 'projection.md');
        const node    = buildBusinessFocusNode({...readBusinessFocusBlock({sourcePath: file, resolveCommit}), asOf: AS_OF});

        expect(projectPublicBusinessRows([node])).toEqual([]);
        expect(projectPublicBusinessRows([{...node, type: 'METRIC'}])).toEqual([]);                     // the id prefix still excludes it
        expect(projectPublicBusinessRows([{id: 'metric-x', properties: node.properties}])).toEqual([]); // publicFlag false excludes it
    });

    test('demoteHeadings turns every heading level into a bold line and leaves other lines alone', () => {
        expect(demoteHeadings('# A\n## B ##\n###### C\ntext # not a heading\n')).toBe('**A**\n**B**\n**C**\ntext # not a heading\n');
    });
});
