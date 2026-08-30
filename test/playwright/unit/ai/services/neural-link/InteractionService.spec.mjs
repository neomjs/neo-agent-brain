import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'NeuralLinkInteractionServiceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

/**
 * @summary Pins the Brain side of the verified drag contract: exact forwarding, typed
 * failure conversion, and loud incompatibility with older Engine clients. Browser
 * geometry and physical gesture execution remain covered by the Engine repository.
 */
test.describe('Neo.ai.services.neural-link.InteractionService — driveDrag', () => {
    let calls, ConnectionService, InteractionService, originalCall, originalReady;

    test.beforeAll(async () => {
        (await import('../../../../../../ai/mcp/server/neural-link/config.template.mjs')).default.data.autoConnect = false;

        ConnectionService       = (await import('../../../../../../ai/services/neural-link/ConnectionService.mjs')).default;
        originalReady           = ConnectionService.ready;
        ConnectionService.ready = async () => {};
        InteractionService      = (await import('../../../../../../ai/services/neural-link/InteractionService.mjs')).default;
    });

    test.afterAll(() => {
        ConnectionService.ready = originalReady;
    });

    test.beforeEach(() => {
        calls        = [];
        originalCall = ConnectionService.call;
    });

    test.afterEach(() => {
        ConnectionService.call = originalCall;
    });

    test('forwards the validated object once and returns a successful physical receipt unchanged', async () => {
        const receipt = {
            success : true,
            phase   : 'complete',
            released: true,
            observed: {ended: true, moveCount: 8, started: true}
        };

        ConnectionService.call = async (sessionId, operation, payload) => {
            calls.push({operation, payload, sessionId});
            return receipt
        };

        const request = {
            destination: {deltaX: 240, deltaY: 0},
            durationMs : 160,
            sessionId  : 'app-worker-1',
            source     : {anchor: {x: 0.5, y: 0.5}, targetId: 'splitter-1', windowId: 'main'},
            steps      : 8,
            waypoints  : [{clientX: 160, clientY: 80, windowId: 'main'}]
        };
        const result = await InteractionService.driveDrag(request);

        expect(result).toBe(receipt);
        expect(calls).toEqual([{
            operation: 'drive_drag',
            payload  : {
                destination: request.destination,
                durationMs : 160,
                source     : request.source,
                steps      : 8,
                waypoints  : request.waypoints
            },
            sessionId: 'app-worker-1'
        }])
    });

    test('converts an Engine refusal into an object error while retaining the exact partial receipt', async () => {
        const receipt = {
            cleanup : {attempted: false, succeeded: true},
            error   : {code: 'DRIVE_RESOLUTION_FAILED', message: "node 'missing' was not found"},
            observed: {ended: false, moveCount: 0, started: false},
            phase   : 'resolution',
            released: false,
            success : false
        };

        ConnectionService.call = async () => receipt;

        const result = await InteractionService.driveDrag({
            destination: {deltaX: 10, deltaY: 0},
            source     : {targetId: 'missing', windowId: 'main'},
            steps      : 8
        });

        expect(result).toEqual({
            error  : 'Drag gesture failed',
            message: "node 'missing' was not found",
            phase  : 'resolution',
            receipt
        })
    });

    test('rejects an invalid duration before reaching the Engine boundary', async () => {
        ConnectionService.call = async (...args) => calls.push(args);

        await expect(InteractionService.driveDrag({
            destination: {deltaX: 10, deltaY: 0},
            durationMs : 127,
            source     : {targetId: 'splitter-1', windowId: 'main'},
            steps      : 8
        })).rejects.toThrow('durationMs must be at least steps * 16');

        expect(calls).toEqual([])
    });

    test('propagates a missing Engine method clearly and never falls back to simulate_event', async () => {
        ConnectionService.call = async (sessionId, operation) => {
            calls.push(operation);
            throw new Error(`RPC method '${operation}' is not registered`)
        };

        await expect(InteractionService.driveDrag({
            destination: {deltaX: 10, deltaY: 0},
            source     : {targetId: 'splitter-1', windowId: 'main'},
            steps      : 8
        })).rejects.toThrow("RPC method 'drive_drag' is not registered");

        expect(calls).toEqual(['drive_drag'])
    });

    test('rejects an incompatible Engine response instead of reporting a green null result', async () => {
        ConnectionService.call = async () => ({phase: 'legacy'});

        await expect(InteractionService.driveDrag({
            destination: {deltaX: 10, deltaY: 0},
            source     : {targetId: 'splitter-1', windowId: 'main'},
            steps      : 8
        })).rejects.toThrow('Engine drive_drag returned no typed outcome')
    });
});
