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
