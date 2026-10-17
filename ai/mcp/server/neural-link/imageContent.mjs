import {ImageContentSchema} from '@modelcontextprotocol/sdk/types.js';

/**
 * @summary The image types a Neural Link result may hand to a model as MCP image content.
 */
const IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']),
    // Model APIs cap one image, and a refused image fails the caller's whole turn, while inline text still reaches
    // it. A rendered frame is far below this: 1024×561 is about 100 KB as a PNG.
    MAX_IMAGE_BYTES = 5 * 1024 * 1024,
    // Once a request carries more than 20 images, Anthropic's API refuses any image wider or taller than this
    // (platform.claude.com/docs/en/build-with-claude/vision). A long session reaches 20 images, and a hi-DPI frame
    // (2560×1386) would then fail every later turn, so a larger declared image stays inline.
    MAX_DIMENSION = 2000;

/**
 * @summary True for the objects JSON produces: the only ones that can carry an artifact.
 * @param {*} value
 * @returns {Boolean}
 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;

    const proto = Object.getPrototypeOf(value);

    return proto === Object.prototype || proto === null
}

/**
 * @summary True for a declared image artifact that a client can show.
 * @param {Object} value
 * @returns {Boolean}
 */
function isImageArtifact(value) {
    const {data, height, mimeType, width} = value;

    // The SDK's own image schema judges the base64, so a lifted block is always one the result envelope admits
    return IMAGE_TYPES.has(mimeType) && typeof data === 'string' && data.length > 0 &&
        Buffer.byteLength(data, 'base64') <= MAX_IMAGE_BYTES && !(width > MAX_DIMENSION) && !(height > MAX_DIMENSION) &&
        ImageContentSchema.safeParse({type: 'image', data, mimeType}).success
}

/**
 * @summary Copy-on-write walk: a branch without artifacts is returned as the same object.
 * @param {*} value
 * @param {Object[]} images Collects the image blocks in walk order
 * @returns {*}
 */
function lift(value, images) {
    let copy = null;

    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            const next = lift(item, images);

            if (next !== item) (copy ??= [...value])[index] = next
        });

        return copy ?? value
    }

    if (!isPlainObject(value)) return value;

    if (isImageArtifact(value)) {
        const {data, ...artifact} = value;

        images.push({type: 'image', data, mimeType: value.mimeType});

        // The JSON text is block 0 of the tool result's content, so the image blocks follow from 1
        return {...artifact, contentIndex: images.length}
    }

    for (const key of Object.keys(value)) {
        const item = value[key], next = lift(item, images);

        if (next !== item) (copy ??= {...value})[key] = next
    }

    return copy ?? value
}

/**
 * @summary Moves the declared image artifacts of a Neural Link result into MCP image blocks, so a model sees a
 * rendered frame instead of reading its base64.
 *
 * An artifact is a plain object that declares an image `mimeType` and carries its bytes as a base64 `data` string,
 * as a renderer's draw receipt does: `{width, height, encoding: 'png-base64', mimeType: 'image/png', sha256, data}`.
 * Its `data` becomes an image block; in its place the JSON keeps the artifact's other fields plus `contentIndex`,
 * the block's position in the tool result's `content`. Nothing is guessed: a long string is never an image unless its
 * object declares one, and an artifact above `MAX_IMAGE_BYTES`, declared wider or taller than `MAX_DIMENSION`, or with
 * invalid base64 stays inline.
 *
 * Pure and server-free, like `verifyBridgeToken.mjs`, so the walk is unit-testable without the Bridge.
 * @param {*} result A tool result, e.g. `call_method`'s
 * @returns {{presented: *, images: Object[]}} `presented` is `result` itself when it holds no artifact
 */
export function liftImageArtifacts(result) {
    const images = [];

    return {presented: lift(result, images), images}
}

/**
 * @summary Formats a tool result with its image artifacts appended as MCP image content after the JSON text block.
 * A result without artifacts, and any result the formatter reads as an error, formats exactly as `format` alone would.
 * @param {*} result A tool result
 * @param {Function} format The server's own formatter, e.g. `BaseServer#formatToolResult`
 * @returns {Object} The MCP `{content, isError, structuredContent?}` envelope
 */
export function formatWithImages(result, format) {
    const {presented, images} = liftImageArtifacts(result);

    if (images.length === 0) return format(result);

    const response = format(presented);

    // An error keeps its complete object: its envelope is text, and a pointer would name a block it never gets
    if (response.isError) return format(result);

    // concat, never push(...images): a spread costs one call argument per image, and a long list exceeds the stack
    response.content = response.content.concat(images);

    return response
}
