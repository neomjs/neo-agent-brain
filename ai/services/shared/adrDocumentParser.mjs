import crypto from 'crypto';
import path   from 'path';
import {
    ADR_FILE_REGEX,
    ADR_NUMBER_REGEX,
    ADR_SLUG_REGEX,
    buildCanonicalAdrKey,
    createCodedError,
    extractCitationSurfaceContext,
    parseCanonicalAdrKey,
    parseHumanOrNumericAdrReference,
    validateAdrIdentityFields
} from './adrIdentityCodec.mjs';

export {extractCitationSurfaceContext, parseHumanOrNumericAdrReference};

/**
 * @module ai/services/shared/adrDocumentParser
 * @summary Pure markdown filename, opening-table `Aliases`, metadata, citation surface/grammar,
 * allocation observation, and author-action measurement parsers for Architecture Decision Records.
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.7
 */

const
    STATUS_ROW_REGEX     = /^\|\s*\*\*Status\*\*\s*\|\s*([^|]+?)\s*\|/mi,
    STATUS_BOLD_REGEX    = /^\s*\*\*Status\*\*:\s*(.+)$/mi,
    STATUS_INNER_REGEX   = /^\s*\*\*Status:\*\*\s*(.+)$/mi,
    SUPERSEDES_ROW_REGEX = /^\|\s*\*\*Supersedes\*\*\s*\|\s*([^|]+?)\s*\|/mi;

/**
 * @summary Stable deep-stringify for ADR payload hashing. Sorts object keys recursively so
 * logically-identical metadata emits the same hash regardless of parser order.
 * @param {*} value
 * @returns {String}
 */
export function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * @summary Computes the differential-sync hash stored under `properties.payloadHash`.
 * @param {Object} adr Parsed ADR metadata.
 * @returns {String}
 */
export function computeAdrPayloadHash(adr) {
    const payload = {
        adrNumber : adr.adrNumber,
        rawStatus : adr.rawStatus,
        source    : adr.source,
        status    : adr.status,
        supersedes: adr.supersedes,
        title     : adr.title,
        ...(adr.canonicalKey && adr.canonicalKey !== `adr-${adr.adrNumber}` ? {
            canonicalKey     : adr.canonicalKey,
            currentSlug      : adr.currentSlug,
            historicalAliases: adr.historicalAliases
        } : {})
    };
    return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * @summary Parses an ADR markdown filename `NNNN-<slug>.md` into its 4-digit number and kebab-case slug.
 * @param {String} fileName
 * @returns {{adrNumber: String, slug: String}}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.7.2
 */
export function parseAdrFilename(fileName) {
    const
        base      = path.basename(String(fileName || '')),
        fileMatch = base.match(ADR_FILE_REGEX);
    if (!fileMatch) {
        throw createCodedError('ADR_INVALID_FILENAME', `Invalid ADR file name: ${fileName}`);
    }
    const [, adrNumber, slug] = fileMatch;
    if (!ADR_NUMBER_REGEX.test(adrNumber)) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid ADR number '${adrNumber}' in file '${fileName}'`);
    }
    if (!ADR_SLUG_REGEX.test(slug)) {
        throw createCodedError('ADR_INVALID_FILENAME_SLUG', `Invalid ADR filename slug '${slug}' in '${fileName}'; expected lowercase ASCII kebab.`);
    }
    return {adrNumber, slug};
}

function stripSingleStrongEmphasis(text) {
    const
        trimmed = String(text || '').trim(),
        match   = trimmed.match(/^(?:\*\*([^*]+)\*\*|__([^_]+)__)$/);
    return match ? (match[1] || match[2]).trim() : trimmed;
}

function splitMarkdownTableRow(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
    return trimmed.slice(1, -1).split('|').map(cell => cell.trim());
}

function isTwoColumnSeparatorRow(cells) {
    return Array.isArray(cells) && cells.length === 2 && cells.every(cell => /^:?-{2,}:?$/.test(cell));
}

function isCanonicalAttributeValueHeader(cells) {
    return Array.isArray(cells) &&
           cells.length === 2 &&
           stripSingleStrongEmphasis(cells[0]) === 'Attribute' &&
           stripSingleStrongEmphasis(cells[1]) === 'Value';
}

function stripAllEmphasisAndPunctuation(text) {
    return String(text || '').replace(/[*_`:~]/g, '').trim().toLowerCase();
}

/**
 * @summary Reads historical slug `Aliases` strictly from the single canonical two-column
 * `Attribute | Value` opening table between the initial root H1 and the first root H2.
 * @param {String} content Raw ADR markdown body.
 * @returns {{aliases: String[], hasCanonicalOpeningTable: Boolean, hasAliasesRow: Boolean}}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.7.2
 */
export function parseAdrOpeningAliases(content) {
    if (typeof content !== 'string' || !content) {
        return {aliases: [], hasCanonicalOpeningTable: false, hasAliasesRow: false};
    }

    const lines = content.split(/\r?\n/);
    let   index = 0;

    if (lines[0]?.trim() === '---') {
        index = 1;
        while (index < lines.length && lines[index].trim() !== '---') index++;
        if (index < lines.length) index++;
    }

    let
        inFence      = false,
        fenceMarker  = null,
        seenRootH1   = false,
        inRootList   = false,
        currentTable = null;
    const
        rootTables        = [],
        nonTableRootLines = [];

    for (; index < lines.length; index++) {
        const
            line       = lines[index],
            trimmed    = line.trim(),
            fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (!inFence) {
                inFence     = true;
                fenceMarker = marker;
                if (currentTable) { rootTables.push(currentTable); currentTable = null; }
            } else if (fenceMarker === marker) {
                inFence     = false;
                fenceMarker = null;
            }
            continue;
        }
        if (inFence) continue;

        if (/^\s*>/.test(line)) {
            if (currentTable) { rootTables.push(currentTable); currentTable = null; }
            continue;
        }

        if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
            inRootList = true;
            if (currentTable) { rootTables.push(currentTable); currentTable = null; }
            continue;
        }
        if (inRootList) {
            if (trimmed !== '' && /^\s{2,}/.test(line)) continue;
            inRootList = false;
        }

        if (!seenRootH1) {
            if (/^#\s+.+$/.test(line)) seenRootH1 = true;
            continue;
        }
        if (/^##\s+.+$/.test(line)) break;

        if (/^\|.*\|$/.test(trimmed)) {
            if (!currentTable) currentTable = [];
            currentTable.push(line);
        } else {
            if (currentTable) { rootTables.push(currentTable); currentTable = null; }
            if (trimmed !== '') nonTableRootLines.push(line);
        }
    }

    if (currentTable) rootTables.push(currentTable);

    for (const line of nonTableRootLines) {
        if (/^\s*(?:\*{1,3}|_{1,3})?Aliases(?:\*{1,3}|_{1,3})?\s*:/i.test(line) || /^\s*Aliases\s*:/i.test(line)) {
            throw createCodedError('ADR_NONCANONICAL_OPENING_TABLE', 'Aliases declaration requires a canonical two-column Attribute | Value opening table.');
        }
    }

    const
        canonicalTables    = [],
        nonCanonicalTables = [];

    for (const tableLines of rootTables) {
        const parsedRows = tableLines.map(splitMarkdownTableRow).filter(Boolean);
        if (parsedRows.length < 2) {
            nonCanonicalTables.push(parsedRows);
            continue;
        }
        const [headerCells, separatorCells, ...dataRows] = parsedRows;
        if (isCanonicalAttributeValueHeader(headerCells) &&
            isTwoColumnSeparatorRow(separatorCells) &&
            dataRows.every(row => row.length === 2)) {
            canonicalTables.push({headerCells, separatorCells, dataRows});
        } else {
            nonCanonicalTables.push(parsedRows);
        }
    }

    for (const rows of nonCanonicalTables) {
        for (const row of rows) {
            if (row.length > 0 && stripAllEmphasisAndPunctuation(row[0]) === 'aliases') {
                throw createCodedError('ADR_NONCANONICAL_OPENING_TABLE', 'Aliases declared in a noncanonical opening table; normalize to Attribute | Value first.');
            }
        }
    }

    if (canonicalTables.length > 1) {
        throw createCodedError('ADR_MULTIPLE_OPENING_TABLES', `Expected at most one canonical Attribute | Value opening table between H1 and H2, found ${canonicalTables.length}.`);
    }
    if (canonicalTables.length === 0) {
        return {aliases: [], hasCanonicalOpeningTable: false, hasAliasesRow: false};
    }

    const matchingRows = [];
    for (const row of canonicalTables[0].dataRows) {
        const rawLabel = row[0].trim();
        if (stripAllEmphasisAndPunctuation(rawLabel) === 'aliases') {
            if (rawLabel !== 'Aliases' && rawLabel !== '**Aliases**' && rawLabel !== '__Aliases__') {
                throw createCodedError('ADR_INVALID_ALIASES_ROW', `Invalid Aliases attribute label '${rawLabel}'; expected plain 'Aliases' or '**Aliases**'.`);
            }
            matchingRows.push(row);
        }
    }

    if (matchingRows.length > 1) {
        throw createCodedError('ADR_DUPLICATE_ALIASES_ROW', 'Duplicate Aliases rows in opening attribute table are forbidden.');
    }
    if (matchingRows.length === 0) {
        return {aliases: [], hasCanonicalOpeningTable: true, hasAliasesRow: false};
    }

    const rawCell = matchingRows[0][1].trim();
    if (!rawCell) {
        return {aliases: [], hasCanonicalOpeningTable: true, hasAliasesRow: true};
    }

    const
        aliases = [],
        seen    = new Set();

    for (const rawToken of rawCell.split(',')) {
        const
            trimmedToken = rawToken.trim(),
            tokenMatch   = trimmedToken.match(/^`([^`]+)`$/);
        if (!tokenMatch) {
            throw createCodedError('ADR_INVALID_ALIAS_TOKEN', `Alias token '${trimmedToken}' must be backtick-delimited.`);
        }
        const slug = tokenMatch[1];
        if (!ADR_SLUG_REGEX.test(slug)) {
            throw createCodedError('ADR_INVALID_ALIAS_TOKEN', `Alias token '${slug}' violates lowercase ASCII kebab slug grammar.`);
        }
        if (seen.has(slug)) {
            throw createCodedError('ADR_INVALID_ALIAS_TOKEN', `Duplicate alias token '${slug}' in Aliases row.`);
        }
        seen.add(slug);
        aliases.push(slug);
    }

    return {aliases, hasCanonicalOpeningTable: true, hasAliasesRow: true};
}

/**
 * @summary Measures normal author actions for ADR creation and rename against the existing numbered-file baseline.
 * @param {Object} scenario
 * @returns {Object}
 */
export function measureAdrAuthorActions({operation = 'create', legacyShape = null} = {}) {
    if (operation === 'create') {
        return {
            operation                     : 'create',
            baselineFileEdits             : 1,
            actualFileEdits               : 1,
            aliasRowEdits                 : 0,
            legacyTableNormalizationEdits : 0,
            additionalRegistrationSurfaces: 0,
            manifestEditsRequired         : 0,
            machineKeyPastesRequired      : 0,
            automaticNumberingPrerequisite: false
        };
    }

    const needsNormalization = operation === 'rename-legacy-table' || Boolean(legacyShape);

    return {
        operation                     : needsNormalization ? 'rename-legacy-table' : 'rename',
        legacyShape                   : legacyShape || (needsNormalization ? 'noncanonical-opening-table' : null),
        baselineFileEdits             : 1,
        actualFileEdits               : 1,
        aliasRowEdits                 : 1,
        legacyTableNormalizationEdits : needsNormalization ? 1 : 0,
        sameSourceEdit                : true,
        additionalRegistrationSurfaces: 0,
        manifestEditsRequired         : 0,
        machineKeyPastesRequired      : 0,
        automaticNumberingPrerequisite: false
    };
}

/**
 * @summary Exposes present-file and unfiltered-history observations (including rename destinations)
 * as an advisory candidate floor, while keeping admission's proved population as the sole certifier.
 * @param {Object} [options={}]
 * @param {String|null} [certifiedEligibleNumber=null]
 * @returns {Object}
 */
export function observeAdrCandidateAllocationFloor({
    presentFiles      = [],
    gitHistoryEntries = [],
    historyComplete   = false,
    shallow           = false,
    historyFilter     = 'all'
} = {}, certifiedEligibleNumber = null) {
    const extractNum = (filePath) => {
        if (typeof filePath !== 'string') return 0;
        const m = path.basename(filePath).match(/^(\d{4})-.*\.md$/);
        return m ? Number(m[1]) : 0;
    };

    let presentMax = 0;
    for (const file of presentFiles) {
        const val = extractNum(file);
        if (val > presentMax) presentMax = val;
    }

    let historyMax = 0;
    for (const entry of gitHistoryEntries) {
        if (typeof entry === 'string') {
            const val = extractNum(entry);
            if (val > historyMax) historyMax = val;
        } else if (entry && typeof entry === 'object') {
            const status = String(entry.status || '').toUpperCase();
            if (historyFilter === 'AD' && status.startsWith('R')) {
                const oldVal = extractNum(entry.oldPath || entry.path);
                if (oldVal > historyMax) historyMax = oldVal;
            } else {
                for (const p of [entry.path, entry.oldPath, entry.newPath]) {
                    const val = extractNum(p);
                    if (val > historyMax) historyMax = val;
                }
            }
        }
    }

    const
        incompleteHistory = !historyComplete || Boolean(shallow) || historyFilter === 'AD',
        observedMax       = Math.max(presentMax, historyMax),
        candidateFloor    = observedMax > 0 ? String(observedMax).padStart(4, '0') : '0000',
        nextCandidate     = observedMax < 9999 ? String(observedMax + 1).padStart(4, '0') : null,
        admittedFloor     = certifiedEligibleNumber
            ? String(Number(certifiedEligibleNumber) - 1).padStart(4, '0')
            : null;

    return {
        presentFloor        : presentMax > 0 ? String(presentMax).padStart(4, '0') : '0000',
        historyFloor        : historyMax > 0 ? String(historyMax).padStart(4, '0') : '0000',
        candidateFloor,
        nextCandidateNumber : nextCandidate,
        incompleteHistory,
        advisoryOnly        : true,
        certifiedByAdmission: false,
        admittedFloor,
        certifiedEligibleNumber
    };
}

/**
 * @summary Strips fenced code blocks from markdown prose so example tokens inside fences are not parsed as edges.
 * @param {String} content
 * @returns {String}
 */
export function stripMarkdownFences(content) {
    if (typeof content !== 'string' || !content) return '';
    const
        lines = content.split(/\r?\n/),
        out   = [];
    let
        inFence     = false,
        fenceMarker = null;

    for (const line of lines) {
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (!inFence) {
                inFence     = true;
                fenceMarker = marker;
            } else if (fenceMarker === marker) {
                inFence     = false;
                fenceMarker = null;
            }
            continue;
        }
        if (!inFence) out.push(line);
    }

    return out.join('\n');
}

/**
 * @summary Extracts the H1 title, raw status text, and normalized status (`'Accepted'` | `'Draft'`) from ADR markdown.
 * @param {String} fileName
 * @param {String} content
 * @returns {{title: String, rawStatus: String, status: String}}
 */
export function extractAdrTitleAndStatus(fileName, content) {
    const
        headingMatch = content.match(/^#\s+ADR\s+\d{4}:?\s*(.+)$/mi),
        title        = headingMatch?.[1]?.trim() || path.basename(fileName, '.md'),
        statusMatch  = content.match(STATUS_ROW_REGEX) || content.match(STATUS_BOLD_REGEX) || content.match(STATUS_INNER_REGEX),
        rawStatus    = (statusMatch?.[1] || 'Draft').replace(/\s+/g, ' ').trim(),
        status       = /^Accepted\b/i.test(rawStatus) ? 'Accepted' : 'Draft';

    return {title, rawStatus, status};
}

/**
 * @summary Parses the ADR table's Supersedes cell into a reviewable array.
 * @param {String} content ADR markdown body.
 * @returns {String[]}
 */
export function parseAdrSupersedes(content) {
    const match = content.match(SUPERSEDES_ROW_REGEX);
    if (!match) return [];

    return match[1]
        .split(/;|\n/)
        .map(item => item.replace(/^\s*(?:[-*]\s+|\([a-z0-9]+\)\s+|[a-z0-9]+\.\s+)/i, '').trim())
        .filter(Boolean);
}

/**
 * @summary Resolves the candidate canonical identity, custody-transition verification, and prior admitted
 * record for a scanned ADR file before graph admission.
 * @param {Object} params
 * @returns {Object}
 */
export function resolveAdrCandidateIdentity({
    adrNumber,
    sourceRepo,
    custodyTransitions = [],
    legacyManifest     = null,
    admissionCatalog,
    onRegisterRepo     = null
}) {
    if (!sourceRepo) {
        const legacyKey = `adr-${adrNumber}`;
        return {
            canonicalKey             : legacyKey,
            assignedIdentity         : null,
            existingRecord           : admissionCatalog.get(legacyKey) || null,
            custodyTransitionVerified: false,
            isCustodyMove            : false
        };
    }

    const
        forge        = sourceRepo.forge || 'github.com',
        repositoryId = sourceRepo.repositoryId,
        namespace    = sourceRepo.namespace;

    validateAdrIdentityFields({forge, repositoryId, namespace, number: adrNumber});
    if (typeof onRegisterRepo === 'function') onRegisterRepo({forge, repositoryId, namespace});

    const manifestEntry = Array.isArray(legacyManifest)
        ? legacyManifest.find(m =>
            m.adrNumber === adrNumber && (
                (m.sourceRepositoryId && m.sourceRepositoryId === repositoryId) ||
                (m.currentCustody?.repositoryId === repositoryId) ||
                (m.assignedNamespace && m.assignedNamespace.toLowerCase() === namespace.toLowerCase())
            )
        )
        : null;

    if (manifestEntry) {
        const assignedIdentity = {
            forge             : manifestEntry.forge || forge,
            repositoryId      : manifestEntry.assignedRepositoryId || manifestEntry.repositoryId,
            namespace         : manifestEntry.assignedNamespace || manifestEntry.namespace,
            assignmentKind    : 'legacy-reviewed',
            reviewedManifestId: manifestEntry.id || 'legacy-manifest'
        };
        const canonicalKey = manifestEntry.canonicalKey || buildCanonicalAdrKey({
            forge       : assignedIdentity.forge,
            repositoryId: assignedIdentity.repositoryId,
            namespace   : assignedIdentity.namespace,
            number      : adrNumber
        });
        return {
            canonicalKey,
            assignedIdentity,
            existingRecord           : admissionCatalog.get(canonicalKey) || null,
            custodyTransitionVerified: Boolean(manifestEntry.custodyTransitionVerified || assignedIdentity.repositoryId !== repositoryId),
            isCustodyMove            : assignedIdentity.repositoryId !== repositoryId || assignedIdentity.namespace !== namespace
        };
    }

    const transition = Array.isArray(custodyTransitions)
        ? custodyTransitions.find(t =>
            (t.toRepositoryId === repositoryId || (t.toNamespace && t.toNamespace.toLowerCase() === namespace.toLowerCase())) &&
            (t.adrNumber === adrNumber || (t.canonicalKey && t.canonicalKey.endsWith(`:${adrNumber}`)))
        )
        : null;

    if (transition) {
        const existingRecord = (transition.canonicalKey && admissionCatalog.get(transition.canonicalKey)) ||
            Array.from(admissionCatalog.values()).find(r =>
                r.adrNumber === adrNumber &&
                (r.sourceTuple?.repositoryId === transition.fromRepositoryId || r.assignmentEvidence?.repositoryId === transition.fromRepositoryId)
            ) || null;

        if (!existingRecord && !transition.canonicalKey) {
            throw createCodedError(
                'ADR_ADMISSION_EVIDENCE_MISSING',
                `Custody transition for ADR ${adrNumber} to '${namespace}' lacks prior admitted record or canonicalKey.`
            );
        }

        const parsedKey = parseCanonicalAdrKey(existingRecord ? existingRecord.canonicalKey : transition.canonicalKey);
        return {
            canonicalKey    : parsedKey.canonicalKey,
            assignedIdentity: existingRecord?.assignmentEvidence || {
                forge: parsedKey.forge, repositoryId: parsedKey.repositoryId, namespace: parsedKey.namespace, assignmentKind: 'created'
            },
            existingRecord,
            custodyTransitionVerified: true,
            custodyTransition        : transition,
            isCustodyMove            : true
        };
    }

    const existingInRepo = Array.from(admissionCatalog.values()).find(r =>
        r.adrNumber === adrNumber && r.sourceTuple?.forge === forge && r.sourceTuple?.repositoryId === repositoryId
    );

    if (existingInRepo) {
        return {
            canonicalKey             : existingInRepo.canonicalKey,
            assignedIdentity         : existingInRepo.assignmentEvidence,
            existingRecord           : existingInRepo,
            custodyTransitionVerified: false,
            isCustodyMove            : existingInRepo.assignmentEvidence?.repositoryId !== repositoryId
        };
    }

    if (sourceRepo.claimedCanonicalKey) {
        const parsedKey = parseCanonicalAdrKey(sourceRepo.claimedCanonicalKey);
        return {
            canonicalKey    : parsedKey.canonicalKey,
            assignedIdentity: {
                forge: parsedKey.forge, repositoryId: parsedKey.repositoryId, namespace: parsedKey.namespace, assignmentKind: 'claimed'
            },
            existingRecord           : admissionCatalog.get(parsedKey.canonicalKey) || null,
            custodyTransitionVerified: false,
            isCustodyMove            : parsedKey.repositoryId !== repositoryId || parsedKey.namespace !== namespace
        };
    }

    const canonicalKey = buildCanonicalAdrKey({forge, repositoryId, namespace, number: adrNumber});
    return {
        canonicalKey,
        assignedIdentity         : {forge, repositoryId, namespace, assignmentKind: 'created'},
        existingRecord           : admissionCatalog.get(canonicalKey) || null,
        custodyTransitionVerified: false,
        isCustodyMove            : false
    };
}

/**
 * @summary Evaluates reservation, namespace-occupancy, custody, alias-removal, lineage, and same-batch
 * conflicts across parsed ADR candidates and invokes `refuseCandidate(cand, code, message)` on violations.
 * @param {Object} params
 */
export function evaluateAdrCandidateConflicts({
    candidates,
    admissionCatalog,
    ensureReservationBucket,
    sourceLineageEvidence = [],
    legacyManifest        = null,
    refusedCandidates,
    refuseCandidate
}) {
    for (const cand of candidates) {
        const
            {adr, specRepo, identityInfo} = cand,
            existingRecord                = identityInfo.existingRecord;

        if (specRepo) {
            const
                forge          = specRepo.forge || 'github.com',
                repositoryId   = specRepo.repositoryId,
                namespace      = specRepo.namespace,
                lowerNamespace = namespace.toLowerCase(),
                bucket         = ensureReservationBucket(forge, repositoryId),
                reservedNum    = bucket.aliases.get(`legacy-number:${lowerNamespace}:${adr.adrNumber}`),
                reservedSlug   = bucket.aliases.get(`slug:${lowerNamespace}:${adr.currentSlug}`);

            if (reservedNum && reservedNum.targetKey !== adr.canonicalKey) {
                refuseCandidate(cand, 'ADR_COMPETING_CLAIM_REFUSED', `ADR number '${adr.adrNumber}' in '${namespace}' is already reserved by '${reservedNum.targetKey}'.`);
                continue;
            }
            if (reservedSlug && reservedSlug.targetKey !== adr.canonicalKey) {
                refuseCandidate(cand, 'ADR_COMPETING_CLAIM_REFUSED', `Slug '${adr.currentSlug}' in '${namespace}' is already reserved by '${reservedSlug.targetKey}'.`);
                continue;
            }

            for (const otherRecord of admissionCatalog.values()) {
                if (otherRecord.canonicalKey === adr.canonicalKey) continue;
                const conflictingAlias = otherRecord.aliasBindings?.find(
                    b => b.forge === forge &&
                         b.namespace.toLowerCase() === lowerNamespace &&
                         b.repositoryId !== repositoryId &&
                         ((b.kind === 'slug' && b.value === adr.currentSlug) ||
                          (b.kind === 'legacy-number' && b.value === adr.adrNumber && specRepo.inheritReservedNamespace === true))
                );
                if (conflictingAlias) {
                    refuseCandidate(
                        cand,
                        'ADR_NAMESPACE_OCCUPANCY_CONFLICT',
                        `Repository '${repositoryId}' occupying '${namespace}' cannot inherit reserved alias '${conflictingAlias.value}' owned by '${otherRecord.canonicalKey}'.`
                    );
                    break;
                }
            }
            if (refusedCandidates.has(cand)) continue;
        }

        if (existingRecord) {
            if (specRepo) {
                const
                    prevRepoId    = existingRecord.sourceTuple?.repositoryId,
                    prevNamespace = existingRecord.sourceTuple?.namespace,
                    repoChanged   = Boolean(prevRepoId && prevRepoId !== specRepo.repositoryId),
                    nsChanged     = Boolean(prevNamespace && prevNamespace.toLowerCase() !== specRepo.namespace.toLowerCase());

                if ((repoChanged || nsChanged) && !identityInfo.custodyTransitionVerified) {
                    refuseCandidate(
                        cand,
                        'ADR_COMPETING_CLAIM_REFUSED',
                        `Undeclared competing custody claim for '${adr.canonicalKey}' from '${specRepo.namespace}' refused; retaining admitted owner '${prevNamespace}'.`
                    );
                    continue;
                }
            }

            if (existingRecord.sourceTuple?.path && existingRecord.sourceTuple.path !== adr.source) {
                const oldFileStillPresent = candidates.some(
                    other => other !== cand &&
                             other.adr.source === existingRecord.sourceTuple.path &&
                             (!specRepo || other.specRepo?.repositoryId === existingRecord.sourceTuple?.repositoryId)
                );
                if (oldFileStillPresent) {
                    refuseCandidate(
                        cand,
                        'ADR_COMPETING_CLAIM_REFUSED',
                        `Duplicate ADR number '${adr.adrNumber}' in '${cand.file}' conflicts with admitted owner '${existingRecord.sourceTuple.path}'.`
                    );
                    continue;
                }
            }

            const
                unionSpellings  = new Set([adr.currentSlug, ...adr.historicalAliases]),
                admittedSlugs   = (existingRecord.aliasBindings || []).filter(b => b.kind === 'slug').map(b => b.value),
                removedSpelling = admittedSlugs.find(slug => !unionSpellings.has(slug));

            if (removedSpelling) {
                refuseCandidate(cand, 'ADR_REMOVED_ADMITTED_ALIAS', `Cannot remove previously admitted slug spelling '${removedSpelling}' from '${adr.canonicalKey}'.`);
                continue;
            }

            const admittedSlugSet = new Set(admittedSlugs);
            for (const histSlug of adr.historicalAliases) {
                if (!admittedSlugSet.has(histSlug)) {
                    const hasLineageProof = Array.isArray(sourceLineageEvidence) &&
                        sourceLineageEvidence.some(ev => (ev.canonicalKey === adr.canonicalKey || ev.adrNumber === adr.adrNumber) && ev.alias === histSlug);
                    if (!hasLineageProof) {
                        refuseCandidate(cand, 'ADR_UNPROVED_HISTORICAL_ALIAS', `Historical alias '${histSlug}' in '${cand.file}' lacks prior admission or source-lineage evidence.`);
                        break;
                    }
                }
            }
        } else {
            for (const histSlug of adr.historicalAliases) {
                const hasLineageProof =
                    (Array.isArray(sourceLineageEvidence) && sourceLineageEvidence.some(ev => (ev.canonicalKey === adr.canonicalKey || ev.adrNumber === adr.adrNumber) && ev.alias === histSlug)) ||
                    (Array.isArray(legacyManifest) && legacyManifest.some(m => m.adrNumber === adr.adrNumber && Array.isArray(m.historicalAliases) && m.historicalAliases.includes(histSlug)));
                if (!hasLineageProof) {
                    refuseCandidate(cand, 'ADR_UNPROVED_HISTORICAL_ALIAS', `New record '${cand.file}' cannot claim historical alias '${histSlug}' without source-lineage or manifest evidence.`);
                    break;
                }
            }
        }
    }

    const
        claimGroups     = new Map(),
        addToClaimGroup = (claimKey, cand) => {
            if (!claimGroups.has(claimKey)) claimGroups.set(claimKey, []);
            claimGroups.get(claimKey).push(cand);
        };

    for (const cand of candidates) {
        if (refusedCandidates.has(cand)) continue;
        const {adr, specRepo} = cand;
        addToClaimGroup(`key:${adr.canonicalKey}`, cand);

        if (specRepo) {
            const forge = specRepo.forge || 'github.com', repoId = specRepo.repositoryId, lowerNs = specRepo.namespace.toLowerCase();
            addToClaimGroup(`slot:${forge}:${repoId}:${adr.adrNumber}`, cand);
            addToClaimGroup(`slug:${forge}:${repoId}:${adr.currentSlug}`, cand);
            addToClaimGroup(`ns-slug:${forge}:${lowerNs}:${adr.currentSlug}`, cand);
        } else {
            addToClaimGroup(`legacy-slot:${adr.adrNumber}`, cand);
            addToClaimGroup(`legacy-slug:${adr.currentSlug}`, cand);
        }
    }

    for (const [claimKey, group] of claimGroups.entries()) {
        if (group.length <= 1) continue;
        const priorOwners = group.filter(cand => {
            const ex = cand.identityInfo.existingRecord;
            if (!ex) return false;
            return cand.specRepo
                ? ex.sourceTuple?.repositoryId === cand.specRepo.repositoryId && ex.sourceTuple?.path === cand.adr.source && !cand.identityInfo.isCustodyMove
                : ex.sourceTuple?.path === cand.adr.source;
        });

        if (priorOwners.length === 1) {
            for (const cand of group) {
                if (cand !== priorOwners[0]) {
                    refuseCandidate(cand, 'ADR_COMPETING_CLAIM_REFUSED', `Competing claim '${cand.file}' on '${claimKey}' refused; retaining admitted owner '${priorOwners[0].file}'.`);
                }
            }
        } else {
            for (const cand of group) {
                refuseCandidate(cand, 'ADR_BATCH_CONFLICT', `Conflicting same-batch claims on '${claimKey}' have no prior owner; neither claim is admitted.`);
            }
        }
    }
}

/**
 * @summary Builds the normalized `adrAdmissionRecord` persisted on admitted `ADR` graph nodes.
 * @param {Object} params
 * @returns {Object}
 */
export function buildAdmittedAdrRecord({existingRecord, adr, identityInfo, specRepo, payloadHash, contentHash}) {
    const
        forge        = specRepo?.forge || identityInfo.assignedIdentity?.forge || 'github.com',
        sourceRepoId = specRepo?.repositoryId || null,
        sourceNs     = specRepo?.namespace || null,
        revision     = specRepo?.revision || null,
        sourceTuple  = {forge, repositoryId: sourceRepoId, namespace: sourceNs, revision, path: adr.source, hash: payloadHash, contentHash},
        record       = existingRecord ? {
            ...existingRecord,
            title            : adr.title,
            status           : adr.status,
            rawStatus        : adr.rawStatus,
            supersedes       : adr.supersedes,
            currentSlug      : adr.currentSlug,
            historicalAliases: [...adr.historicalAliases],
            sourceTuple,
            aliasBindings    : existingRecord.aliasBindings.map(b => ({...b})),
            reservations     : existingRecord.reservations.map(r => ({...r})),
            provenance       : {
                ...existingRecord.provenance,
                lastAdmittedRevision: revision || existingRecord.provenance?.lastAdmittedRevision || null,
                custodyTransitions  : [...(existingRecord.provenance?.custodyTransitions || [])],
                repositoryRenames   : [...(existingRecord.provenance?.repositoryRenames || [])],
                sourceLineage       : [...(existingRecord.provenance?.sourceLineage || [])]
            },
            stale            : false,
            documentAvailable: true,
            kbAvailable      : true
        } : {
            canonicalKey      : adr.canonicalKey,
            adrNumber         : adr.adrNumber,
            title             : adr.title,
            status            : adr.status,
            rawStatus         : adr.rawStatus,
            supersedes        : adr.supersedes,
            currentSlug       : adr.currentSlug,
            historicalAliases : [...adr.historicalAliases],
            assignmentEvidence: identityInfo.assignedIdentity ? {
                forge             : identityInfo.assignedIdentity.forge || forge,
                repositoryId      : identityInfo.assignedIdentity.repositoryId,
                namespace         : identityInfo.assignedIdentity.namespace,
                number            : adr.adrNumber,
                assignmentKind    : identityInfo.assignedIdentity.assignmentKind || 'created',
                assignedAtRevision: revision,
                reviewedManifestId: identityInfo.assignedIdentity.reviewedManifestId || null
            } : null,
            sourceTuple,
            aliasBindings: [],
            reservations : [],
            provenance   : {
                createdAtRevision   : revision,
                lastAdmittedRevision: revision,
                custodyTransitions  : [],
                repositoryRenames   : [],
                sourceLineage       : []
            },
            stale            : false,
            documentAvailable: true,
            kbAvailable      : true
        };

    if (identityInfo.custodyTransition) {
        record.provenance.custodyTransitions.push({...identityInfo.custodyTransition, appliedAtRevision: revision});
    }

    return record;
}
