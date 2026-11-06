import {test, expect} from '@playwright/test';
import {
    demultiplexDockerLogs,
    dockerLogFraming,
    isMultiplexedDockerStream
} from '../../../../../../../ai/daemons/orchestrator/services/dockerLogStream.mjs';

const MULTIPLEXED = {'api-version': '1.47', 'content-type': 'application/vnd.docker.multiplexed-stream'},
      RAW         = {'api-version': '1.47', 'content-type': 'application/vnd.docker.raw-stream'};

/**
 * @summary One Docker stream frame: the 8-byte header (stream byte, three zero bytes, big-endian size), then the payload.
 * @param {Number} stream 1 stdout, 2 stderr
 * @param {Buffer|String} payload
 * @returns {Buffer}
 */
const frame = (stream, payload) => {
    const bytes  = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8'),
          header = Buffer.alloc(8);

    header[0] = stream;
    header.writeUInt32BE(bytes.length, 4);

    return Buffer.concat([header, bytes])
};

test.describe('ai/daemons/orchestrator/services/dockerLogStream', () => {
    test('interleaved stdout and stderr frames read as their text, in arrival order', () => {
        const body = Buffer.concat([frame(1, 'booted\n'), frame(2, 'warn: slow disk\n'), frame(1, 'ready\n')]);

        expect(isMultiplexedDockerStream(body)).toBe(true);
        expect(demultiplexDockerLogs(body)).toBe('booted\nwarn: slow disk\nready\n')
    });

    test('a frame of 200 bytes keeps its text: the size byte 0xC8 never reaches the decoder', () => {
        const line = `${'x'.repeat(199)}\n`;

        expect(demultiplexDockerLogs(frame(1, line))).toBe(line)
    });

    test('a frame of 10 bytes adds no line: its size byte is 0x0A', () => {
        const text = demultiplexDockerLogs(Buffer.concat([frame(1, '123456789\n'), frame(1, 'done\n')]));

        expect(text).toBe('123456789\ndone\n');
        expect(text.split('\n')).toHaveLength(3)
    });

    test('a character written across two frames of one stream stays whole', () => {
        const euro = Buffer.from('€', 'utf8'); // three bytes

        const body = Buffer.concat([
            frame(1, Buffer.concat([Buffer.from('price '), euro.subarray(0, 1)])),
            frame(2, 'stderr between\n'),
            frame(1, Buffer.concat([euro.subarray(1), Buffer.from('5\n')]))
        ]);

        expect(demultiplexDockerLogs(body)).toBe('price stderr between\n€5\n')
    });

    test('a raw TTY stream is not a frame chain and decodes as plain text', () => {
        const raw = Buffer.from('plain tty output\nsecond line\n', 'utf8');

        expect(isMultiplexedDockerStream(raw)).toBe(false);
        expect(demultiplexDockerLogs(raw)).toBe('plain tty output\nsecond line\n')
    });

    test('a frame chain cut short is not multiplexed, so nothing is dropped', () => {
        const cut = frame(1, 'complete line\n').subarray(0, 12);

        expect(isMultiplexedDockerStream(cut)).toBe(false);
        expect(demultiplexDockerLogs(cut)).toBe(cut.toString('utf8'))
    });

    test('an already decoded string passes through, and an empty body reads as no text', () => {
        expect(demultiplexDockerLogs('service booted')).toBe('service booted');
        expect(demultiplexDockerLogs(Buffer.alloc(0))).toBe('');
        expect(demultiplexDockerLogs(Buffer.alloc(0), {headers: MULTIPLEXED})).toBe('');
        expect(demultiplexDockerLogs(null)).toBe('')
    });

    test('the declared framing decides; a raw label counts only from API 1.42', () => {
        expect(dockerLogFraming(MULTIPLEXED)).toBe('multiplexed');
        expect(dockerLogFraming(RAW)).toBe('raw');
        expect(dockerLogFraming({'api-version': '1.41', 'content-type': 'application/vnd.docker.raw-stream'})).toBeNull();
        expect(dockerLogFraming({})).toBeNull();
        expect(dockerLogFraming()).toBeNull()
    });

    test('a declared raw stream keeps every byte, even when its bytes form a frame chain', () => {
        const chainLike = frame(1, 'tty text that happens to look framed\n');

        expect(isMultiplexedDockerStream(chainLike)).toBe(true);
        expect(Buffer.from(demultiplexDockerLogs(chainLike, {headers: RAW}), 'utf8').equals(chainLike)).toBe(true);
        expect(demultiplexDockerLogs(chainLike, {headers: {'api-version': '1.41', 'content-type': 'application/vnd.docker.raw-stream'}}))
            .toBe('tty text that happens to look framed\n')
    });

    test('a daemon-error frame (stream 3) fails the read with its message', () => {
        const body = Buffer.concat([frame(1, 'booted\n'), frame(3, 'error from daemon in stream: log file rotated\n')]);

        expect(isMultiplexedDockerStream(body)).toBe(true);
        expect(() => demultiplexDockerLogs(body, {headers: MULTIPLEXED})).toThrow('Docker log stream failed: error from daemon in stream: log file rotated');
        expect(() => demultiplexDockerLogs(body)).toThrow('Docker log stream failed')
    });

    test('a declared multiplexed stream that is not a frame chain fails the read', () => {
        expect(() => demultiplexDockerLogs(Buffer.from('plain text\n'), {headers: MULTIPLEXED}))
            .toThrow('not a complete frame chain')
    })
});
