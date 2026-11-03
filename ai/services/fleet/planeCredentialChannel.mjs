/**
 * @module ai/services/fleet/planeCredentialChannel
 * @summary The fleet server's end of the launcher's credential pipe (`fleet.planeCredentialFd`).
 *
 * The packaged Fleet Manager keeps the operator's PAT in its main process and hands it over on an
 * inherited fd instead of env, so a PAT update reaches the running server without a restart. Each
 * frame is one JSON line, `{"bearer": "…", "bearerClass": "github-pat"}`: the class travels with its
 * bearer, as the launcher records it. The first frame is the boot bearer, each later one a rotation.
 * Every frame gets one answer line, in arrival order: `{"state": "adopted", "identity": "@x"}`, or
 * `{"state": "refused", "reason": "…"}`, which adds `resolvedIdentity` and `expectedIdentity` when the
 * bearer belongs to another account.
 *
 * A refusal never echoes the frame, which may hold a bearer.
 */
import readline from 'node:readline';

/**
 * @summary Parses one frame without ever echoing it.
 * @param {String} line
 * @returns {Object} `{ok: true, credential: {bearer, bearerClass}}` or `{ok: false, reason}`.
 */
export function parsePlaneCredentialFrame(line) {
    let frame;

    try {
        frame = JSON.parse(line)
    } catch {
        return {ok: false, reason: 'malformed credential frame: not JSON'}
    }

    const bearer = typeof frame?.bearer === 'string' ? frame.bearer.trim() : '';

    if (!bearer) {
        return {ok: false, reason: 'malformed credential frame: no bearer'}
    }

    if (frame.bearerClass !== undefined && typeof frame.bearerClass !== 'string') {
        return {ok: false, reason: 'malformed credential frame: bearerClass is not a string'}
    }

    return {ok: true, credential: {bearer, bearerClass: frame.bearerClass?.trim() ?? ''}}
}

/**
 * @summary Maps a plane proof (`planeMailboxClient#init` or `#rotate`) to the frame's answer.
 * @param {Object} result `{ok: true, identity}` or `{ok: false, reason, resolvedIdentity?}`
 * @param {String} expectedIdentity The viewer this process is bound to
 * @returns {Object}
 */
export function planeCredentialAnswer(result, expectedIdentity) {
    if (result.ok) {
        return {state: 'adopted', identity: result.identity}
    }

    return {
        state : 'refused',
        reason: result.reason,
        ...(result.resolvedIdentity ? {resolvedIdentity: result.resolvedIdentity, expectedIdentity} : {})
    }
}

/**
 * @summary Opens the pipe over a duplex stream: the inherited fd as a `net.Socket`, because the
 * launcher's extra `stdio` pipe is a socket pair.
 * @param {Object} options
 * @param {import('node:stream').Duplex} options.stream
 * @returns {Object} `{next, answer, serve}`
 */
export function openPlaneCredentialChannel({stream}) {
    const
        lines   = readline.createInterface({input: stream, crlfDelay: Infinity})[Symbol.asyncIterator](),
        channel = {
            /**
             * @summary The next frame, parsed; `null` once the launcher closed the pipe.
             * @returns {Promise<Object|null>}
             */
            async next() {
                const {value, done} = await lines.next();

                return done ? null : parsePlaneCredentialFrame(value)
            },

            /**
             * @summary Answers the oldest unanswered frame. Resolves once the line is flushed, so a
             * refused boot can exit right after it.
             * @param {Object} answer
             * @returns {Promise<void>}
             */
            answer(answer) {
                return new Promise(resolve => stream.write(`${JSON.stringify(answer)}\n`, () => resolve()))
            },

            /**
             * @summary Answers each later frame with `adopt(credential)`, one at a time, until the
             * launcher closes the pipe.
             * @param {Function} adopt `credential => Promise<Object>`, the frame's answer
             * @returns {Promise<void>}
             */
            async serve(adopt) {
                for (let frame = await channel.next(); frame; frame = await channel.next()) {
                    await channel.answer(frame.ok ? await adopt(frame.credential) : {state: 'refused', reason: frame.reason})
                }
            }
        };

    return channel
}
