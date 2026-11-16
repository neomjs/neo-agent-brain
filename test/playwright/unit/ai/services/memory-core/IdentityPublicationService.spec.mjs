import {test, expect} from '@playwright/test';
import {spawnSync}    from 'node:child_process';

const serviceUrl = new URL('../../../../../../ai/services/memory-core/IdentityPublicationService.mjs', import.meta.url).href;
const helper     = name => new URL('../../../../../../ai/services/memory-core/helpers/' + name + '.mjs', import.meta.url).href;
const shared     = name => new URL('../../../../../../ai/services/shared/' + name + '.mjs', import.meta.url).href;
const seedUrl    = new URL('../../../../../../ai/graph/identityFoundingSeed.mjs', import.meta.url).href;

test('boot composition preserves signed bytes, physical refusal and coherent founding snapshots', () => {
    const script = `
        import assert from 'node:assert/strict';
        import {registerHooks} from 'node:module';
        import {generateKeyPairSync, sign} from 'node:crypto';
        import Database from 'better-sqlite3';
        import {stringifyCanonicalJson} from ${JSON.stringify(shared('canonicalJson'))};
        import {compileFoundingFamilySeed} from ${JSON.stringify(seedUrl)};
        import {consumeIdentityPublicationBoot, readIdentityPublicationLineage} from ${JSON.stringify(helper('identityPublicationLineage'))};
        import {admitIdentityPublication, readIdentityPublicationSnapshot} from ${JSON.stringify(helper('identityPublicationAdmission'))};
        import {installIdentityFoundingSource} from ${JSON.stringify(helper('identityFoundingStorage'))};
        import {fenceIdentityPublication} from ${JSON.stringify(helper('identityPublicationFence'))};
        await import('neo.mjs/src/Neo.mjs');
        await import('neo.mjs/src/core/_export.mjs');
        const db = new Database(':memory:');
        db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL); CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);');
        const target = {planeId: 'composition-fixture', dataRoot: '/fixture/composition'};
        const pair = generateKeyPairSync('ed25519');
        const reservation = {version: 1, target, issuer: 'fixture-fleet', reservation: {
            attemptId: 'fixture-attempt', kid: 'fixture-key', originRunId: '123e4567-e89b-42d3-a456-426614174000'}, trust: null};
        const reserveText = stringifyCanonicalJson(reservation);
        const boundText = stringifyCanonicalJson({...reservation, trust: [{kid: 'fixture-key',
            publicKey: pair.publicKey.export({type: 'spki', format: 'der'}).toString('base64url')}]});
        globalThis.fixtureConfig = {identityPublicationBoot: null, identityPublicationFounding: null,
            plane: {id: target.planeId, dataRoot: target.dataRoot}};
        let bootCalls = 0, receivedToken = null;
        globalThis.fixtureGraph = {
            async ready() {},
            consumeIdentityPublicationBoot(text, resolvedTarget) {
                bootCalls++; assert.deepEqual(resolvedTarget, target);
                return consumeIdentityPublicationBoot(db, text, resolvedTarget);
            },
            admitIdentityPublication(token, options) {
                receivedToken = token;
                assert.equal(options.bootText, boundText); assert.deepEqual(options.target, target);
                assert.equal(Object.hasOwn(options, 'clock'), false);
                return admitIdentityPublication(db, token, options);
            },
            installIdentityFoundingSource(options) {return installIdentityFoundingSource(db, options);},
            readIdentityPublicationSnapshot(options) {return readIdentityPublicationSnapshot(db, options);},
            readIdentityPublicationLineage(text, resolvedTarget) {return readIdentityPublicationLineage(db, text, resolvedTarget);}
        };
        const serviceUrl = ${JSON.stringify(serviceUrl)};
        const modules = new Map([
            ['../../mcp/server/memory-core/config.mjs', 'export default globalThis.fixtureConfig'],
            ['./GraphService.mjs', 'export default globalThis.fixtureGraph']
        ]);
        const seen = new Set();
        const hooks = registerHooks({resolve(specifier, context, nextResolve) {
            if (context.parentURL === serviceUrl && modules.has(specifier)) {
                seen.add(specifier);
                return {url: 'data:text/javascript,' + encodeURIComponent(modules.get(specifier)), shortCircuit: true};
            }
            return nextResolve(specifier, context);
        }});
        try {
            const service = (await import(serviceUrl)).default;
            await service.ready();
            assert.equal(service.configureBoot(), null);
            assert.equal((await service.start()).code, 'publication-not-provisioned');
            assert.equal(bootCalls, 0);
            assert.equal(service.getIdentityPublicationSnapshot().state, 'unavailable');
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Nodes').get().n, 0);

            globalThis.fixtureConfig.identityPublicationBoot = reserveText;
            const reserveBoundary = service.configureBoot();
            assert.equal(reserveBoundary.publicKeys.size, 0);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Nodes').get().n, 0);
            assert.equal((await service.start()).state, 'reserved');
            const reserved = service.getIdentityPublicationLineage();
            assert.equal(reserved.reservation.originRunId, reservation.reservation.originRunId);
            assert.equal(reserved.fingerprint, null);

            const seed = compileFoundingFamilySeed({identities: [{id: '@founder', type: 'AgentIdentity',
                properties: {accountType: 'agent', modelFamily: 'gpt'}}], subjects: [{identityKey: '@founder',
                subject: {authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: 'founder'}}]});
            globalThis.fixtureConfig.identityPublicationBoot = boundText;
            globalThis.fixtureConfig.identityPublicationFounding = stringifyCanonicalJson({seed, sourceRevision: 'fixture-reviewed-source'});
            const boundary = service.configureBoot();
            assert.equal((await service.start()).state, 'bound');
            assert.equal((await service.start()).state, 'bound');
            assert.equal(service.getIdentityPublicationLineage().reservation.originRunId, reserved.reservation.originRunId);
            const now = Date.now();
            const operation = {kind: 'baseline', operationId: 'baseline', effectiveAt: now,
                expectedPlaneRevision: 0, bindings: []};
            const payload = Buffer.from(stringifyCanonicalJson({version: 1, purpose: 'identity-family-publication',
                audience: target.planeId, issuer: reservation.issuer, kid: 'fixture-key',
                issuedAt: now, expiresAt: now + 300000, operation}));
            const token = payload.toString('base64url') + '.' + sign(null,
                Buffer.concat([Buffer.from('neo.identity-family-publication.v1\\0'), payload]), pair.privateKey).toString('base64url');
            assert.equal(boundary.admit(token).body.state, 'accepted');
            assert.equal(receivedToken, token);
            assert.equal(boundary.admit(token).body.state, 'idempotent');
            const read = service.getIdentityPublicationSnapshot({target: {planeId: 'forged'}, clock: () => 0});
            assert.equal(read.state, 'available');
            assert.deepEqual(read.snapshot.target, target);
            assert.equal(read.snapshot.counts.subjects, 1);
            assert.equal(read.snapshot.counts.admittedSubjects, 0);
            assert.deepEqual(read.snapshot.founding, seed);
            assert.equal(read.snapshot.foundingRevision, 1);
            assert.equal(read.snapshot.foundingProvenance.sourceRevision, 'fixture-reviewed-source');
            const retainedSource = read.snapshot.foundingProvenance;

            for (const method of ['ready', 'consumeIdentityPublicationBoot']) {
                const original = globalThis.fixtureGraph[method];
                const cause = Object.assign(new Error('fixture-private-owner-detail'), {
                    code: 'untrusted-owner-code', statusCode: 201, credential: 'fixture-private-credential'
                });
                globalThis.fixtureGraph[method] = method === 'ready'
                    ? async () => {throw cause;}
                    : () => {throw cause;};
                service.configureBoot();
                assert.equal(service.getIdentityPublicationLineage().state, 'bound', 'pending boot does not hide the retained lineage');
                try {
                    await assert.rejects(service.start(), error => {
                        assert.equal(error.cause, cause, method + ' preserves the original exception locally');
                        assert.equal(error.code, 'publication-boot-unavailable');
                        assert.equal(error.message, 'Identity publication boot unavailable: publication-boot-unavailable');
                        assert.deepEqual(Object.keys(error), ['code']);
                        assert.equal(JSON.stringify(error), '{"code":"publication-boot-unavailable"}');
                        return true;
                    });
                    assert.deepEqual(service.publish(token), {statusCode: 503, body: {state: 'unavailable', code: 'publication-boot-unavailable'}});
                    assert.deepEqual(service.getIdentityPublicationSnapshot(), {state: 'unavailable', code: 'publication-boot-unavailable'});
                    assert.equal(service.getIdentityPublicationLineage().state, 'bound', 'failed boot still permits read-only lineage reconciliation');
                } finally {globalThis.fixtureGraph[method] = original;}
                assert.equal((await service.start()).state, 'bound');
            }

            globalThis.fixtureConfig.identityPublicationFounding = stringifyCanonicalJson({
                seed: compileFoundingFamilySeed({identities: [], subjects: []}), sourceRevision: 'replacement'});
            service.configureBoot();
            await assert.rejects(service.start(), /founding-source-conflict/);
            assert.equal(service.publish(token).statusCode, 503);
            assert.equal(service.getIdentityPublicationSnapshot().code, 'founding-source-conflict');
            assert.deepEqual(readIdentityPublicationSnapshot(db, {bootText: boundText, target}).snapshot.founding, seed);
            globalThis.fixtureConfig.identityPublicationFounding = stringifyCanonicalJson({seed, sourceRevision: 'new-reference'});
            service.configureBoot();
            await service.start();
            assert.deepEqual(service.getIdentityPublicationSnapshot().snapshot.foundingProvenance, retainedSource);
            boundary.publicKeys.clear();
            assert.equal(service.getBoundary().publicKeys.size, 1);
            db.transaction(() => fenceIdentityPublication(db, {...target, operation: 'fixture-restore', source: 'fixture'})).immediate();
            assert.equal(boundary.admit(token).body.code, 'publication-restore-fenced');
            assert.equal(service.getIdentityPublicationSnapshot().code, 'publication-restore-fenced');
            await assert.rejects(service.start(), /publication-restore-fenced/);
            assert.equal(service.getIdentityPublicationLineage().state, 'fenced');
            assert.deepEqual(seen, new Set(modules.keys()));
            service.destroy();
        } finally {hooks.deregister(); db.close();}
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {encoding: 'utf8', timeout: 20000});
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
});
