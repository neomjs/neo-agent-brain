import {test, expect}                   from '@playwright/test';
import Database                         from 'better-sqlite3';
import {generateKeyPairSync, sign}      from 'node:crypto';
import fs                               from 'node:fs';
import os                               from 'node:os';
import path                             from 'node:path';
import {compileFoundingFamilySeed}      from '../../../../../../ai/graph/identityFoundingSeed.mjs';
import {stringifyCanonicalJson}         from '../../../../../../ai/services/shared/canonicalJson.mjs';
import {consumeIdentityPublicationBoot} from '../../../../../../ai/services/memory-core/helpers/identityPublicationLineage.mjs';
import {installIdentityFoundingSource}  from '../../../../../../ai/services/memory-core/helpers/identityFoundingStorage.mjs';
import {familySubjectStateKey}          from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';
import {
    admitIdentityPublication,
    readIdentityPublicationSnapshot
} from '../../../../../../ai/services/memory-core/helpers/identityPublicationAdmission.mjs';
import {
    readFoundingIdentities,
    readIdentityBinding,
    readSubjectBinding,
    readSubjectBindingRecords
} from '../../../../../../ai/services/memory-core/helpers/subjectBinding.mjs';
import {runSubjectBindingAdmin}                      from '../../../../../../ai/scripts/maintenance/subjectBindings.mjs';

/**
 * @summary The plane-local administrative bind: a dry run unless applied, bound only to an identity the graph
 * holds, under the retained founding revision the current lineage qualifies, and reachable from no other surface.
 */

const
    target     = {planeId: 'binding-admin-fixture', dataRoot: '/fixture/binding-admin'},
    descriptor = (trust, kid = 'kid-a') => ({version: 1, target: {...target}, issuer: 'fixture-fleet',
        reservation: {attemptId: 'attempt-a', kid, originRunId: '123e4567-e89b-42d3-a456-426614174000'}, trust}),
    key        = generateKeyPairSync('ed25519'),
    publicKey  = (pair = generateKeyPairSync('ed25519')) => pair.publicKey.export({type: 'spki', format: 'der'}).toString('base64url'),
    bootText   = stringifyCanonicalJson(descriptor([{kid: 'kid-a', publicKey: publicKey(key)}])),
    S          = Object.freeze({authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: '1001'}),
    T          = Object.freeze({...S, providerUserId: '2002'}),
    U          = Object.freeze({...S, providerUserId: '3003'});

let root, dbPath;

/**
 * @summary Builds a graph with bound publication lineage, optionally a founding source, and three identities.
 * The founding record maps S to `@ada` alone, U to `@clio` (whom the graph lacks), and T to both `@grace` and `@vega`.
 */
function seedGraph({founding = true} = {}) {
    const db = new Database(dbPath);

    try {
        db.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
            CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);`);
        expect(consumeIdentityPublicationBoot(db, stringifyCanonicalJson(descriptor(null)), target).state).toBe('reserved');
        expect(consumeIdentityPublicationBoot(db, bootText, target).state).toBe('bound');

        if (founding) {
            expect(installIdentityFoundingSource(db, {bootText, target, sourceRevision: 'reviewed-source:fixture', clock: () => 100,
                seed: compileFoundingFamilySeed({
                    identities: ['@ada', '@clio', '@grace', '@vega'].map(id => ({id, type: 'AgentIdentity', properties: {accountType: 'agent', modelFamily: 'claude'}})),
                    subjects  : [
                        {identityKey: '@ada',   subject: {...S}},
                        {identityKey: '@clio',  subject: {...U}},
                        {identityKey: '@grace', subject: {...T}},
                        {identityKey: '@vega',  subject: {...T}}
                    ]
                })
            }).state).toBe('installed');
        }

        const node = db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)');
        ['@ada', '@grace', '@vega'].forEach(id => node.run(id, JSON.stringify({id, label: 'AgentIdentity'})));
        node.run('memory-1', JSON.stringify({id: 'memory-1', label: 'MEMORY'}));
    } finally {
        db.close();
    }
}

/** @summary Signs one family-publication operation for the fixture lineage with its test-only key. */
function token(operation, issuedAt) {
    const payload = Buffer.from(stringifyCanonicalJson({version: 1, purpose: 'identity-family-publication',
        audience: target.planeId, issuer: 'fixture-fleet', kid: 'kid-a', issuedAt, expiresAt: issuedAt + 300000, operation}));

    return payload.toString('base64url') + '.' + sign(null,
        Buffer.concat([Buffer.from('neo.identity-family-publication.v1\0'), payload]), key.privateKey).toString('base64url');
}

/** @summary Admits family history under one subject through the admission path: a baseline seat, then a declaration. */
function admitHistory(subject) {
    const
        db      = new Database(dbPath),
        binding = {seatId: 'seat-ada', incarnation: 'inc-ada', subject: {...subject, providerUsername: 'ada'}},
        admit   = (operation, at) => admitIdentityPublication(db, token(operation, at), {bootText, target, clock: () => at}).state;

    try {
        expect(admit({kind: 'baseline', operationId: 'baseline-ada', effectiveAt: 90, expectedPlaneRevision: 0, bindings: [binding]}, 100)).toBe('accepted');
        expect(admit({kind: 'confirm', operationId: 'confirm-ada', binding, effectiveAt: 100, expectedMembershipRevision: 1,
            expectedAdmissionRevision: 0, operatorPrincipal: 'owner-a', family: 'claude', model: null,
            unattestedReason         : 'No model attested', newFamily: false}, 110)).toBe('accepted');
    } finally {
        db.close();
    }
}

/** @summary Reads the stored relation on its own connection. */
function stored(read) {
    const db = new Database(dbPath, {readonly: true});
    try { return read(db); } finally { db.close(); }
}

/** @summary One administrative bind of S to `@ada`, a dry run unless `apply` is set. */
const bind = (options = {}) => runSubjectBindingAdmin({
    dbPath, command: 'bind', subject: S, identityId: '@ada', apply: false,
    bootText, target, configuredGraphPath: dbPath, now: () => 500, ...options
});

/** @summary One seed from the retained founding record, a dry run unless `apply` is set. */
const seed = (options = {}) => runSubjectBindingAdmin({
    dbPath, command: 'seed', apply: false, bootText, target, configuredGraphPath: dbPath, now: () => 500, ...options
});

/** @summary What the fixture's founding record leaves unresolved, in the record's order. */
const UNRESOLVED = [
    {subject: U, identityIds: ['@clio'], reason: 'identity-unknown'},
    {subject: T, identityIds: ['@grace', '@vega'], reason: 'several-identities'}
];

test.beforeEach(() => {
    root   = fs.mkdtempSync(path.join(os.tmpdir(), 'subject-bindings-admin-'));
    dbPath = path.join(root, 'graph.sqlite');
    seedGraph();
});

test.afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

test.describe('ai/scripts/maintenance/subjectBindings', () => {
    test('a bind without --apply reports its plan and the retained founding revision, and writes nothing', () => {
        expect(bind()).toEqual({ok: true, command: 'bind', applied: false, state: 'bound', identityId: '@ada', foundingRevision: 'reviewed-source:fixture'});
        expect(stored(readSubjectBindingRecords)).toEqual([]);
    });

    test('--apply binds an existing identity under that revision; presenting it again reads the match without a write', () => {
        expect(bind({apply: true})).toMatchObject({applied: true, state: 'bound'});

        const bound = stored(db => readSubjectBinding(db, S));

        expect(bound).toEqual({...S, identityId: '@ada', writer: 'administrative', foundingRevision: 'reviewed-source:fixture', formerBaseUrls: [], boundAt: 500});
        expect(bind({apply: true, now: () => 900})).toMatchObject({applied: true, state: 'matching'});
        expect(stored(db => readSubjectBinding(db, S))).toEqual(bound);
    });

    test('an endpoint move keeps the identity and the endpoint it leaves, so the family history admitted there stays reachable', () => {
        const
            moved = {...S, providerBaseUrl: 'https://github.example.com/api/v3'},
            again = {...S, providerBaseUrl: 'https://github.internal/api/v3'},
            keyOf = subject => familySubjectStateKey({planeId: target.planeId, subject}),
            // the family history the binding reaches: every subject tuple its row names, read by the family-history reader
            history = () => stored(db => {
                const
                    binding           = readIdentityBinding(db, '@ada'),
                    keys              = [binding.providerBaseUrl, ...binding.formerBaseUrls ?? []].map(providerBaseUrl => keyOf({...S, providerBaseUrl})),
                    {state, snapshot} = readIdentityPublicationSnapshot(db, {bootText, target});

                expect(state).toBe('available');
                return snapshot.subjects.filter(entry => keys.includes(keyOf(entry.subject)) && entry.bindings.length > 0);
            });

        bind({apply: true});
        admitHistory(S);
        expect(history()).toHaveLength(1);

        expect(bind({apply: true, subject: moved})).toMatchObject({applied: true, state: 'moved'});

        const [reached] = history();
        expect(reached, 'the history admitted under the endpoint the binding left').toMatchObject({subject: S, bindings: [{binding: {seatId: 'seat-ada'}}]});
        expect(reached.source.declarations).toMatchObject([{family: 'claude', operatorPrincipal: 'owner-a'}]);
        expect(stored(db => readSubjectBinding(db, S))).toBeNull();
        expect(stored(db => readSubjectBinding(db, moved))).toMatchObject({identityId: '@ada', formerBaseUrls: [S.providerBaseUrl]});

        // each further move keeps every endpoint left, and a move back to one drops it from the list
        bind({apply: true, subject: again});
        expect(stored(db => readIdentityBinding(db, '@ada')).formerBaseUrls).toEqual([S.providerBaseUrl, moved.providerBaseUrl]);
        bind({apply: true, subject: S});
        expect(stored(db => readIdentityBinding(db, '@ada'))).toMatchObject({...S, formerBaseUrls: [moved.providerBaseUrl, again.providerBaseUrl]});
        expect(history()).toHaveLength(1);
    });

    test('another identity bound to the subject refuses by name, and nothing changes', () => {
        bind({apply: true});

        expect(() => bind({apply: true, identityId: '@grace'})).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_SUBJECT_CLAIMED', identityId: '@ada'}));
        expect(stored(db => readSubjectBinding(db, S)).identityId).toBe('@ada');
    });

    test('a new identity binds only at its first admission', () => {
        for (const identityId of ['@unknown', 'memory-1']) {
            expect(() => bind({apply: true, identityId})).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_IDENTITY_UNKNOWN'}));
        }
        expect(stored(readSubjectBindingRecords)).toEqual([]);
    });

    test('a bind refuses without a founding source, or with one the current lineage does not qualify', () => {
        const foreignBoot = stringifyCanonicalJson(descriptor([{kid: 'kid-b', publicKey: publicKey()}], 'kid-b'));

        expect(() => bind({apply: true, bootText: foreignBoot})).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_FOUNDING_UNQUALIFIED'}));

        fs.rmSync(dbPath);
        seedGraph({founding: false});

        expect(() => bind({apply: true})).toThrow(expect.objectContaining({code: 'IDENTITY_FOUNDING_SOURCE_UNAVAILABLE'}));
        expect(stored(readSubjectBindingRecords)).toEqual([]);
    });

    test('the request guard reads the same qualified record: every identity a subject maps to, or none', () => {
        const
            mapped      = (subject, boot = bootText) => stored(db => readFoundingIdentities(db, {bootText: boot, target, subject})),
            foreignBoot = stringifyCanonicalJson(descriptor([{kid: 'kid-b', publicKey: publicKey()}], 'kid-b'));

        // An identity the graph lacks still maps: the guard holds the subject for its founding identity
        expect(mapped(S)).toEqual(['@ada']);
        expect(mapped(T)).toEqual(['@grace', '@vega']);
        expect(mapped(U)).toEqual(['@clio']);

        // The subject compares exactly, so the same account at another endpoint is not mapped
        expect(mapped({...S, providerUserId: '4004'})).toEqual([]);
        expect(mapped({...S, providerBaseUrl: 'https://github.example.com/api/v3'})).toEqual([]);

        expect(() => mapped(S, foreignBoot)).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_FOUNDING_UNQUALIFIED'}));

        fs.rmSync(dbPath);
        seedGraph({founding: false});

        expect(() => mapped(S)).toThrow(expect.objectContaining({code: 'IDENTITY_FOUNDING_SOURCE_UNAVAILABLE'}));
    });

    test('--apply refuses a database other than the configured live graph', () => {
        const other = path.join(root, 'other.sqlite');

        fs.writeFileSync(other, '');

        for (const configuredGraphPath of [other, path.join(root, 'missing.sqlite'), undefined]) {
            expect(() => bind({apply: true, configuredGraphPath})).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_TARGET_MISMATCH'}));
        }
        expect(stored(readSubjectBindingRecords)).toEqual([]);
    });

    test('seed binds each subject the founding record maps to one held identity, and names the rest without choosing', () => {
        expect(seed()).toEqual({
            ok   : true, command: 'seed', applied: false, foundingRevision: 'reviewed-source:fixture',
            bound: [{subject: S, identityId: '@ada'}], matching: [], held: [], refused: [], unresolved: UNRESOLVED
        });
        expect(stored(readSubjectBindingRecords)).toEqual([]);

        expect(seed({apply: true})).toMatchObject({ok: true, applied: true, bound: [{subject: S, identityId: '@ada'}], unresolved: UNRESOLVED});
        expect(stored(db => readSubjectBinding(db, S))).toEqual({...S, identityId: '@ada', writer: 'administrative', foundingRevision: 'reviewed-source:fixture', formerBaseUrls: [], boundAt: 500});
        expect(stored(db => readSubjectBinding(db, T))).toBeNull();
        expect(stored(db => readSubjectBinding(db, U))).toBeNull();

        expect(seed({apply: true})).toMatchObject({bound: [], matching: [{subject: S, identityId: '@ada'}]});
    });

    test('seed holds an identity an administrative move placed elsewhere', () => {
        const moved = {...S, providerBaseUrl: 'https://github.example.com/api/v3'};

        bind({apply: true, subject: moved});

        expect(seed({apply: true})).toMatchObject({ok: true, bound: [], held: [{subject: S, identityId: '@ada'}]});
        expect(stored(db => readSubjectBinding(db, moved)).identityId).toBe('@ada');
        expect(stored(db => readSubjectBinding(db, S))).toBeNull();
    });

    test('seed refuses by name where the relation already binds the subject elsewhere, and changes nothing', () => {
        bind({apply: true, identityId: '@grace'});

        expect(seed({apply: true})).toMatchObject({
            ok: false, bound: [], refused: [{subject: S, identityId: '@ada', code: 'SUBJECT_BINDING_SUBJECT_CLAIMED'}]
        });
        expect(stored(db => readSubjectBinding(db, S)).identityId).toBe('@grace');
    });

    test.describe('inventory (#1814)', () => {
        const
            inventory = (options = {}) => runSubjectBindingAdmin({dbPath, command: 'inventory', bootText, target, now: () => 500, ...options}),
            insert    = (sql, ...values) => {
                const db = new Database(dbPath);
                try { db.prepare(sql).run(...values); } finally { db.close(); }
            },
            node      = (id, data) => insert('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)', id, JSON.stringify({id, ...data})),
            stateOf   = result => Object.fromEntries(result.identities.map(({id, state}) => [id, state]));

        test('names every unbound identity with its remedy and binding authority, keeps activation shut, and writes nothing', () => {
            node('@maryam', {label: 'AgentIdentity', properties: {accountType: 'agent', authProvider: 'github', providerBaseUrl: S.providerBaseUrl, providerUserId: '5005'}});

            const result = inventory();

            expect(result).toMatchObject({ok: true, command: 'inventory', readyToActivate: false, activation: {state: 'dormant'},
                founding: {state: 'qualified', foundingRevision: 'reviewed-source:fixture'}, foundingSubjects: [{subject: U, identityIds: ['@clio']}]});
            expect(stateOf(result)).toEqual({'@ada': 'seedable', '@grace': 'ambiguous-founding', '@maryam': 'non-rostered', '@vega': 'ambiguous-founding'});
            // Last-seen provider properties are a candidate only: they bind nothing and count as no evidence
            expect(result.identities.find(({id}) => id === '@maryam').candidate).toEqual({...S, providerUserId: '5005'});
            expect(result.unresolved).toEqual(expect.arrayContaining([
                {row: '@ada',    state: 'seedable',           remedy: '`seed --apply`',                  authority: 'the qualified founding record'},
                {row: '@grace',  state: 'ambiguous-founding', remedy: 'an explicit administrative bind', authority: '#1297 on a Fleet plane; a reviewed cutover bind elsewhere'},
                {row: '@maryam', state: 'non-rostered',       remedy: 'an explicit administrative bind', authority: '#1297 on a Fleet plane; a reviewed cutover bind elsewhere'},
                expect.objectContaining({row: `github ${U.providerBaseUrl} 3003`, state: 'identity-unknown', identityIds: ['@clio']})
            ]));
            expect(result.blockers).toEqual([{blocker: 'unbound-active-identities', identities: ['@ada', '@grace', '@maryam', '@vega']}]);
            expect(result.formerSpellings.every(({state}) => state === 'clear')).toBe(true);
            expect(stored(readSubjectBindingRecords)).toEqual([]);
            expect(() => inventory({apply: true, configuredGraphPath: dbPath})).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_INVALID'}));
        });

        test('once every active identity is bound it is ready to activate, and its revision moves with the state', () => {
            const before = inventory().revision;

            seed({apply: true});
            bind({apply: true, subject: T, identityId: '@grace'});
            bind({apply: true, subject: {...S, providerUserId: '4004'}, identityId: '@vega'});

            const result = inventory();

            expect(result).toMatchObject({readyToActivate: true, blockers: []});
            expect(stateOf(result)).toEqual({'@ada': 'bound', '@grace': 'bound', '@vega': 'bound'});
            expect(result.identities.find(({id}) => id === '@ada').binding).toEqual({...S, writer: 'administrative'});
            expect(result.revision).toMatch(/^cutover-inventory-[a-f0-9]{64}$/);
            expect(result.revision).not.toBe(before);
            expect(inventory().revision).toBe(result.revision);
        });

        test('without a qualified founding record every unbound identity waits on identity publication', () => {
            fs.rmSync(dbPath);
            seedGraph({founding: false});

            const result = inventory();

            expect(result.founding).toEqual({state: 'unavailable', code: 'IDENTITY_FOUNDING_SOURCE_UNAVAILABLE'});
            expect(new Set(Object.values(stateOf(result)))).toEqual(new Set(['founding-unavailable']));
            expect(result.unresolved[0]).toEqual({row: 'founding', state: 'founding-unavailable', code: 'IDENTITY_FOUNDING_SOURCE_UNAVAILABLE',
                remedy: 'provision identity publication on this plane: a bound lineage and an installed founding source', authority: 'the lineage issuer'});
            expect(result.blockers.map(({blocker}) => blocker)).toEqual(['founding-unavailable', 'unbound-active-identities']);

            // A plane that never provisioned identity publication names that, not a crash
            expect(inventory({bootText: null}).founding).toEqual({state: 'unavailable', code: 'publication-not-provisioned'});
        });

        test('a row still stored under a former spelling blocks activation, and a reclaimed spelling holding rows is ambiguous', () => {
            node('MESSAGE:legacy', {label: 'MESSAGE', properties: {to: '@neo-gemini-pro', from: '@ada'}});
            insert('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, NULL, ?, ?, ?, ?)', 'edge-legacy', 'AGENT:neo-opus-4-7', 'pr-1', 'IMPLEMENTS', '{}');

            const spelling = (result, handle) => result.formerSpellings.find(entry => entry.spelling === handle);
            let result = inventory();

            expect(spelling(result, '@neo-gemini-pro')).toMatchObject({identityIds: ['@neo-gemini-julia'], sources: ['roster'], reclaimed: false, messages: 1, state: 'legacy-rows'});
            expect(spelling(result, '@neo-opus-4-7')).toMatchObject({identityIds: ['@neo-opus-ada'], edges: [{id: 'edge-legacy', type: 'IMPLEMENTS', source: 'AGENT:neo-opus-4-7', target: 'pr-1'}], state: 'legacy-rows'});
            expect(spelling(result, '@neo-gpt')).toMatchObject({messages: 0, edges: [], state: 'clear'});
            expect(result.blockers).toContainEqual({blocker: 'former-spelling-rows', spellings: ['@neo-gemini-pro', '@neo-opus-4-7']});

            node('@neo-gemini-pro', {label: 'AgentIdentity', properties: {accountType: 'agent'}});
            result = inventory();

            expect(spelling(result, '@neo-gemini-pro')).toMatchObject({reclaimed: true, state: 'ambiguous-legacy-ownership'});
            expect(result.unresolved).toContainEqual({row: '@neo-gemini-pro', state: 'ambiguous-legacy-ownership',
                remedy: 'a reviewed reconciliation: the spelling is a live identity of its own', authority: 'the plane operator'});
        });

        test('a row between two former spellings counts for each of them once, so a reclaimed second spelling stays ambiguous', () => {
            node('MESSAGE:between', {label: 'MESSAGE', properties: {to: '@neo-gpt', from: '@neo-gemini-pro'}});
            node('MESSAGE:self',    {label: 'MESSAGE', properties: {to: '@neo-gpt', from: '@neo-gpt'}});
            insert('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, NULL, ?, ?, ?, ?)', 'edge-between', 'AGENT:neo-gpt', 'AGENT:neo-gemini-pro', 'RELATES_TO', '{}');
            node('@neo-gemini-pro', {label: 'AgentIdentity', properties: {accountType: 'agent'}});

            const
                result   = inventory(),
                spelling = handle => result.formerSpellings.find(entry => entry.spelling === handle),
                edge     = {id: 'edge-between', type: 'RELATES_TO', source: 'AGENT:neo-gpt', target: 'AGENT:neo-gemini-pro'};

            expect(spelling('@neo-gpt')).toMatchObject({reclaimed: false, messages: 2, edges: [edge], state: 'legacy-rows'});
            expect(spelling('@neo-gemini-pro')).toMatchObject({reclaimed: true, messages: 1, edges: [edge], state: 'ambiguous-legacy-ownership'});
            expect(result.unresolved).toContainEqual(expect.objectContaining({row: '@neo-gemini-pro', state: 'ambiguous-legacy-ownership'}));
            expect(result.blockers).toContainEqual({blocker: 'former-spelling-rows', spellings: ['@neo-gemini-pro', '@neo-gpt']});
        });
    });

    test.describe('activate (#1814)', () => {
        const
            activate  = (options = {}) => runSubjectBindingAdmin({dbPath, command: 'activate', bootText, target, configuredGraphPath: dbPath, now: () => 900, ...options}),
            revision  = () => runSubjectBindingAdmin({dbPath, command: 'inventory', bootText, target}).revision,
            activated = () => stored(db => readSubjectBindingRecords(db).find(({type}) => type === 'subject-binding-activation')?.data ?? null),
            bindAll   = () => {
                seed({apply: true});
                bind({apply: true, subject: T, identityId: '@grace'});
                bind({apply: true, subject: {...S, providerUserId: '4004'}, identityId: '@vega'});
            };

        test('refuses while the inventory has a blocker, and writes nothing', () => {
            const reviewed = revision();

            expect(() => activate({cutoverRevision: reviewed, apply: true})).toThrow(expect.objectContaining({
                code    : 'SUBJECT_BINDING_CUTOVER_BLOCKED',
                blockers: [{blocker: 'unbound-active-identities', identities: ['@ada', '@grace', '@vega']}]
            }));
            expect(activated()).toBeNull();
        });

        test('refuses an inventory revision the state has moved past, and one it never named', () => {
            const reviewed = revision();

            bindAll();

            expect(() => activate({cutoverRevision: reviewed, apply: true})).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_CUTOVER_STALE'}));
            expect(() => activate({apply: true})).toThrow(expect.objectContaining({code: 'SUBJECT_BINDING_INVALID'}));
            expect(activated()).toBeNull();
        });

        test('activates on the reviewed revision once every active identity is bound, and only moves forward', () => {
            bindAll();

            const reviewed = revision();

            expect(activate({cutoverRevision: reviewed})).toEqual({ok: true, command: 'activate', applied: false, state: 'ready', revision: reviewed});
            expect(activated()).toBeNull();

            expect(activate({cutoverRevision: reviewed, apply: true})).toMatchObject({applied: true, state: 'activated', activation: {cutoverRevision: reviewed, activatedAt: 900}});
            expect(activated()).toEqual({cutoverRevision: reviewed, activatedAt: 900});

            // Re-running keeps the first record, and the inventory now reads the plane as active
            expect(activate({cutoverRevision: reviewed, apply: true})).toMatchObject({applied: false, state: 'active', activation: {cutoverRevision: reviewed}});
            expect(runSubjectBindingAdmin({dbPath, command: 'inventory', bootText, target}).activation).toEqual({state: 'active', cutoverRevision: reviewed, activatedAt: 900});
        });
    });

    test('list reads the relation', () => {
        bind({apply: true});

        expect(runSubjectBindingAdmin({dbPath, command: 'list'})).toEqual({
            ok: true, command: 'list', records: [{type: 'subject-binding', data: stored(db => readSubjectBinding(db, S))}]
        });
    });

    test('no MCP tool, HTTP route or Fleet wire reaches the administrative writer or the activation', () => {
        const naming = {bindAdministratively: [], activateSubjectBinding: []};

        /** @summary Collects every `ai/` module that names a writer; the two expected hits per writer are the scan's positive control. */
        const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).forEach(entry => {
            const file = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules') walk(file);
            } else if (entry.name.endsWith('.mjs')) {
                const source = fs.readFileSync(file, 'utf8');
                Object.keys(naming).filter(writer => source.includes(writer))
                    .forEach(writer => naming[writer].push(path.relative(process.cwd(), file).split(path.sep).join('/')));
            }
        });

        walk(path.join(process.cwd(), 'ai'));

        for (const writer of Object.keys(naming)) {
            expect(naming[writer].sort(), writer).toEqual([
                'ai/scripts/maintenance/subjectBindings.mjs',
                'ai/services/memory-core/helpers/subjectBinding.mjs'
            ]);
        }
    });
});
