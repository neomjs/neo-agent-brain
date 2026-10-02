import {CORPUS_GRAPH_ORIGIN} from './corpusProjectionContract.mjs';

/**
 * @module ai/services/graph/ticketReferences
 * @summary Resolves authored ticket references against the graph's declared implicit origin and
 * typed ticket nodes. Lookup is injected so mailbox projection and maintenance share one rule
 * without importing each other's runtime. Corpus-source Git coordinates never identify a ticket.
 */

/**
 * @summary Resolves one supported ticket reference, preserving its authored external spelling.
 * Foreign repositories are rejected before lookup. Missing, ambiguous and non-ticket targets stay
 * unresolved; a numeric tag concept is diagnostic evidence, never a ticket target.
 * @param {String} reference Authored owner/repo#N or #N reference.
 * @param {Function} getNode Synchronous id => {id, label|type} or null.
 * @param {Object} [options]
 * @param {Function} [options.onUnresolved] Receives one unresolved reason per reference.
 * @returns {{targetId: String, externalRef: String}|null}
 */
export function resolveTicketReference(reference, getNode, {onUnresolved} = {}) {
    const reject = reason => {
        onUnresolved && onUnresolved(reason);
        return null
    };
    const text = typeof reference === 'string' ? reference.trim() : '';
    const match = text.match(/^([^#]*)#(\d+)$/);

    if (!match) {
        if (/^\d+$/.test(text)) {
            try {
                const tag = getNode(text);
                if (tag?.id === text && nodeLabel(tag) === 'CONCEPT') return reject('conceptCollision')
            } catch {
                return reject('lookupFailed')
            }
        }
        return reject('invalidReference')
    }
    if (match[1] && match[1] !== CORPUS_GRAPH_ORIGIN) return reject('foreignRepository');

    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number <= 0) return reject('invalidReference');

    try {
        const matches = [];
        let conceptCollision = false;

        for (const [prefix, label] of [['issue-', 'ISSUE'], ['pr-', 'PULL_REQUEST']]) {
            const targetId = prefix + number;
            const node = getNode(targetId);

            if (node?.id === targetId && nodeLabel(node) === label) {
                matches.push(targetId)
            } else if (node?.id === targetId && nodeLabel(node) === 'CONCEPT') {
                conceptCollision = true
            }
        }
        if (matches.length > 1) return reject('ambiguousTicket');
        if (matches.length === 1) return {targetId: matches[0], externalRef: reference};

        const tag = getNode(String(number));
        conceptCollision ||= tag?.id === String(number) && nodeLabel(tag) === 'CONCEPT';
        return reject(conceptCollision ? 'conceptCollision' : 'notIngested')
    } catch {
        return reject('lookupFailed')
    }
}

/**
 * @summary Reads the label from the two plain projections supplied by graph and SQLite lookups.
 * @param {Object|null} node
 * @returns {String|undefined}
 * @private
 */
function nodeLabel(node) {
    return node?.label ?? node?.type
}
