#!/usr/bin/env node

/**
 * @summary Lints the target-architecture composition ADR's seam table against the present ADR corpus.
 *
 * The target-architecture composition record stays trustworthy BY CONSTRUCTION: this guard derives
 * the present ADR ids from `learn/agentos/decisions/[0-9][0-9][0-9][0-9]-*.md` and fails unless the
 * seam table contains exactly one row per present id — both directions (no missing rows, no ghost
 * rows). Id-based, never count-based (the graduation-record constraint): a new ADR merges WITH its
 * seam-table row in the same diff, or CI fails.
 *
 * The composition ADR is located by CONTENT (the seam-table marker), not by filename/number, so
 * renumbering or renaming never silently disables the guard.
 */

import fs                                from 'fs';
import path                              from 'path';
import {fileURLToPath}                   from 'url';
import {isAdrRedirect, parseAdrRedirect} from '../../services/shared/adrRedirect.mjs';
import {
    ADR_FILE_REGEX,
    KNOWN_CUT_REPOSITORIES,
    buildCanonicalAdrKey,
    parseCanonicalAdrKey
} from '../../services/shared/adrIdentityCodec.mjs';

const
    __filename    = fileURLToPath(import.meta.url),
    __dirname     = path.dirname(__filename),
    ROOT_DIR      = path.resolve(__dirname, '../../..'),
    DECISIONS_DIR = path.join(ROOT_DIR, 'learn/agentos/decisions'),
    TABLE_MARKER  = '## §2 The Seam Table';

/**
 * @summary Resolves the default multi-repository ADR directories for CLI and zero-arg invocations.
 * Prefers the post-cut sibling repositories (`neo` + `neo-agent-institution`) when available alongside
 * `neo-agent-brain`, and falls back to installed `node_modules/neo.mjs` in single-repo CI checkouts.
 * @param {String} [rootDir=ROOT_DIR]
 * @returns {Array<{dir: String, forge: String, repositoryId: String, namespace: String, governedByComposition: Boolean}>}
 */
export function resolveDefaultSeamSources(rootDir = ROOT_DIR) {
    const
        brainDir       = path.join(rootDir, 'learn/agentos/decisions'),
        siblingNeoDir  = path.resolve(rootDir, '../neo/learn/agentos/decisions'),
        siblingInstDir = path.resolve(rootDir, '../neo-agent-institution/learn/agentos/decisions'),
        pkgNeoDir      = path.join(rootDir, 'node_modules/neo.mjs/learn/agentos/decisions'),
        sources        = [];

    if (fs.existsSync(brainDir)) {
        sources.push({
            dir         : brainDir,
            forge       : 'github.com',
            repositoryId: '1344062228',
            namespace   : 'neomjs/neo-agent-brain'
        });
    }

    if (fs.existsSync(siblingNeoDir) && fs.existsSync(siblingInstDir)) {
        sources.push(
            {
                dir         : siblingNeoDir,
                forge       : 'github.com',
                repositoryId: '220867748',
                namespace   : 'neomjs/neo'
            },
            {
                dir         : siblingInstDir,
                forge       : 'github.com',
                repositoryId: '1347756127',
                namespace   : 'neomjs/neo-agent-institution'
            }
        );
    } else if (fs.existsSync(pkgNeoDir)) {
        sources.push({
            dir         : pkgNeoDir,
            forge       : 'github.com',
            repositoryId: '220867748',
            namespace   : 'neomjs/neo'
        });
    }

    return sources;
}

/**
 * @summary Lists the 4-digit ids of all present non-redirect ADR files in a directory.
 * Redirect pointers (`isAdrRedirect`) are excluded so moved records never count as present in their old location.
 * @param {String} [dir=DECISIONS_DIR] Decisions directory.
 * @returns {String[]} Sorted unique ids, e.g. `['0001', …]`.
 */
export function listPresentAdrIds(dir = DECISIONS_DIR) {
    if (!fs.existsSync(dir)) return [];

    const ids = new Set();

    for (const name of fs.readdirSync(dir)) {
        const match = /^(\d{4})-.*\.md$/.exec(name);
        if (!match) continue;

        const content = fs.readFileSync(path.join(dir, name), 'utf8');
        if (isAdrRedirect(content)) continue;

        ids.add(match[1]);
    }

    return [...ids].sort();
}

/**
 * @summary Lists repository-qualified present ADR records across one or more repository sources,
 * ignoring redirect pointers (`isAdrRedirect`) while recording redirect observations separately.
 * @param {Array<Object|String>} [sources=[]] Directory paths or source descriptors `{dir, forge, repositoryId, namespace, governedByComposition}`.
 * @returns {{records: Object[], redirects: Object[], intraRepoDuplicates: String[]}}
 */
export function listPresentAdrRecords(sources = []) {
    const
        normalizedSources = (Array.isArray(sources) ? sources : [sources]).map(src =>
            typeof src === 'string' ? {dir: src, forge: 'github.com', repositoryId: null, namespace: null} : src
        ),
        records             = [],
        redirects           = [],
        intraRepoDuplicates = [],
        seenPerRepo         = new Map();

    for (const source of normalizedSources) {
        const
            dir                   = source?.dir,
            forge                 = source?.forge || 'github.com',
            knownRepo             = KNOWN_CUT_REPOSITORIES.find(r => r.namespace === source?.namespace || r.repositoryId === source?.repositoryId),
            repositoryId          = source?.repositoryId || knownRepo?.repositoryId || null,
            namespace             = source?.namespace || knownRepo?.namespace || null,
            governedByComposition = source?.governedByComposition !== false,
            repoScopeKey          = repositoryId ? `${forge}:${repositoryId}` : (namespace || dir);

        if (!dir || !fs.existsSync(dir)) continue;
        if (!seenPerRepo.has(repoScopeKey)) seenPerRepo.set(repoScopeKey, new Set());
        const repoNumbers = seenPerRepo.get(repoScopeKey);

        for (const name of fs.readdirSync(dir).sort()) {
            const match = ADR_FILE_REGEX.exec(name);
            if (!match) continue;

            const
                [, adrNumber, slug] = match,
                filePath            = path.join(dir, name),
                content             = fs.readFileSync(filePath, 'utf8'),
                redirectInfo        = parseAdrRedirect(content);

            if (redirectInfo.isRedirect) {
                redirects.push({
                    file      : name,
                    filePath,
                    adrNumber,
                    slug,
                    forge,
                    repositoryId,
                    namespace,
                    target    : redirectInfo.target,
                    valid     : redirectInfo.valid,
                    reasonCode: redirectInfo.reasonCode
                });
                continue;
            }

            if (repoNumbers.has(adrNumber)) {
                intraRepoDuplicates.push(namespace ? `${namespace}#${adrNumber}` : adrNumber);
            }
            repoNumbers.add(adrNumber);

            const
                canonicalKey = (repositoryId && namespace)
                    ? buildCanonicalAdrKey({forge, repositoryId, namespace, number: adrNumber})
                    : null,
                qualifiedId  = namespace ? `${namespace}#${adrNumber}` : adrNumber;

            records.push({
                id                : adrNumber,
                adrNumber,
                slug,
                file              : name,
                filePath,
                forge,
                repositoryId,
                namespace,
                qualifiedId,
                canonicalKey,
                explicitlyGoverned: typeof source?.governedByComposition === 'boolean' ? source.governedByComposition : null,
                governedByComposition
            });
        }
    }

    return {
        records,
        redirects,
        intraRepoDuplicates: [...new Set(intraRepoDuplicates)].sort()
    };
}

/**
 * @summary Finds the composition ADR by its seam-table content marker across one directory or a list of sources,
 * ignoring redirect pointers and enforcing marker uniqueness.
 * @param {String|Array<Object|String>} [dirOrSources=DECISIONS_DIR] Decisions directory or array of source descriptors.
 * @returns {{file: String, content: String, namespace?: String|null, ambiguousFiles: String[]}|null}
 */
export function findCompositionAdr(dirOrSources = DECISIONS_DIR) {
    const
        sources = Array.isArray(dirOrSources)
            ? dirOrSources.map(s => typeof s === 'string' ? {dir: s, namespace: null} : s)
            : [{dir: dirOrSources, namespace: null}],
        matches = [];

    for (const source of sources) {
        if (!source?.dir || !fs.existsSync(source.dir)) continue;

        for (const name of fs.readdirSync(source.dir).sort()) {
            if (!/\.md$/.test(name)) continue;

            const content = fs.readFileSync(path.join(source.dir, name), 'utf8');
            if (isAdrRedirect(content)) continue;

            if (content.includes(TABLE_MARKER)) {
                matches.push({
                    file     : name,
                    content,
                    namespace: source.namespace || null
                });
            }
        }
    }

    if (matches.length === 0) return null;

    return {
        ...matches[0],
        ambiguousFiles: matches.length > 1 ? matches.map(match => match.file) : []
    };
}

/**
 * @summary Extracts structured seam-table row descriptors from the composition ADR's `## §2 The Seam Table` section.
 * Supports bare 4-digit rows (`| 0001 | ... |`), repository-qualified rows (`| neomjs/neo-stage#0001 | ... |`),
 * canonical decision keys (`| adr:github.com:...:0001 | ... |`), or an explicit repository column.
 * @param {String} content Composition-ADR markdown.
 * @returns {Array<{id: String, namespace: String|null, repositoryId: String|null, canonicalKey: String|null, qualifiedId: String}>}
 */
export function listSeamTableRows(content) {
    const
        section = (typeof content === 'string' ? content.split(TABLE_MARKER)[1] : '') || '',
        table   = section.split(/\n## /)[0] || '',
        rows    = [];

    for (const line of table.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

        const
            cells     = trimmed.slice(1, -1).split('|').map(c => c.trim()),
            firstCell = (cells[0] || '').replace(/^`|`$/g, '').trim();

        if (!firstCell || firstCell === 'ADR' || /^:?-{2,}:?$/.test(firstCell)) continue;

        if (firstCell.startsWith('adr:')) {
            try {
                const parsed = parseCanonicalAdrKey(firstCell);
                rows.push({
                    id          : parsed.number,
                    namespace   : parsed.namespace,
                    repositoryId: parsed.repositoryId,
                    canonicalKey: parsed.canonicalKey,
                    qualifiedId : `${parsed.namespace}#${parsed.number}`
                });
                continue;
            } catch {}
        }

        const qualifiedMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#(?:adr-)?|:)(\d{4})$/.exec(firstCell);
        if (qualifiedMatch) {
            const [, namespace, id] = qualifiedMatch;
            rows.push({
                id,
                namespace,
                repositoryId: null,
                canonicalKey: null,
                qualifiedId : `${namespace}#${id}`
            });
            continue;
        }

        const bareMatch = /^(\d{4})$/.exec(firstCell);
        if (bareMatch) {
            const
                id         = bareMatch[1],
                secondCell = (cells[1] || '').replace(/^`|`$/g, '').trim(),
                explicitNs = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(secondCell) ? secondCell : null;

            rows.push({
                id,
                namespace   : explicitNs,
                repositoryId: null,
                canonicalKey: null,
                qualifiedId : explicitNs ? `${explicitNs}#${id}` : id
            });
        }
    }

    return rows;
}

/**
 * @summary Extracts the ADR ids holding seam-table rows — ALL occurrences, duplicates preserved.
 *
 * Cardinality is part of the contract ("exactly one row per present id"), so this deliberately
 * does NOT dedupe: duplicate detection happens in `checkSeamTable`.
 *
 * @param {String} content Composition-ADR markdown.
 * @returns {String[]} Row ids in table order, duplicates included.
 */
export function listSeamTableRowIds(content) {
    return listSeamTableRows(content).map(row => row.id);
}

/**
 * @summary Normalizes explicit composition authority input (`{file, content}`, `{path}`, or file path string).
 * @param {Object|String|null} compositionAdr
 * @returns {{file: String, content: String, ambiguousFiles: String[]}|null}
 * @private
 */
function resolveExplicitCompositionAdr(compositionAdr) {
    if (!compositionAdr) return null;

    if (typeof compositionAdr === 'string') {
        if (!fs.existsSync(compositionAdr)) return null;
        return {
            file          : path.basename(compositionAdr),
            content       : fs.readFileSync(compositionAdr, 'utf8'),
            ambiguousFiles: []
        };
    }

    if (typeof compositionAdr === 'object') {
        if (typeof compositionAdr.content === 'string') {
            return {
                file          : compositionAdr.file || (compositionAdr.path ? path.basename(compositionAdr.path) : 'composition-adr.md'),
                content       : compositionAdr.content,
                ambiguousFiles: Array.isArray(compositionAdr.ambiguousFiles) ? compositionAdr.ambiguousFiles : []
            };
        }
        if (typeof compositionAdr.path === 'string' && fs.existsSync(compositionAdr.path)) {
            return {
                file          : compositionAdr.file || path.basename(compositionAdr.path),
                content       : fs.readFileSync(compositionAdr.path, 'utf8'),
                ambiguousFiles: []
            };
        }
    }

    return null;
}

/**
 * @summary Runs the seam-table check: missing rows, ghost rows, duplicate rows, marker ambiguity,
 * and cross-repository qualified record coexistence.
 *
 * Accepts either a single directory string `dir` (preserving all single-directory callers) or an
 * options object `{dir, sources, compositionAdr, governedNamespaces}` (or zero arguments for the
 * default multi-repository organism check).
 *
 * @param {String|Object} [dirOrOptions] Decisions directory or options object.
 * @returns {{ok: Boolean, missingRows: String[], ghostRows: String[], duplicateRows: String[],
 *            ambiguousFiles: String[], file: String|null, presentRecords?: Object[], redirects?: Object[]}}
 */
export function checkSeamTable(dirOrOptions) {
    if (typeof dirOrOptions === 'string') {
        const
            dir         = dirOrOptions,
            composition = findCompositionAdr(dir);

        if (!composition) {
            return {ok: false, missingRows: [], ghostRows: [], duplicateRows: [], ambiguousFiles: [], file: null};
        }

        const
            present       = listPresentAdrIds(dir),
            rows          = listSeamTableRowIds(composition.content),
            rowSet        = new Set(rows),
            presentSet    = new Set(present),
            counts        = rows.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map()),
            missingRows   = present.filter(id => !rowSet.has(id)),
            ghostRows     = [...rowSet].filter(id => !presentSet.has(id)).sort(),
            duplicateRows = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();

        return {
            ok: missingRows.length === 0 && ghostRows.length === 0 && duplicateRows.length === 0
                && composition.ambiguousFiles.length === 0,
            file          : composition.file,
            ambiguousFiles: composition.ambiguousFiles,
            missingRows,
            ghostRows,
            duplicateRows
        };
    }

    const
        options          = dirOrOptions && typeof dirOrOptions === 'object' ? dirOrOptions : {},
        isDefaultSources = !options.sources && !options.dir,
        sources          = options.sources || (options.dir ? [options.dir] : resolveDefaultSeamSources(options.rootDir || ROOT_DIR)),
        composition      = resolveExplicitCompositionAdr(options.compositionAdr) || findCompositionAdr(sources);

    if (!composition || !composition.content.includes(TABLE_MARKER)) {
        return {
            ok            : false,
            missingRows   : [],
            ghostRows     : [],
            duplicateRows : [],
            ambiguousFiles: [],
            file          : null,
            presentRecords: [],
            redirects     : []
        };
    }

    const
        {records: presentRecords, redirects, intraRepoDuplicates} = listPresentAdrRecords(sources),
        parsedRows                                                = listSeamTableRows(composition.content),
        usesQualifiedRow                                          = parsedRows.some(r => Boolean(r.namespace || r.canonicalKey)),
        cutNamespaces                                             = new Set(KNOWN_CUT_REPOSITORIES.map(r => r.namespace.toLowerCase())),
        hasCutSources                                             = presentRecords.some(r => r.namespace && cutNamespaces.has(r.namespace.toLowerCase())),
        cutCeiling                                                = isDefaultSources && !usesQualifiedRow && composition.file?.startsWith('0031-') ? 40 : null;

    const governedRecords = presentRecords.filter(record => {
        if (record.explicitlyGoverned === false) return false;
        if (record.explicitlyGoverned === true)  return true;
        if (!usesQualifiedRow && hasCutSources && record.namespace && !cutNamespaces.has(record.namespace.toLowerCase())) {
            return false;
        }
        if (cutCeiling !== null && record.namespace !== composition.namespace && Number(record.id) > cutCeiling) {
            return false;
        }
        return true;
    });

    const
        rowKeys = parsedRows.map(r => usesQualifiedRow ? r.qualifiedId.toLowerCase() : r.id),
        counts  = rowKeys.reduce((map, key) => map.set(key, (map.get(key) || 0) + 1), new Map());

    const
        duplicateRows = [
            ...[...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key),
            ...intraRepoDuplicates
        ].sort(),
        rowKeySet      = new Set(rowKeys),
        presentKeyList = new Map(),
        ambiguousRows  = [];

    for (const record of governedRecords) {
        const key = usesQualifiedRow ? record.qualifiedId.toLowerCase() : record.id;
        if (!presentKeyList.has(key)) presentKeyList.set(key, []);
        presentKeyList.get(key).push(record);
    }

    for (const [key, group] of presentKeyList.entries()) {
        if (!usesQualifiedRow && group.length > 1) {
            ambiguousRows.push(key);
        }
    }

    const
        missingRows = [...presentKeyList.keys()].filter(key => !rowKeySet.has(key)).sort(),
        ghostRows   = [...rowKeySet].filter(key => !presentKeyList.has(key)).sort();

    return {
        ok: missingRows.length === 0 && ghostRows.length === 0 && duplicateRows.length === 0
            && ambiguousRows.length === 0 && composition.ambiguousFiles.length === 0,
        file          : composition.file,
        ambiguousFiles: composition.ambiguousFiles,
        ambiguousRows,
        missingRows,
        ghostRows,
        duplicateRows,
        presentRecords,
        redirects
    };
}

if (process.argv[1] === __filename) {
    const result = checkSeamTable();

    if (!result.file) {
        console.error('[lint-adr-seam-table] FAILED: no composition ADR found (missing seam-table marker)');
        process.exit(1)
    }

    if (!result.ok) {
        console.error('[lint-adr-seam-table] FAILED');
        result.missingRows.length && console.error(`- present ADR ids WITHOUT a seam-table row: ${result.missingRows.join(', ')} (a new ADR merges WITH its row in the same diff)`);
        result.ghostRows.length && console.error(`- seam-table rows WITHOUT a present ADR file: ${result.ghostRows.join(', ')}`);
        result.duplicateRows.length && console.error(`- DUPLICATE seam-table rows for: ${result.duplicateRows.join(', ')} (exactly one row per id — resolve the conflict, keep one)`);
        result.ambiguousFiles.length && console.error(`- MULTIPLE files carry the seam-table marker: ${result.ambiguousFiles.join(', ')} (exactly one composition record may exist)`);
        process.exit(1)
    }

    console.log(`[lint-adr-seam-table] OK (${result.file})`)
}
