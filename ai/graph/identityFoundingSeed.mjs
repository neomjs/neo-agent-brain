import {createHash} from 'node:crypto';
import {stringifyCanonicalJson} from '../services/shared/canonicalJson.mjs';
import {isIdentityPublicationFamily, isIdentityPublicationIdentifier, isIdentityPublicationSubject}
    from '../services/shared/identityPublicationOperation.mjs';

/**
 * @module ai/graph/identityFoundingSeed
 * @summary Compiles explicit roster facts into a detached, content-addressed founding-family input.
 * This pure compiler neither writes a graph nor grants seed, membership or routing authority.
 * The seed owner must retain the complete result through its protected transaction; runtime family
 * readers consume that retained source, never import the mutable roster or resolve login aliases.
 * @see ../../learn/agentos/IdentitySchema.md
 */

/** @summary Refuses incomplete or malformed source inputs rather than emitting a partial seed. */
function requireSource(condition, reason) {
    if (!condition) throw new TypeError('Founding family seed: ' + reason);
}

/** @summary Requires closed plain-JSON records after canonical validation has rejected accessors. */
function fields(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** @summary Binds the full ordered payload under the founding-seed domain, without granting authority. */
function digest(payload) {
    return 'sha256:' + createHash('sha256').update('neo.identity-family.founding-seed.v1\0')
        .update(stringifyCanonicalJson(payload), 'utf8').digest('hex');
}

/**
 * @summary Checks every retained founding row and its canonical digest before any subject selection.
 * A valid digest proves content consistency only; protected provenance and physical snapshot
 * coherence must be established by the source owner, never inferred from this boolean result.
 * @param {*} value Complete retained {version, entries, digest} payload.
 * @returns {Boolean} Whether the complete payload matches the compiler's closed canonical shape.
 */
export function validateFoundingFamilySeed(value) {
    try {
        stringifyCanonicalJson(value);
        if (!fields(value, ['version', 'entries', 'digest']) || value.version !== 1 || !Array.isArray(value.entries)) return false;
        let previous = null;
        for (const entry of value.entries) {
            if (!fields(entry, ['identityKey', 'family', 'subject']) ||
                !isIdentityPublicationIdentifier(entry.identityKey) || !isIdentityPublicationFamily(entry.family) ||
                !isIdentityPublicationSubject(entry.subject) || previous !== null && entry.identityKey <= previous) return false;
            previous = entry.identityKey;
        }
        return value.digest === digest({version: value.version, entries: value.entries});
    } catch {
        return false;
    }
}

/**
 * @summary Binds every agent roster entry to its explicit stable subject and exact family value.
 * Multiple roster entries may share a subject; all survive for the reader's agreement check.
 * Display names, aliases and unrelated metadata do not affect the family-source digest.
 * @param {Object} options Explicit source inputs; there is no ambient roster fallback.
 * @param {Object[]} options.identities Complete checked-in identity-root array.
 * @param {Object[]} options.subjects Complete literal {identityKey, subject} rows for agent entries.
 * @returns {Object} Frozen {version, entries, digest}; digest binds the complete canonical payload.
 * @throws {TypeError} On an incomplete, duplicate or malformed mapping; no partial result is returned.
 */
export function compileFoundingFamilySeed(options) {
    stringifyCanonicalJson(options);
    requireSource(fields(options, ['identities', 'subjects']), 'explicit identities and subjects are required.');
    const {identities, subjects} = options;
    requireSource(Array.isArray(identities) && Array.isArray(subjects), 'complete source arrays are required.');
    const roster = new Map(), seen = new Set();
    for (const identity of identities) {
        requireSource(identity && Object.hasOwn(identity, 'id') &&
            isIdentityPublicationIdentifier(identity.id) && !seen.has(identity.id),
            'identity roots require unique explicit IDs.');
        seen.add(identity.id);
        const properties = identity.properties, type = identity.type, accountType = properties?.accountType;
        requireSource(Object.hasOwn(identity, 'type') && Object.hasOwn(identity, 'properties') &&
            properties && typeof properties === 'object' && !Array.isArray(properties) &&
            Object.hasOwn(properties, 'accountType') &&
            (type === 'AgentIdentity' && ['agent', 'human'].includes(accountType) ||
                type === 'System' && accountType === 'system' ||
                type === 'BroadcastSentinel' && accountType === 'sentinel'),
        identity.id + ' requires an explicit, consistent root type and accountType.');
        if (accountType !== 'agent') continue;
        requireSource(isIdentityPublicationFamily(identity.properties.modelFamily),
            identity.id + ' requires an exact family.');
        roster.set(identity.id, identity.properties.modelFamily);
    }

    const mapped = new Set(), entries = [];
    for (const mapping of subjects) {
        requireSource(mapping && Object.keys(mapping).length === 2 &&
            Object.hasOwn(mapping, 'identityKey') && Object.hasOwn(mapping, 'subject') &&
            isIdentityPublicationIdentifier(mapping.identityKey) && isIdentityPublicationSubject(mapping.subject),
        'expected a literal identityKey and stable subject tuple.');
        requireSource(roster.has(mapping.identityKey) && !mapped.has(mapping.identityKey),
            mapping.identityKey + ' must name one unmapped agent roster entry.');
        mapped.add(mapping.identityKey);
        entries.push(Object.freeze({identityKey: mapping.identityKey, family: roster.get(mapping.identityKey),
            subject: Object.freeze({...mapping.subject})}));
    }
    const missing = [...roster.keys()].filter(key => !mapped.has(key));
    requireSource(missing.length === 0, 'missing provider subjects for ' + missing.join(', ') + '.');
    entries.sort((a, b) => a.identityKey < b.identityKey ? -1 : a.identityKey > b.identityKey ? 1 : 0);
    const payload = {version: 1, entries: Object.freeze(entries)};
    return Object.freeze({...payload, digest: digest(payload)});
}
