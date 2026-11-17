import {test, expect}                                from '@playwright/test';
import Database                                      from 'better-sqlite3';
import {generateKeyPairSync, sign}                   from 'node:crypto';
import fs                                            from 'node:fs';
import os                                            from 'node:os';
import path                                          from 'node:path';
import {compileFoundingFamilySeed}                   from '../../../../../../ai/graph/identityFoundingSeed.mjs';
import {stringifyCanonicalJson}                      from '../../../../../../ai/services/shared/canonicalJson.mjs';
import {consumeIdentityPublicationBoot}              from '../../../../../../ai/services/memory-core/helpers/identityPublicationLineage.mjs';
import {installIdentityFoundingSource}               from '../../../../../../ai/services/memory-core/helpers/identityFoundingStorage.mjs';
import {familySubjectStateKey}                       from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';
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
            unattestedReason: 'No model attested', newFamily: false}, 110)).toBe('accepted');
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
            moved   = {...S, providerBaseUrl: 'https://github.example.com/api/v3'},
            again   = {...S, providerBaseUrl: 'https://github.internal/api/v3'},
            keyOf   = subject => familySubjectStateKey({planeId: target.planeId, subject}),
            // the family history the binding reaches: every subject tuple its row names, read by the family-history reader
            history = () => stored(db => {
                const
                    binding  = readIdentityBinding(db, '@ada'),
                    keys     = [binding.providerBaseUrl, ...binding.formerBaseUrls ?? []].map(providerBaseUrl => keyOf({...S, providerBaseUrl})),
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
            ok: true, command: 'seed', applied: false, foundingRevision: 'reviewed-source:fixture',
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

    test('list reads the relation', () => {
        bind({apply: true});

        expect(runSubjectBindingAdmin({dbPath, command: 'list'})).toEqual({
            ok: true, command: 'list', records: [{type: 'subject-binding', data: stored(db => readSubjectBinding(db, S))}]
        });
    });

    test('no MCP tool, HTTP route or Fleet wire reaches the administrative writer', () => {
        const naming = [];

        /** @summary Collects every `ai/` module that names the writer; the two expected hits are the scan's positive control. */
        const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).forEach(entry => {
            const file = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules') walk(file);
            } else if (entry.name.endsWith('.mjs') && fs.readFileSync(file, 'utf8').includes('bindAdministratively')) {
                naming.push(path.relative(process.cwd(), file).split(path.sep).join('/'));
            }
        });

        walk(path.join(process.cwd(), 'ai'));

        expect(naming.sort()).toEqual([
            'ai/scripts/maintenance/subjectBindings.mjs',
            'ai/services/memory-core/helpers/subjectBinding.mjs'
        ]);
    });
});
