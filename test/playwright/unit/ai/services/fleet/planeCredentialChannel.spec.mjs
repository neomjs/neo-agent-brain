import {test, expect}          from '@playwright/test';
import {Duplex, PassThrough} from 'node:stream';

import {openPlaneCredentialChannel, parsePlaneCredentialFrame, planeCredentialAnswer} from '../../../../../../ai/services/fleet/planeCredentialChannel.mjs';

const BEARER = 'ghp_piped_fixture_bearer';

/**
 * @summary The two ends of a credential pipe: the server's duplex, and the launcher's write side
 * plus every answer line it has read.
 * @returns {{stream: Duplex, send: Function, end: Function, answers: Object[], answered: Function}}
 */
function pipePair() {
    const
        toServer   = new PassThrough(),
        toLauncher = new PassThrough(),
        answers    = [];

    let buffered = '';

    toLauncher.on('data', chunk => {
        const lines = (buffered + chunk).split('\n');

        buffered = lines.pop();
        lines.forEach(line => answers.push(JSON.parse(line)))
    });

    return {
        stream  : Duplex.from({readable: toServer, writable: toLauncher}),
        send    : frame => toServer.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`),
        end     : () => toServer.end(),
        answers,
        answered: count => expect.poll(() => answers.length).toBe(count)
    }
}

test.describe('planeCredentialChannel: frames', () => {
    test('a frame carries a bearer and the class that travels with it; an absent class is empty', () => {
        expect(parsePlaneCredentialFrame(JSON.stringify({bearer: ` ${BEARER} `, bearerClass: 'github-pat'})))
            .toEqual({ok: true, credential: {bearer: BEARER, bearerClass: 'github-pat'}});
        expect(parsePlaneCredentialFrame(JSON.stringify({bearer: BEARER})))
            .toEqual({ok: true, credential: {bearer: BEARER, bearerClass: ''}})
    });

    test('a malformed frame is refused by its shape, and the refusal never echoes what it carried', () => {
        const refusals = [
            BEARER,
            JSON.stringify({token: BEARER}),
            JSON.stringify({bearer: '   '}),
            JSON.stringify({bearer: BEARER, bearerClass: 7})
        ].map(parsePlaneCredentialFrame);

        expect(refusals.map(refusal => refusal.reason)).toEqual([
            'malformed credential frame: not JSON',
            'malformed credential frame: no bearer',
            'malformed credential frame: no bearer',
            'malformed credential frame: bearerClass is not a string'
        ]);
        expect(JSON.stringify(refusals)).not.toContain(BEARER)
    });

    test('a proof becomes the answer: adopted with the identity, refused with the reason, another account named beside the bound one', () => {
        expect(planeCredentialAnswer({ok: true, identity: '@viewer'}, '@viewer')).toEqual({state: 'adopted', identity: '@viewer'});
        expect(planeCredentialAnswer({ok: false, reason: 'plane unreachable (TypeError)'}, '@viewer'))
            .toEqual({state: 'refused', reason: 'plane unreachable (TypeError)'});
        expect(planeCredentialAnswer({ok: false, reason: 'plane identity mismatch', resolvedIdentity: '@other'}, '@viewer'))
            .toEqual({state: 'refused', reason: 'plane identity mismatch', resolvedIdentity: '@other', expectedIdentity: '@viewer'})
    });
});

test.describe('planeCredentialChannel: the pipe', () => {
    test('the first frame is read on its own, and its answer is one JSON line', async () => {
        const pipe    = pipePair(),
              channel = openPlaneCredentialChannel({stream: pipe.stream});

        pipe.send({bearer: BEARER, bearerClass: 'github-pat'});

        expect(await channel.next()).toEqual({ok: true, credential: {bearer: BEARER, bearerClass: 'github-pat'}});

        await channel.answer({state: 'adopted', identity: '@viewer'});
        await pipe.answered(1);
        expect(pipe.answers).toEqual([{state: 'adopted', identity: '@viewer'}])
    });

    test('later frames are adopted one at a time and answered in arrival order; a malformed one never reaches adopt', async () => {
        const
            pipe    = pipePair(),
            channel = openPlaneCredentialChannel({stream: pipe.stream}),
            events  = [];

        let release;

        const gate = new Promise(resolve => release = resolve);

        const serving = channel.serve(async credential => {
            events.push(`adopt ${credential.bearer}`);
            credential.bearer === 'first' && await gate;
            events.push(`settled ${credential.bearer}`);

            return {state: 'adopted', identity: credential.bearer}
        });

        pipe.send({bearer: 'first'});
        pipe.send('not json');
        pipe.send({bearer: 'second'});

        // the second frame waits behind the first one's proof, however long it takes
        await expect.poll(() => events).toEqual(['adopt first']);
        expect(pipe.answers).toEqual([]);

        release();
        await pipe.answered(3);

        expect(events).toEqual(['adopt first', 'settled first', 'adopt second', 'settled second']);
        expect(pipe.answers).toEqual([
            {state: 'adopted', identity: 'first'},
            {state: 'refused', reason: 'malformed credential frame: not JSON'},
            {state: 'adopted', identity: 'second'}
        ]);

        pipe.end();
        await serving
    });

    test('a closed pipe ends the frames: next() reads null and serve resolves', async () => {
        const pipe    = pipePair(),
              channel = openPlaneCredentialChannel({stream: pipe.stream});

        pipe.end();

        expect(await channel.next()).toBeNull();
        await channel.serve(() => { throw new Error('a closed pipe carries no frame') })
    });
});
