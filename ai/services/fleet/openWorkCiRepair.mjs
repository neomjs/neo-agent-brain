import {createHash}             from 'node:crypto';
import {stringifyCanonicalJson} from '../shared/canonicalJson.mjs';

/**
 * @module ai/services/fleet/openWorkCiRepair
 * @summary Producer-side original CI evidence and maintainer-comment admission, without I/O or a clock.
 * Hashing stays on the producer-only reducer path. Fingerprints bind original latest failing facts;
 * message presentation is separate. Old authority is dormant while checks are unread.
 * A separate admitted touch preserves engagement, never repair authority. Comment bodies are not retained.
 */
const MEMBERS        = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const FAILING        = new Set(['ACTION_REQUIRED', 'CANCELLED', 'ERROR', 'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT']);
const CHECK_STATUSES = new Set(['COMPLETED', 'IN_PROGRESS', 'PENDING', 'QUEUED', 'REQUESTED', 'WAITING']);
const CONCLUSIONS    = new Set(['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'NEUTRAL', 'SKIPPED', 'STALE', 'STARTUP_FAILURE', 'SUCCESS', 'TIMED_OUT']);
const STATUS_STATES  = new Set(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']);
const MARKER         = 'neo-ci-repair-classification:';

/** @summary Requires an original nonempty string without normalizing identifiers. */
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
/** @summary Retains provider display names verbatim; message limits do not redefine evidence. */
const name = value => typeof value === 'string' && value.length > 0;
/** @summary Recognizes the fixed evidence/body hash representation. */
const key = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** @summary Matches the full original GitHub commit OID required at the wake boundary. */
const head = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
/** @summary Requires the canonical native identity returned by the existing resolver. */
const seat = value => typeof value === 'string' && /^@[A-Za-z0-9._-]{1,100}$/.test(value);
/** @summary Validates provider time while preserving its original representation. */
const dated = value => typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
/** @summary Checks closed JSON records; marker fields never supply author or source authority. */
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(name => Object.hasOwn(value, name));
/** @summary Domain-separates original evidence, body revisions and decision witnesses. */
const digest = (kind, value) => createHash('sha256').update('neo.open-work.ci-repair.' + kind + '.v1\0')
    .update(stringifyCanonicalJson(value)).digest('hex');
/** @summary Freezes only projected values owned by this module. */
function freeze(value) {
    if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
    return value;
}
/** @summary Detaches a returned witness without freezing a previous snapshot's input. */
const detached = value => value ? freeze(JSON.parse(stringifyCanonicalJson(value))) : null;

/** @summary Binds the provider, repository and PR independently of comment prose. */
function sourceOf(node, apiBase) {
    const repo = node?.repository?.nameWithOwner;
    if (!text(apiBase) || !text(node?.id) || !text(repo) || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) ||
        !Number.isSafeInteger(node.number) || node.number < 1 || !head(node.headRefOid)) return null;
    const api = new URL(apiBase);
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) return null;
    return {provider: 'github', apiBase, repo, prId: node.id, number: node.number};
}

/** @summary Accepts only the original HTTPS IssueComment URL for this provider and PR. */
function receiptUrl(value, source) {
    if (!text(value)) return null;
    try {
        const url    = new URL(value), api = new URL(source.apiBase);
        const origin = api.hostname === 'api.github.com' ? 'https://github.com' : api.origin;
        return url.protocol === 'https:' && !url.username && !url.password && !url.search && url.origin === origin &&
            url.pathname.toLowerCase() === ('/' + source.repo + '/pull/' + source.number).toLowerCase() &&
            /^#issuecomment-[1-9]\d*$/.test(url.hash) ? value : null;
    } catch {return null;}
}

/** @summary Retains original context facts, distinguishing explicit null from missing provider fields. */
function checkOf(value) {
    if (!text(value?.id)) return null;
    if (value.__typename === 'CheckRun') {
        const suite = value.checkSuite, app = suite?.app, workflow = suite?.workflowRun === null ? null : suite?.workflowRun?.workflow;
        if (!name(value.name) || !CHECK_STATUSES.has(value.status) || !text(app?.id) ||
            !(app.slug === null || text(app.slug)) || !(workflow === null || text(workflow?.id) && name(workflow?.name)) ||
            !(value.startedAt === null || dated(value.startedAt)) || !(value.completedAt === null || dated(value.completedAt)) ||
            (value.status === 'COMPLETED' ? !CONCLUSIONS.has(value.conclusion) : value.conclusion !== null || value.completedAt !== null) ||
            value.startedAt && value.completedAt && Date.parse(value.completedAt) < Date.parse(value.startedAt)) return null;
        return {kind: 'CheckRun', id: value.id, name: value.name, status: value.status, conclusion: value.conclusion,
            startedAt: value.startedAt, completedAt: value.completedAt, app: {id: app.id, slug: app.slug},
            workflow : workflow === null ? null : {id: workflow.id, name: workflow.name}};
    }
    if (value.__typename === 'StatusContext') {
        if (!name(value.context) || !STATUS_STATES.has(value.state) || !dated(value.createdAt) || !dated(value.updatedAt) ||
            Date.parse(value.updatedAt) < Date.parse(value.createdAt) || !(value.targetUrl === null || text(value.targetUrl))) return null;
        return {kind: 'StatusContext', id: value.id, context: value.context, state: value.state,
            createdAt: value.createdAt, updatedAt: value.updatedAt, targetUrl: value.targetUrl};
    }
    return null;
}

/** @summary A not-yet-started rerun supersedes an older failure; indistinguishable latest runs remain unknown. */
function latestOf(values) {
    if (values.length === 1) return values[0];
    const pending = values.filter(value => value.kind === 'CheckRun' && value.status !== 'COMPLETED' && value.startedAt === null);
    if (pending.length) return pending.length === 1 ? pending[0] : null;
    if (values.some(value => value.kind === 'CheckRun' && value.startedAt === null)) return null;
    const time   = value => Date.parse(value.kind === 'CheckRun' ? value.startedAt : value.updatedAt);
    const newest = Math.max(...values.map(time)), latest = values.filter(value => time(value) === newest);
    return latest.length === 1 ? latest[0] : null;
}

/** @summary Resolves a complete latest set, then fingerprints only failing facts and retains their original names. */
function evidenceOf(node, source) {
    const commit = node.commits?.nodes?.[0]?.commit, connection = commit?.statusCheckRollup?.contexts;
    if (commit?.oid !== node.headRefOid || !Array.isArray(connection?.nodes) || connection.nodes.length > 100 ||
        Object.keys(connection.nodes).length !== connection.nodes.length || connection.pageInfo?.hasNextPage !== false) return null;
    const facts = connection.nodes.map(checkOf), groups = new Map();
    if (facts.some(value => !value) || new Set(facts.map(value => value.id)).size !== facts.length) return null;
    for (const fact of facts) {
        const group = stringifyCanonicalJson(fact.kind === 'CheckRun'
            ? [fact.kind, fact.app.id, fact.workflow?.id ?? null, fact.name] : [fact.kind, fact.context]);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(fact);
    }
    const latest = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, values]) => latestOf(values));
    if (latest.some(value => !value)) return null;
    const failed = latest.filter(value => FAILING.has(value.conclusion ?? value.state));
    const names  = failed.map(value => value.name ?? value.context);
    return {head: node.headRefOid, key: digest('evidence', {source, head: node.headRefOid, failed}),
        failedChecks: [...new Set(names)].sort()};
}

/** @summary Reads one unindented marker outside fenced/quoted material; duplicate keys or markers refuse. */
function markerOf(body) {
    if (typeof body !== 'string' || body.split(MARKER).length !== 2) return null;
    let fence = null, htmlComment = false;
    for (const line of body.split(/\r?\n/)) {
        if (fence) {
            const close = /^ {0,3}([\x60~]+)\s*$/.exec(line)?.[1];
            if (close && close.length >= fence.length && [...close].every(char => char === fence[0])) fence = null;
            continue;
        }
        const opening = /^ {0,3}(\x60{3,}|~{3,})/.exec(line)?.[1];
        if (opening) {fence = opening; continue;}
        if (htmlComment) {if (line.includes('-->')) htmlComment = false; continue;}
        if (/^\s*>/.test(line)) continue;
        const found = /^<!-- neo-ci-repair-classification:v1 (\{.*\}) -->$/.exec(line);
        if (found) {
            try {
                const value = JSON.parse(found[1]);
                return exact(value, ['head', 'evidenceKey', 'kind']) && head(value.head) && key(value.evidenceKey) &&
                    ['mechanical', 'content'].includes(value.kind) && JSON.stringify(value) === found[1].replace(/\s/g, '') ? value : null;
            } catch {return null;}
        }
        if (line.includes('<!--') && !line.includes('-->')) htmlComment = true;
    }
    return null;
}

/** @summary Derives maintainer and receipt authority from original comment facts, never the marker payload. */
function decisionOf(comment, source, identities) {
    const marker     = markerOf(comment.body), author = comment.author;
    const maintainer = author?.__typename === 'User' && text(author.id) && text(author.login)
        ? identities?.byLogin?.(author.login) : null;
    const url = receiptUrl(comment.url, source);
    if (!marker || !url || !MEMBERS.has(comment.authorAssociation) || !seat(maintainer) ||
        !dated(comment.createdAt) || !dated(comment.updatedAt) || Date.parse(comment.updatedAt) < Date.parse(comment.createdAt)) return null;
    return {...marker, maintainer, receiptUrl: url, source: {...source},
        comment: {id: comment.id, createdAt: comment.createdAt, updatedAt: comment.updatedAt,
            author  : {id: author.id, kind: 'User', login: author.login}, association: comment.authorAssociation,
            bodyHash: digest('body', comment.body)}};
}

/** @summary Keeps a bounded original read footprint for edits/deletions without retaining any raw body. */
function commentsOf(node, source, identities) {
    const connection = node.comments, nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
    let   valid      = Array.isArray(connection?.nodes) && nodes.length <= 10 && Object.keys(nodes).length === nodes.length &&
        typeof connection.pageInfo?.hasPreviousPage === 'boolean' && connection.pageInfo?.hasNextPage !== true;
    const comments = nodes.slice(-10).map(comment => {
        const known = text(comment?.id) && dated(comment.createdAt) && dated(comment.updatedAt) &&
            Date.parse(comment.updatedAt) >= Date.parse(comment.createdAt) && typeof comment.body === 'string' && receiptUrl(comment.url, source);
        valid &&= Boolean(known);
        return {id: text(comment?.id) ? comment.id : null, createdAt: dated(comment?.createdAt) ? comment.createdAt : null,
            updatedAt: dated(comment?.updatedAt) ? comment.updatedAt : null,
            decision : known ? decisionOf(comment, source, identities) : null};
    });
    if (new Set(comments.map(comment => comment.id)).size !== comments.length) valid = false;
    return {coverage: !valid ? 'unavailable' : connection.pageInfo.hasPreviousPage ? 'partial' : 'complete', comments};
}

/** @summary Selects a unique latest edit; equal-time conflicting receipts remain unclassified. */
function newestDecision(values) {
    const unique = [...new Map(values.map(value => [stringifyCanonicalJson(value), value])).values()];
    if (!unique.length) return null;
    const newest = Math.max(...unique.map(value => Date.parse(value.comment.updatedAt)));
    const latest = unique.filter(value => Date.parse(value.comment.updatedAt) === newest);
    return latest.length === 1 ? latest[0] : null;
}

/** @summary Projects admitted engagement without carrying kind or evidence as continuing authority. */
function touchOf(value) {
    return {head: value.head, commentId: value.comment.id, maintainer: value.maintainer, receiptUrl: value.receiptUrl,
        source: {...value.source}, author: {...value.comment.author}};
}

/** @summary Checks the complete row-evidence shape without applying message display limits. */
function validEvidence(value) {
    return exact(value, ['head', 'key', 'failedChecks']) && head(value.head) && key(value.key) &&
        Array.isArray(value.failedChecks) && value.failedChecks.length <= 100 && value.failedChecks.every(name);
}

/**
 * @summary Normalizes original provider evidence and comments in the existing PR read.
 * @param {Object} node Original GraphQL PR node with current-head contexts and latest-ten comments.
 * @param {Object} identities Existing canonical byLogin resolver.
 * @param {Object} options Existing acquisition source, including apiBase.
 * @returns {Object} Evidence, admitted current classification and bounded private read metadata.
 */
export function normalizeCiRepair(node, identities, {apiBase = null} = {}) {
    try {
        const source = sourceOf(node, apiBase);
        if (!source) throw new Error();
        const evidence   = evidenceOf(node, source), observed = commentsOf(node, source, identities);
        const candidates = observed.coverage !== 'unavailable' && evidence?.failedChecks.length
            ? observed.comments.map(value => value.decision).filter(value =>
                value?.head === evidence.head && value.evidenceKey === evidence.key) : [];
        const classification = newestDecision(candidates);
        return freeze({ciRepairEvidence: evidence, ciRepairClassification: classification,
            ciRepairRead: {source, head: node.headRefOid, ...observed, touch: classification ? touchOf(classification) : null}});
    } catch {
        return {ciRepairEvidence: null, ciRepairClassification: null, ciRepairRead: null};
    }
}

/** @summary Rechecks the original witness's source and current canonical identity before inheritance. */
function eligibleWitness(value, read, identities) {
    if (!exact(value, ['head', 'evidenceKey', 'kind', 'maintainer', 'receiptUrl', 'source', 'comment']) ||
        value.head !== read.head || !key(value.evidenceKey) || !['mechanical', 'content'].includes(value.kind) ||
        !seat(value.maintainer) || stringifyCanonicalJson(value.source) !== stringifyCanonicalJson(read.source) ||
        !exact(value.comment, ['id', 'createdAt', 'updatedAt', 'author', 'association', 'bodyHash']) ||
        !text(value.comment.id) || !dated(value.comment.createdAt) || !dated(value.comment.updatedAt) ||
        Date.parse(value.comment.updatedAt) < Date.parse(value.comment.createdAt) || !key(value.comment.bodyHash) ||
        !MEMBERS.has(value.comment.association) || !exact(value.comment.author, ['id', 'kind', 'login']) ||
        value.comment.author.kind !== 'User' || !text(value.comment.author.id) || !text(value.comment.author.login) ||
        identities?.byLogin?.(value.comment.author.login) !== value.maintainer || !receiptUrl(value.receiptUrl, read.source)) return false;
    return true;
}

/**
 * @summary Joins a current row with its previously admitted witness without inventing source coverage.
 * A missing comment outside a proved suffix is not a withdrawal. Visible changes, complete-page
 * deletion, source/head/identity drift or changed complete evidence invalidate it. Unknown evidence
 * retains only the old witness, dormant; it never admits a new comment.
 * @param {Object} current Newly normalized row.
 * @param {Object|null} previous Previously retained row.
 * @param {Object} identities Existing canonical byLogin resolver, rechecked on inheritance.
 * @returns {Object|null} Detached admitted witness, or null.
 */
export function retainCiRepairClassification(current, previous, identities) {
    try {
        const read = current?.ciRepairRead, evidence = current?.ciRepairEvidence;
        if (!read || !head(read.head) || current.head !== read.head || evidence !== null && !validEvidence(evidence)) return null;
        const matches = value => eligibleWitness(value, read, identities) && evidence?.head === read.head &&
            evidence.failedChecks.length > 0 && value.evidenceKey === evidence.key;
        const fresh = read.coverage !== 'unavailable' && evidence
            ? read.comments.map(value => value.decision).filter(value => value && matches(value)) : [];
        let old = previous?.ciRepairClassification;
        if (!old || previous.head !== current.head || !eligibleWitness(old, read, identities) || evidence && !matches(old)) old = null;
        if (old) {
            const visible = read.comments.find(value => value.id === old.comment.id);
            if (visible) {
                if (!visible.decision || stringifyCanonicalJson(visible.decision) !== stringifyCanonicalJson(old)) old = null;
            } else if (read.coverage === 'complete' || read.coverage === 'partial' && read.comments.some(value =>
                dated(value.createdAt) && Date.parse(value.createdAt) < Date.parse(old.comment.createdAt))) {
                old = null;
            }
        }
        if (!evidence) {
            if (old && read.comments.some(value => value.decision && value.decision.head === old.head &&
                value.decision.evidenceKey === old.evidenceKey && value.decision.comment.id !== old.comment.id &&
                Date.parse(value.decision.comment.updatedAt) >= Date.parse(old.comment.updatedAt))) old = null;
            return detached(old);
        }
        return detached(newestDecision([...fresh, ...(old ? [old] : [])]));
    } catch {return null;}
}

/**
 * @summary Retains one admitted current-head engagement witness independently of repair authority.
 * Only active verified admission creates it. Unknown or changed evidence and marker withdrawal do
 * not erase past engagement; source/head or canonical identity changes do. Raw markers never create it.
 * @param {Object} current Newly normalized/joined row.
 * @param {Object|null} previous Previously retained row.
 * @param {Object} identities Existing canonical byLogin resolver.
 * @returns {Object|null} Detached engagement witness with no kind or evidenceKey.
 */
export function retainCiRepairTouch(current, previous, identities) {
    try {
        const read = current?.ciRepairRead, evidence = current?.ciRepairEvidence, decision = current?.ciRepairClassification;
        if (!read || !head(read.head) || read.head !== current.head) return null;
        if (validEvidence(evidence) && evidence.head === current.head && evidence.failedChecks.length &&
            decision && eligibleWitness(decision, read, identities) && decision.evidenceKey === evidence.key) {
            return detached(touchOf(decision));
        }
        const touch = previous?.ciRepairRead?.touch;
        if (!exact(touch, ['head', 'commentId', 'maintainer', 'receiptUrl', 'source', 'author']) ||
            previous.head !== current.head || touch.head !== current.head || !text(touch.commentId) || !seat(touch.maintainer) ||
            stringifyCanonicalJson(touch.source) !== stringifyCanonicalJson(read.source) ||
            !exact(touch.author, ['id', 'kind', 'login']) || touch.author.kind !== 'User' || !text(touch.author.id) ||
            !text(touch.author.login) || identities?.byLogin?.(touch.author.login) !== touch.maintainer ||
            !receiptUrl(touch.receiptUrl, read.source)) return null;
        return detached(touch);
    } catch {return null;}
}
