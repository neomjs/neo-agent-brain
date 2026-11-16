import Base                                                                                         from 'neo.mjs/src/core/Base.mjs';
import {createPlaneMailboxClient}                                                                   from '../fleet/planeMailboxClient.mjs';
import {normalizeAgentIdentity, normalizeExpectedPlaneTarget, normalizeSecureMcpEndpoint}           from '../fleet/mcpWireParsing.mjs';
import {stringifyCanonicalJson}                                                                     from './canonicalJson.mjs';
import {familyMembershipKey, familySubjectStateKey}                                                 from './identityPublicationKeys.mjs';
import {IDENTITY_PUBLICATION_LIMITS, isIdentityPublicationBinding, isIdentityPublicationIdentifier} from './identityPublicationOperation.mjs';
import {buildFamilyProjection}                                                                      from '../../graph/identityFamilyProjection.mjs';
import {validateFoundingFamilySeed}                                                                 from '../../graph/identityFoundingSeed.mjs';

/**
 * @module ai/services/shared/identityPublicationClient
 * @summary A read-only admitted-history client with explicit credential, viewer and remote-target custody.
 * The reused planeMailboxClient is a direct MC wire client, not a call to a Fleet service. It owns
 * session correlation, single-flight recovery, 404-only replay and terminal teardown. This adapter
 * requires both session proofs and validates every complete returned snapshot; it caches no history.
 * The production Server owns this Neo instance and its close barrier; each read obtains a fresh snapshot.
 */

/** @summary Checks a closed plain JSON record after canonical serialization has rejected exotic values. */
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** @summary Validates canonical counters without coercion. */
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
/** @summary Requires a representable nonnegative Date boundary rather than merely a safe counter. */
const time = value => integer(value) && Number.isFinite(new Date(value).getTime());
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
    'lineage-reservation-conflict', 'lineage-rotation-required', 'lineage-key-conflict', 'lineage-missing',
    'publication-boot-unavailable', 'founding-source-conflict', 'founding-source-unavailable',
    'founding-history-unreconciled', 'founding-input-invalid']);

/**
 * @summary Validates one complete founding-and-admitted observation against an independently held target.
 * Authority/completeness comes from the proven source; local validation cannot confer it on a caller's
 * object. The admission revision and the founding digest/revision/provenance bind their distinct sources;
 * physical coherence belongs to the one MC read. No local checksum claims source authority.
 * @param {Object} value Remote snapshot.
 * @param {Object} expectedTarget Independently declared planeId/dataRoot.
 * @returns {Object} Detached frozen snapshot or an explicit invalid result.
 */
export function validateIdentityPublicationSnapshot(value, expectedTarget) {
    try {
        const canonical = stringifyCanonicalJson(value), target = normalizeExpectedPlaneTarget(expectedTarget);
        if (!target || !exact(value, ['version', 'target', 'revision', 'founding', 'foundingRevision', 'foundingProvenance', 'baselineSince', 'counts', 'subjects']) || value.version !== 1 ||
            !exact(value.target, ['planeId', 'dataRoot']) || !integer(value.revision) || value.revision < 1 ||
            !time(value.baselineSince) || !Array.isArray(value.subjects) ||
            !exact(value.counts, ['subjects', 'admittedSubjects', 'memberships', 'declarations', 'corrections']) ||
            !Object.values(value.counts).every(integer)) throw new Error('Malformed snapshot.');
        if (value.target.planeId !== target.planeId || value.target.dataRoot !== target.dataRoot) {
            return {valid: false, code: 'family-snapshot-target-mismatch'};
        }
        const provenance = value.foundingProvenance;
        if (!validateFoundingFamilySeed(value.founding) || value.foundingRevision !== 1 ||
            !exact(provenance, ['sourceRevision', 'installedAt', 'issuer', 'lineageHead']) ||
            typeof provenance.sourceRevision !== 'string' || !provenance.sourceRevision.trim() || !time(provenance.installedAt) ||
            !isIdentityPublicationIdentifier(provenance.issuer) || typeof provenance.lineageHead !== 'string' ||
            !/^identity-family-lineage-head-[a-f0-9]{64}$/.test(provenance.lineageHead)) throw new Error('Malformed founding source.');
        const foundingSubjects = new Set(value.founding.entries.map(entry => familySubjectStateKey({planeId: target.planeId, subject: entry.subject})));
        const subjects         = new Set(), bindings = new Set(), activeSeats = new Set(), admissions = new Set(), revisions = new Set();
        const activeChanges    = new Map();
        let   operationCount   = 1, declarationCount = 0, correctionCount = 0, admittedSubjectCount = 0;
        for (const item of value.subjects) {
            if (!exact(item, ['subject', 'membershipRevision', 'admissionRevision', 'bindings', 'source']) ||
                !exact(item.subject, ['authProvider', 'providerBaseUrl', 'providerUserId']) ||
                !integer(item.membershipRevision) || item.membershipRevision > value.revision ||
                !integer(item.admissionRevision) || item.admissionRevision > value.revision ||
                !Array.isArray(item.bindings) || !exact(item.source, ['baselineSince', 'revision', 'memberships', 'declarations', 'corrections']) ||
                item.source.revision !== value.revision ||
                item.source.baselineSince !== value.baselineSince || !buildFamilyProjection(item.source).valid ||
                item.source.declarations.length + item.source.corrections.length !== item.admissionRevision) throw new Error('Malformed subject.');
            const subjectKey = familySubjectStateKey({planeId: target.planeId, subject: item.subject});
            if (subjects.has(subjectKey)) throw new Error('Repeated subject.');
            subjects.add(subjectKey);
            if (item.membershipRevision === 0) {
                if (!foundingSubjects.has(subjectKey) || item.bindings.length || item.admissionRevision !== 0 ||
                    item.source.memberships.length || item.source.declarations.length || item.source.corrections.length) {
                    throw new Error('Malformed founding-only subject.');
                }
            } else {
                if (!item.bindings.length) throw new Error('Missing admitted bindings.');
                admittedSubjectCount++;
            }
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
        if ([...foundingSubjects].some(subject => !subjects.has(subject)) || admittedSubjectCount !== value.counts.admittedSubjects ||
            operationCount !== value.revision || subjects.size !== value.counts.subjects || bindings.size !== value.counts.memberships ||
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
 * @summary Owns one explicitly bound, read-only Memory Core connection and its terminal close barrier.
 * Construction is passive. connect() proves the bootstrap binding; each read obtains one fresh physical snapshot.
 * @class Neo.ai.services.shared.IdentityPublicationClient
 * @extends Neo.core.Base
 */
class IdentityPublicationClient extends Base {
    static config = {
        /** @member {String} className @protected */
        className: 'Neo.ai.services.shared.IdentityPublicationClient',
        /** @member {String|null} baseUrl Explicit Memory Core endpoint. */
        baseUrl: null,
        /** @member {String|null} credential Caller-owned remote MC bearer, never a forge-token fallback. */
        credential: null,
        /** @member {String|null} expectedIdentity Independently authenticated bootstrap viewer. */
        expectedIdentity: null,
        /** @member {Object|null} expectedTarget Independently bound planeId/dataRoot. */
        expectedTarget: null,
        /** @member {Function|null} fetchImpl Explicit transport test seam. */
        fetchImpl: null,
        /** @member {Function|null} createSession Explicit session test seam. */
        createSession: null,
        /** @member {String[]} allowPlainHttpHosts Deployment-declared confidential endpoints. */
        allowPlainHttpHosts: []
    }

    /** @member {Object|null} planeClient Owned direct MC transport. @private */
    planeClient = null;
    /** @member {Promise|null} initialization Shared initial proof. @private */
    initialization = null;
    /** @member {Promise|null} closing Terminal resource barrier. @private */
    closing = null;
    /** @member {Boolean} closed Prevents reacquisition after disposal. @private */
    closed = false;
    /** @member {Object} sourceState Named connection state; never a retained history snapshot. */
    sourceState = unavailable('family-source-uninitialized');

    /** @summary Validates bootstrap inputs before allocating the passive transport. @param {Object} config */
    construct(config = {}) {
        const identity = normalizeAgentIdentity(config.expectedIdentity), target = normalizeExpectedPlaneTarget(config.expectedTarget),
            endpoint   = normalizeSecureMcpEndpoint(config.baseUrl, {allowPlainHttpHosts: config.allowPlainHttpHosts});
        if (!identity || !target || !endpoint || typeof config.credential !== 'string' || !config.credential || config.credential.trim() !== config.credential) {
            throw Object.assign(new Error('Family source requires an explicit credential, authenticated viewer and remote target.'),
                {code: 'family-source-configuration-unavailable'});
        }
        super.construct({...config, baseUrl: endpoint, expectedIdentity: identity, expectedTarget: target});
        this.planeClient = createPlaneMailboxClient({baseUrl: this.baseUrl, credential: this.credential,
            fetchImpl: this.fetchImpl, createSession: this.createSession, allowPlainHttpHosts: this.allowPlainHttpHosts});
    }

    /** @summary Proves the explicit identity and target without reading or caching family history. @returns {Promise<Object>} */
    async connect() {
        if (this.closed || this.isDestroying || this.isDestroyed) return unavailable('family-source-closed');
        try {
            this.initialization ??= this.planeClient.init({expectedIdentity: this.expectedIdentity, expectedTarget: this.expectedTarget});
            const result = await this.initialization;
            if (this.closed || this.isDestroying || this.isDestroyed) return unavailable('family-source-closed');
            if (!result.ok) {
                this.initialization = null;
                return this.sourceState = unavailable(result.blockerCode ?? 'family-source-unavailable');
            }
            return this.sourceState = Object.freeze({state: 'bound'});
        } catch {
            if (this.closed || this.isDestroying || this.isDestroyed) return unavailable('family-source-closed');
            this.initialization = null;
            return this.sourceState = unavailable('family-source-unavailable');
        }
    }

    /** @summary Reads one complete committed snapshot; unread or malformed source never becomes empty success. @returns {Promise<Object>} */
    async readSnapshot() {
        const state = await this.connect();
        if (state.state !== 'bound') return state;
        try {
            const result = await this.planeClient.callTool('get_identity_publication_snapshot', {});
            if (this.closed || this.isDestroying || this.isDestroyed) return unavailable('family-source-closed');
            if (result?.state !== 'available') return unavailable(result?.state === 'unavailable' && SOURCE_REFUSALS.has(result.code)
                ? result.code : 'family-source-unavailable');
            const checked = validateIdentityPublicationSnapshot(result.snapshot, this.expectedTarget);
            return checked.valid ? Object.freeze({state: 'available', snapshot: checked.snapshot}) : unavailable(checked.code);
        } catch (error) {
            return unavailable(this.closed || this.isDestroying || this.isDestroyed ? 'family-source-closed' :
                ['viewer-binding-unavailable', 'plane-binding-unavailable'].find(code =>
                    error?.code === code || error?.planeBlockerCode === code) ?? 'family-source-unavailable');
        }
    }

    /** @summary Fences new reads and drains initial proof and transport teardown exactly once. @returns {Promise<void>} */
    close() {
        this.closed = true;
        this.sourceState = unavailable('family-source-closed');
        if (!this.closing) {
            const client = this.planeClient, initialization = this.initialization, stopping = client?.close();
            this.closing = (async () => {
                await Promise.allSettled([stopping, initialization]);
                // init may still cross its initial close await; retire that late epoch too.
                await client?.close();
            })();
        }
        return this.closing;
    }

    /** @summary Retires the owned connection when the Neo owner is destroyed. @param {...*} args */
    destroy(...args) {
        this.close().catch(() => {});
        super.destroy(...args);
    }
}

const IdentityPublicationClientClass = Neo.setupClass(IdentityPublicationClient);
export default IdentityPublicationClientClass;

/** @summary Compatibility constructor; lifecycle and resources belong to the returned Neo instance. @param {Object} options @returns {Object} */
export function createIdentityPublicationClient(options) {
    return Neo.create(IdentityPublicationClientClass, options);
}
