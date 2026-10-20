import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'LintAdrSeamTableTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import fs             from 'fs';
import os             from 'os';
import path           from 'path';

import {
    checkSeamTable,
    findCompositionAdr,
    listPresentAdrIds,
    listPresentAdrRecords,
    listSeamTableRowIds,
    listSeamTableRows
} from '../../../../../../ai/scripts/lint/lint-adr-seam-table.mjs';

const TABLE = (rows) => [
    '# ADR 9990: Composition Fixture',
    '',
    '## §2 The Seam Table',
    '',
    '| ADR | Surface | Owned seam | Parent |',
    '|---|---|---|---|',
    ...rows.map(id => `| ${id} | X | Y | — |`),
    '',
    '## §3 Next Section',
    'prose'
].join('\n');

function fixtureDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-adr-lint-'));

    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content, 'utf8')
    }

    return dir
}

test.describe('ai.scripts.lint.lint-adr-seam-table (#14525)', () => {

    test('listPresentAdrIds derives 4-digit ids from filenames only', () => {
        const dir = fixtureDir({
            '0001-a.md' : 'x',
            '0002-b.md' : 'x',
            'notes.md'  : 'x',
            '123-bad.md': 'x'
        });

        expect(listPresentAdrIds(dir)).toEqual(['0001', '0002']);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('findCompositionAdr locates by content marker, never by filename', () => {
        const dir = fixtureDir({
            '0001-a.md'   : 'no table here',
            '0007-comp.md': TABLE(['0001', '0007'])
        });

        expect(findCompositionAdr(dir)?.file).toBe('0007-comp.md');
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('listSeamTableRowIds parses only the §2 table section — rows after the next heading are ignored', () => {
        const content = TABLE(['0001', '0002']) + '\n| 0099 | outside | the table | — |\n';

        // 0099 sits AFTER '## §3 Next Section', so the parser must not see it.
        expect(listSeamTableRowIds(content)).toEqual(['0001', '0002']);
    });

    test('checkSeamTable passes when ids and rows match both directions', () => {
        const dir = fixtureDir({
            '0001-a.md'   : 'x',
            '0002-comp.md': TABLE(['0001', '0002'])
        });

        const result = checkSeamTable(dir);

        expect(result.ok).toBe(true);
        expect(result.missingRows).toEqual([]);
        expect(result.ghostRows).toEqual([]);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('checkSeamTable fails with a MISSING row when a present ADR has no table entry', () => {
        const dir = fixtureDir({
            '0001-a.md'   : 'x',
            '0002-b.md'   : 'x',
            '0003-comp.md': TABLE(['0001', '0003'])
        });

        const result = checkSeamTable(dir);

        expect(result.ok).toBe(false);
        expect(result.missingRows).toEqual(['0002']);
        expect(result.ghostRows).toEqual([]);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('checkSeamTable fails with a GHOST row when the table names an absent ADR', () => {
        const dir = fixtureDir({
            '0001-a.md'   : 'x',
            '0002-comp.md': TABLE(['0001', '0002', '0042'])
        });

        const result = checkSeamTable(dir);

        expect(result.ok).toBe(false);
        expect(result.missingRows).toEqual([]);
        expect(result.ghostRows).toEqual(['0042']);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('checkSeamTable fails when no composition ADR exists', () => {
        const dir = fixtureDir({'0001-a.md': 'no marker'});

        const result = checkSeamTable(dir);

        expect(result.ok).toBe(false);
        expect(result.file).toBeNull();
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('checkSeamTable fails on DUPLICATE rows — set equality is not cardinality (gpt RA, PR #14527)', () => {
        const dir = fixtureDir({
            '0001-a.md'   : 'x',
            '9990-comp.md': TABLE(['0001', '0001', '9990'])
        });

        const result = checkSeamTable(dir);

        expect(result.ok).toBe(false);
        expect(result.duplicateRows).toEqual(['0001']);
        expect(result.missingRows).toEqual([]);
        expect(result.ghostRows).toEqual([]);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('checkSeamTable fails on MULTIPLE marker files — exactly one composition record (Grace hardening)', () => {
        const dir = fixtureDir({
            '0001-a.md'   : TABLE(['0001', '0002']),
            '0002-comp.md': TABLE(['0001', '0002'])
        });

        const result = checkSeamTable(dir);

        expect(result.ok).toBe(false);
        expect(result.ambiguousFiles).toEqual(['0001-a.md', '0002-comp.md']);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('AC3: ignores redirect pointers in listPresentAdrIds and listPresentAdrRecords and accepts explicit compositionAdr authority across repositories', () => {
        const
            redirect0034 = [
                '---',
                'type: redirect',
                'target: adr:github.com:220867748:neomjs%2Fneo:0034',
                '---',
                '# Moved to neomjs/neo-agent-institution'
            ].join('\n'),
            neoDir = fixtureDir({
                '0031-target-architecture-composition.md': TABLE(['0001', '0031', '0034']),
                '0034-electron-shell-architecture.md'    : redirect0034
            }),
            brainDir = fixtureDir({
                '0001-cross-process-cache-coherence.md': '# ADR 0001: Cache Coherence'
            }),
            instDir = fixtureDir({
                '0034-electron-shell-architecture.md': '# ADR 0034: Electron Shell'
            });

        expect(listPresentAdrIds(neoDir)).toEqual(['0031']);

        const multiResult = checkSeamTable({
            compositionAdr: path.join(neoDir, '0031-target-architecture-composition.md'),
            sources       : [
                {dir: neoDir,   repositoryId: '220867748',  namespace: 'neomjs/neo'},
                {dir: brainDir, repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain'},
                {dir: instDir,  repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution'}
            ]
        });

        expect(multiResult.ok).toBe(true);
        expect(multiResult.missingRows).toEqual([]);
        expect(multiResult.ghostRows).toEqual([]);
        expect(multiResult.redirects).toHaveLength(1);
        expect(multiResult.redirects[0].target).toBe('adr:github.com:220867748:neomjs%2Fneo:0034');
        expect(multiResult.presentRecords.map(r => r.qualifiedId).sort()).toEqual([
            'neomjs/neo#0031',
            'neomjs/neo-agent-brain#0001',
            'neomjs/neo-agent-institution#0034'
        ]);

        fs.rmSync(neoDir,   {recursive: true, force: true});
        fs.rmSync(brainDir, {recursive: true, force: true});
        fs.rmSync(instDir,  {recursive: true, force: true});
    });

    test('AC3 & AC5: equal bare numbers across separate repositories (neomjs/neo-stage 0001 and neomjs/neo-agent-brain 0001) coexist without collision or silent winner selection', () => {
        const
            brainDir = fixtureDir({
                '0001-cross-process-cache-coherence.md': '# ADR 0001: Cross-Process Cache Coherence'
            }),
            stageDir = fixtureDir({
                '0001-the-engine-contract.md': '# ADR 0001: The Engine Contract'
            }),
            sources = [
                {dir: brainDir, repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain'},
                {dir: stageDir, repositoryId: '1350000001', namespace: 'neomjs/neo-stage'}
            ];

        const {records, intraRepoDuplicates} = listPresentAdrRecords(sources);
        expect(intraRepoDuplicates).toEqual([]);
        expect(records.map(r => r.canonicalKey)).toEqual([
            'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0001',
            'adr:github.com:1350000001:neomjs%2Fneo-stage:0001'
        ]);

        // 1. Qualified seam table rows validate both 0001 records distinctly
        const qualifiedTable = TABLE(['neomjs/neo-agent-brain#0001', 'neomjs/neo-stage#0001']);
        expect(listSeamTableRows(qualifiedTable).map(r => r.qualifiedId)).toEqual([
            'neomjs/neo-agent-brain#0001',
            'neomjs/neo-stage#0001'
        ]);

        const qualifiedResult = checkSeamTable({
            compositionAdr: {file: '0031-comp.md', content: qualifiedTable},
            sources
        });
        expect(qualifiedResult.ok).toBe(true);
        expect(qualifiedResult.duplicateRows).toEqual([]);
        expect(qualifiedResult.ambiguousRows).toEqual([]);

        // 2. AgentOS 0031 cut table coexists with non-cut neo-stage 0001 without collision
        const cutResult = checkSeamTable({
            compositionAdr: {file: '0031-target-architecture-composition.md', content: TABLE(['0001'])},
            sources
        });
        expect(cutResult.ok).toBe(true);
        expect(cutResult.presentRecords).toHaveLength(2);

        // 3. When both repos are explicitly governed against an unqualified 0001 row, refuses silent winner selection
        const ambiguousResult = checkSeamTable({
            compositionAdr: {file: '0031-comp.md', content: TABLE(['0001'])},
            sources       : sources.map(s => ({...s, governedByComposition: true}))
        });
        expect(ambiguousResult.ok).toBe(false);
        expect(ambiguousResult.ambiguousRows).toEqual(['0001']);

        fs.rmSync(brainDir, {recursive: true, force: true});
        fs.rmSync(stageDir, {recursive: true, force: true});
    });
});
