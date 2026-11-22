#!/usr/bin/env node
/**
 * @module ai.scripts.lint.lint-public-docs
 * @summary Validates `docs/public-manifest.json` against `learn/tree.json`, excludes ADR/measurement/incident records,
 * and enforces public-publish hygiene across every manifest-admitted Brain Markdown guide.
 *
 * Guarantees enforced on every run:
 * 1. **Structural parity:** `docs/public-manifest.json` and `learn/tree.json` have a `1:1` leaf mapping, valid
 *    non-orphan `parentId` hierarchy, and canonical `/learn/<id>` routes with zero ADR/measurement/incident leakage.
 * 2. **Content hygiene:** Admitted guides contain zero real host filesystem paths (`/Users/<name>/`, `/home/<name>/`,
 *    `C:\Users\<name>\`, or `file://` URLs targeting them), zero private-repository identifiers (`neomjs/business`,
 *    `neomjs/neo-stage`, `neomjs/neo-pro`), zero externally supplied forbidden terms (`forbiddenTerms` /
 *    `NEO_PUBLIC_DOCS_FORBIDDEN_TERMS`, keeping client names out of public source), and zero broken or unpublished
 *    relative Markdown links outside fenced and inline code. Relative links resolving inside `learn/` must target a
 *    manifest-admitted guide; relative links climbing outside `learn/` must target an existing committed `ai/**` file
 *    or directory (excluding gitignored `config.mjs` overlays) so Portal and SSR link rewriters resolve them to
 *    `neomjs/neo-agent-brain` on GitHub.
 */

import fs              from 'node:fs';
import path            from 'node:path';
import process         from 'node:process';
import {fileURLToPath} from 'node:url';
import {isEntryModule} from '../../services/shared/isEntryModule.mjs';

const
    __filename        = fileURLToPath(import.meta.url),
    ROOT_DIR          = path.resolve(path.dirname(__filename), '../../..'),
    EXPECTED_SCHEMA   = 'public-manifest.v1',
    EXPECTED_SPOKE    = 'neomjs/neo-agent-brain',
    EXCLUDED_SUBDIRS  = ['learn/agentos/decisions/', 'learn/agentos/measurements/', 'learn/agentos/incidents/'],
    UNIX_HOST_PATH_RE = /(?:^|[\s`'"(=:]|file:\/\/)(\/(?:Users|home)\/(?![<{]|(?:you|user|username)(?:\/|\b))[A-Za-z0-9._-]+\/[^\s`'")>\]]*)/gm,
    WIN_HOST_PATH_RE  = /(?:^|[\s`'"(=:]|file:\/\/\/?)([A-Za-z]:[\\/]Users[\\/](?![<{]|(?:you|user|username)(?:[\\/]|\b))[A-Za-z0-9._-]+[\\/][^\s`'")>\]]*)/gm,
    PRIVATE_REPO_RE   = /\bneomjs\/(?:business|neo-stage|neo-pro)\b/gi,
    REL_LINK_RE       = /\[(?:[^\[\]]|\[[^\]]*\])*\]\(([^)\s]+)\)/g,
    INLINE_CODE_RE    = /`[^`\n]+`/g,
    FENCE_RE          = /^ {0,3}(`{3,}|~{3,})/;

/**
 * @summary Every path glob whose modification can change this lint's verdict.
 * Imported by `lintWorkflowScanRootParity.spec.mjs` to keep `.github/workflows/brain-lint.yml` in lockstep.
 * @type {ReadonlyArray<String>}
 */
export const SCAN_SURFACE = Object.freeze([
    'docs/public-manifest.json',
    'learn/tree.json',
    'learn/agentos/**',
    'learn/benefits/**'
]);

/**
 * @summary Strips fenced Markdown code blocks while preserving line numbers for diagnostics.
 * @param {String} markdown
 * @returns {String}
 */
export function stripFencedCodeBlocks(markdown) {
    const
        lines = String(markdown).split('\n'),
        out   = [];

    let fence = null;

    for (const rawLine of lines) {
        const
            line  = rawLine.replace(/\r$/, ''),
            match = FENCE_RE.exec(line);

        if (fence) {
            if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
                fence = null
            }
            out.push('');
            continue
        }

        if (match) {
            fence = match[1];
            out.push('');
            continue
        }

        out.push(line)
    }

    return out.join('\n')
}

/**
 * @summary Computes the 1-based line number for a character offset in a string.
 * @param {String} text
 * @param {Number} index
 * @returns {Number}
 */
function lineAt(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text[i] === '\n') line++
    }
    return line
}

/**
 * @summary Escapes RegExp metacharacters in a literal token.
 * @param {String} value
 * @returns {String}
 */
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @summary Resolves optional forbidden terms from explicit options or `NEO_PUBLIC_DOCS_FORBIDDEN_TERMS`.
 * @param {String[]|null} [explicitTerms=null]
 * @returns {String[]}
 */
function resolveForbiddenTerms(explicitTerms) {
    if (Array.isArray(explicitTerms)) {
        return explicitTerms.map(t => String(t).trim()).filter(Boolean)
    }

    const envTerms = process.env.NEO_PUBLIC_DOCS_FORBIDDEN_TERMS;
    if (typeof envTerms === 'string' && envTerms.trim()) {
        return envTerms.split(',').map(t => t.trim()).filter(Boolean)
    }

    return []
}

/**
 * @summary Returns `true` when `repoRelPath` names a gitignored `AiConfig` local overlay rather than a committed template.
 * @param {String} repoRelPath
 * @returns {Boolean}
 */
function isGitignoredConfigOverlay(repoRelPath) {
    return repoRelPath === 'ai/config.mjs' || /^ai\/mcp\/server\/[^/]+\/config\.mjs$/.test(repoRelPath)
}

/**
 * @summary Validates `docs/public-manifest.json`, `learn/tree.json`, and all admitted Markdown files under `root`.
 * @param {Object} [options={}]
 * @param {String} [options.root=ROOT_DIR] Repository root directory.
 * @param {String} [options.manifestRelPath='docs/public-manifest.json'] Manifest path relative to `root`.
 * @param {String} [options.routePrefix='/learn/'] Required canonical URL prefix for routes in this spoke.
 * @param {String} [options.expectedSpoke=EXPECTED_SPOKE] Expected `spoke` identifier in the manifest.
 * @param {String[]|null} [options.forbiddenTerms=null] Optional forbidden tokens checked case-insensitively.
 * @returns {{entryCount: Number, routes: String[]}}
 */
export function lintPublicDocs({
    root            = ROOT_DIR,
    manifestRelPath = 'docs/public-manifest.json',
    routePrefix     = '/learn/',
    expectedSpoke   = EXPECTED_SPOKE,
    forbiddenTerms  = null
} = {}) {
    const
        errors          = [],
        activeForbidden = resolveForbiddenTerms(forbiddenTerms),
        manifestPath    = path.resolve(root, manifestRelPath);

    if (!fs.existsSync(manifestPath)) {
        throw new Error(`[public-docs] Missing manifest: ${manifestRelPath}`)
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (err) {
        throw new Error(`[public-docs] Invalid JSON in ${manifestRelPath}: ${err.message}`)
    }

    if (manifest?.schema !== EXPECTED_SCHEMA) {
        errors.push(`schema must be "${EXPECTED_SCHEMA}" (got ${JSON.stringify(manifest?.schema)})`)
    }
    if (manifest?.spoke !== expectedSpoke) {
        errors.push(`spoke must be "${expectedSpoke}" (got ${JSON.stringify(manifest?.spoke)})`)
    }
    if (typeof manifest?.treeFile !== 'string' || !manifest.treeFile.trim()) {
        errors.push('treeFile must be a non-empty relative path')
    }
    if (!Array.isArray(manifest?.treeMounts) || manifest.treeMounts.length === 0) {
        errors.push('treeMounts must be a non-empty array')
    }
    if (!Array.isArray(manifest?.entries) || manifest.entries.length === 0) {
        errors.push('entries must be a non-empty array')
    }

    if (errors.length > 0) {
        throw new Error(`[public-docs] ${manifestRelPath} failed header validation:\n  - ${errors.join('\n  - ')}`)
    }

    const treePath = path.resolve(root, manifest.treeFile);
    if (!fs.existsSync(treePath)) {
        throw new Error(`[public-docs] Missing treeFile declared by manifest: ${manifest.treeFile}`)
    }

    const tree = JSON.parse(fs.readFileSync(treePath, 'utf-8'));
    if (!Array.isArray(tree?.data)) {
        throw new Error(`[public-docs] ${manifest.treeFile} must contain a top-level "data" array`)
    }

    const
        learnRoot      = path.resolve(root, 'learn'),
        treeNodesById  = new Map(),
        treeLeafByFile = new Map();

    for (const node of tree.data) {
        if (!node || typeof node.id !== 'string' || typeof node.name !== 'string') {
            errors.push(`${manifest.treeFile}: every node requires string id and name`);
            continue
        }
        treeNodesById.set(node.id, node);
        if (node.isLeaf !== false) {
            treeLeafByFile.set(`learn/${node.id}.md`, node.id)
        }
    }

    for (const node of tree.data) {
        if (node.parentId !== null && node.parentId !== undefined) {
            const parent = treeNodesById.get(node.parentId);
            if (!parent || parent.isLeaf !== false) {
                errors.push(`${manifest.treeFile}: node "${node.id}" references missing or leaf parentId "${node.parentId}"`)
            }
        }
    }

    for (const mount of manifest.treeMounts) {
        const treeNode = treeNodesById.get(mount?.id);
        if (!treeNode || treeNode.isLeaf !== false || treeNode.parentId !== mount.parentId || treeNode.name !== mount.name) {
            errors.push(`treeMounts entry "${mount?.id}" does not match a folder node in ${manifest.treeFile}`)
        }
    }

    const
        seenFiles        = new Set(),
        seenRoutes       = new Set(),
        admittedAbsFiles = new Set();

    for (const entry of manifest.entries) {
        if (entry && typeof entry.file === 'string' && !entry.file.includes('..') && entry.file.startsWith('learn/') && entry.file.endsWith('.md')) {
            const absCandidate = path.resolve(root, entry.file);
            if (absCandidate.startsWith(learnRoot + path.sep) && fs.existsSync(absCandidate) && fs.statSync(absCandidate).isFile()) {
                admittedAbsFiles.add(absCandidate)
            }
        }
    }

    for (const [index, entry] of manifest.entries.entries()) {
        const label = `entries[${index}]`;

        if (!entry || typeof entry.file !== 'string' || typeof entry.route !== 'string') {
            errors.push(`${label}: each entry requires string "file" and "route"`);
            continue
        }

        const normalizedFile = path.posix.normalize(entry.file);
        if (normalizedFile !== entry.file || !entry.file.startsWith('learn/') || !entry.file.endsWith('.md') || entry.file.includes('..')) {
            errors.push(`${label}: invalid file path "${entry.file}" (must be normalized "learn/<path>.md")`);
            continue
        }

        if (EXCLUDED_SUBDIRS.some(prefix => entry.file.startsWith(prefix))) {
            errors.push(`${label}: excluded internal record "${entry.file}" cannot be published`)
        }

        if (seenFiles.has(entry.file)) {
            errors.push(`${label}: duplicate file "${entry.file}"`)
        }
        seenFiles.add(entry.file);

        if (!entry.route.startsWith(routePrefix) || entry.route.endsWith('/') || entry.route.endsWith('.md') || entry.route.includes('..')) {
            errors.push(`${label}: invalid route "${entry.route}" (must start with "${routePrefix}" without trailing "/" or ".md")`)
        }

        const expectedId = treeLeafByFile.get(entry.file);
        if (expectedId && entry.route !== `${routePrefix}${expectedId}`) {
            errors.push(`${label}: route "${entry.route}" does not match expected route "${routePrefix}${expectedId}"`)
        }

        if (seenRoutes.has(entry.route)) {
            errors.push(`${label}: duplicate route "${entry.route}"`)
        }
        seenRoutes.add(entry.route);

        const absFile = path.resolve(root, entry.file);
        if (!absFile.startsWith(learnRoot + path.sep) || !fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
            errors.push(`${label}: missing Markdown file "${entry.file}"`);
            continue
        }

        const
            rawMarkdown = fs.readFileSync(absFile, 'utf-8'),
            proseOnly   = stripFencedCodeBlocks(rawMarkdown);

        for (const [regex, kind] of [
            [UNIX_HOST_PATH_RE, 'host filesystem path'],
            [WIN_HOST_PATH_RE,  'Windows host filesystem path']
        ]) {
            regex.lastIndex = 0;
            for (const match of rawMarkdown.matchAll(regex)) {
                const
                    token = match[1],
                    line  = lineAt(rawMarkdown, match.index + match[0].indexOf(token));
                errors.push(`${entry.file}:${line}: forbidden ${kind} "${token}"`)
            }
        }

        PRIVATE_REPO_RE.lastIndex = 0;
        for (const match of rawMarkdown.matchAll(PRIVATE_REPO_RE)) {
            const line = lineAt(rawMarkdown, match.index);
            errors.push(`${entry.file}:${line}: forbidden private-repository reference "${match[0]}"`)
        }

        for (const term of activeForbidden) {
            const termRe = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
            for (const match of rawMarkdown.matchAll(termRe)) {
                const line = lineAt(rawMarkdown, match.index);
                errors.push(`${entry.file}:${line}: forbidden term "${match[0]}"`)
            }
        }

        const linkScanText = proseOnly.replace(INLINE_CODE_RE, match => ' '.repeat(match.length));

        REL_LINK_RE.lastIndex = 0;
        for (const match of linkScanText.matchAll(REL_LINK_RE)) {
            const
                rawTarget = match[1],
                target    = rawTarget.split(/[?#]/)[0];

            if (!target || /^(?:https?:|mailto:)/i.test(rawTarget) || rawTarget.startsWith('#') || rawTarget.startsWith('/')) continue;

            const
                resolvedExact = path.resolve(path.dirname(absFile), target),
                resolvedMd    = target.endsWith('.md') ? resolvedExact : path.resolve(path.dirname(absFile), `${target}.md`);

            if (admittedAbsFiles.has(resolvedExact) || admittedAbsFiles.has(resolvedMd)) {
                continue
            }

            const repoRel = path.relative(root, resolvedExact).split(path.sep).join('/');
            if (repoRel.startsWith('ai/') && !repoRel.startsWith('..') && !isGitignoredConfigOverlay(repoRel) && fs.existsSync(resolvedExact)) {
                continue
            }

            const line = lineAt(linkScanText, match.index);
            errors.push(`${entry.file}:${line}: broken relative Markdown link "${target}" (must resolve to a manifest-admitted guide or committed ai/** path)`)
        }
    }

    for (const relFile of treeLeafByFile.keys()) {
        if (!seenFiles.has(relFile)) {
            errors.push(`${manifest.treeFile}: leaf "${relFile}" is missing from ${manifestRelPath}`)
        }
    }

    for (const relFile of seenFiles) {
        if (!treeLeafByFile.has(relFile)) {
            errors.push(`${manifestRelPath}: "${relFile}" is not a leaf in ${manifest.treeFile}`)
        }
    }

    if (errors.length > 0) {
        throw new Error(`[public-docs] Validation failed (${errors.length} issue(s)):\n  - ${errors.join('\n  - ')}`)
    }

    return {
        entryCount: manifest.entries.length,
        routes    : [...seenRoutes]
    }
}

/**
 * @summary CLI runner returning `{exitCode, entryCount, routes}`.
 * @param {Object} [options={}]
 * @returns {{exitCode: Number, entryCount?: Number, routes?: String[]}}
 */
export function runLint(options = {}) {
    try {
        const result = lintPublicDocs(options);
        console.log(`[public-docs] OK — verified ${result.entryCount} manifest-listed Brain guides against learn/tree.json.`);
        return {exitCode: 0, ...result}
    } catch (err) {
        console.error(err.message);
        return {exitCode: 1}
    }
}

if (isEntryModule(import.meta.url)) {
    const {exitCode} = runLint();
    process.exit(exitCode)
}
