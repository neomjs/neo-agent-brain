import {setup} from '../../../../../setup.mjs';

const appName = 'SkillSourceTest';

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

import {test, expect}  from '@playwright/test';
import {createHash}    from 'node:crypto';
import fs              from 'fs-extra';
import os              from 'node:os';
import path            from 'path';
import {fileURLToPath} from 'url';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '../../../../../../..');

test.describe('Neo.ai.services.knowledge-base.source.SkillSource', () => {
    let SkillSource;
    let aiConfig;
    let originalRoot;
    let originalSkillSourcePath;
    let mockRoot;

    test.beforeAll(async () => {
        aiConfig    = (await import('../../../../../../../ai/mcp/server/knowledge-base/config.template.mjs')).default;
        SkillSource = (await import('../../../../../../../ai/services/knowledge-base/source/SkillSource.mjs')).default;

        originalRoot = aiConfig.neoRootDir;
        originalSkillSourcePath = aiConfig.sourcePaths.SkillSource;

        mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-source-mock-'));

        const skillsDir = path.join(mockRoot, '.agents/skills');
        fs.ensureDirSync(path.join(skillsDir, 'ideation-sandbox/references/audits'));
        fs.ensureDirSync(path.join(skillsDir, 'legacy-skill/references'));
        fs.ensureDirSync(path.join(skillsDir, 'simple-skill'));

        // Monolith SKILL.md with YAML frontmatter
        fs.writeFileSync(path.join(skillsDir, 'ideation-sandbox/SKILL.md'),
`---
name: custom-ideation
triggers: use when exploring
---

# Overview
Ideation description.

# Rules
1. Do this
2. Do that`);

        // Workflow map with a trigger-pointer target
        fs.writeFileSync(path.join(skillsDir, 'ideation-sandbox/references/workflow.md'),
`## Stage 1
<!-- trigger: edge-case validation → read ./audits/rare-rule.md -->
Stage 1 details.
## Stage 2
Stage 2 details.`);

        fs.writeFileSync(path.join(skillsDir, 'ideation-sandbox/references/audits/rare-rule.md'),
`# Rare Rule
Rare rule details.`);

        // Simple skill without YAML
        fs.writeFileSync(path.join(skillsDir, 'simple-skill/SKILL.md'),
`# Simple
Simple skill contents.`);

        // Legacy reference payload without trigger-pointer metadata keeps fallback behavior.
        fs.writeFileSync(path.join(skillsDir, 'legacy-skill/references/legacy.md'),
`# Legacy
Legacy skill payload.`);

        aiConfig.neoRootDir = mockRoot;
        aiConfig.sourcePaths.SkillSource = '.agents/skills';
    });

    test.afterAll(() => {
        aiConfig.neoRootDir = originalRoot;
        aiConfig.sourcePaths.SkillSource = originalSkillSourcePath;
        if (mockRoot && fs.existsSync(mockRoot)) fs.removeSync(mockRoot);
    });

    test('is a Neo.setupClass singleton with the expected className and extract() method', () => {
        expect(SkillSource, 'default export must resolve').toBeDefined();
        expect(SkillSource.className).toBe('Neo.ai.services.knowledge-base.source.SkillSource');
        expect(typeof SkillSource.extract).toBe('function');
    });

    test('extract() emits correctly typed and chunked skills with sub-metadata', async () => {
        const written     = [];
        const writeStream = {
            write(chunkStr) {
                written.push(JSON.parse(chunkStr.trim()));
                return true;
            }
        };
        const createHashFn = chunk => 'hash:' + chunk.name;

        const count = await SkillSource.extract(writeStream, createHashFn);

        // ideation-sandbox SKILL.md -> Overview chunk + Rules chunk (2)
        // ideation-sandbox workflow.md -> Stage 1 + Stage 2 (2)
        // ideation-sandbox rare-rule.md -> Rare Rule (1)
        // simple-skill SKILL.md -> Simple (1)
        // legacy-skill legacy.md -> Legacy (1)
        expect(count).toBe(7);
        expect(written).toHaveLength(7);

        const ideationChunks = written.filter(w => w.skillName === 'custom-ideation');
        expect(ideationChunks).toHaveLength(2);

        const overviewChunk = ideationChunks.find(w => w.sectionAnchor === 'Overview');
        expect(overviewChunk).toBeDefined();
        expect(overviewChunk).toMatchObject({
            type                  : 'skill',
            kind                  : 'skill',
            triggerCondition      : 'use when exploring',
            isAtlasMonolithSubRule: false,
            content               : '# Overview\nIdeation description.',
            name                  : 'custom-ideation - Overview'
        });

        const rulesChunk = ideationChunks.find(w => w.sectionAnchor === 'Rules');
        expect(rulesChunk).toBeDefined();

        const workflowChunks = written.filter(w => w.skillName === 'ideation-sandbox' && w.sectionAnchor.startsWith('Stage'));
        expect(workflowChunks).toHaveLength(2);
        expect(workflowChunks[0].triggerCondition).toBe('');
        expect(workflowChunks.every(w => !w.isAtlasMonolithSubRule)).toBe(true);

        const rareRuleChunk = written.find(w => w.source.endsWith('rare-rule.md'));
        expect(rareRuleChunk).toBeDefined();
        expect(rareRuleChunk.isAtlasMonolithSubRule).toBe(true);

        const simpleChunk = written.find(w => w.skillName === 'simple-skill');
        expect(simpleChunk).toBeDefined();
        expect(simpleChunk.triggerCondition).toBe('');
        expect(simpleChunk.isAtlasMonolithSubRule).toBe(false);

        const legacyChunk = written.find(w => w.skillName === 'legacy-skill');
        expect(legacyChunk).toBeDefined();
        expect(legacyChunk.isAtlasMonolithSubRule).toBe(true);
    });

    test('repository-bound extraction is byte-equivalent for one Skill territory and ignores ambient config', async () => {
        const
            createHashFn = chunk => 'hash:' + chunk.name,
            legacyWrites = [],
            portWrites   = [],
            legacyCount  = await SkillSource.extract({
                write: value => legacyWrites.push(value)
            }, createHashFn),
            skillsDir = path.join(mockRoot, '.agents/skills'),
            relativeFiles = (await fs.readdir(skillsDir, {recursive: true}))
                .filter(filePath => filePath.endsWith('.md'))
                .map(filePath => filePath.split(path.sep).join('/'))
                .sort(),
            assignments = relativeFiles.map(skillRelativePath => ({
                root        : '.agents/skills',
                relativePath: skillRelativePath,
                entry       : {
                    sourcePath: `.agents/skills/${skillRelativePath}`
                }
            }));

        aiConfig.sourcePaths.SkillSource = 'does-not-exist';
        aiConfig.neoRootDir = path.join(mockRoot, 'ambient-root-must-not-be-read');

        try {
            const result = await SkillSource.extractFromRepository({
                context: {
                    repositoryReader: {
                        async readText(sourcePath) {
                            return await fs.readFile(path.join(mockRoot, sourcePath), 'utf8')
                        }
                    },
                    territory: {assignments}
                },
                writeStream: {write: value => portWrites.push(value)},
                createHashFn
            });

            expect(result.count).toBe(legacyCount);
            expect(portWrites).toEqual(legacyWrites);
            expect(result.yieldedSourcePaths).toEqual(assignments
                .map(assignment => assignment.entry.sourcePath)
                .sort());
        } finally {
            aiConfig.sourcePaths.SkillSource = originalSkillSourcePath;
            aiConfig.neoRootDir = mockRoot;
        }
    });

    test('a trigger-pointer-only change re-identifies an unchanged target on territory replay', () => {
        const
            createHashFn = chunk => createHash('sha256').update(JSON.stringify(chunk)).digest('hex'),
            target       = {
                sourcePath       : '.agents/skills/skill/rule.md',
                skillRelativePath: 'skill/rule.md',
                content          : '# Rule\nUnchanged target content.'
            },
            withPointer = SkillSource.createChunksFromDocuments({
                createHashFn,
                documents: [{
                    sourcePath       : '.agents/skills/skill/SKILL.md',
                    skillRelativePath: 'skill/SKILL.md',
                    content          : '## Skill\n<!-- trigger: edge → read ./rule.md -->\nPointer.'
                }, target]
            }),
            withoutPointer = SkillSource.createChunksFromDocuments({
                createHashFn,
                documents: [{
                    sourcePath       : '.agents/skills/skill/SKILL.md',
                    skillRelativePath: 'skill/SKILL.md',
                    content          : '## Skill\nPointer removed.'
                }, target]
            }),
            before = withPointer.chunks.find(chunk => chunk.source === target.sourcePath),
            after  = withoutPointer.chunks.find(chunk => chunk.source === target.sourcePath);

        expect(before.content).toBe(after.content);
        expect(before.isAtlasMonolithSubRule).toBe(true);
        expect(after.isAtlasMonolithSubRule).toBe(false);
        expect(before.hash).not.toBe(after.hash);
        expect(withPointer.yieldedSourcePaths).toContain(target.sourcePath);
        expect(withoutPointer.yieldedSourcePaths).toContain(target.sourcePath);
    });

    test('trigger-target membership cannot bleed across same-shaped folders in two roots', () => {
        const
            createHashFn = chunk => createHash('sha256').update(JSON.stringify(chunk)).digest('hex'),
            result       = SkillSource.createChunksFromDocuments({
                createHashFn,
                documents: [{
                    root             : 'root-a',
                    sourcePath       : 'root-a/skill/SKILL.md',
                    skillRelativePath: 'skill/SKILL.md',
                    content          : '## Skill\n<!-- trigger: edge → read ./rule.md -->\nPointer.'
                }, {
                    root             : 'root-a',
                    sourcePath       : 'root-a/skill/rule.md',
                    skillRelativePath: 'skill/rule.md',
                    content          : '# Rule\nA.'
                }, {
                    root             : 'root-b',
                    sourcePath       : 'root-b/skill/SKILL.md',
                    skillRelativePath: 'skill/SKILL.md',
                    content          : '## Skill\nNo pointer.'
                }, {
                    root             : 'root-b',
                    sourcePath       : 'root-b/skill/rule.md',
                    skillRelativePath: 'skill/rule.md',
                    content          : '# Rule\nB.'
                }]
            }),
            rootA = result.chunks.find(chunk => chunk.source === 'root-a/skill/rule.md'),
            rootB = result.chunks.find(chunk => chunk.source === 'root-b/skill/rule.md');

        expect(rootA.isAtlasMonolithSubRule).toBe(true);
        expect(rootB.isAtlasMonolithSubRule).toBe(false);
    });

    test('records a matched binary Markdown blob as an extractor-owned skip', async () => {
        const result = await SkillSource.extractFromRepository({
            context: {
                repositoryReader: {
                    async readText() {
                        const error = new Error('binary');
                        error.code = 'KB_REVISION_READER_BINARY_BLOB';
                        throw error
                    }
                },
                territory: {
                    assignments: [{
                        root        : '.agents/skills',
                        relativePath: 'skill/Binary.md',
                        entry       : {sourcePath: '.agents/skills/skill/Binary.md'}
                    }]
                }
            },
            writeStream: {write() {
                throw new Error('binary content must not emit')
            }},
            createHashFn: () => 'hash'
        });

        expect(result).toEqual({
            count             : 0,
            yieldedSourcePaths: [],
            skippedSourcePaths: [{
                sourcePath: '.agents/skills/skill/Binary.md',
                reason    : 'binary'
            }]
        });
    });

    test('extract() returns 0 and writes nothing when the skills directory is absent', async () => {
        const missingRoot = path.join(mockRoot, 'does-not-exist');
        aiConfig.neoRootDir = missingRoot;
        try {
            const written     = [];
            const writeStream = {
                write(chunkStr) { written.push(chunkStr); return true; }
            };

            const count = await SkillSource.extract(writeStream, () => 'h');

            expect(count).toBe(0);
            expect(written).toHaveLength(0);
        } finally {
            aiConfig.neoRootDir = mockRoot;
        }
    });


});
