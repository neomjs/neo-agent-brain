import {buildSubjectFamilyProjection, familyAt, familiesDuring}    from '../../graph/identityFamilyProjection.mjs';
import {validateFoundingFamilySeed}                                from '../../graph/identityFoundingSeed.mjs';
import {stringifyCanonicalJson}                                    from '../shared/canonicalJson.mjs';
import {isIdentityPublicationFamily, isIdentityPublicationSubject} from '../shared/identityPublicationOperation.mjs';
import {disclosedFamiliesOf}                                       from './disclosedModelFamilies.mjs';

/**
 * @module ai/services/graph/admittedFamilyResolution
 * @summary Resolves review families from one already-qualified protected source observation.
 * The caller owns transport/viewer/plane proof and acquires one snapshot per decision.
 * This pure adapter performs no I/O, imports no roster and grants no publication authority.
 */

const MEMBER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** @summary Converts source timestamps without coercing absent values into the epoch. */
function timestamp(value) {
    const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) :
        value instanceof Date ? value.getTime() : NaN;
    return Number.isSafeInteger(time) && time >= 0 && !Object.is(time, -0) && Number.isFinite(new Date(time).getTime()) ? time : null;
}

/** @summary Freezes derived output only; inputs are detached before projection. */
function freeze(value) {
    if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
    return value;
}

/**
 * @summary Retains a provider User's exact decimal identity without borrowing a node ID or login.
 * @param {Object|null} actor Original GraphQL Actor or an already-normalized actor.
 * @returns {Object} {login, __typename, databaseId}; only User carries an exact positive decimal ID.
 */
export function normalizeFamilyActor(actor) {
    const type = typeof actor?.__typename === 'string' ? actor.__typename : null;
    const raw  = actor?.databaseId;
    const id   = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? String(raw) :
        typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? raw : null;
    return Object.freeze({login: typeof actor?.login === 'string' && actor.login ? actor.login : null,
        __typename: type, databaseId: type === 'User' ? id : null});
}

/**
 * @summary Parses only an anchored explicit identity key; social names and aliases grant no binding.
 * @param {String} body Original PR body.
 * @returns {String|null} One literal @key, or null for absent/ambiguous declarations.
 */
export function parseBoundSelfIdKey(body) {
    if (typeof body !== 'string') return null;
    const keys = new Set();
    for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('Authored by ')) continue;
        for (const match of line.matchAll(/(?:\s|\()(@[A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[\s),;])/g)) keys.add(match[1]);
    }
    return keys.size === 1 ? [...keys][0] : null;
}

/**
 * @summary Creates one detached decision resolver from the registered client's qualified observation.
 * @param {Object} options
 * @param {Object} options.source Registered client's qualified source result, not caller-supplied authority.
 * @param {String} options.providerBaseUrl GitHub acquisition owner's exact REST API base.
 * @param {Date|String|Number} options.observedAt Decision time; history is not projected beyond this observation.
 * @returns {Object} Actor/review classifiers, budget grouping and the cross-family verdict.
 */
export function createAdmittedFamilyResolver({source, providerBaseUrl, observedAt} = {}) {
    const observationTime = timestamp(observedAt), projections = new Map(), identityKeys = new Map();
    let   metadata        = {sourceState: 'unavailable', code: source?.code ?? 'family-source-unavailable',
        revision: null, foundingRevision: null, foundingDigest: null};

    if (source?.state === 'available') {
        try {
            const snapshot = JSON.parse(stringifyCanonicalJson(source.snapshot));
            if (observationTime === null || !isIdentityPublicationSubject({authProvider: 'github', providerBaseUrl, providerUserId: '1'})) {
                throw new Error('Invalid decision context.');
            }
            if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
                timestamp(snapshot.baselineSince) === null || snapshot.foundingRevision !== 1 ||
                !validateFoundingFamilySeed(snapshot.founding) || !Array.isArray(snapshot.subjects) ||
                snapshot.counts?.subjects !== snapshot.subjects.length) throw new Error('Invalid snapshot.');
            for (const entry of snapshot.subjects) {
                if (!isIdentityPublicationSubject(entry.subject) || entry.source?.revision !== snapshot.revision ||
                    entry.source.baselineSince !== snapshot.baselineSince) throw new Error('Mixed observation.');
                const key        = stringifyCanonicalJson(entry.subject);
                const projection = buildSubjectFamilyProjection({subject: entry.subject, source: entry.source, founding: snapshot.founding});
                if (projections.has(key) || !projection.valid) throw new Error('Invalid subject history.');
                projections.set(key, projection);
            }
            for (const entry of snapshot.founding.entries) {
                const key = stringifyCanonicalJson(entry.subject);
                if (!projections.has(key)) throw new Error('Missing founding subject.');
                identityKeys.set(entry.identityKey, key);
            }
            metadata = {sourceState: 'available', code: null, revision: snapshot.revision,
                foundingRevision: snapshot.foundingRevision, foundingDigest: snapshot.founding.digest};
        } catch {
            projections.clear(); identityKeys.clear();
            metadata = {...metadata, code: 'family-snapshot-invalid'};
        }
    }

    /** @summary Selects a provider-stable subject; mutable login and seat spelling never select history. */
    const projectionFor = actor => {
        if (metadata.sourceState !== 'available') return null;
        const normalized = normalizeFamilyActor(actor);
        if (!normalized.databaseId) return null;
        return projections.get(stringifyCanonicalJson({authProvider: 'github', providerBaseUrl, providerUserId: normalized.databaseId})) ?? null;
    };

    /** @summary Classifies one actor at a witnessed instant no later than this observation. */
    const classifyActor = (actor, at = observationTime) => {
        const normalized = normalizeFamilyActor(actor), time = timestamp(at);
        let   resolved   = {state: 'unavailable', family: null}, code = metadata.code;
        if (metadata.sourceState === 'available') {
            if (!normalized.databaseId) code = 'family-actor-unbound';
            else if (time === null || time > observationTime) code = 'family-time-unavailable';
            else {
                const projection = projectionFor(normalized);
                resolved = projection ? familyAt(projection, time) : {state: 'membership-unknown', family: null};
                code = resolved.state === 'classified' ? null : 'family-' + resolved.state;
            }
        }
        return freeze({...metadata, ...normalized, ...resolved, classified: resolved.state === 'classified', code});
    };

    /** @summary Charges a submitted review at its original submittedAt, never at the current family. */
    const classifyReviewer = review => classifyActor(review?.author, timestamp(review?.submittedAt));

    /** @summary Groups exactly the reviews the budget owner selected, retaining every unclassified row. */
    const groupReviews = (reviews = []) => {
        const byFamily = Object.create(null), unclassified = [];
        if (!Array.isArray(reviews)) {
            return freeze({...metadata, code: 'review-history-unavailable', byFamily,
                unclassified: [{login: null, state: 'unavailable', code: 'review-history-unavailable'}]});
        }
        for (const review of reviews) {
            const result = classifyReviewer(review);
            if (result.classified) byFamily[result.family] = (byFamily[result.family] ?? 0) + 1;
            else unclassified.push({login: result.login, state: result.state, code: result.code});
        }
        return freeze({...metadata, byFamily, unclassified});
    };

    /** @summary Resolves author interval union and historical approval families from this single source. */
    const resolveVerdict = (pr = {}) => {
        if (!pr || typeof pr !== 'object') pr = {};
        const opener         = normalizeFamilyActor(pr.author), openerProjection = projectionFor(opener);
        const selfId         = Object.hasOwn(pr, 'selfIdIdentityKey') ? pr.selfIdIdentityKey : parseBoundSelfIdKey(pr.body);
        const selfProjection = typeof selfId === 'string' && /^@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(selfId)
            ? projections.get(identityKeys.get(selfId)) : null;
        const outside = !openerProjection && !selfProjection && typeof pr.authorAssociation === 'string' &&
            !MEMBER_ASSOCIATIONS.has(pr.authorAssociation);
        const result = {...metadata, qualified: false, authorFamily: null, authorFamilies: [], outside,
            authorLogin          : selfProjection ? selfId.replace(/^@/, '') : opener.login,
            disclosureTruncated  : outside && Boolean(pr.disclosureTruncated), approvingFamilies: [],
            unclassifiedApprovers: [], approvalsTruncated: Boolean(pr.approvalsTruncated), crossFamily: null};
        const refuse = code => freeze({...result, code});
        if (metadata.sourceState !== 'available') return freeze(result);
        if (!opener.databaseId) return refuse('family-actor-unbound');
        const createdAt = timestamp(pr.createdAt);
        if (createdAt === null || createdAt > observationTime) return refuse('author-family-unclassified');

        if (outside) {
            const disclosed = pr.disclosedFamilies ?? disclosedFamiliesOf(pr);
            if (!Array.isArray(disclosed) || [...disclosed].some(family => !isIdentityPublicationFamily(family))) {
                return refuse('author-disclosure-unavailable');
            }
            result.authorFamilies = [...new Set(disclosed)].sort();
        } else {
            if (!openerProjection) return refuse('author-family-unclassified');
            const authors  = new Set([openerProjection, ...(selfProjection ? [selfProjection] : [])]);
            const families = new Set();
            for (const projection of authors) {
                const interval = familiesDuring(projection, createdAt, observationTime);
                if (interval.state !== 'classified') return refuse('author-family-unclassified');
                interval.families.forEach(family => families.add(family));
            }
            result.authorFamilies = [...families].sort();
        }
        result.authorFamily = result.authorFamilies.join(', ') || null;
        if (!Array.isArray(pr.reviews) || pr.reviews.some(review =>
            !review || !['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))) {
            return refuse('approval-history-unavailable');
        }
        const approvals = pr.reviews.filter(review => review?.state === 'APPROVED')
            .map(classifyReviewer);
        if (approvals.length === 0) {
            return result.approvalsTruncated ? refuse('approval-history-unavailable') :
                freeze({...result, qualified: true, code: null, crossFamily: false});
        }
        result.approvingFamilies = [...new Set(approvals.filter(review => review.classified).map(review => review.family))].sort();
        result.unclassifiedApprovers = approvals.filter(review => !review.classified).map(review => review.login).filter(Boolean);
        if (!result.approvingFamilies.length) return refuse('approval-family-unclassified');
        const crossFamily = result.authorFamilies.length ? result.approvingFamilies.some(family => !result.authorFamilies.includes(family)) : null;
        if (crossFamily === false && result.approvalsTruncated) return refuse('approval-history-unavailable');
        if (crossFamily !== false && result.disclosureTruncated) return refuse('author-disclosure-unavailable');
        return freeze({...result, qualified: true, code: null, crossFamily});
    };
    return Object.freeze({...metadata, classifyActor, classifyReviewer, groupReviews, resolveVerdict});
}
