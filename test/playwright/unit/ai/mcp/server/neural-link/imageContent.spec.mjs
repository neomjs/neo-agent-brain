import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'ImageContentTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                         from '@playwright/test';
import Neo                                    from 'neo.mjs/src/Neo.mjs';
import * as core                              from 'neo.mjs/src/core/_export.mjs';
import BaseServer                             from '../../../../../../../ai/mcp/server/BaseServer.mjs';
import {formatWithImages, liftImageArtifacts} from '../../../../../../../ai/mcp/server/neural-link/imageContent.mjs';

// A 1×1 PNG, carried the way a draw receipt carries its frame
const PNG      = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      artifact = () => ({width: 1, height: 1, encoding: 'png-base64', mimeType: 'image/png', sha256: 'ab12', data: PNG}),
      // The real envelope: BaseServer's formatter reads no instance state
      format   = value => BaseServer.prototype.formatToolResult.call(null, value);

test.describe('Neural Link image content (imageContent.mjs)', () => {
    test('a result without artifacts is the same object and formats exactly as BaseServer formats it', () => {
        const result = {result: {status: 'drawn', receipt: {frame: 3, materials: [{index: 0, roughnessFactor: 0.08}]}}};

        expect(liftImageArtifacts(result)).toEqual({presented: result, images: []});
        expect(liftImageArtifacts(result).presented).toBe(result);
        expect(formatWithImages(result, format)).toEqual(format(result));

        for (const value of [null, undefined, 42, 'text', [1, {a: 2}]]) {
            expect(liftImageArtifacts(value).presented).toBe(value)
        }
    });

    test('a nested PNG artifact becomes an image block after the JSON text, leaving a pointer', () => {
        const parts                               = [{nodeIndex: 25, primitiveIndex: 0, visible: 33698}],
              result                              = {result: {status: 'drawn', receipt: {frame: 4, inspection: {parts, color: artifact(), ids: artifact()}}}},
              response                            = formatWithImages(result, format),
              {color, ids, parts: presentedParts} = response.structuredContent.result.receipt.inspection;

        expect(response.isError).toBe(false);
        expect(response.content.map(block => block.type)).toEqual(['text', 'image', 'image']);
        expect(response.content[1]).toEqual({type: 'image', data: PNG, mimeType: 'image/png'});
        expect(color).toEqual({width: 1, height: 1, encoding: 'png-base64', mimeType: 'image/png', sha256: 'ab12', contentIndex: 1});
        expect(ids.contentIndex).toBe(2);
        expect(response.content[0].text).toContain('"contentIndex": 1');
        expect(response.content[0].text).not.toContain(PNG);
        // Copy-on-write: the caller's object keeps its bytes, an untouched branch keeps its identity
        expect(result.result.receipt.inspection.color.data).toBe(PNG);
        expect(presentedParts).toBe(parts)
    });

    test('artifacts in an array lift in walk order', () => {
        const plain               = {index: 1},
              {presented, images} = liftImageArtifacts({frames: [artifact(), plain, artifact()]});

        expect(images).toHaveLength(2);
        expect(presented.frames.map(frame => frame.contentIndex ?? null)).toEqual([1, null, 2]);
        expect(presented.frames[1]).toBe(plain)
    });

    test('only a declared image a client can show is lifted', () => {
        class Artifact {
            constructor() { Object.assign(this, artifact()) }
        }

        const oversized = 'A'.repeat(Math.ceil(5 * 1024 * 1024 * 4 / 3) + 4),
              refused   = [
                  {...artifact(), mimeType: 'image/svg+xml'},
                  {...artifact(), mimeType: 'application/pdf'},
                  {...artifact(), mimeType: undefined},
                  {...artifact(), data: 42},
                  {...artifact(), data: ''},
                  {...artifact(), data: 'not base64!'},
                  {...artifact(), data: `data:image/png;base64,${PNG}`},
                  {...artifact(), data: oversized},
                  {...artifact(), width: 2560, height: 1386},
                  {...artifact(), width: 1280, height: 2001},
                  new Artifact()
              ];

        for (const value of refused) {
            const wrapped = {receipt: {color: value}};

            expect(liftImageArtifacts(wrapped)).toEqual({presented: wrapped, images: []});
            expect(liftImageArtifacts(wrapped).presented).toBe(wrapped)
        }
    });

    test('an image at the dimension bound, or with no declared dimensions, is lifted', () => {
        for (const value of [{...artifact(), width: 2000, height: 2000}, {mimeType: 'image/png', data: PNG}]) {
            expect(liftImageArtifacts({color: value}).images).toEqual([{type: 'image', data: PNG, mimeType: 'image/png'}])
        }
    });

    test('an error result keeps its complete object and gets no image block', () => {
        const failure  = {error: 'Inspection failed', message: 'context lost', receipt: {color: artifact()}},
              response = formatWithImages(failure, format);

        expect(response).toEqual(format(failure));
        expect(response.isError).toBe(true);
        expect(response.content).toHaveLength(1);
        expect(response.structuredContent.receipt.color.data).toBe(PNG)
    });
});
