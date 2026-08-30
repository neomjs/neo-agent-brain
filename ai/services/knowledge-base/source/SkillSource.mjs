import Base     from './Base.mjs';
import fs       from 'fs-extra';
import path     from 'path';
import fg       from 'fast-glob';
import aiConfig from '../../../mcp/server/knowledge-base/config.mjs';

/**
 * @summary Indexes a skill document's trigger pointers by section.
 *
 * Lived in `ai/scripts/lint/lint-skill-manifest.mjs` until that lint retired with the corpus it
 * validated — this extractor was its only importer, so the parser moved to its consumer rather than
 * keeping a retired lint alive for one function. A trigger comment marks a section whose body is
 * delegated to a sub-rule file; the Knowledge Base carries that pointer into the chunk metadata so a
 * reader can follow it.
 *
 * @param {String} text Markdown source of one skill document.
 * @returns {Object[]} One entry per section carrying a trigger comment.
 */
export function parseSectionTriggers(text) {
    const index    = [];
    const sections = text.split(/^(?=#{2,6}\s)/m);

    for (const section of sections) {
        if (!section.trim()) continue;

        const headerMatch = section.match(/^(#{2,6})\s+([^\n]+)/);
        if (!headerMatch) continue;

        const anchor        = headerMatch[2].trim();
        const bodySizeBytes = Buffer.byteLength(section, 'utf8');

        const triggerMatch = section.match(/^<!-- trigger:\s+(.+?)\s+→\s+read\s+(.+?\.md)\s*-->$/m);
        if (triggerMatch) {
            index.push({
                anchor,
                trigger    : triggerMatch[1].trim(),
                subRulePath: triggerMatch[2].trim(),
                bodySizeBytes
            });
        }
    }

    return index;
}

/**
 * @summary Extracts knowledge chunks from Skill Markdown files.
 *
 * This source provider scans the `.agents/skills` directory for Markdown files.
 * It chunks documents by headers and extracts sub-metadata like `skillName`,
 * `sectionAnchor`, `triggerCondition`, and trigger-pointer sub-rule metadata.
 *
 * @class Neo.ai.services.knowledge-base.source.SkillSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class SkillSource extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.source.SkillSource'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.source.SkillSource',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Extracts knowledge chunks from Skill files.
     * @param {Object}   writeStream  The JSONL write stream.
     * @param {Function} createHashFn Function to create content hash.
     * @returns {Promise<Number>} The number of chunks extracted.
     */
    async extract(writeStream, createHashFn) {
        // Per-source path from the `sourcePaths` config (SSOT).
        const skillsBasePath = path.resolve(aiConfig.neoRootDir, aiConfig.sourcePaths.SkillSource);

        if (!await fs.pathExists(skillsBasePath)) {
            return 0
        }

        // Fast-glob's ordering is not a contract. Sort explicitly so legacy and repository readers
        // feed the shared parser byte-identically.
        const
            pattern    = path.join(skillsBasePath, '**/*.md').replace(/\\/g, '/'),
            skillFiles = (await fg(pattern)).sort(),
            documents  = await Promise.all(skillFiles.map(async filePath => ({
                content          : await fs.readFile(filePath, 'utf8'),
                root             : this.normalizeRelativePath(path.relative(aiConfig.neoRootDir, skillsBasePath)),
                sourcePath       : this.normalizeRelativePath(path.relative(aiConfig.neoRootDir, filePath)),
                skillRelativePath: this.normalizeRelativePath(path.relative(skillsBasePath, filePath))
            }))),
            result = this.createChunksFromDocuments({documents, createHashFn});

        this.writeChunks({chunks: result.chunks, writeStream});

        return result.chunks.length;
    }

    /**
     * @summary Extracts one Skill territory from an exact repository revision.
     * @param {Object} params
     * @returns {Promise<{count: Number, yieldedSourcePaths: String[], skippedSourcePaths: Object[]}>}
     */
    async extractFromRepository({context, writeStream, createHashFn} = {}) {
        const reader = context?.repositoryReader;

        if (!reader || typeof reader.readText !== 'function') {
            throw new TypeError('SkillSource repository extraction requires context.repositoryReader')
        }

        const
            documents          = [],
            skippedSourcePaths = [];

        for (const assignment of [...(context?.territory?.assignments || [])]
            .sort((left, right) => left.entry.sourcePath === right.entry.sourcePath
                ? 0
                : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1)) {
            if (!assignment.entry.sourcePath.endsWith('.md')) {
                continue
            }

            let content;

            try {
                content = await reader.readText(assignment.entry.sourcePath);
            } catch (error) {
                if (error.code === 'KB_REVISION_READER_BINARY_BLOB') {
                    skippedSourcePaths.push({
                        sourcePath: assignment.entry.sourcePath,
                        reason    : 'binary'
                    });
                    continue
                }
                throw error
            }

            documents.push({
                content,
                root             : assignment.root,
                sourcePath       : assignment.entry.sourcePath,
                skillRelativePath: assignment.relativePath
            });
        }

        const result = this.createChunksFromDocuments({documents, createHashFn});

        this.writeChunks({chunks: result.chunks, writeStream});

        return {
            count             : result.chunks.length,
            yieldedSourcePaths: result.yieldedSourcePaths,
            skippedSourcePaths
        };
    }

    /**
     * @summary Parses already-bound Skill documents without filesystem or config authority.
     * @param {Object} options
     * @returns {{chunks: Object[], yieldedSourcePaths: String[]}}
     * @protected
     */
    createChunksFromDocuments({documents = [], createHashFn}) {
        const
            ordered = [...documents].sort((left, right) => left.sourcePath === right.sourcePath
                ? 0
                : left.sourcePath < right.sourcePath ? -1 : 1),
            triggerTargetPathsBySkill = this.collectTriggerTargetPathsFromDocuments(ordered),
            chunks = [],
            yieldedSourcePaths = new Set();

        for (const {content, root = '.', sourcePath, skillRelativePath} of ordered) {
            const
                normalizedSkillPath = this.normalizeRelativePath(skillRelativePath),
                pathParts           = normalizedSkillPath.split('/'),
                skillFolder         = pathParts[0],
                skillTriggerTargets = triggerTargetPathsBySkill.get(
                    this.createSkillTerritoryKey(root, skillFolder)
                ),
                isAtlasMonolithSubRule = skillTriggerTargets?.size
                    ? skillTriggerTargets.has(normalizedSkillPath)
                    : pathParts.includes('references');

            let skillName        = skillFolder;
            let triggerCondition = '';
            let contentToParse   = content;

            const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);

            if (yamlMatch) {
                const
                    yaml         = yamlMatch[1],
                    nameMatch    = yaml.match(/^name:\s*(.*)/m),
                    triggerMatch = yaml.match(/^triggers:\s*(.*)/m);

                if (nameMatch) {
                    skillName = nameMatch[1].trim();
                }
                if (triggerMatch) {
                    triggerCondition = triggerMatch[1].trim();
                }

                contentToParse = content.substring(yamlMatch[0].length).trim();
            }

            for (const section of contentToParse.split(/(?=^#+\s)/m)) {
                if (section.trim() === '') {
                    continue
                }

                const
                    headingMatch  = section.match(/^#+\s(.*)/),
                    sectionAnchor = headingMatch ? headingMatch[1].trim() : '',
                    chunk         = {
                        type   : 'skill',
                        kind   : 'skill',
                        name   : `${skillName}${sectionAnchor ? ` - ${sectionAnchor}` : ''}`,
                        content: section.trim(),
                        source : sourcePath,
                        skillName,
                        sectionAnchor,
                        triggerCondition,
                        isAtlasMonolithSubRule
                    };

                chunk.hash = createHashFn(chunk);
                chunks.push(chunk);
                yieldedSourcePaths.add(sourcePath);
            }
        }

        return {
            chunks,
            yieldedSourcePaths: [...yieldedSourcePaths].sort()
        };
    }

    /**
     * @summary Writes parsed chunks in deterministic order.
     * @param {Object} options
     * @protected
     */
    writeChunks({chunks, writeStream}) {
        chunks.forEach(chunk => writeStream.write(JSON.stringify(chunk) + '\n'));
    }

    /**
     * Builds a per-skill set of files targeted by trigger-pointer comments.
     * @param {String[]} skillFiles      Absolute skill markdown file paths.
     * @param {String}   skillsBasePath Absolute `.agents/skills` path.
     * @returns {Promise<Map<String, Set<String>>>}
     */
    async collectTriggerTargetPathsBySkill(skillFiles, skillsBasePath) {
        const documents = await Promise.all(skillFiles.map(async filePath => ({
            content          : await fs.readFile(filePath, 'utf8'),
            root             : this.normalizeRelativePath(path.relative(aiConfig.neoRootDir, skillsBasePath)),
            sourcePath       : this.normalizeRelativePath(path.relative(aiConfig.neoRootDir, filePath)),
            skillRelativePath: this.normalizeRelativePath(path.relative(skillsBasePath, filePath))
        })));

        return this.collectTriggerTargetPathsFromDocuments(documents);
    }

    /**
     * @summary Builds trigger-target membership across a complete in-memory Skill territory.
     * @param {Object[]} documents
     * @returns {Map<String, Set<String>>}
     * @protected
     */
    collectTriggerTargetPathsFromDocuments(documents = []) {
        const targetPathsBySkill = new Map();

        for (const {content, root = '.', skillRelativePath} of documents) {
            const
                normalizedSkillPath = this.normalizeRelativePath(skillRelativePath),
                skillFolder         = normalizedSkillPath.split('/')[0],
                sectionTriggers     = parseSectionTriggers(content),
                territoryKey        = this.createSkillTerritoryKey(root, skillFolder);

            if (!sectionTriggers.length) {
                continue
            }

            const skillTargets = targetPathsBySkill.get(territoryKey) || new Set();

            targetPathsBySkill.set(territoryKey, skillTargets);

            for (const {subRulePath} of sectionTriggers) {
                const targetRelative = this.normalizeRelativePath(
                    path.posix.normalize(path.posix.join(path.posix.dirname(normalizedSkillPath), subRulePath))
                );

                if (!targetRelative.startsWith(`${skillFolder}/`)) {
                    continue
                }

                skillTargets.add(targetRelative);
            }
        }

        return targetPathsBySkill;
    }

    /**
     * @summary Keys trigger-target metadata by territory root plus skill folder.
     *
     * Two declared roots may both contain `skill/SKILL.md`. Folder-only keys would let a pointer
     * from one repository territory mark the other root's same-relative-path document.
     *
     * @param {String} root Canonical repository-relative route root.
     * @param {String} skillFolder Root-relative skill folder.
     * @returns {String}
     * @protected
     */
    createSkillTerritoryKey(root, skillFolder) {
        return `${root}\0${skillFolder}`;
    }

    /**
     * Normalizes relative filesystem paths for trigger-target matching.
     * @param {String} filePath Relative file path.
     * @returns {String}
     */
    normalizeRelativePath(filePath) {
        return filePath.split(path.sep).join('/');
    }
}

export default Neo.setupClass(SkillSource);
