/**
 * @module ai/services/shared/adrIdentityCodec
 * @summary Canonical RFC 3986 key codec and field validators for Architecture Decision Record
 * identities (`adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`).
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */

export const ADR_SLUG_REGEX            = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const ADR_FILE_REGEX            = /^(\d{4})-(.+)\.md$/;
export const ADR_NUMBER_REGEX          = /^(?!0000)\d{4}$/;
export const FORGE_AUTHORITY_REGEX     = /^[a-z0-9.-]+(?::[1-9][0-9]*)?$/;
export const FULL_NAMESPACE_REGEX      = /^[^/\s]+\/[^/\s]+$/;
const        RFC3986_ENCODED_TOKEN_REX = /^(?:[A-Za-z0-9\-._~]|%[0-9A-F]{2})+$/;

/**
 * Evidenced repository cut bindings for the core organism repositories.
 */
export const KNOWN_CUT_REPOSITORIES = Object.freeze([
    Object.freeze({forge: 'github.com', repositoryId: '220867748',  namespace: 'neomjs/neo'}),
    Object.freeze({forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain'}),
    Object.freeze({forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution'})
]);

/**
 * @summary Builds an Error carrying a structured `.code` property.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 */
export function createCodedError(code, message) {
    const err = new Error(message);
    err.code  = code;
    return err;
}

function isUnreservedRfc3986Byte(byte) {
    return (byte >= 0x41 && byte <= 0x5A) || // A-Z
           (byte >= 0x61 && byte <= 0x7A) || // a-z
           (byte >= 0x30 && byte <= 0x39) || // 0-9
           byte === 0x2D ||                  // -
           byte === 0x2E ||                  // .
           byte === 0x5F ||                  // _
           byte === 0x7E;                    // ~
}

/**
 * @summary Encodes UTF-8 bytes of one ADR canonical-key field per RFC 3986 §§2.1–2.3.
 * Only ASCII letters, digits, `-`, `.`, `_`, and `~` remain literal; all other bytes
 * are percent-encoded with uppercase hexadecimal digits.
 * @param {String} value Raw field value.
 * @returns {String}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function encodeAdrKeyField(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', 'ADR identity field must be a non-empty string.');
    }

    const bytes = Buffer.from(value, 'utf8');
    let   out   = '';

    for (const byte of bytes) {
        if (isUnreservedRfc3986Byte(byte)) {
            out += String.fromCharCode(byte);
        } else {
            out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
        }
    }

    return out;
}

/**
 * @summary Decodes one RFC 3986-encoded ADR canonical-key field once and verifies
 * canonical re-encoding equality (uppercase hex, literal unreserved chars).
 * @param {String} encoded Encoded field segment.
 * @returns {String}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function decodeAdrKeyField(encoded) {
    if (typeof encoded !== 'string' || encoded.length === 0 || !RFC3986_ENCODED_TOKEN_REX.test(encoded)) {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', `Noncanonical or malformed encoded ADR key field: '${String(encoded)}'`);
    }

    let decoded;
    try {
        decoded = decodeURIComponent(encoded);
    } catch {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', `Invalid UTF-8 percent-encoding in ADR key field: '${encoded}'`);
    }

    if (encodeAdrKeyField(decoded) !== encoded) {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', `ADR key field failed canonical re-encoding equality: '${encoded}'`);
    }

    return decoded;
}

/**
 * @summary Validates the four canonical ADR decision identity fields before admission or key serialization.
 * @param {Object} fields
 * @param {String} fields.forge Canonical provider authority (no scheme, credentials, or default port).
 * @param {String} fields.repositoryId Evidenced stable repository resource ID (not a mutable name).
 * @param {String} fields.namespace Full `<organization>/<repository>` name at assignment.
 * @param {String} fields.number Four ASCII decimal digits `0001`..`9999`.
 * @returns {{forge: String, repositoryId: String, namespace: String, number: String}}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function validateAdrIdentityFields({forge, repositoryId, namespace, number} = {}) {
    if (typeof forge !== 'string' || !forge || forge.trim() !== forge ||
        forge.includes('://') || forge.includes('@') || forge.includes('/') ||
        !FORGE_AUTHORITY_REGEX.test(forge) || /:80$|:443$/.test(forge)) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid or noncanonical forge authority: '${String(forge)}'`);
    }

    if (typeof repositoryId !== 'string' || !repositoryId || repositoryId.trim() !== repositoryId ||
        /\s|\//.test(repositoryId) || repositoryId === namespace) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Missing or invalid stable repositoryId proof: '${String(repositoryId)}'`);
    }

    if (typeof namespace !== 'string' || !namespace || namespace.trim() !== namespace ||
        !FULL_NAMESPACE_REGEX.test(namespace)) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid ADR namespace (full <organization>/<repository> required): '${String(namespace)}'`);
    }

    if (typeof number !== 'string' || !ADR_NUMBER_REGEX.test(number)) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid ADR number (expected 0001..9999): '${String(number)}'`);
    }

    return {forge, repositoryId, namespace, number};
}

/**
 * @summary Builds the canonical decision identity key `adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`.
 * @param {Object} fields
 * @param {String} fields.forge
 * @param {String} fields.repositoryId
 * @param {String} fields.namespace
 * @param {String} fields.number
 * @returns {String}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function buildCanonicalAdrKey(fields = {}) {
    const {forge, repositoryId, namespace, number} = validateAdrIdentityFields(fields);
    const
        encForge     = encodeAdrKeyField(forge),
        encRepoId    = encodeAdrKeyField(repositoryId),
        encNamespace = encodeAdrKeyField(namespace);

    if (decodeAdrKeyField(encForge) !== forge ||
        decodeAdrKeyField(encRepoId) !== repositoryId ||
        decodeAdrKeyField(encNamespace) !== namespace) {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', 'ADR identity fields failed decode/re-encode roundtrip.');
    }

    return `adr:${encForge}:${encRepoId}:${encNamespace}:${number}`;
}

/**
 * @summary Parses and validates a canonical decision identity key (`adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`).
 * @param {String} key Candidate canonical key.
 * @returns {{canonicalKey: String, forge: String, repositoryId: String, namespace: String, number: String}}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function parseCanonicalAdrKey(key) {
    if (typeof key !== 'string' || !key.startsWith('adr:')) {
        throw createCodedError('ADR_INVALID_CANONICAL_KEY', `Invalid canonical ADR key: '${String(key)}'`);
    }

    const parts = key.split(':');
    if (parts.length !== 5 || parts[0] !== 'adr') {
        throw createCodedError('ADR_INVALID_CANONICAL_KEY', `Canonical ADR key must have 5 colon-separated parts: '${key}'`);
    }

    const
        forge        = decodeAdrKeyField(parts[1]),
        repositoryId = decodeAdrKeyField(parts[2]),
        namespace    = decodeAdrKeyField(parts[3]),
        number       = parts[4];

    validateAdrIdentityFields({forge, repositoryId, namespace, number});

    const rebuilt = buildCanonicalAdrKey({forge, repositoryId, namespace, number});
    if (rebuilt !== key) {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', `Canonical ADR key failed re-encoding equality: '${key}'`);
    }

    return {canonicalKey: key, forge, repositoryId, namespace, number};
}

/**
 * Shared in-memory admitted ADR catalog, per-repository reservation buckets, and forge directory
 * accessed by both `AdrIngestor` and `AdrSource`.
 */
export const SHARED_ADR_CATALOG_STATE = Object.freeze({
    admissionCatalog      : new Map(),
    repositoryReservations: new Map(),
    forgeDirectory        : new Map()
});

/**
 * @summary Ensures and returns the reservation bucket for `(forge, repositoryId)` in the shared catalog state.
 * @param {String} forge
 * @param {String} repositoryId
 * @returns {{forge: String, repositoryId: String, numbers: Set<String>, aliases: Map<String, Object>}}
 */
export function ensureSharedReservationBucket(forge, repositoryId) {
    const key = `${forge}:${repositoryId}`;
    if (!SHARED_ADR_CATALOG_STATE.repositoryReservations.has(key)) {
        SHARED_ADR_CATALOG_STATE.repositoryReservations.set(key, {
            forge,
            repositoryId,
            numbers: new Set(),
            aliases: new Map()
        });
    }
    return SHARED_ADR_CATALOG_STATE.repositoryReservations.get(key);
}

/**
 * @summary Registers a repository's current namespace occupancy in the shared forge provider directory.
 * @param {Object} repo
 */
export function registerSharedForgeRepository({forge = 'github.com', repositoryId, namespace, aliases = []} = {}) {
    validateAdrIdentityFields({forge, repositoryId, namespace, number: '0001'});
    if (!SHARED_ADR_CATALOG_STATE.forgeDirectory.has(forge)) {
        SHARED_ADR_CATALOG_STATE.forgeDirectory.set(forge, new Map());
    }

    const dir = SHARED_ADR_CATALOG_STATE.forgeDirectory.get(forge);
    dir.set(namespace.toLowerCase(), {forge, repositoryId, currentNamespace: namespace});

    for (const aliasNs of aliases) {
        if (typeof aliasNs === 'string' && FULL_NAMESPACE_REGEX.test(aliasNs)) {
            const existing = dir.get(aliasNs.toLowerCase());
            if (!existing || existing.repositoryId === repositoryId) {
                dir.set(aliasNs.toLowerCase(), {forge, repositoryId, currentNamespace: namespace});
            }
        }
    }

    ensureSharedReservationBucket(forge, repositoryId);
}

/**
 * @summary Resets the shared admitted ADR catalog and seeds the default cut repositories.
 */
export function resetSharedAdrCatalog() {
    SHARED_ADR_CATALOG_STATE.admissionCatalog.clear();
    SHARED_ADR_CATALOG_STATE.repositoryReservations.clear();
    SHARED_ADR_CATALOG_STATE.forgeDirectory.clear();
    for (const repo of KNOWN_CUT_REPOSITORIES) {
        registerSharedForgeRepository(repo);
    }
}

/**
 * @summary Extracts evidenced forge and repository context from a citation surface descriptor.
 * @param {Object} [context={}]
 * @returns {{forge: String|null, repositoryId: String|null, namespace: String|null}}
 */
export function extractCitationSurfaceContext(context = {}) {
    const surface = String(context.surface || 'repository_artifact').toLowerCase();

    if (surface === 'organization_discussion' || surface === 'discussion') {
        const forge = context.webOrigin?.forge || context.sourceOrigin?.forge || context.forge || null;
        return {forge, repositoryId: null, namespace: null};
    }
    if (surface === 'memory_or_a2a' || surface === 'memory' || surface === 'a2a') {
        return {forge: context.originEnvelope?.forge || null, repositoryId: null, namespace: null};
    }
    if (surface === 'historical_content' || surface === 'moved_file' || surface === 'copied_content') {
        const origin = context.evidencedCitationOrigin || null;
        return origin ? {
            forge       : origin.forge || null,
            repositoryId: origin.repositoryId || null,
            namespace   : origin.namespace || null
        } : {forge: null, repositoryId: null, namespace: null};
    }

    const origin = context.sourceOrigin || context;
    return {
        forge       : origin.forge || null,
        repositoryId: origin.repositoryId || null,
        namespace   : origin.namespace || null
    };
}

/**
 * @summary Parses a non-canonical human slug or legacy numeric ADR citation token into its
 * optional qualifier (`explicitForge`, `explicitNamespace`) and target (`targetKind`, `targetValue`).
 * @param {String} raw Trimmed citation string.
 * @returns {{ok: Boolean, reasonCode?: String, explicitForge?: String|null, explicitNamespace?: String|null, targetKind?: 'slug'|'legacy-number', targetValue?: String}}
 */
export function parseHumanOrNumericAdrReference(raw) {
    let
        explicitForge     = null,
        explicitNamespace = null,
        targetKind        = null,
        targetValue       = null;

    if (raw.includes('#')) {
        const
            hashIndex = raw.indexOf('#'),
            qualifier = raw.slice(0, hashIndex),
            fragment  = raw.slice(hashIndex + 1),
            segments  = qualifier.split('/');

        if (segments.length === 2 && segments[0] && segments[1]) {
            explicitNamespace = `${segments[0]}/${segments[1]}`;
        } else if (segments.length === 3 && segments[0] && segments[1] && segments[2]) {
            explicitForge     = segments[0];
            explicitNamespace = `${segments[1]}/${segments[2]}`;
        } else {
            return {ok: false, reasonCode: 'INVALID_REPOSITORY_LOCATOR'};
        }

        if (fragment.startsWith('adr:')) {
            targetKind  = 'slug';
            targetValue = fragment.slice(4);
        } else if (/^adr-\d{4}$/.test(fragment)) {
            targetKind  = 'legacy-number';
            targetValue = fragment.slice(4);
        } else {
            return {ok: false, reasonCode: 'INVALID_ADR_FRAGMENT'};
        }
    } else if (raw.startsWith('adr:')) {
        targetKind  = 'slug';
        targetValue = raw.slice(4);
    } else if (/^adr-\d{4}$/.test(raw)) {
        targetKind  = 'legacy-number';
        targetValue = raw.slice(4);
    } else {
        return {ok: false, reasonCode: 'UNRECOGNIZED_REFERENCE_FORM'};
    }

    if (targetKind === 'slug' && !ADR_SLUG_REGEX.test(targetValue)) {
        return {ok: false, reasonCode: 'ADR_INVALID_ALIAS_TOKEN'};
    }
    if (targetKind === 'legacy-number' && !ADR_NUMBER_REGEX.test(targetValue)) {
        return {ok: false, reasonCode: 'ADR_INVALID_IDENTITY_FIELD'};
    }

    return {ok: true, explicitForge, explicitNamespace, targetKind, targetValue};
}

/**
 * @summary Evaluates whether a reader context is authorized for an admitted ADR record,
 * including private-repository (`neomjs/neo-stage`) tenant/reader policy controls.
 * @param {Object} record
 * @param {Object} [context={}]
 * @returns {Boolean}
 */
export function isAdrReaderAuthorized(record, context = {}) {
    if (!record) return false;
    if (typeof context.isAuthorized === 'function' && !context.isAuthorized(record)) return false;

    const
        repoId     = record.sourceTuple?.repositoryId || record.assignmentEvidence?.repositoryId,
        namespace  = (record.sourceTuple?.namespace || record.assignmentEvidence?.namespace || '').toLowerCase(),
        visibility = record.visibility || 'public',
        tenantId   = record.tenantId || null;

    if (Array.isArray(context.authorizedRepositoryIds)) {
        const allowedIds = new Set(context.authorizedRepositoryIds.map(String));
        if (!allowedIds.has(String(repoId))) return false;
    }

    if (Array.isArray(context.authorizedNamespaces)) {
        const allowedNs = new Set(context.authorizedNamespaces.map(ns => String(ns).toLowerCase()));
        if (!allowedNs.has(namespace)) return false;
    }

    if (Array.isArray(context.authorizedTenants) && tenantId) {
        const allowedTenants = new Set(context.authorizedTenants.map(String));
        if (!allowedTenants.has(String(tenantId))) return false;
    }

    if (visibility === 'private') {
        const
            hasRepoAuth   = Array.isArray(context.authorizedRepositoryIds) &&
                            context.authorizedRepositoryIds.map(String).includes(String(repoId)),
            hasNsAuth     = Array.isArray(context.authorizedNamespaces) &&
                            context.authorizedNamespaces.map(ns => String(ns).toLowerCase()).includes(namespace),
            hasTenantAuth = (Boolean(tenantId) && context.tenantId === tenantId) ||
                            (Boolean(tenantId) && Array.isArray(context.authorizedTenants) && context.authorizedTenants.includes(tenantId)),
            hasCustomAuth = typeof context.isAuthorized === 'function' && Boolean(context.isAuthorized(record));

        if (!hasRepoAuth && !hasNsAuth && !hasTenantAuth && !hasCustomAuth) {
            return false;
        }
    }

    return true;
}

/**
 * @summary Binds current slug, historical aliases, and legacy-number reservations on an admitted record
 * and in the shared repository reservation buckets.
 * @param {Object} record
 * @param {Object|null} specRepo
 * @param {Object} adr
 * @param {Boolean} [isCustodyMove=false]
 * @param {String} [defaultNamespace='neo-agent-brain']
 */
export function bindSharedAdrRecordAliases(record, specRepo, adr, isCustodyMove = false, defaultNamespace = 'neo-agent-brain') {
    const addBinding = (bucket, binding) => {
        const
            normalizedNs = binding.namespace.toLowerCase(),
            matches      = item => item.kind === binding.kind && item.value === binding.value &&
                                   item.forge === binding.forge && item.repositoryId === binding.repositoryId &&
                                   item.namespace.toLowerCase() === normalizedNs,
            existing     = record.aliasBindings.find(matches);

        if (existing) {
            existing.current = Boolean(binding.current);
        } else {
            record.aliasBindings.push({...binding});
        }

        if (!record.reservations.some(matches)) {
            record.reservations.push({
                kind        : binding.kind,
                value       : binding.value,
                forge       : binding.forge,
                repositoryId: binding.repositoryId,
                namespace   : binding.namespace,
                targetKey   : record.canonicalKey
            });
        }

        if (bucket) {
            bucket.aliases.set(`${binding.kind}:${normalizedNs}:${binding.value}`, {...binding, targetKey: record.canonicalKey});
        }
    };

    if (!specRepo) {
        addBinding(null, {kind: 'slug', value: adr.currentSlug, forge: 'github.com', repositoryId: null, namespace: defaultNamespace, targetKey: adr.canonicalKey, current: true});
        addBinding(null, {kind: 'legacy-number', value: adr.adrNumber, forge: 'github.com', repositoryId: null, namespace: defaultNamespace, targetKey: adr.canonicalKey, current: true});
        return;
    }

    const
        forge        = specRepo.forge || 'github.com',
        sourceRepoId = specRepo.repositoryId,
        sourceNs     = specRepo.namespace,
        bucket       = ensureSharedReservationBucket(forge, sourceRepoId);

    bucket.numbers.add(adr.adrNumber);

    for (const b of record.aliasBindings) {
        if (b.kind === 'slug' && b.forge === forge && b.repositoryId === sourceRepoId) {
            b.current = (b.value === adr.currentSlug && b.namespace.toLowerCase() === sourceNs.toLowerCase());
        }
    }

    addBinding(bucket, {kind: 'slug', value: adr.currentSlug, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: true});
    addBinding(bucket, {kind: 'legacy-number', value: adr.adrNumber, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: true});

    for (const histSlug of adr.historicalAliases) {
        const alreadyAdmitted = record.aliasBindings.some(b => b.kind === 'slug' && b.value === histSlug);
        if (!alreadyAdmitted && !isCustodyMove) {
            addBinding(bucket, {kind: 'slug', value: histSlug, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: false});
        }
    }

    if (record.assignmentEvidence?.repositoryId && record.assignmentEvidence.repositoryId !== sourceRepoId) {
        const
            originForge  = record.assignmentEvidence.forge || forge,
            originRepoId = record.assignmentEvidence.repositoryId,
            originBucket = ensureSharedReservationBucket(originForge, originRepoId);
        originBucket.numbers.add(adr.adrNumber);
        if (record.assignmentEvidence.namespace) {
            const originNs = record.assignmentEvidence.namespace;
            addBinding(originBucket, {kind: 'slug', value: adr.currentSlug, forge: originForge, repositoryId: originRepoId, namespace: originNs, targetKey: adr.canonicalKey, current: false});
            addBinding(originBucket, {kind: 'legacy-number', value: adr.adrNumber, forge: originForge, repositoryId: originRepoId, namespace: originNs, targetKey: adr.canonicalKey, current: false});
        }
    }
}

function unresolvedRefResult(reasonCode, candidates = []) {
    return {
        status           : candidates.length > 1 ? 'ambiguous' : 'unresolved',
        resolved         : false,
        canonicalKey     : null,
        identityResolved : false,
        documentAvailable: false,
        candidates,
        reasonCode
    };
}

function resolvedRefResult(record) {
    return {
        status           : 'resolved',
        resolved         : true,
        canonicalKey     : record.canonicalKey,
        identityResolved : true,
        documentAvailable: Boolean(record.documentAvailable),
        kbAvailable      : Boolean(record.kbAvailable),
        stale            : Boolean(record.stale),
        record,
        candidates       : [record.canonicalKey]
    };
}

/**
 * @summary Resolves a human or machine ADR citation against the shared admitted catalog using
 * evidenced citation context, forge-adapter repository identity lookup, rename/reuse conflict rules,
 * and reader authorization.
 * @param {String} reference
 * @param {Object} [context={}]
 * @returns {Object}
 */
export function resolveSharedAdrReference(reference, context = {}) {
    const
        catalog = SHARED_ADR_CATALOG_STATE.admissionCatalog,
        raw     = typeof reference === 'string' ? reference.trim() : '';

    if (!raw) return unresolvedRefResult('EMPTY_REFERENCE');

    if (raw.startsWith('adr:') && raw.split(':').length === 5) {
        let parsedKey;
        try {
            parsedKey = parseCanonicalAdrKey(raw);
        } catch (e) {
            return unresolvedRefResult(e.code || 'ADR_INVALID_CANONICAL_KEY');
        }
        const record = catalog.get(parsedKey.canonicalKey);
        if (!record || !isAdrReaderAuthorized(record, context)) {
            return unresolvedRefResult('NOT_FOUND');
        }
        return resolvedRefResult(record);
    }

    const parsedRef = parseHumanOrNumericAdrReference(raw);
    if (!parsedRef.ok) return unresolvedRefResult(parsedRef.reasonCode);

    const
        {explicitForge, explicitNamespace, targetKind, targetValue} = parsedRef,
        surfaceContext                                              = extractCitationSurfaceContext(context),
        effectiveForge                                              = explicitForge || surfaceContext.forge,
        hasRepositoryContext                                        = Boolean(explicitNamespace || surfaceContext.repositoryId || surfaceContext.namespace);

    if (!hasRepositoryContext) {
        const matchingAuthorized = [];
        for (const record of catalog.values()) {
            if (!isAdrReaderAuthorized(record, context)) continue;
            const matches = record.aliasBindings?.some(
                b => b.kind === targetKind && b.value === targetValue && (!effectiveForge || b.forge === effectiveForge)
            ) || (targetKind === 'legacy-number' && record.adrNumber === targetValue && !record.assignmentEvidence?.repositoryId);
            if (matches) matchingAuthorized.push(record.canonicalKey);
        }

        if (matchingAuthorized.length === 1 &&
            matchingAuthorized[0] === `adr-${targetValue}` &&
            !context.surface &&
            !context.requireRepositoryContext) {
            return resolvedRefResult(catalog.get(matchingAuthorized[0]));
        }
        return unresolvedRefResult('MISSING_REPOSITORY_CONTEXT', matchingAuthorized);
    }

    if (!effectiveForge) return unresolvedRefResult('MISSING_FORGE_CONTEXT');

    const
        targetNamespace   = explicitNamespace || surfaceContext.namespace,
        lowerTargetNs     = targetNamespace ? targetNamespace.toLowerCase() : null,
        forgeMap          = SHARED_ADR_CATALOG_STATE.forgeDirectory.get(effectiveForge),
        adapterResolution = lowerTargetNs && forgeMap ? forgeMap.get(lowerTargetNs) : null,
        currentOccupantId = (!explicitNamespace && surfaceContext.repositoryId)
            ? surfaceContext.repositoryId
            : (adapterResolution?.repositoryId || null),
        namespaceBindings = [],
        repoIdBindings    = [];

    for (const record of catalog.values()) {
        for (const binding of record.aliasBindings || []) {
            if (binding.forge !== effectiveForge || binding.kind !== targetKind || binding.value !== targetValue) continue;
            if (lowerTargetNs && binding.namespace.toLowerCase() === lowerTargetNs) namespaceBindings.push({binding, record});
            if (currentOccupantId && binding.repositoryId === currentOccupantId) repoIdBindings.push({binding, record});
        }
    }

    if (lowerTargetNs && currentOccupantId) {
        const conflictingHistorical = namespaceBindings.filter(entry => entry.binding.repositoryId !== currentOccupantId);
        if (conflictingHistorical.length > 0) {
            const candidateSet = new Set();
            for (const entry of [...conflictingHistorical, ...namespaceBindings.filter(e => e.binding.repositoryId === currentOccupantId)]) {
                if (isAdrReaderAuthorized(entry.record, context)) candidateSet.add(entry.record.canonicalKey);
            }
            const authorizedCandidates = Array.from(candidateSet);
            if (authorizedCandidates.length === 0) return unresolvedRefResult('NOT_FOUND');

            return {
                status              : 'conflict',
                resolved            : false,
                canonicalKey        : null,
                identityResolved    : false,
                documentAvailable   : false,
                requiresCanonicalKey: true,
                candidates          : authorizedCandidates,
                reasonCode          : 'RESERVED_NAMESPACE_OCCUPANCY_CONFLICT'
            };
        }
    }

    let matchedEntries = [];
    if (lowerTargetNs) {
        matchedEntries = namespaceBindings;
        if (matchedEntries.length === 0 && currentOccupantId && adapterResolution) {
            matchedEntries = repoIdBindings.filter(entry =>
                entry.record.provenance?.repositoryRenames?.some(
                    r => r.forge === effectiveForge &&
                         r.repositoryId === currentOccupantId &&
                         (r.currentNamespace.toLowerCase() === lowerTargetNs || r.previousNamespace.toLowerCase() === lowerTargetNs)
                )
            );
        }
    } else if (currentOccupantId) {
        matchedEntries = repoIdBindings;
    }

    const
        authorizedRecords = [],
        seenKeys          = new Set();

    for (const entry of matchedEntries) {
        if (!seenKeys.has(entry.record.canonicalKey) && isAdrReaderAuthorized(entry.record, context)) {
            seenKeys.add(entry.record.canonicalKey);
            authorizedRecords.push(entry.record);
        }
    }

    if (authorizedRecords.length === 0) return unresolvedRefResult('NOT_FOUND');
    if (authorizedRecords.length > 1)   return unresolvedRefResult('AMBIGUOUS_REFERENCE', authorizedRecords.map(r => r.canonicalKey));

    return resolvedRefResult(authorizedRecords[0]);
}

resetSharedAdrCatalog();
