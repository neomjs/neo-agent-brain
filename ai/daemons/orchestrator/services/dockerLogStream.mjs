import {StringDecoder} from 'node:string_decoder';

// One stream byte (0 stdin, 1 stdout, 2 stderr, 3 daemon error), three zero bytes, a big-endian payload size
const FRAME_HEADER_BYTES = 8;
const SYSTEMERR          = 3;

/**
 * @summary Whether `bytes` is one complete chain of Docker stream frames, from its first byte to its last.
 * @param {Buffer} bytes
 * @returns {Boolean}
 */
export function isMultiplexedDockerStream(bytes) {
    let offset = 0;

    while (offset < bytes.length) {
        if (offset + FRAME_HEADER_BYTES > bytes.length || bytes[offset] > SYSTEMERR ||
            bytes[offset + 1] !== 0 || bytes[offset + 2] !== 0 || bytes[offset + 3] !== 0) {
            return false
        }

        offset += FRAME_HEADER_BYTES + bytes.readUInt32BE(offset + 4)
    }

    return bytes.length > 0 && offset === bytes.length
}

/**
 * @summary The framing a Docker log response declares: `multiplexed`, `raw`, or `null` when it does not say.
 *
 * From API 1.42 the daemon labels a TTY container's stream raw and any other multiplexed. Before 1.42 it labels
 * every log stream raw, so only that version makes a raw label authoritative.
 * @param {Object} [headers={}] Response headers
 * @returns {'multiplexed'|'raw'|null}
 */
export function dockerLogFraming(headers = {}) {
    const type    = String(headers['content-type'] ?? ''),
          version = Number.parseFloat(headers['api-version']);

    if (type.includes('multiplexed-stream')) return 'multiplexed';
    if (type.includes('raw-stream') && version >= 1.42) return 'raw';

    return null
}

/**
 * @summary Turns a Docker log response body into its log text, without the stream's frame headers.
 *
 * The declared framing decides; an undeclared response is multiplexed only when its bytes form a complete frame
 * chain. Frames are cut on the bytes, before decoding: decoded first, a size byte of 0x80 or more becomes U+FFFD
 * and a size of 10 a newline. Each stream decodes through its own `StringDecoder`, so a character written across
 * two writes stays whole, and frames keep Docker's arrival order. A daemon-error frame (stream 3) fails the read.
 * @param {Buffer|String} body
 * @param {Object} [options]
 * @param {Object} [options.headers] Response headers, read for the declared framing
 * @returns {String}
 */
export function demultiplexDockerLogs(body, {headers} = {}) {
    if (typeof body === 'string') return body;
    if (!Buffer.isBuffer(body) || body.length === 0) return '';

    const framing = dockerLogFraming(headers);

    if (framing === 'raw' || (framing === null && !isMultiplexedDockerStream(body))) {
        return body.toString('utf8')
    }

    if (!isMultiplexedDockerStream(body)) {
        throw new Error('Docker declared a multiplexed log stream that is not a complete frame chain')
    }

    const decoders    = new Map();
    let   daemonError = '',
          offset      = 0,
          text        = '';

    while (offset < body.length) {
        const stream  = body[offset],
              end     = offset + FRAME_HEADER_BYTES + body.readUInt32BE(offset + 4),
              payload = body.subarray(offset + FRAME_HEADER_BYTES, end);

        if (stream === SYSTEMERR) {
            daemonError += payload.toString('utf8')
        } else {
            decoders.has(stream) || decoders.set(stream, new StringDecoder('utf8'));
            text += decoders.get(stream).write(payload)
        }

        offset = end
    }

    if (daemonError) {
        throw new Error(`Docker log stream failed: ${daemonError.trim().slice(0, 512)}`)
    }

    decoders.forEach(decoder => {text += decoder.end()});

    return text
}
