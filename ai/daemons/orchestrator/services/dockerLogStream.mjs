import {StringDecoder} from 'node:string_decoder';

// One stream byte (0 stdin, 1 stdout, 2 stderr), three zero bytes, a big-endian payload size
const FRAME_HEADER_BYTES = 8;

/**
 * @summary Whether `bytes` is one complete chain of Docker stream frames, from its first byte to its last.
 *
 * A container without a TTY sends its logs as such a chain; a TTY container sends raw text, which does not
 * chain, so a body that fails this test is not multiplexed.
 * @param {Buffer} bytes
 * @returns {Boolean}
 */
export function isMultiplexedDockerStream(bytes) {
    let offset = 0;

    while (offset < bytes.length) {
        if (offset + FRAME_HEADER_BYTES > bytes.length || bytes[offset] > 2 ||
            bytes[offset + 1] !== 0 || bytes[offset + 2] !== 0 || bytes[offset + 3] !== 0) {
            return false
        }

        offset += FRAME_HEADER_BYTES + bytes.readUInt32BE(offset + 4)
    }

    return bytes.length > 0 && offset === bytes.length
}

/**
 * @summary Turns a Docker log response body into its log text, without the stream's frame headers.
 *
 * The frames are cut on the bytes, before decoding: decoded first, a size byte of 0x80 or more becomes
 * U+FFFD and a size of 10 a newline. Each stream decodes through its own `StringDecoder`, so a character
 * written across two writes stays whole. Frames keep Docker's arrival order. A body that is not a frame
 * chain decodes as plain UTF-8, and a string passes through.
 * @param {Buffer|String} body
 * @returns {String}
 */
export function demultiplexDockerLogs(body) {
    if (typeof body === 'string') {
        return body
    }

    if (!Buffer.isBuffer(body) || !isMultiplexedDockerStream(body)) {
        return Buffer.isBuffer(body) ? body.toString('utf8') : ''
    }

    const decoders = new Map();
    let   offset   = 0,
          text     = '';

    while (offset < body.length) {
        const stream = body[offset],
              end    = offset + FRAME_HEADER_BYTES + body.readUInt32BE(offset + 4);

        decoders.has(stream) || decoders.set(stream, new StringDecoder('utf8'));
        text  += decoders.get(stream).write(body.subarray(offset + FRAME_HEADER_BYTES, end));
        offset = end
    }

    decoders.forEach(decoder => {text += decoder.end()});

    return text
}
