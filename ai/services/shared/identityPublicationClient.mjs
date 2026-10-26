import {createPlaneMailboxClient}                                                                   from '../fleet/planeMailboxClient.mjs';
import {normalizeAgentIdentity, normalizeExpectedPlaneTarget}                                       from '../fleet/mcpWireParsing.mjs';
import {stringifyCanonicalJson}                                                                     from './canonicalJson.mjs';
import {familyMembershipKey, familySubjectStateKey}                                                 from './identityPublicationKeys.mjs';
import {IDENTITY_PUBLICATION_LIMITS, isIdentityPublicationBinding, isIdentityPublicationIdentifier} from './identityPublicationOperation.mjs';
import {buildFamilyProjection}                                                                      from '../../graph/identityFamilyProjection.mjs';

/**
 * @module ai/services/shared/identityPublicationClient
 * @summary A read-only admitted-history client with explicit credential, viewer and remote-target custody.
 * The reused planeMailboxClient is a direct MC wire client, not a call to a Fleet service. It owns
 * session correlation, single-flight recovery, 404-only replay and terminal teardown. This adapter
 * requires both session proofs and validates every complete returned snapshot; it caches no history.
 * Runtime bootstrap still owns declared configuration, roster composition and consumer integration.
 */

/** @summary Checks a closed plain JSON record after canonical serialization has rejected exotic values. */
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** @summary Validates canonical counters without coercion. */
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
/** @summary Freezes a detached snapshot, never a transport's shared payload. */
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
/** @summary Returns bounded source states without forwarding arbitrary remote diagnostics. */
const unavailable = code => Object.freeze({state: 'unavailable', code});
/** Source-owned refusal vocabulary; unrecognized remote text never becomes a diagnostic. */
const SOURCE_REFUSALS = new Set(['publication-graph-unavailable', 'publication-transaction-in-progress',
    'publication-not-provisioned', 'publication-trust-unavailable', 'publication-restore-fenced',
    'publication-history-unavailable', 'publication-lineage-unbound', 'membership-unknown',
    'lineage-reservation-conflict', 'lineage-rotation-required', 'lineage-key-conflict', 'lineage-missing']);

/**
 * @summary Validates the complete admitted-history wire shape against an independently held target.
 * Authority/completeness comes from the proven source; local validation cannot confer it on a caller's
 * object. Every subject's normalized arrays feed the existing temporal validator before acceptance.
 * @param {Object} value Remote snapshot.
 * @param {Object} expectedTarget Independently declared planeId/dataRoot.
 * @returns {Object} Detached frozen snapshot or an explicit invalid result.
 */
export function validateIdentityPublicationSnapshot(value, expectedTarget) {
    try {
        const canonical = stringifyCanonicalJson(value), target = normalizeExpectedPlaneTarget(expectedTarget);
        if (!target || !exact(value, ['version', 'target', 'revision', 'baselineSince', 'counts', 'subjects']) || value.version !== 1 ||
            !exact(value.target, ['planeId', 'dataRoot']) || !integer(value.revision) || value.revision < 1 ||
            !integer(value.baselineSince) || !Array.isArray(value.subjects) ||
            !exact(value.counts, ['subjects', 'memberships', 'declarations', 'corrections']) ||
            !Object.values(value.counts).every(integer)) throw new Error('Malformed snapshot.');
        if (value.target.planeId !== target.planeId || value.target.dataRoot !== target.dataRoot) {
            return {valid: false, code: 'family-snapshot-target-mismatch'};
        }
        const subjects       = new Set(), bindings = new Set(), activeSeats = new Set(), admissions = new Set(), revisions = new Set();
        const activeChanges  = new Map();
        let   operationCount = 1, declarationCount = 0, correctionCount = 0;
        for (const item of value.subjects) {
            if (!exact(item, ['subject', 'membershipRevision', 'admissionRevision', 'bindings', 'source']) ||
                !exact(item.subject, ['authProvider', 'providerBaseUrl', 'providerUserId']) ||
                !integer(item.membershipRevision) || item.membershipRevision < 1 || item.membershipRevision > value.revision ||
                !integer(item.admissionRevision) || item.admissionRevision > value.revision ||
                !Array.isArray(item.bindings) || !item.bindings.length || item.source?.revision !== value.revision ||
                item.source.baselineSince !== value.baselineSince || !buildFamilyProjection(item.source).valid ||
                item.source.declarations.length + item.source.corrections.length !== item.admissionRevision) throw new Error('Malformed subject.');
            const subjectKey = familySubjectStateKey({planeId: target.planeId, subject: item.subject});
            if (subjects.has(subjectKey)) throw new Error('Repeated subject.');
            subjects.add(subjectKey);
            declarationCount += item.source.declarations.length; correctionCount += item.source.corrections.length;
            const memberIds = new Set(item.source.memberships.map(member => member.bindingId));
            if (memberIds.size !== item.bindings.length) throw new Error('Incomplete bindings.');
            operationCount += item.membershipRevision + item.admissionRevision -
                (item.source.memberships.some(member => member.since === value.baselineSince) ? 1 : 0);
            for (const member of item.source.memberships) {
                activeChanges.set(member.since, (activeChanges.get(member.since) ?? 0) + 1);
                if (member.until !== null) activeChanges.set(member.until, (activeChanges.get(member.until) ?? 0) - 1);
            }
            for (const entry of item.bindings) {
                if (!exact(entry, ['bindingId', 'binding', 'currentSeatId']) || !isIdentityPublicationBinding(entry.binding) ||
                    !isIdentityPublicationIdentifier(entry.currentSeatId) || !memberIds.has(entry.bindingId) || bindings.has(entry.bindingId) ||
                    entry.bindingId !== familyMembershipKey({planeId: target.planeId, ...entry.binding}) ||
                    Object.keys(item.subject).some(key => item.subject[key] !== entry.binding.subject[key])) throw new Error('Foreign binding.');
                bindings.add(entry.bindingId);
                if (item.source.memberships.find(member => member.bindingId === entry.bindingId).until === null) {
                    if (activeSeats.has(entry.currentSeatId)) throw new Error('Repeated active seat.');
                    activeSeats.add(entry.currentSeatId);
                }
            }
            for (const admission of [...item.source.declarations, ...item.source.corrections]) {
                if (admission.revision <= 1 || admissions.has(admission.admissionId) || revisions.has(admission.revision)) {
                    throw new Error('Invalid admission revision.');
                }
                admissions.add(admission.admissionId); revisions.add(admission.revision);
            }
        }
        if (operationCount !== value.revision || subjects.size !== value.counts.subjects || bindings.size !== value.counts.memberships ||
            declarationCount !== value.counts.declarations || correctionCount !== value.counts.corrections) throw new Error('Inconsistent owner counters.');
        let activeCount = 0;
        for (const [, delta] of [...activeChanges].sort(([a], [b]) => a - b)) {
            activeCount += delta;
            if (activeCount < 0 || activeCount > IDENTITY_PUBLICATION_LIMITS.baselineBindings) throw new Error('Invalid active capacity.');
        }
        return {valid: true, snapshot: freeze(JSON.parse(canonical))};
    } catch {
        return {valid: false, code: 'family-snapshot-invalid'};
    }
}

/**
 * @summary Creates a passive, read-only MC client for one explicitly declared bootstrap binding.
 * An absent credential/target refuses before construction; no environment or local identity is a
 * fallback. The source owner supplies the authenticated expectedIdentity and independent remote
 * target. The snapshot tool is unavailable until MC's separately governed integration is installed.
 * @param {Object} options Explicit baseUrl, credential, expectedIdentity and expectedTarget.
 * @param {Function} [options.fetchImpl] Existing SDK transport test seam.
 * @param {Function} [options.createSession] Existing SDK session test seam.
 * @returns {Object} readSnapshot() and terminal close(), with no general tool or write method.
 */
export function createIdentityPublicationClient({baseUrl, credential, expectedIdentity, expectedTarget, fetchImpl = null,
    createSession = null, allowPlainHttpHosts = []} = {}) {
    const identity = normalizeAgentIdentity(expectedIdentity), target = normalizeExpectedPlaneTarget(expectedTarget);
    if (!identity || !target || typeof credential !== 'string' || !credential || credential.trim() !== credential) {
        throw Object.assign(new Error('Family source requires an explicit credential, authenticated viewer and remote target.'),
            {code: 'family-source-configuration-unavailable'});
    }
    const client         = createPlaneMailboxClient({baseUrl, credential, fetchImpl, createSession, allowPlainHttpHosts});
    let   initialization = null, closing = null, closed = false;
    return {
        /** @summary Reads one complete decision snapshot; source errors never become an empty success. */
        async readSnapshot() {
            if (closed) return unavailable('family-source-closed');
            try {
                initialization ??= client.init({expectedIdentity: identity, expectedTarget: target}).then(result => {
                    if (!result.ok) throw Object.assign(new Error('Family source binding unavailable.'),
                        {code: result.blockerCode ?? 'family-source-unavailable'});
                    return result;
                }).catch(error => { initialization = null; throw error; });
                await initialization;
                if (closed) return unavailable('family-source-closed');
                const result = await client.callTool('get_identity_publication_snapshot', {});
                if (closed) return unavailable('family-source-closed');
                if (result?.state !== 'available') return unavailable(result?.state === 'unavailable' && SOURCE_REFUSALS.has(result.code)
                    ? result.code : 'family-source-unavailable');
                const checked = validateIdentityPublicationSnapshot(result.snapshot, target);
                return checked.valid ? Object.freeze({state: 'available', snapshot: checked.snapshot}) : unavailable(checked.code);
            } catch (error) {
                return unavailable(closed ? 'family-source-closed' :
                    ['viewer-binding-unavailable', 'plane-binding-unavailable'].find(code =>
                        error?.code === code || error?.planeBlockerCode === code) ?? 'family-source-unavailable');
            }
        },
        /** @summary Prevents further reads and awaits the existing client's complete close barrier. */
        close() {
            closed = true;
            closing ??= (async () => {
                try { await initialization; } catch { /* failed proof owns its candidate cleanup */ }
                await client.close();
            })();
            return closing;
        }
    };
}
