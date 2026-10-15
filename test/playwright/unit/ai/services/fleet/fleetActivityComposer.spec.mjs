import {setup} from '../../../../setup.mjs';

const appName = 'FleetActivityComposerTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

/**
 * @summary The producer for the slot `FleetControlBridge` has consumed since it was written.
 *
 * Events merge trivially; SIGHT does not — and that asymmetry is the whole reason this module exists.
 * A degraded adapter contributes zero events, which is byte-identical to a healthy adapter on a quiet
 * fleet. The event list therefore cannot carry the difference, and the capability is the only place it
 * can survive. Every test below is aimed at that single claim: the composite never reports more sight
 * than it has.
 */
test.describe('fleetActivityComposer — composing two truths means composing two capabilities', () => {
    let createFleetActivityReadSource;

    const wired = (events = [], counts = []) => async () => ({
        capability: {source: 'fleet:a2a', state: 'wired', confidence: 'observed'},
        counts,
        events
    });

    const degraded = (source, reason) => async () => ({
        capability: {source, state: 'degraded', confidence: 'none', reason},
        events    : []
    });

    test.beforeAll(async () => {
        const mod = await import('../../../../../../ai/services/fleet/fleetActivityComposer.mjs');
        createFleetActivityReadSource = mod.createFleetActivityReadSource
    });

    test('both adapters wired → the composite may claim wired, and the feed merges newest-first', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : wired([{occurredAt: '2026-07-16T11:00:00.000Z', eventId: 'a2a-old'}]),
            readPrLaneSnapshot: wired([{occurredAt: '2026-07-16T12:00:00.000Z', eventId: 'pr-new'}])
        });

        const {capability, events} = await source.readActivitySnapshot();

        expect(capability.state).toBe('wired');
        expect(capability.confidence).toBe('observed');
        expect(capability.reason).toBeNull();
        // one feed, not two lists stapled together
        expect(events.map(event => event.eventId)).toEqual(['pr-new', 'a2a-old'])
    });

    test('each contributor\'s own capability survives the composition under `slots`, keyed by the slot the composer asked', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : wired([]),
            readPrLaneSnapshot: async () => ({
                capability: {source: 'fleet:pr-lane', state: 'wired', confidence: 'observed', capturedAt: '2026-07-16T12:00:00.000Z', producer: {observedAt: '2026-07-16T11:59:00.000Z', coverage: 'complete'}},
                events    : []
            })
        });

        const {capability} = await source.readActivitySnapshot();

        expect(Object.keys(capability.slots).sort()).toEqual(['a2a', 'pr-lane']);
        // what the slot observed is delivered as the slot said it, not re-stamped by this read
        expect(capability.slots['pr-lane']).toMatchObject({slot: 'pr-lane', state: 'wired', capturedAt: '2026-07-16T12:00:00.000Z', producer: {observedAt: '2026-07-16T11:59:00.000Z', coverage: 'complete'}});
        expect(capability.capturedAt).not.toBe('2026-07-16T12:00:00.000Z')
    });

    test('keeps only producer-complete source counts — never promotes a partial slot into a fleet total', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot: wired([], [{
                source    : 'memory-core:mailbox',
                scope     : 'total',
                value     : 2159,
                complete  : true,
                capturedAt: '2026-08-22T21:00:00.000Z'
            }, {
                source    : 'memory-core:mailbox',
                scope     : 'last24h',
                value     : 42,
                complete  : false,
                capturedAt: '2026-08-22T21:00:00.000Z'
            }]),
            readPrLaneSnapshot: wired([], [{scope: 'total', value: 999, complete: true, capturedAt: '2026-08-22T21:00:00.000Z'}])
        });

        const {counts} = await source.readActivitySnapshot();

        expect(counts).toEqual([{
            source    : 'memory-core:mailbox',
            scope     : 'total',
            value     : 2159,
            complete  : true,
            capturedAt: '2026-08-22T21:00:00.000Z'
        }])
    });

    test('drops missing identities and collapses repeated producer ids newest-first', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot: wired([
                {eventId: 'a2a:one', occurredAt: '2026-07-16T11:00:00.000Z'},
                {occurredAt: '2026-07-16T11:30:00.000Z'}
            ]),
            readPrLaneSnapshot: wired([
                {eventId: 'a2a:one', occurredAt: '2026-07-16T12:00:00.000Z'}
            ])
        });

        const {events} = await source.readActivitySnapshot();

        expect(events).toEqual([{eventId: 'a2a:one', occurredAt: '2026-07-16T12:00:00.000Z'}])
    });

    test('ONE blind adapter degrades the composite — a half-feed must not read as the whole fleet', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : wired([{occurredAt: '2026-07-16T11:00:00.000Z', eventId: 'a2a-1'}]),
            readPrLaneSnapshot: degraded('fleet:pr-lane', 'github unreachable')
        });

        const {capability, events} = await source.readActivitySnapshot();

        // The events look perfectly healthy — one real row, nothing obviously missing. That is exactly
        // why `wired` here would be a lie the caller could never detect.
        expect(events.map(event => event.eventId)).toEqual(['a2a-1']);

        expect(capability.state).toBe('degraded');
        expect(capability.confidence).toBe('none');
        // attributed by the composer-owned SLOT, not the adapter's self-reported source
        expect(capability.reason).toContain('pr-lane');
        expect(capability.reason).toContain('github unreachable')
    });

    test('BOTH blind → not-wired, not degraded — half a feed and none of it are different facts', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : degraded('fleet:a2a', 'mailbox unreadable'),
            readPrLaneSnapshot: degraded('fleet:pr-lane', 'github unreachable')
        });

        const {capability} = await source.readActivitySnapshot();

        expect(capability.state).toBe('not-wired');
        // BOTH slots are named: an operator debugging a dead feed must not fix one adapter and wonder
        // why nothing changed.
        expect(capability.reason).toContain('a2a');
        expect(capability.reason).toContain('pr-lane')
    });

    test('a wired composite with NO events says so — "nothing happened" is not "we could not look"', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : wired([]),
            readPrLaneSnapshot: wired([])
        });

        const {capability, events} = await source.readActivitySnapshot();

        // The AC that makes the whole module worth having: an empty list under a WIRED capability is a
        // quiet fleet; the same empty list under a degraded one is blindness. Identical events, and the
        // capability is the only thing that separates them.
        expect(events).toEqual([]);
        expect(capability.state).toBe('wired')
    });

    test('a THROWING adapter degrades rather than taking the snapshot down with it', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : async () => { throw new Error('mailbox exploded') },
            readPrLaneSnapshot: wired([{occurredAt: '2026-07-16T12:00:00.000Z', eventId: 'pr-1'}])
        });

        const {capability, events} = await source.readActivitySnapshot();

        expect(capability.state).toBe('degraded');
        expect(capability.reason).toContain('mailbox exploded');
        // the half that CAN be read still reaches the cockpit — degraded is not blank
        expect(events.map(event => event.eventId)).toEqual(['pr-1'])
    });

    test('the caller\'s limit bounds the MERGED feed, and reaches both adapters', async () => {
        const seen      = [];
        const recording = id => async params => {
            seen.push([id, params.limit]);
            return {capability: {source: id, state: 'wired', confidence: 'observed'}, events: [
                {occurredAt: '2026-07-16T12:00:00.000Z', eventId: `${id}-a`},
                {occurredAt: '2026-07-16T11:00:00.000Z', eventId: `${id}-b`}
            ]}
        };

        const source = createFleetActivityReadSource({
            readA2ASnapshot   : recording('a2a'),
            readPrLaneSnapshot: recording('pr')
        });

        const {events} = await source.readActivitySnapshot({limit: 3});

        // bounding only the merge would let each adapter read unboundedly and throw the surplus away
        expect(seen).toEqual([['a2a', 3], ['pr', 3]]);
        expect(events).toHaveLength(3)
    });

    test('a page offset reaches the readers normalized: anything but a positive integer reads the first page', async () => {
        const seen   = [];
        const reader = async params => {
            seen.push(params.offset);
            return {capability: {source: 'fleet:a2a', state: 'wired', confidence: 'observed'}, events: []}
        };

        const source = createFleetActivityReadSource({readA2ASnapshot: reader, readPrLaneSnapshot: wired()});

        for (const offset of [50, -5, 2.5, '50', null, undefined]) {
            await source.readActivitySnapshot({offset})
        }

        // the offset arrives over the wire like the limit, so a malformed one never reaches the mailbox
        expect(seen).toEqual([50, 0, 0, 0, 0, 0])
    });

    test('`slots` asks only the named lanes, and the capability speaks for those alone', async () => {
        const asked  = [];
        const reader = (id, state) => async () => {
            asked.push(id);
            return {
                capability: {source: id, state, confidence: state === 'wired' ? 'observed' : 'none', reason: state === 'wired' ? null : 'down'},
                events    : [{occurredAt: '2026-07-16T12:00:00.000Z', eventId: `${id}-a`}]
            }
        };

        const source  = createFleetActivityReadSource({readA2ASnapshot: reader('a2a', 'wired'), readPrLaneSnapshot: reader('pr', 'degraded')}),
              history = await source.readActivitySnapshot({offset: 50, slots: ['a2a']});

        // a mailbox page never asks the PR/lane reader, so neither its rows nor its blindness reach it
        expect(asked).toEqual(['a2a']);
        expect(history.capability.state).toBe('wired');
        expect(history.events.map(event => event.eventId)).toEqual(['a2a-a'])
    });

    test('a selection naming no known lane reads every lane, as a live read does', async () => {
        const asked  = [];
        const reader = id => async () => {
            asked.push(id);
            return {capability: {source: id, state: 'wired', confidence: 'observed'}, events: []}
        };

        const source = createFleetActivityReadSource({readA2ASnapshot: reader('a2a'), readPrLaneSnapshot: reader('pr')});

        for (const slots of [undefined, [], ['nope'], 'a2a']) {
            asked.length = 0;
            await source.readActivitySnapshot({slots});
            expect(asked, JSON.stringify(slots)).toEqual(['a2a', 'pr'])
        }
    });

    test('a SYNCHRONOUS throw is contained — Promise.resolve(read()) never sees it', async () => {
        // `Promise.resolve(read(params))` evaluates the call BEFORE the wrapper exists, so a sync throw
        // would escape the .catch and take the whole snapshot down. An async stub cannot surface that;
        // a real adapter validating its arguments throws exactly this way.
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : () => { throw new Error('sync validation failure') },
            readPrLaneSnapshot: wired([{occurredAt: '2026-07-16T12:00:00.000Z', eventId: 'pr-1'}])
        });

        const {capability, events} = await source.readActivitySnapshot();

        expect(capability.state).toBe('degraded');
        expect(capability.reason).toContain('sync validation failure');
        expect(events.map(event => event.eventId)).toEqual(['pr-1'])
    });

    test('failure attribution is by SLOT, not by the adapter\'s self-report', async () => {
        // A broken contributor claiming another's source would send the operator to a healthy adapter.
        // The reason line is the one surface that exists to be trusted when things break; it must not
        // be forgeable by the thing that broke.
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : async () => ({capability: {source: 'fleet:pr-lane', state: 'degraded', confidence: 'none', reason: 'mislabelled'}, events: []}),
            readPrLaneSnapshot: wired([])
        });

        const {capability} = await source.readActivitySnapshot();

        // the A2A slot failed, and the reason says so despite the adapter naming pr-lane
        expect(capability.reason).toContain('a2a');
        expect(capability.reason).not.toMatch(/^pr-lane/)
    });

    test('a failure reason is capped and single-line — it is rendered to an operator', async () => {
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : async () => { throw new Error('x'.repeat(5000) + '\nsecond line') },
            readPrLaneSnapshot: wired([])
        });

        const {capability} = await source.readActivitySnapshot();

        // unbounded: an Error message has no length contract, and this travels into the projection
        expect(capability.reason.length).toBeLessThan(300);
        expect(capability.reason).not.toContain('\n')
    });

    test('NO credential family reaches the composed reason — the whole matrix, not one branch', async () => {
        // @neo-gpt's controlled production probe of the first fix, which I had shipped as "credential
        // redaction" on the strength of a single Bearer witness:
        //
        //   ghp_A…        leaked=true  redacted=true    ← the deceptive row
        //   github_pat_A… leaked=true  redacted=false
        //   glpat-A…      leaked=true  redacted=false
        //   Bearer …      leaked=false redacted=true    ← the only branch I tested
        //
        // The first row is the whole lesson: the replacement was DERIVED from the match
        // (`match.split(/[:=\s]/)[0]`), which assumes every match is `key: value`. A bare token has no
        // delimiter, so the entire secret became the "label" and was printed beside the word
        // [redacted]. It reported itself handled while carrying the credential — which is why
        // `toContain('[redacted]')` was green on a leak, and why every row below asserts ABSENCE of
        // the secret first and the marker second.
        const secrets = [
            ['bearer header',    'GET /api failed: Authorization: Bearer super-secret-token-value abc', 'super-secret-token-value'],
            ['bare classic PAT', 'push rejected for ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGG1234',             'ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGG1234'],
            ['bare fine PAT',    'push rejected for github_pat_11ABCDE0Y0abcdefgh_XYZ123',              'github_pat_11ABCDE0Y0abcdefgh_XYZ123'],
            ['bare GitLab PAT',  'clone failed for glpat-AAAABBBBCCCC-1234',                            'glpat-AAAABBBBCCCC-1234'],
            ['keyed secret',     'auth failed: token=s3cr3t-value-here, retrying',                      's3cr3t-value-here'],
            ['basic header',     'GET /api failed: Authorization: Basic dXNlcjpwYXNzd29yZA== next',     'dXNlcjpwYXNzd29yZA=='],
            // The credentials run to the END of the header value, not to the first delimiter. RFC 7235
            // allows a token68 OR a comma-separated auth-param list, and Digest uses the list — so
            // stopping at the first comma redacted `username` and published `response`, which IS the
            // credential, with `[redacted]` printed beside it. The single-token case was the one I
            // tested, so the single-token case was the one that worked.
            ['digest auth-param list', 'GET failed: Authorization: Digest username="u", realm="r", nonce="abc", response="deadbeefcafe1234"', 'deadbeefcafe1234'],
            // @neo-opus-grace's line, against a patch I had just prescribed to her: an allow-list of
            // four degrades on the FIFTH. These four are the schemes nobody taught the list — none of
            // them appears anywhere in the module, which is the point of the rows.
            ['ntlm',      'GET failed: Authorization: NTLM TlRMTVNTUAABAAAAB4IIogAAAAA=',                                'TlRMTVNTUAABAAAAB4IIogAAAAA='],
            ['negotiate', 'GET failed: Authorization: Negotiate YIIZkAYGKwYBBQUCoIIZ',                                   'YIIZkAYGKwYBBQUCoIIZ'],
            ['hawk',      'GET failed: Authorization: Hawk id="dh37", mac="6R4rV5iE+NPoym"',                             '6R4rV5iE+NPoym'],
            ['aws sigv4', 'GET failed: Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7/20260717, Signature=deadbeef', 'deadbeef']
        ];

        for (const [label, message, secret] of secrets) {
            const source = createFleetActivityReadSource({
                readA2ASnapshot   : async () => { throw new Error(message) },
                readPrLaneSnapshot: wired([])
            });

            const {capability} = await source.readActivitySnapshot();

            expect(capability.reason, `${label}: the secret must not survive`).not.toContain(secret);
            expect(capability.reason, `${label}: a redaction marker must remain`).toMatch(/\[redacted(-token)?]/);
            // the operator still learns WHICH slot failed — a reason of pure [redacted] debugs nothing
            expect(capability.reason, `${label}: attribution must survive`).toContain('a2a')
        }
    });

    test('the redactor does not eat the diagnostic — an absence assertion alone cannot see over-redaction', async () => {
        // @neo-opus-grace's control, and the necessary other half of the matrix above: a redactor that
        // consumed the rest of every line would pass EVERY "secret is absent" row while destroying the
        // reason this module exists to carry. Redacting the auth header deliberately over-consumes an
        // unknown trailing token — a word of lost context is cheap, a published credential is not — so
        // the bound has to be witnessed, not assumed.
        const honest = [
            ['keyed secret mid-sentence', 'auth failed: token=sk-live-1, retry after 30s', 'retry after 30s'],
            ['no credential at all',      'ECONNREFUSED contacting api.github.com:443',    'ECONNREFUSED contacting api.github.com:443']
        ];

        for (const [label, message, mustSurvive] of honest) {
            const source = createFleetActivityReadSource({
                readA2ASnapshot   : async () => { throw new Error(message) },
                readPrLaneSnapshot: wired([])
            });

            const {capability} = await source.readActivitySnapshot();

            expect(capability.reason, `${label}: the operator's evidence must survive`).toContain(mustSurvive)
        }
    });

    test('a LOCALLY-created degraded capability is attributed to its slot, not to "unknown slot"', async () => {
        // The existing slot witness only covered a capability the adapter RETURNED. The degraded one
        // this module builds itself omitted the `slot` field the healthy path sets, so composeCapability
        // read undefined and printed `unknown slot: a2a: …` — the attribution lost, and the prefix
        // doubled. Two return paths of one function disagreeing about their own contract.
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : async () => ({events: []}),   // no capability: has not reported sight
            readPrLaneSnapshot: wired([])
        });

        const {capability} = await source.readActivitySnapshot();

        expect(capability.reason).not.toContain('unknown slot');
        expect(capability.reason).toContain('a2a: returned no capability')
    });

    test('the COMPOSITE reason is capped — bounding the parts does not bound the join', async () => {
        // Two blind slots at the per-reason cap, plus prefixes and the separator, reached ~430 chars
        // through a guard whose stated purpose was that one failure cannot flood the pane. The operator
        // reads the composite, so the composite is the thing that must be bounded.
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : async () => { throw new Error('a'.repeat(5000)) },
            readPrLaneSnapshot: async () => { throw new Error('b'.repeat(5000)) }
        });

        const {capability} = await source.readActivitySnapshot();

        expect(capability.state).toBe('not-wired');
        expect(capability.reason.length).toBeLessThanOrEqual(200)
    });

    test('a misconfigured fallback fails LOUD — the guard against an unbounded read must not unbound it', async () => {
        // normalizeBound guarded the CALLER's limit and then handed `Math.min(-1, MAX)` === -1 to every
        // adapter as the fallback for each refused request. The clamp obeyed a misconfiguration exactly
        // as readily as it had obeyed a hostile caller. Refused once at construction, where the missing
        // readers are already refused, rather than silently on every later call.
        for (const bad of [-1, 0, NaN, 1e9, 'many', null]) {
            expect(() => createFleetActivityReadSource({
                readA2ASnapshot   : wired([]),
                readPrLaneSnapshot: wired([]),
                limit             : bad
            }), `configured limit ${String(bad)} must be refused at construction`).toThrow(TypeError)
        }
    });

    test('an unusable bound falls back to the default — a caller cannot unbound the read', async () => {
        // `params.limit ?? limit` obeyed -1, NaN and 0. The bound reaches the adapters verbatim, so a
        // bad one is a caller-controlled unbounded read, not a display quirk.
        for (const bad of [-1, 0, NaN, 'many', null]) {
            const seen   = [];
            const source = createFleetActivityReadSource({
                readA2ASnapshot   : async params => { seen.push(params.limit); return {capability: {source: 'a', state: 'wired'}, events: []} },
                readPrLaneSnapshot: async params => { seen.push(params.limit); return {capability: {source: 'b', state: 'wired'}, events: []} },
                limit             : 50
            });

            await source.readActivitySnapshot({limit: bad});
            expect(seen, `limit ${String(bad)} must not reach the adapters`).toEqual([50, 50])
        }
    });

    test('an UNBOUNDED bound is clamped — the default is not a maximum', async () => {
        // @neo-opus-vega's falsifier. The first cut refused -1/0/NaN/'many' and obeyed 1e9 — so it
        // guarded the malformed class and left the one this guard's own JSDoc names: `params` arrives
        // over the wire, so the ceiling was caller-chosen against a producer that fans out to every
        // adapter. The reason string was capped in this same file; the count was not.
        for (const huge of [1e9, Number.MAX_SAFE_INTEGER, 201]) {
            const seen   = [];
            const source = createFleetActivityReadSource({
                readA2ASnapshot   : async params => { seen.push(params.limit); return {capability: {source: 'a', state: 'wired'}, events: []} },
                readPrLaneSnapshot: async params => { seen.push(params.limit); return {capability: {source: 'b', state: 'wired'}, events: []} },
                limit             : 25
            });

            await source.readActivitySnapshot({limit: huge});
            expect(seen, `limit ${huge} must be clamped, not obeyed`).toEqual([200, 200])
        }
    });

    test('the clamp caps the RESULT too — a slot cannot answer past the ceiling', async () => {
        // Vega's own observation about boundEvents, pinned: bounding only the REQUEST trusts the
        // adapters to honour it. A slot returning more than asked must not blow the cap.
        const flood = async () => ({
            capability: {source: 'a', state: 'wired', confidence: 'observed'},
            events    : Array.from({length: 500}, (_, index) => ({occurredAt: `2026-07-16T${String(index % 24).padStart(2, '0')}:00:00.000Z`, eventId: `e-${index}`}))
        });
        const source = createFleetActivityReadSource({readA2ASnapshot: flood, readPrLaneSnapshot: flood, limit: 25});

        const {events} = await source.readActivitySnapshot({limit: 1e9});

        expect(events.length).toBe(200)
    });

    test('an honest bound below the ceiling is untouched', async () => {
        // Without this, "clamp everything to 200" would satisfy the tests above and silently ignore
        // every caller's actual request.
        const seen   = [];
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : async params => { seen.push(params.limit); return {capability: {source: 'a', state: 'wired'}, events: []} },
            readPrLaneSnapshot: async params => { seen.push(params.limit); return {capability: {source: 'b', state: 'wired'}, events: []} },
            limit             : 25
        });

        await source.readActivitySnapshot({limit: 7});
        expect(seen).toEqual([7, 7])
    });

    test('a contributor returning NO capability has not reported sight', async () => {
        // Inventing a capability for a malformed answer is the exact failure this module prevents.
        const source = createFleetActivityReadSource({
            readA2ASnapshot   : async () => undefined,
            readPrLaneSnapshot: wired([])
        });

        const {capability} = await source.readActivitySnapshot();

        expect(capability.state).toBe('degraded');
        expect(capability.reason).toContain('a2a')
    });

    test('fails LOUD on a missing reader — a one-legged composite is not the fleet\'s activity', () => {
        expect(() => createFleetActivityReadSource({readA2ASnapshot: wired([])}))
            .toThrow(/readA2ASnapshot and readPrLaneSnapshot must be injected/);
        expect(() => createFleetActivityReadSource({readPrLaneSnapshot: wired([])}))
            .toThrow(/readA2ASnapshot and readPrLaneSnapshot must be injected/);
        expect(() => createFleetActivityReadSource())
            .toThrow(/must be injected/)
    })
});

/**
 * @summary The composition, with NO double between the halves.
 *
 * Two suites can both be green over code that cannot run: when each stubs the other, both agree with
 * a contract neither honours, and the mismatch surfaces only in production. The suite above has that
 * hole by construction — it proves the composer against one reading of the bridge's contract.
 *
 * This binds the REAL `FleetControlBridge` to the REAL composer. If the producer does not satisfy the
 * consumer, this is the only test here that can say so.
 */
test.describe('fleetActivityComposer ↔ FleetControlBridge — the real consumer calls the real producer', () => {
    let FleetControlBridge, createFleetActivityReadSource;

    test.beforeAll(async () => {
        FleetControlBridge           = (await import('../../../../../../ai/services/fleet/FleetControlBridge.mjs')).default;
        createFleetActivityReadSource = (await import('../../../../../../ai/services/fleet/fleetActivityComposer.mjs')).createFleetActivityReadSource
    });

    test.afterEach(() => { FleetControlBridge.activitySource = null });

    test('the bridge accepts the composer as its activitySource and gets a composed snapshot back', async () => {
        const seen = [];

        FleetControlBridge.activitySource = createFleetActivityReadSource({
            readA2ASnapshot: async params => {
                seen.push(['a2a', params.limit]);
                return {
                    capability: {source: 'fleet:a2a', state: 'wired', confidence: 'observed'},
                    events    : [{occurredAt: '2026-07-16T11:00:00.000Z', eventId: 'a2a-1'}]
                }
            },
            readPrLaneSnapshot: async params => {
                seen.push(['pr-lane', params.limit]);
                return {
                    capability: {source: 'fleet:pr-lane', state: 'wired', confidence: 'observed'},
                    events    : [{occurredAt: '2026-07-16T12:00:00.000Z', eventId: 'pr-1'}]
                }
            }
        });

        // the bridge's own verb, not a direct call to the source
        const result = await FleetControlBridge.fleetActivity({limit: 25});

        // The bridge forwards its bounds verbatim (FleetControlBridge.mjs:355) — so the caller's limit
        // must reach BOTH adapters through the composer, not stop at it.
        expect(seen).toEqual([['a2a', 25], ['pr-lane', 25]]);

        expect(result.capability.state).toBe('wired');
        expect(result.capability.source).toBe('fleet:activity-adapters');
        expect(result.events.map(event => event.eventId)).toEqual(['pr-1', 'a2a-1'])
    });

    test('a blind half reaches the bridge as degraded — the honest state survives the seam', async () => {
        FleetControlBridge.activitySource = createFleetActivityReadSource({
            readA2ASnapshot   : async () => ({capability: {source: 'fleet:a2a', state: 'wired', confidence: 'observed'}, events: []}),
            readPrLaneSnapshot: async () => ({capability: {source: 'fleet:pr-lane', state: 'degraded', confidence: 'none', reason: 'github unreachable'}, events: []})
        });

        const result = await FleetControlBridge.fleetActivity();

        // The events are empty either way; only the capability distinguishes a quiet fleet from a
        // half-blind one — and it has to survive the bridge to be worth anything.
        expect(result.events).toEqual([]);
        expect(result.capability.state).toBe('degraded');
        expect(result.capability.reason).toContain('github unreachable')
    })
});

// A lane lives for days, a mailbox page for minutes, a Fleet process until its next restart.
test.describe('fleetActivityComposer — the lanes', () => {
    const
        stamp = '2026-10-03T18:00:00.000Z',
        LANES = {memorySharing: 'team', scope: 'all'},
        claim = (agentId, occurredAt, subject, collisionTag = 'lane-claim') => ({
            eventId: `${agentId}@${occurredAt}`, type: collisionTag === 'lane-claim' ? 'lane-claim' : 'a2a-activity',
            source : 'memory-core:mailbox', agentId, occurredAt, payload: {subject, collisionTag}
        }),
        // one mailbox answer; an observer answer carries the admission it was read under
        answer  = (events, {admissionKey = null, policy = null, state = 'wired'} = {}) => ({
            capability: {source: 'memory-core:mailbox', state, confidence: state === 'wired' ? 'observed' : 'none', capturedAt: stamp, reason: state === 'wired' ? null : 'mailbox unavailable'},
            scanned   : events.length,
            events    : state === 'wired' ? events : [],
            ...(policy && {a2a: {observation: {admissionKey: admissionKey ?? `key-${policy}`, clamped: policy !== 'team', planeId: 'plane', policy, scope: 'all', viewer: '@viewer'}, page: {nextOffset: null, offset: 0}}})
        }),
        // the viewer's own inbox holds no broadcast; the team observation holds every one
        mailbox = ({calls = [], inbox = [], policy = 'team', team = []} = {}) => async params => {
            calls.push(params);
            return params.observer ? answer(team, {policy}) : answer(inbox)
        },
        prLane  = async () => ({capability: {state: 'wired'}, events: []}),
        lanesOf = source => Object.fromEntries((source.readHeldLaneSnapshot()?.a2a.entries ?? [])
            .map(({agentId, collisionTag, subject}) => [agentId, collisionTag === 'lane-claim' ? subject : 'released'])),
        clock   = () => {
            let at = Date.parse(stamp);
            return Object.assign(() => at, {advance(ms) { at += ms }})
        },
        memory  = () => {
            const store = {state: null, saves: 0};
            return Object.assign(store, {load: () => structuredClone(store.state), save: state => { store.saves++; store.state = structuredClone(state) }})
        };
    let createSource, INTERVAL;
    test.beforeAll(async () => {
        const composer = await import('../../../../../../ai/services/fleet/fleetActivityComposer.mjs');

        createSource = composer.createFleetActivityReadSource;
        INTERVAL     = composer.FLEET_LANE_OBSERVATION_INTERVAL
    });

    test('a human viewer reads every seat\'s broadcast lane from the team observation, never from its own mailbox (AC-1)', async () => {
        const calls  = [],
              source = createSource({
                  resolveViewerIdentity: () => '@tobiu', readPrLaneSnapshot: prLane,
                  readA2ASnapshot      : mailbox({calls, team: [claim('neo-gpt', '2026-10-15T09:15:00.000Z', '[lane-claim] Stage #39')]})
              });

        expect(source.readHeldLaneSnapshot(), 'nothing is held before the first observation').toBeNull();
        await source.readActivitySnapshot({limit: 1});

        expect(calls, 'the observation asks the team breadth with its own bound, and nothing else').toEqual([{limit: 1, offset: 0}, {limit: 50, observer: LANES}]);
        expect(lanesOf(source)).toEqual({'neo-gpt': '[lane-claim] Stage #39'});
        expect(source.readHeldLaneSnapshot().a2a.capability).toMatchObject({
            source: 'memory-core:mailbox', state: 'wired', confidence: 'observed', policy: 'team', reason: null, scanned: 1
        });

        source.readHeldLaneSnapshot().a2a.entries[0].subject = 'mutated';
        expect(lanesOf(source), 'every read is an independent copy').toEqual({'neo-gpt': '[lane-claim] Stage #39'});
    });

    test('a narrower sharing policy still folds what it admits, and the A2A source says it is clamped (AC-2)', async () => {
        const source = createSource({
            resolveViewerIdentity: () => '@tobiu', readPrLaneSnapshot: prLane,
            readA2ASnapshot      : mailbox({policy: 'private', team: [claim('neo-gpt', '2026-10-15T09:15:00.000Z', '[lane-claim] granted inbox')]})
        });

        await source.readActivitySnapshot();

        expect(lanesOf(source)).toEqual({'neo-gpt': '[lane-claim] granted inbox'});
        expect(source.readHeldLaneSnapshot().a2a.capability).toMatchObject({
            state: 'degraded', confidence: 'none', policy: 'private', reason: "the 'private' sharing policy shows other seats' broadcasts only through inbox grants"
        });
    });

    test('the caller\'s page and observer never feed the lanes', async () => {
        const source = createSource({
            resolveViewerIdentity: () => '@viewer', readPrLaneSnapshot: prLane,
            readA2ASnapshot      : async params => params.observer?.memorySharing === 'team'
                ? answer([], {policy: 'team'})
                : answer([claim('alice', stamp, params.observer ? '[lane-claim] the caller\'s observer' : '[lane-claim] the caller\'s page')], {policy: params.observer ? 'team' : null})
        });

        await source.readActivitySnapshot();
        await source.readActivitySnapshot({observer: {scope: 'involves-me'}});

        expect(lanesOf(source)).toEqual({});
    });

    test('a live read observes once a minute per viewer; history and PR-only reads never do', async () => {
        const calls        = [],
              now          = clock(),
              observations = () => calls.filter(params => params.observer).length;
        let   viewer = '@viewer';
        const source = createSource({resolveViewerIdentity: () => viewer, readA2ASnapshot: mailbox({calls}), readPrLaneSnapshot: prLane, now});

        await source.readActivitySnapshot();
        await source.readActivitySnapshot();
        await source.readActivitySnapshot({offset: 10, slots: ['a2a']});
        await source.readActivitySnapshot({slots: ['pr-lane']});
        expect(observations(), 'one observation stands for a minute').toBe(1);

        now.advance(INTERVAL);
        await source.readActivitySnapshot();
        expect(observations()).toBe(2);

        viewer = '@other';
        await source.readActivitySnapshot();
        expect(observations(), 'another viewer is observed at once').toBe(3);
    });

    test('a late observation never replaces a newer one, and holds for the viewer it was asked for', async () => {
        const now      = clock(),
              releases = [];
        let   viewer = '@viewer';
        const source = createSource({
            resolveViewerIdentity: () => viewer, readPrLaneSnapshot: prLane, now,
            readA2ASnapshot      : params => params.observer ? new Promise(resolve => releases.push(resolve)) : Promise.resolve(answer([]))
        });

        const older = source.readActivitySnapshot();
        now.advance(INTERVAL);
        const newer = source.readActivitySnapshot();

        releases[1](answer([claim('alice', '2026-10-03T12:00:00.000Z', '[lane-claim] the newer read')], {policy: 'team'}));
        await newer;
        releases[0](answer([claim('alice', '2026-10-03T13:00:00.000Z', '[lane-claim] the older read')], {policy: 'private'}));
        await older;

        expect(lanesOf(source)).toEqual({alice: '[lane-claim] the newer read'});
        expect(source.readHeldLaneSnapshot().a2a.capability.policy).toBe('team');

        now.advance(INTERVAL);
        const pending = source.readActivitySnapshot();
        viewer = '@other';
        releases[2](answer([], {policy: 'team'}));
        await pending;
        expect(source.readHeldLaneSnapshot(), 'the observation belongs to the viewer it was asked for').toBeNull();
        viewer = '@viewer';
        expect(lanesOf(source)).toEqual({alice: '[lane-claim] the newer read'});
    });

    test('a failed observation names its cause and lends no retained claim until the next one answers', async () => {
        const now    = clock();
        let   fail   = false;
        const source = createSource({
            resolveViewerIdentity: () => '@viewer', readPrLaneSnapshot: prLane, now,
            readA2ASnapshot      : async params => {
                if (params.observer && fail) throw new Error('observer refused');
                return params.observer ? answer([claim('alice', stamp, '[lane-claim] A')], {policy: 'team'}) : answer([])
            }
        });

        await source.readActivitySnapshot();
        expect(lanesOf(source)).toEqual({alice: '[lane-claim] A'});

        fail = true;
        now.advance(INTERVAL);
        await source.readActivitySnapshot();
        expect(source.readHeldLaneSnapshot().a2a).toEqual({
            capability: expect.objectContaining({state: 'degraded', policy: null, reason: expect.stringContaining('observer refused')}),
            entries   : []
        });

        fail = false;
        now.advance(INTERVAL);
        await source.readActivitySnapshot();
        expect(lanesOf(source)).toEqual({alice: '[lane-claim] A'});
    });

    test('an unbound source observes nothing and holds nothing, whatever the caller names', async () => {
        const calls  = [],
              source = createSource({readA2ASnapshot: mailbox({calls}), readPrLaneSnapshot: prLane});

        await source.readActivitySnapshot({viewerIdentity: '@forged'});

        expect(calls.some(params => params.observer)).toBe(false);
        expect(source.readHeldLaneSnapshot()).toBeNull();
    });

    test('a claim pushed off the page stays with its seat until the seat replaces or releases it', async () => {
        const now   = clock(),
              pages = [
                  answer([claim('alice', '2026-10-03T12:00:00.000Z', '[lane-claim] A'), claim('bob', '2026-10-03T12:01:00.000Z', '[lane-claim] B')], {policy: 'team'}),
                  answer([claim('carol', '2026-10-03T13:00:00.000Z', 'chatter', null)], {policy: 'team'}),
                  answer([], {state: 'degraded'}),
                  answer([claim('bob', '2026-10-03T14:00:00.000Z', '[claim-corrected] B is free', 'claim-corrected'),
                          claim('alice', '2026-10-03T11:00:00.000Z', '[lane-claim] older than A')], {policy: 'team'}),
                  answer([claim('alice', '2026-10-03T15:00:00.000Z', '[lane-claim] A2')], {policy: 'team'})
              ],
              source  = createSource({
                  resolveViewerIdentity: () => '@viewer', readPrLaneSnapshot: prLane, now,
                  readA2ASnapshot      : async params => params.observer ? pages.shift() : answer([])
              }),
              observe = async () => { await source.readActivitySnapshot(); now.advance(INTERVAL) };

        await observe();
        await observe();
        expect(lanesOf(source)).toEqual({alice: '[lane-claim] A', bob: '[lane-claim] B'});

        await observe();
        expect(lanesOf(source), 'a failed observation lends nothing').toEqual({});

        await observe();
        expect(lanesOf(source), 'the failure changed no seat; a release ends a lane; an older claim displaces nothing')
            .toEqual({alice: '[lane-claim] A', bob: 'released'});

        await observe();
        expect(lanesOf(source)).toEqual({alice: '[lane-claim] A2', bob: 'released'});
    });

    test('after a restart the first observation shows the saved claims, only to the viewer and mailbox they were read from', async () => {
        const store = memory(),
              start = (viewer, events, laneClaimSource = 'plane:https://plane-a.example') => createSource({
                  resolveViewerIdentity: () => viewer, readPrLaneSnapshot: prLane, laneClaimStore: store, laneClaimSource,
                  readA2ASnapshot      : async params => params.observer ? answer(events, {policy: 'team'}) : answer([])
              });

        await start('@viewer', [claim('alice', '2026-10-03T12:00:00.000Z', '[lane-claim] A')]).readActivitySnapshot();
        expect(store.saves).toBe(1);

        const restarted = start('@viewer', [claim('carol', '2026-10-03T19:00:00.000Z', 'chatter', null)]);
        expect(restarted.readHeldLaneSnapshot(), 'nothing is held before the first observation').toBeNull();
        await restarted.readActivitySnapshot();
        expect(lanesOf(restarted)).toEqual({alice: '[lane-claim] A'});
        expect(store.saves, 'an observation that changes no seat writes nothing').toBe(1);

        const other = start('@other', []);
        await other.readActivitySnapshot();
        expect(lanesOf(other)).toEqual({});

        // the same viewer and data directory, restarted against another plane: that plane's claims only
        await start('@viewer', [claim('alice', '2026-10-03T12:00:00.000Z', '[lane-claim] A')]).readActivitySnapshot();
        const otherPlane = start('@viewer', [], 'plane:https://plane-b.example');
        await otherPlane.readActivitySnapshot();
        expect(lanesOf(otherPlane)).toEqual({});
    });

    test('a changed admission retires every retained claim: a narrower policy, a revoked grant', async () => {
        const now     = clock(),
              claimA  = claim('alice', '2026-10-03T12:00:00.000Z', '[lane-claim] A'),
              answers = [],
              source  = createSource({
                  resolveViewerIdentity: () => '@viewer', readPrLaneSnapshot: prLane, now,
                  readA2ASnapshot      : async params => params.observer ? answers.shift() : answer([])
              }),
              observe = async next => {
                  answers.push(next);
                  await source.readActivitySnapshot();
                  now.advance(INTERVAL)
              };

        await observe(answer([claimA], {policy: 'team'}));
        expect(lanesOf(source)).toEqual({alice: '[lane-claim] A'});

        await observe(answer([], {policy: 'private'}));
        expect(lanesOf(source), 'the narrower admission lends nothing only the team one showed').toEqual({});

        await observe(answer([claimA], {admissionKey: 'key-private-granted', policy: 'private'}));
        expect(lanesOf(source)).toEqual({alice: '[lane-claim] A'});

        await observe(answer([], {admissionKey: 'key-private-revoked', policy: 'private'}));
        expect(lanesOf(source), 'a revoked grant retires what it admitted').toEqual({});
    });

    test('a saved record lends its claims only under the admission it was saved for', async () => {
        const store = memory(),
              start = (events, policy) => createSource({
                  resolveViewerIdentity: () => '@viewer', readPrLaneSnapshot: prLane, laneClaimStore: store, laneClaimSource: 'plane:https://plane-a.example',
                  readA2ASnapshot      : async params => params.observer ? answer(events, {policy}) : answer([])
              });

        await start([claim('alice', '2026-10-03T12:00:00.000Z', '[lane-claim] A')], 'team').readActivitySnapshot();
        expect(store.state.admissionKey).toBe('key-team');

        const narrower = start([], 'private');
        await narrower.readActivitySnapshot();
        expect(lanesOf(narrower), 'a restart under a narrower admission replays nothing').toEqual({});

        // a record saved before admissions were kept names none, so it lends nothing either
        store.state = {source: 'plane:https://plane-a.example', viewerIdentity: '@viewer', seats: [['alice', {collisionTag: 'lane-claim', occurredAt: '2026-10-03T12:00:00.000Z', messageId: null, subject: '[lane-claim] A'}]]};
        const legacy = start([], 'team');
        await legacy.readActivitySnapshot();
        expect(lanesOf(legacy)).toEqual({});
    });

    test('a saved record that cannot be read is kept in memory only and never overwritten', async () => {
        for (const load of [
            () => { throw new SyntaxError('Unexpected end of JSON input') },
            () => ({viewerIdentity: '@viewer', seats: {}}),
            () => ({source: 'plane:https://plane-a.example', viewerIdentity: '@viewer', seats: 'none'}),
            () => [],
            () => 'lanes'
        ]) {
            const store  = {saves: 0, load, save() { this.saves++ }},
                  source = createSource({
                      resolveViewerIdentity: () => '@viewer', readPrLaneSnapshot: prLane, laneClaimStore: store, laneClaimSource: 'plane:https://plane-a.example',
                      readA2ASnapshot      : mailbox({team: [claim('alice', '2026-10-03T12:00:00.000Z', '[lane-claim] A')]})
                  });

            await source.readActivitySnapshot();
            expect(lanesOf(source), String(load)).toEqual({alice: '[lane-claim] A'});
            expect(store.saves, String(load)).toBe(0);
        }
    });

    test('a lane store without the mailbox source it belongs to is refused at construction', () => {
        expect(() => createSource({
            readA2ASnapshot: mailbox(), readPrLaneSnapshot: prLane, laneClaimStore: memory()
        })).toThrow(TypeError);
    });

    test('the newest live read holds its forge lane facts under their own state; a read without them is degraded', async () => {
        const facts = {state: 'wired', reason: null, assignments: [], claims: [{agentId: 'neo-gpt', issue: 'neo-agent-brain#1046', line: 'neo-agent-brain#1046 Roster lanes', occurredAt: stamp}]},
              reads = [
                  {capability: {state: 'degraded', reason: 'open-work producer stale since 2026-10-03T17:00:00.000Z', capturedAt: stamp}, events: [], lanes: facts},
                  {capability: {state: 'wired', capturedAt: stamp}, events: []},
                  () => { throw new Error('plane unreachable') }
              ],
              source  = createSource({
                  resolveViewerIdentity: () => '@viewer', readA2ASnapshot: mailbox(),
                  readPrLaneSnapshot   : async () => {
                      const next = reads.shift();
                      return typeof next === 'function' ? next() : next
                  }
              }),
              forgeOf = () => source.readHeldLaneSnapshot().forge;

        await source.readActivitySnapshot();
        expect(forgeOf(), 'a stale producer does not touch the issues the facts are read from').toEqual({
            assignments: [],
            capability : {source: 'github-workflow:issue-comments', state: 'wired', confidence: 'observed', reason: null, capturedAt: stamp},
            claims     : facts.claims
        });

        await source.readActivitySnapshot();
        expect(forgeOf(), 'a plane that predates lane facts').toMatchObject({claims: [], capability: {state: 'degraded', reason: 'the PR/lane read answered no lane facts'}});

        await source.readActivitySnapshot();
        expect(forgeOf()).toMatchObject({claims: [], capability: {state: 'degraded', reason: expect.stringContaining('plane unreachable')}});
    });
});
