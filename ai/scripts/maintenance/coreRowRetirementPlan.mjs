import {createHash} from 'node:crypto';

/**
 * @module ai/scripts/maintenance/coreRowRetirementPlan
 * @summary Plans exact-ID retirement only when bound profile bytes and landed rows reproduce a legacy fact.
 * No filesystem, collection client, service initialization or mutation lives in this planner. Correspondence
 * prose selects facts to compare; it never substitutes for the all-fields redundancy witness.
 */

const PROFILE_SCHEMA = 'neo.shared-core-corpus-profiles/v1';
const PLAN_SCHEMA    = 'neo.legacy-core-retirement-plan/v1';
const REPOS          = ['neo', 'neo-agent-brain'];
const FAMILIES       = new Set(['src', 'app', 'example', 'brain-source', 'ai-infrastructure', 'test', 'guide', 'blog', 'adr']);
const PROTECTED      = new Set(['ticket', 'pull', 'discussion', 'concept', 'skill', 'skills', 'release', 'releasenote', 'releasenotes']);
const PROVENANCE     = new Set([
    'id', 'hash', 'hashInputs', 'tenantId', 'repoSlug', 'visibility', 'originAgentIdentity',
    'tenantConfigVersion', 'ingestedAt', 'extractorId', 'extractorVersion', 'extractionIdentity',
    'rootKind', 'kbEmbeddingInputFormat', 'line_start', 'line_end'
]);
const SPLIT_FIELDS = ['oversizedSplit', 'oversizedSplitIndex', 'oversizedSplitTotal', 'oversizedSplitCharStart', 'oversizedSplitCharEnd'];
const CONVERTIBLE  = new Set(['source', 'sourcePath', 'type']);

/** @summary Indexes the complete artifact locator; paths alone cannot identify a source fact. */
function targetKey(target) {
    return JSON.stringify([target.repoSlug, target.revision, target.artifactSha256, target.extractionIdentity,
        target.source, target.sourcePath, target.type, target.name, target.kind ?? null]);
}

/** @summary Canonicalizes finite JSON data without silently dropping unsupported values. */
function canonical(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    throw new TypeError('Expected finite JSON data');
}

/**
 * @summary Fingerprints exact string bytes or canonical structured JSON.
 * @param {*} value JSON data, or exact text bytes.
 * @returns {String} SHA-256 digest.
 */
export function fingerprint(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}

/**
 * @summary Binds the entire observed metadata object, including provenance and unknown fields.
 * @param {Object} metadata Captured collection metadata.
 * @returns {String} SHA-256 digest.
 */
export function metadataFingerprint(metadata) {
    return fingerprint({metadata});
}

/** @summary Refuses malformed binding inputs before returning any executable preview. */
function requireValue(condition, message) {
    if (!condition) throw new Error(message);
}

/** @summary Freezes a detached plan without freezing caller-owned observations. */
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

/** @summary Converts structured chunk fields to the scalar metadata shape used by Chroma. */
function scalars(record) {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key,
        value === null ? 'null' : typeof value === 'object' ? JSON.stringify(canonical(value)) : value
    ]));
}

/** @summary Keeps every meaning field, including unknown fields; conversions cannot rewrite payload or names. */
function semanticPayload(record, conversions = []) {
    const result = Object.fromEntries(Object.entries(scalars(record)).filter(([key]) => !PROVENANCE.has(key)));
    const seen   = new Set();
    for (const {field, from, to} of conversions) {
        requireValue(CONVERTIBLE.has(field) && !seen.has(field), 'Only exact source/sourcePath/type conversions are allowed');
        requireValue((result[field] ?? null) === from && typeof to === 'string' && to.length > 0, 'Conversion does not match captured metadata');
        seen.add(field);
        result[field] = to;
    }
    return result;
}

/**
 * @summary Names the preservation boundary shared by planning and the executor's live old-row recheck.
 * @param {Object} metadata Captured or freshly observed old-row metadata.
 * @param {Object} scope Exact legacy tenant/repository tuple.
 * @returns {String|null} Null only for an eligible legacy family in the exact scope.
 */
export function coreRowProtectionReason(metadata, scope) {
    if (!metadata || metadata.tenantId !== scope.tenantId || metadata.repoSlug !== scope.repoSlug) return 'FOREIGN_SCOPE';
    if (Object.hasOwn(metadata, 'extractionIdentity')) return 'PROFILE_ROW';
    const family = String(metadata.type || '').toLowerCase().replace(/[-_\s]/gu, '');
    if (PROTECTED.has(family)) return 'PROTECTED_FAMILY';
    return FAMILIES.has(metadata.type) ? null : 'UNMATCHED_FAMILY';
}

/** @summary Binds exact manifest/artifact bytes, counts and per-row profile identities. */
function readProfiles(manifest, artifacts, scope) {
    requireValue(typeof manifest?.text === 'string' && fingerprint(manifest.text) === manifest.sha256, 'Manifest bytes do not match captured SHA');
    const parsed = JSON.parse(manifest.text), targetsByKey = new Map();
    requireValue(parsed.schemaVersion === PROFILE_SCHEMA && parsed.artifacts?.length === 2, 'Expected two-repository profile manifest');
    for (const [index, artifact] of parsed.artifacts.entries()) {
        requireValue(artifact.repoSlug === REPOS[index] && artifact.tenantId === scope.tenantId
            && /^[a-f0-9]{40}$/u.test(artifact.revision) && /^[a-f0-9]{64}$/u.test(artifact.extractionIdentity), 'Invalid profile identity');
        const files = artifacts.filter(file => file.path === artifact.path);
        requireValue(files.length === 1 && fingerprint(files[0].text) === artifact.sha256, 'Artifact bytes do not match manifest SHA');
        const rows = files[0].text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        requireValue(Number.isSafeInteger(artifact.count) && artifact.count >= 0 && rows.length === artifact.count, 'Artifact count mismatch');
        for (const chunk of rows) {
            requireValue(chunk.extractionIdentity === artifact.extractionIdentity && typeof chunk.sourcePath === 'string'
                && chunk.sourcePath.length > 0 && typeof chunk.source === 'string' && typeof chunk.name === 'string'
                && typeof chunk.type === 'string', 'Artifact chunk identity mismatch');
            const key = targetKey({repoSlug: artifact.repoSlug, revision: artifact.revision,
                artifactSha256: artifact.sha256, extractionIdentity: artifact.extractionIdentity,
                source        : chunk.source, sourcePath: chunk.sourcePath, type: chunk.type, name: chunk.name, kind: chunk.kind});
            if (!targetsByKey.has(key)) targetsByKey.set(key, []);
            targetsByKey.get(key).push({artifact, chunk});
        }
    }
    return {targetsByKey, receipts: parsed.artifacts};
}

/** @summary Reassembles actual landed children, preserving actual enrichment and rejecting lost parent meaning. */
function reassemble(chunk, actualRows) {
    if (!actualRows.some(row => row.metadata.oversizedSplit)) {
        requireValue(actualRows.length === 1, 'Unexpected non-split child population');
        return actualRows[0].metadata;
    }
    const ordered = actualRows.slice().sort((a, b) => a.metadata.oversizedSplitIndex - b.metadata.oversizedSplitIndex);
    const total   = ordered.length, source = chunk.content || chunk.description;
    requireValue(total > 1 && typeof source === 'string' && source.length > 0, 'Incomplete split population');
    for (const field of ['content', 'description']) {
        requireValue(!Object.hasOwn(chunk, field) || chunk[field] === source, 'Split parent body fields are not reconstructible');
    }
    let end = 0, content = '', common;
    for (const [index, {metadata}] of ordered.entries()) {
        requireValue(metadata.oversizedSplit === true && metadata.oversizedSplitIndex === index
            && metadata.oversizedSplitTotal === total && metadata.oversizedSplitCharStart === end
            && Number.isSafeInteger(metadata.oversizedSplitCharEnd) && metadata.oversizedSplitCharEnd > end
            && typeof metadata.content === 'string' && metadata.description === metadata.content
            && metadata.content.length === metadata.oversizedSplitCharEnd - end
            && metadata.name === `${chunk.name} [part ${index + 1}/${total}]`, 'Split metadata or ranges are incomplete');
        const stable = semanticPayload(metadata);
        for (const field of [...SPLIT_FIELDS, 'content', 'description', 'name']) delete stable[field];
        if (common !== undefined) requireValue(fingerprint(stable) === common, 'Split children disagree on meaning');
        common = fingerprint(stable);
        content += metadata.content;
        end = metadata.oversizedSplitCharEnd;
    }
    requireValue(content === source && end === source.length, 'Split children do not reproduce artifact body');
    const assembled = {...ordered[0].metadata, name: chunk.name};
    SPLIT_FIELDS.forEach(field => delete assembled[field]);
    for (const field of ['content', 'description']) {
        if (Object.hasOwn(chunk, field)) assembled[field] = content;
        else delete assembled[field]; // The splitter introduced this duplicate field, not another fact.
    }
    return assembled;
}

/** @summary Verifies expected artifact fields against actual landed rows; writer enrichment remains actual evidence. */
function landedReplacement(chunk, artifact, rows, deriveStoredRows) {
    const derived = deriveStoredRows(JSON.parse(JSON.stringify(chunk)), {tenantId: artifact.tenantId, repoSlug: artifact.repoSlug});
    requireValue(Array.isArray(derived) && derived.length > 0 && new Set(derived.map(row => row.id)).size === derived.length, 'Invalid derived child population');
    const actual = derived.map(child => {
        requireValue(/^[a-f0-9]{64}$/u.test(child.id) && child.metadata?.hash === child.id
            && child.metadata.tenantId === artifact.tenantId && child.metadata.repoSlug === artifact.repoSlug
            && child.metadata.extractionIdentity === artifact.extractionIdentity && child.metadata.sourcePath === chunk.sourcePath, 'Invalid derived child identity');
        const stored = rows.get(child.id);
        requireValue(stored, 'Derived target is not landed');
        const expected = scalars(child.metadata), observed = scalars(stored.metadata);
        requireValue(Object.entries(expected).every(([key, value]) => key === 'ingestedAt' || key === 'line_start' || key === 'line_end'
            || (Object.hasOwn(observed, key) && fingerprint(observed[key]) === fingerprint(value))), 'Landed target differs from artifact');
        return stored;
    });
    return {payload: reassemble(chunk, actual), rows: actual.map(row => ({id: row.id, metadataDigest: row.metadataDigest})).sort((a, b) => a.id.localeCompare(b.id))};
}

/**
 * @summary Builds a detached, immutable redundancy plan from exact supplied observations.
 * @param {Object} options Frozen bytes, metadata census and explicit reviewed correspondences.
 * @param {Function} options.deriveStoredRows Existing VectorService expansion/stamping plus metadata-writer adapter.
 * @param {String[]} [options.protectedIds=[]] Other observed collection IDs whose metadata was not fetched.
 * @returns {Object} Exact input bindings, candidate/target fingerprints and preservation population.
 */
export function buildCoreRowRetirementPlan({collectionId, scope, manifest, artifacts, census, correspondence, deriveStoredRows, protectedIds = []}) {
    requireValue(typeof collectionId === 'string' && collectionId.length > 0, 'Exact collection identity required');
    requireValue(typeof scope?.tenantId === 'string' && scope.tenantId.length > 0 && typeof scope.repoSlug === 'string' && scope.repoSlug.length > 0, 'Exact legacy scope required');
    requireValue(typeof deriveStoredRows === 'function', 'Existing vector-owner derivation adapter required');
    requireValue(Array.isArray(protectedIds) && protectedIds.every(id => typeof id === 'string' && id.length > 0), 'Invalid protected ID population');
    const {targetsByKey, receipts} = readProfiles(manifest, artifacts, scope);
    requireValue(typeof correspondence?.text === 'string' && fingerprint(correspondence.text) === correspondence.sha256, 'Correspondence bytes do not match captured SHA');
    const map         = JSON.parse(correspondence.text), rows = new Map(), entries = new Map(), protectedSet = new Set(protectedIds);
    const landedByKey = new Map();
    requireValue(Array.isArray(map.entries) && Array.isArray(census), 'Correspondence and census populations required');
    for (const row of census) {
        requireValue(typeof row.id === 'string' && row.id.length > 0 && row.metadata && !rows.has(row.id), 'Invalid or duplicate census row');
        rows.set(row.id, JSON.parse(JSON.stringify(canonical({id: row.id, metadata: row.metadata, metadataDigest: metadataFingerprint(row.metadata)}))));
    }
    for (const entry of map.entries) {
        requireValue(typeof entry.oldId === 'string' && !entries.has(entry.oldId), 'Duplicate or invalid old-ID correspondence');
        entries.set(entry.oldId, entry);
    }
    const retained = [], candidates = [], refusals = [];
    for (const entry of entries.values()) {
        if (!rows.has(entry.oldId)) refusals.push({id: entry.oldId, code: protectedSet.has(entry.oldId) ? 'PROTECTED_OLD_ID' : 'OLD_ID_NOT_CAPTURED'});
    }
    for (const row of [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const {metadataDigest} = row, entry = entries.get(row.id);
        const protection       = protectedSet.has(row.id) ? 'PROTECTED_OLD_ID' : coreRowProtectionReason(row.metadata, scope);
        if (protection) {
            if (entry) refusals.push({id: row.id, code: 'PROTECTED_CORRESPONDENCE', reason: protection});
            retained.push({id: row.id, metadataDigest, reason: protection});
            continue;
        }
        if (!entry) {retained.push({id: row.id, metadataDigest, reason: 'UNMATCHED'}); continue;}
        if (entry.metadataDigest !== metadataDigest) {
            refusals.push({id: row.id, code: 'OLD_METADATA_CHANGED'});
            retained.push({id: row.id, metadataDigest, reason: 'OLD_METADATA_CHANGED'});
            continue;
        }
        const targets = entry.targets ?? (entry.target ? [entry.target] : []), replacements = [], alternatives = [];
        requireValue(Array.isArray(targets), 'Targets must be an array');
        for (const target of targets) {
            const family = String(target?.type || '').toLowerCase().replace(/[-_\s]/gu, '');
            if (!target || (Object.hasOwn(target, 'tenantId') && target.tenantId !== scope.tenantId)
                || !REPOS.includes(target.repoSlug) || PROTECTED.has(family) || !FAMILIES.has(target.type)) {
                refusals.push({id: row.id, code: 'FORBIDDEN_REPLACEMENT', target});
                alternatives.push({target, reason: 'FORBIDDEN_REPLACEMENT'});
                continue;
            }
            const key = targetKey(target), matches = targetsByKey.get(key) || [];
            if (matches.length !== 1) {alternatives.push({target, reason: matches.length ? 'AMBIGUOUS_ARTIFACT_TARGET' : 'TARGET_NOT_IN_ARTIFACT'}); continue;}
            const {artifact, chunk} = matches[0];
            try {
                const oldPayload = semanticPayload(row.metadata, target.conversions ?? entry.conversions ?? []);
                if (!landedByKey.has(key)) {
                    try {landedByKey.set(key, {value: landedReplacement(chunk, artifact, rows, deriveStoredRows)});}
                    catch (error) {landedByKey.set(key, {error});}
                }
                const cached = landedByKey.get(key);
                if (cached.error) throw cached.error;
                const landed = cached.value;
                requireValue(oldPayload.content || oldPayload.description, 'Semantic body absent');
                requireValue(fingerprint(oldPayload) === fingerprint(semanticPayload(landed.payload)), 'Non-provenance payload differs');
                const {conversions, ...locator} = target;
                const replacement               = {...locator, ids: landed.rows.map(item => item.id), rows: landed.rows};
                if (!replacements.some(item => fingerprint(item) === fingerprint(replacement))) replacements.push(replacement);
            } catch (error) {alternatives.push({target, reason: error.message});}
        }
        if (replacements.length) {
            candidates.push({id: row.id, metadataDigest, semanticDigest: fingerprint(semanticPayload(row.metadata)), replacements, alternatives});
        } else retained.push({id: row.id, metadataDigest, reason: 'NO_REDUNDANCY_WITNESS', alternatives});
    }
    const snapshots       = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    const population      = [...new Set([...rows.keys(), ...protectedSet])].sort();
    const retirementIds   = candidates.map(row => row.id).sort(), deleting = new Set(retirementIds);
    const preservationIds = population.filter(id => !deleting.has(id));
    const body            = canonical({
        schemaVersion: PLAN_SCHEMA,
        binding      : {collectionId, scope, manifestSha256: manifest.sha256, correspondenceSha256: correspondence.sha256,
            artifacts: receipts, protectedIds: [...protectedSet].sort(), populationIdDigest: fingerprint(population)},
        census      : snapshots, censusDigest: fingerprint(snapshots), candidates, retirementIds, retained, refusals,
        preservation: {ids: preservationIds, count: preservationIds.length, digest: fingerprint(preservationIds)},
        executable  : refusals.length === 0
    });
    return freeze({...body, planDigest: fingerprint(body)});
}
