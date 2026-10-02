import {test, expect} from '@playwright/test';
import {resolveTicketReference} from '../../../../../../ai/services/graph/ticketReferences.mjs';
import {CORPUS_GRAPH_ORIGIN, CORPUS_PROJECTION_ORIGIN} from '../../../../../../ai/services/graph/corpusProjectionContract.mjs';

/** @summary Typed ticket resolution refuses namespace and label collisions while preserving authored references. */
test.describe('ticketReferences', () => {
    const node = (id, label) => ({id, label});
    const resolve = (reference, nodes) => {
        const reasons = [], calls = [];
        const result = resolveTicketReference(reference, id => { calls.push(id); return nodes[id] ?? null }, {onUnresolved: reason => reasons.push(reason)});
        return {result, reasons, calls}
    };

    test('the graph origin is one declaration for both coordinate forms', () => {
        expect(CORPUS_GRAPH_ORIGIN).toBe('neomjs/neo');
        expect(CORPUS_PROJECTION_ORIGIN).toBe('neo')
    });

    test('qualified issue and implicit PR references resolve, preserving authored strings', () => {
        const nodes = {'issue-7': node('issue-7', 'ISSUE'), 'pr-8': {id: 'pr-8', type: 'PULL_REQUEST'}};
        expect(resolve('neomjs/neo#7', nodes).result).toEqual({targetId: 'issue-7', externalRef: 'neomjs/neo#7'});
        expect(resolve('#8', nodes).result).toEqual({targetId: 'pr-8', externalRef: '#8'});
        expect(resolve(' #007 ', nodes).result).toEqual({targetId: 'issue-7', externalRef: ' #007 '})
    });

    test('a foreign repository never looks up a same-number local ticket', () => {
        const result = resolve('neomjs/neo-agent-brain#7', {'issue-7': node('issue-7', 'ISSUE')});
        expect(result).toEqual({result: null, reasons: ['foreignRepository'], calls: []})
    });

    test('numeric concepts and concepts occupying canonical ids are never tickets', () => {
        expect(resolve('#7', {'7': node('7', 'CONCEPT')}).reasons).toEqual(['conceptCollision']);
        expect(resolve('7', {'7': node('7', 'CONCEPT')}).reasons).toEqual(['conceptCollision']);
        expect(resolve('#7', {'issue-7': node('issue-7', 'CONCEPT')}).result).toBeNull()
    });

    test('non-ticket labels, wrong identities, missing and ambiguous tickets remain unresolved', () => {
        expect(resolve('#7', {'issue-7': node('issue-7', 'FILE')}).reasons).toEqual(['notIngested']);
        expect(resolve('#7', {'issue-7': node('issue-8', 'ISSUE')}).result).toBeNull();
        expect(resolve('#7', {}).reasons).toEqual(['notIngested']);
        expect(resolve('#7', {'issue-7': node('issue-7', 'ISSUE'), 'pr-7': node('pr-7', 'PULL_REQUEST')}).reasons).toEqual(['ambiguousTicket'])
    });

    test('invalid shapes and unsafe or zero numbers are rejected', () => {
        for (const reference of ['', 'issue-7', '#0', '#-1', '#9007199254740992', null]) {
            expect(resolve(reference, {}).reasons).toEqual(['invalidReference'])
        }
    });

    test('a failed lookup remains unresolved without changing mailbox delivery authority', () => {
        const reasons = [];
        expect(resolveTicketReference('#7', () => { throw new Error('lookup failed') }, {onUnresolved: reason => reasons.push(reason)})).toBeNull();
        expect(reasons).toEqual(['lookupFailed'])
    });
});
