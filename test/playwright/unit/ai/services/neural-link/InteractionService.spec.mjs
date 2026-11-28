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
test.describe('Neo.ai.services.neural-link.InteractionService — gesture and drag replay', () => {
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


    const gestureTarget = {provider: 'engine', sessionId: 'app-worker-1', target: 'helix', windowId: 'main'},
          gesturePreset = {kind: 'hold', at: {x: 100, y: 100}};

    test('forwards the gesture to the explicit session without transforming the contact plan', async () => {
        const frames = [{t: 0, contacts: [{id: 'A', x: 15, y: 20, state: 'down'}]}],
              receipt = {provider: 'engine', success: true, trusted: false, observed: []};

        ConnectionService.call = async (...args) => {
            calls.push(args);
            return receipt
        };

        await expect(InteractionService.driveGesture({...gestureTarget, frames, timeoutMs: 31_000})).resolves.toBe(receipt);
        expect(calls).toEqual([['app-worker-1', 'drive_gesture',
            {frames, provider: 'engine', target: 'helix', timeoutMs: 31_000, windowId: 'main'},
            {executionBudgetMs: 31_000}
        ]])
    });

    test('rejects missing or mixed gesture forms before dispatching an RPC', async () => {
        ConnectionService.call = async (...args) => calls.push(args);

        await expect(InteractionService.driveGesture(gestureTarget)).rejects.toThrow('Provide either frames or a preset');
        await expect(InteractionService.driveGesture({...gestureTarget, frames: [], preset: gesturePreset}))
            .rejects.toThrow('Provide either frames or a preset');
        expect(calls).toEqual([])
    });

    test('requires a non-empty session instead of falling back to the sole connected App', async () => {
        ConnectionService.call = async (...args) => calls.push(args);

        for (const sessionId of [undefined, '', '  ']) {
            await expect(InteractionService.driveGesture({...gestureTarget, sessionId, preset: gesturePreset}))
                .rejects.toThrow('An explicit App Worker sessionId is required')
        }

        expect(calls).toEqual([])
    });

    test('keeps an Engine browser refusal and its provider evidence intact', async () => {
        const receipt = {
            error: {code: 'BROWSER_PROVIDER_UNAVAILABLE', message: 'Engine Main has no attached browser-input driver'},
            observed: [], observationAvailable: true, phases: [], provider: 'browser',
            sequences: [], status: 'unavailable', success: false, terminal: 'none', trusted: null
        };

        ConnectionService.call = async (...args) => {
            calls.push(args);
            return receipt
        };

        const result = await InteractionService.driveGesture({...gestureTarget, preset: gesturePreset, provider: 'browser'});
        expect(result).toEqual({error: 'Gesture replay failed', message: receipt.error.message, receipt});
        expect(result.receipt).toBe(receipt);
        expect(calls).toEqual([['app-worker-1', 'drive_gesture',
            {preset: gesturePreset, provider: 'browser', target: 'helix', windowId: 'main'},
            {executionBudgetMs: 31_000}
        ]])
    });

    test('refuses successful receipts from an incompatible provider or untrusted browser path', async () => {
        const request = {...gestureTarget, provider: 'browser', preset: gesturePreset};
        ConnectionService.call = async () => ({provider: 'engine', success: true, trusted: false});
        await expect(InteractionService.driveGesture(request)).rejects.toThrow('no compatible provider receipt');

        ConnectionService.call = async () => ({provider: 'browser', success: true, trusted: false});
        await expect(InteractionService.driveGesture(request)).rejects.toThrow('no compatible provider receipt')
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
