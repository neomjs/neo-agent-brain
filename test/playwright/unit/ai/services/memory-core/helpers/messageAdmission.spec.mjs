import {test, expect} from '@playwright/test';
import {
    admissionWhere,
    canReadMessage
} from '../../../../../../../ai/services/memory-core/helpers/messageAdmission.mjs';
import {normalizeMailboxIdentityForComparison as canonical} from '../../../../../../../ai/services/memory-core/helpers/mailboxReadStateClassifier.mjs';
import {toMessageEmbedRecord} from '../../../../../../../ai/services/memory-core/helpers/messageWalStore.mjs';

const PEOPLE = ['@alice', '@bob', '@carol', '@dave', '@erin'];

/**
 * @summary Spells one canonical identity the ways legacy storage did.
 * @param {String} identity Canonical `@` identity.
 * @param {Function} random Seeded random source.
 * @returns {String}
 */
function spell(identity, random) {
    const bare = identity.slice(1);
    return [identity, bare, `AGENT:${identity}`, `AGENT:${bare}`, `@${identity}`][Math.floor(random() * 5)]
}

/**
 * @summary A small deterministic PRNG, so a failing case reproduces.
 * @param {Number} seed
 * @returns {Function}
 */
function seeded(seed) {
    return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
}

/**
 * @summary Evaluates the subset of Chroma's `where` dialect that `admissionWhere` emits. A missing
 * key matches nothing, as in Chroma.
 * @param {Object} where
 * @param {Object} metadata
 * @returns {Boolean}
 */
function matches(where, metadata) {
    if (where.$or)  return where.$or.some(clause => matches(clause, metadata));
    if (where.$and) return where.$and.every(clause => matches(clause, metadata));

    return Object.entries(where).every(([key, condition]) => {
        if (!(key in metadata)) return false;

        const value = metadata[key];

        if (condition?.$in)       return condition.$in.includes(value);
        if (condition?.$contains) return Array.isArray(value) && value.includes(condition.$contains);

        return value === condition
    })
}

/**
 * @summary Generates one message as both of its forms: the graph facts `getMessage` reads and the
 * WAL record the embed drain maps.
 * @param {Number} index
 * @param {Function} random
 * @returns {{id: String, kind: String, record: Object, facts: Function}}
 */
function generateMessage(index, random) {
    const pick      = list => list[Math.floor(random() * list.length)],
          sender    = pick(PEOPLE),
          shape     = pick(['direct', 'direct', 'known', 'known-zero', 'legacy']),
          recipient = pick(PEOPLE),
          audience  = shape === 'known' ? PEOPLE.filter(() => random() < 0.4) : [],
          cohort    = shape === 'known' && audience.length === 0 ? 'known-zero' : shape,
          id        = `MESSAGE:${index}`,
          route     = shape === 'direct' ? spell(recipient, random) : 'AGENT:*',
          record    = {
              id,
              timestamp: 1_790_000_000_000 + index,
              message  : {id, type: 'MESSAGE', name: id, properties: {subject: `subject ${index}`, bodyText: `body ${index}`}},
              routing  : {
                  sentBy: spell(sender, random),
                  to    : route,
                  ...(shape === 'legacy' ? {} : {broadcastRecipients: shape === 'direct' ? [] : audience.map(person => spell(person, random))})
              }
          };

    // The graph side spells its edge targets independently of the WAL record, and reads them as
    // `getMessage` does: delivery and grant lookups compare canonical identities.
    const sentBy     = spell(sender, random),
          sentTo     = shape === 'direct' ? spell(recipient, random) : 'AGENT:*',
          deliveries = audience.map(person => spell(person, random));

    return {
        id,
        kind  : cohort,
        record,
        facts : (me, grants) => ({
            sentBy,
            sentTo        : [sentTo],
            deliveredToMe : deliveries.some(target => canonical(target) === me),
            hasDeliveries : deliveries.length > 0,
            canReadInboxOf: target => grants.has(canonical(target))
        })
    }
}

test.describe('Neo.ai.services.memory-core.helpers.messageAdmission', () => {
    test('admissionWhere admits exactly what canReadMessage admits, over a generated corpus (#1445)', () => {
        const random   = seeded(1445),
              messages = Array.from({length: 400}, (_, index) => generateMessage(index, random)),
              tally    = {};

        for (const viewer of PEOPLE) {
            const grants = new Set(PEOPLE.filter(person => person !== viewer && random() < 0.3)),
                  where  = admissionWhere(spell(viewer, random), [...grants].map(person => spell(person, random)));

            for (const message of messages) {
                const metadata = toMessageEmbedRecord(message.record, '2026-11-03').metadata,
                      expected = canReadMessage(spell(viewer, random), message.facts(viewer, grants)),
                      key      = `${message.kind}:${expected ? 'admitted' : 'refused'}`;

                expect(matches(where, metadata), `${message.id} for ${viewer} (${message.kind})`).toBe(expected);
                tally[key] = (tally[key] ?? 0) + 1
            }
        }

        // Every class is exercised on both sides of the line, except the ones open to everyone.
        for (const key of ['direct:admitted', 'direct:refused', 'known:admitted', 'known:refused', 'known-zero:admitted', 'legacy:admitted']) {
            expect(tally[key], key).toBeGreaterThan(0)
        }
        expect(tally['known-zero:refused']).toBeUndefined();
        expect(tally['legacy:refused']).toBeUndefined();
    });

    test('a grant opens a direct message to that inbox, never a broadcast delivered there (#1445)', () => {
        const grants   = new Set(['@bob']),
              calls    = [],
              asked    = target => (calls.push(target), grants.has(target)),
              toBob    = {sentBy: '@alice', sentTo: ['@bob'],    deliveredToMe: false, hasDeliveries: false, canReadInboxOf: asked},
              bobsCopy = {sentBy: '@alice', sentTo: ['AGENT:*'], deliveredToMe: false, hasDeliveries: true,  canReadInboxOf: asked};

        expect(canReadMessage('@dave', toBob)).toBe(true);
        expect(canReadMessage('@dave', bobsCopy)).toBe(false);
        expect(calls).toEqual(['@bob']);

        const where = admissionWhere('@dave', ['@bob']);
        expect(matches(where, {from: '@alice', to: '@bob', kind: 'direct'})).toBe(true);
        expect(matches(where, {from: '@alice', to: 'AGENT:*', kind: 'broadcast', cohort: 'known', recipientCount: 1, recipients: ['@bob']})).toBe(false);
    });

    test('admissionWhere omits the grant clause without grants, and drops self and broadcast grants (#1445)', () => {
        expect(JSON.stringify(admissionWhere('@dave'))).not.toContain('$in');
        expect(JSON.stringify(admissionWhere('dave', ['AGENT:@dave', 'AGENT:*']))).not.toContain('$in');
        expect(admissionWhere('AGENT:@dave', ['bob']).$or).toContainEqual({$and: [{kind: 'direct'}, {to: {$in: ['@bob']}}]});
    });
});
