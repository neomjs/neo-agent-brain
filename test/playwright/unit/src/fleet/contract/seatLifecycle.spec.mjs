import {test, expect}  from '@playwright/test';
import fs              from 'node:fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse}         from 'acorn';
import * as contract   from 'neo-agent-brain/fleet-contract';

const root    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const service = path.join(root, 'ai/services/fleet/FleetLifecycleService.mjs');

/**
 * @summary Collects every state word the lifecycle service writes into a seat record: the records it
 * `set`s on `this.processes`, what it `Object.assign`s onto a `record`, a `record.state` assignment, and
 * the result shapes it returns with an `id` and a `pid`. Other `state` keys (a wake route, a window
 * capture, a repository row) belong to other vocabularies and stay out.
 * @param {String} source Module source.
 * @returns {{word: String, line: Number}[]} One entry per literal, in source order.
 */
function seatStateWrites(source) {
    const
        ast   = parse(source, {ecmaVersion: 'latest', sourceType: 'module', locations: true}),
        found = new Map(),
        keyOf = property => property.key?.name ?? property.key?.value;

    const literalsIn = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'Literal' && typeof node.value === 'string') found.set(node.start, {word: node.value, line: node.loc.start.line});
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(literalsIn);
            else if (value && typeof value === 'object' && value.type) literalsIn(value);
        }
    };

    const stateOf = object => {
        if (object?.type !== 'ObjectExpression') return;
        const state = object.properties.find(property => property.type === 'Property' && keyOf(property) === 'state');
        literalsIn(state?.value);
    };

    const isMember = (node, objectName, name) => node?.type === 'MemberExpression' &&
        node.object?.type === 'Identifier' && node.object.name === objectName && node.property?.name === name;

    const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression') {
            const callee = node.callee;
            // this.processes.set(id, {...})
            if (callee?.type === 'MemberExpression' && callee.property?.name === 'set' &&
                callee.object?.type === 'MemberExpression' && callee.object.object?.type === 'ThisExpression' &&
                callee.object.property?.name === 'processes') stateOf(node.arguments[1]);
            // Object.assign(record, {...})
            if (isMember(callee, 'Object', 'assign') && node.arguments[0]?.type === 'Identifier' &&
                node.arguments[0].name === 'record') node.arguments.slice(1).forEach(stateOf);
        }
        // record.state = ...
        if (node.type === 'AssignmentExpression' && isMember(node.left, 'record', 'state')) literalsIn(node.right);
        // {id, state, pid, ...}: a status or start result
        if (node.type === 'ObjectExpression') {
            const keys = node.properties.filter(property => property.type === 'Property').map(keyOf);
            if (keys.includes('id') && keys.includes('pid')) stateOf(node);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object' && value.type) walk(value);
        }
    };

    walk(ast);
    return [...found.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry);
}

test.describe('seat lifecycle vocabulary', () => {
    test('the words are one frozen contract: what the Fleet writes, what it only reads, what a row falls back to', () => {
        expect(contract.SEAT_LIFECYCLE_STATES).toEqual(['running', 'stopping', 'stopped', 'failed', 'unavailable']);
        expect(contract.SEAT_LIFECYCLE_READ_ONLY_STATES).toEqual(['exited']);
        expect(contract.SEAT_LIFECYCLE_ROW_FALLBACK).toBe('unknown');
        expect(Object.isFrozen(contract.SEAT_LIFECYCLE_STATES)).toBe(true);
        expect(Object.isFrozen(contract.SEAT_LIFECYCLE_READ_ONLY_STATES)).toBe(true);

        const all = [...contract.SEAT_LIFECYCLE_STATES, ...contract.SEAT_LIFECYCLE_READ_ONLY_STATES, contract.SEAT_LIFECYCLE_ROW_FALLBACK];
        expect(new Set(all).size).toBe(all.length);
    });

    test('every state the lifecycle service writes into a seat record is a word the Fleet declares', () => {
        const found = seatStateWrites(fs.readFileSync(service, 'utf8'));

        // positive control: the service writes every declared word today, at more sites than words
        expect(new Set(found.map(({word}) => word))).toEqual(new Set(contract.SEAT_LIFECYCLE_STATES));
        expect(found.length).toBeGreaterThan(contract.SEAT_LIFECYCLE_STATES.length);

        for (const {word, line} of found) {
            expect(contract.SEAT_LIFECYCLE_STATES, `'${word}' written at line ${line}`).toContain(word);
        }
    });

    test('a planted word is found and refused: the scan reads the record writes, not every state key', () => {
        const found = seatStateWrites(`
            class Service {
                write(record, exited) {
                    this.processes.set('a', {id: 'a', state: 'exploded', pid: null});
                    Object.assign(record, {state: exited ? 'stopped' : 'failed'});
                    record.state         = 'stopping';
                    record.windowCapture = {state: 'recorded'};
                    this.routes.set('a', {state: 'ready'});
                    return {id: 'a', state: 'running', pid: 1}
                }
            }`);

        expect(found.map(({word}) => word)).toEqual(['exploded', 'stopped', 'failed', 'stopping', 'running']);
        expect(found.map(({word}) => contract.SEAT_LIFECYCLE_STATES.includes(word))).toEqual([false, true, true, true, true]);
    });
});
