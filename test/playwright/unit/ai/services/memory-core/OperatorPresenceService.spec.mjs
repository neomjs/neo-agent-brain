import {setup} from '../../../../setup.mjs';

const appName = 'OperatorPresenceServiceTest';

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

import {test, expect}         from '@playwright/test';
import Neo                    from 'neo.mjs/src/Neo.mjs';
import * as core              from 'neo.mjs/src/core/_export.mjs';
import RequestContextService  from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import fs                     from 'fs';
import path                   from 'path';
import * as yaml              from 'js-yaml';
import {fileURLToPath}        from 'url';
import {buildOutputZodSchema} from '../../../../../../ai/mcp/validation/openApiValidator.mjs';

if (!Neo.get) Neo.get = () => null;

// Every write is parsed against the DECLARED output schema, with the validator the MCP server applies.
const repoRoot          = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
      memoryCoreOpenApi = yaml.load(fs.readFileSync(path.join(repoRoot, 'ai/mcp/server/memory-core/openapi.yaml'), 'utf8')),
      setOutputSchema   = buildOutputZodSchema(memoryCoreOpenApi, memoryCoreOpenApi.paths['/operator-presence/set'].post);

/**
 * @summary The operator's present/away record: only a human principal writes it, every seat reads it,
 * and an away past its `until` reads present.
 */
test.describe('Neo.ai.services.memory-core.OperatorPresenceService', () => {
    test.describe.configure({mode: 'serial'});

    let GraphService, LifecycleService, OperatorPresenceService;

    const T0       = '2026-11-12T22:00:00.000Z',
          LATER    = '2026-11-12T23:00:00.000Z',
          MORNING  = '2026-11-13T08:00:00.000Z',
          operator = {userId: 'operator', agentIdentityNodeId: '@operator'},
          agent    = {userId: 'agent',    agentIdentityNodeId: '@agent'},
          as       = (ctx, fn)               => RequestContextService.run(ctx, fn),
          set      = (ctx, args, now = T0)   => as(ctx, () => OperatorPresenceService.setOperatorPresence({now, ...args})),
          read     = now                     => OperatorPresenceService.getOperatorPresence(now);

    test.beforeAll(async () => {
        GraphService            = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        LifecycleService        = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        OperatorPresenceService = (await import('../../../../../../ai/services/memory-core/OperatorPresenceService.mjs')).default;

        if (!LifecycleService._initPromise) {
            await LifecycleService.initAsync();
        } else {
            await LifecycleService.ready();
        }
    });

    test.afterAll(async () => {
        const {cleanupChromaManager} = await import('./util.mjs');
        await cleanupChromaManager();
    });

    test.beforeEach(async () => {
        GraphService.db.nodes.clear();
        GraphService.db.edges.clear();
        GraphService.db.vicinityLoadedNodes.clear();
        await GraphService.db.storage.clear();
        GraphService.db.storage.db.exec('DELETE FROM GraphLog');

        GraphService.upsertNode({id: '@operator', type: 'AgentIdentity', name: 'Operator', properties: {accountType: 'human'}});
        GraphService.upsertNode({id: '@agent',    type: 'AgentIdentity', name: 'Agent',    properties: {accountType: 'agent'}});
    });

    test('no record reads present, the fleet\'s standing assumption', () => {
        expect(read(T0)).toEqual({mode: 'present', since: null, until: null, setBy: null});
    });

    test('the operator goes away until morning, and every seat reads it', () => {
        const result = set(operator, {mode: 'away', until: '2026-11-13T08:00:00Z'});

        expect(result).toEqual({
            operatorPresence: {mode: 'away', since: T0, until: MORNING, setBy: '@operator'},
            changed         : true
        });
        expect(() => setOutputSchema.parse(result)).not.toThrow();
        expect(read(LATER).mode).toBe('away');

        // the row carries the operator's tenant key, and an agent's RLS-scoped read still sees it
        expect(as(agent, () => GraphService.getNodeRecord({id: 'OPERATOR_PRESENCE'}))?.properties.mode).toBe('away');
    });

    test('the same state again is no change and keeps since; a new until is a change that keeps since', () => {
        set(operator, {mode: 'away'});

        expect(set(operator, {mode: 'away'}, LATER)).toEqual({
            operatorPresence: {mode: 'away', since: T0, until: null, setBy: '@operator'},
            changed         : false
        });
        expect(set(operator, {mode: 'away', until: MORNING}, LATER)).toEqual({
            operatorPresence: {mode: 'away', since: T0, until: MORNING, setBy: '@operator'},
            changed         : true
        });
    });

    test('coming back is a change, and since moves to the return', () => {
        set(operator, {mode: 'away'});

        expect(set(operator, {mode: 'present'}, LATER)).toEqual({
            operatorPresence: {mode: 'present', since: LATER, until: null, setBy: '@operator'},
            changed         : true
        });
    });

    test('an away past its until reads present, flagged expired, and returning after it is no change', () => {
        set(operator, {mode: 'away', until: MORNING});

        const expired = read(MORNING);

        expect(expired).toEqual({mode: 'present', since: MORNING, until: null, setBy: '@operator', expired: true});
        expect(() => setOutputSchema.parse({operatorPresence: expired, changed: false})).not.toThrow();

        // readers already see present, so the return announces nothing
        expect(set(operator, {mode: 'present'}, '2026-11-13T09:00:00.000Z')).toEqual({
            operatorPresence: {mode: 'present', since: MORNING, until: null, setBy: '@operator'},
            changed         : false
        });
    });

    test('an agent, an external human, and a human marked operator: false are refused; the record stays as it was', () => {
        set(operator, {mode: 'away'});

        GraphService.upsertNode({id: '@guest',  type: 'AgentIdentity', name: 'Guest',  properties: {accountType: 'human', trustTier: 'external'}});
        GraphService.upsertNode({id: '@viewer', type: 'AgentIdentity', name: 'Viewer', properties: {accountType: 'human', operator: false}});

        expect(() => set(agent, {mode: 'present'})).toThrow(/'@agent' is not the human operator/);
        expect(() => set({userId: 'guest',  agentIdentityNodeId: '@guest'},  {mode: 'present'})).toThrow(/'@guest' is not the human operator/);
        expect(() => set({userId: 'viewer', agentIdentityNodeId: '@viewer'}, {mode: 'present'})).toThrow(/'@viewer' is not the human operator/);
        expect(read(LATER)).toEqual({mode: 'away', since: T0, until: null, setBy: '@operator'});
    });

    test('a call with no bound identity is refused', () => {
        expect(() => OperatorPresenceService.setOperatorPresence({mode: 'away', now: T0})).toThrow(/no agent identity context bound/);
    });

    test('an invalid mode or until is refused before anything is written', () => {
        expect(() => set(operator, {mode: 'gone'})).toThrow(/Invalid mode 'gone'/);
        expect(() => set(operator, {mode: 'present', until: MORNING})).toThrow(/until applies to away only/);
        expect(() => set(operator, {mode: 'away', until: 'tomorrow'})).toThrow(/Invalid until 'tomorrow'/);
        expect(() => set(operator, {mode: 'away', until: '2026-11-12T21:00:00Z'})).toThrow(/has already passed/);

        expect(read(T0)).toEqual({mode: 'present', since: null, until: null, setBy: null});
    });
});
