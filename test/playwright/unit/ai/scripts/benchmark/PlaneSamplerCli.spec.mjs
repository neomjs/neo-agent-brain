import {test, expect} from '@playwright/test';

import {spawn}                                                from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os                                                     from 'node:os';
import path                                                   from 'node:path';

/**
 * @summary The plane sampler's CLI at its boundary: the real script, a real clock and real signals,
 * against a `docker` executable the spec writes.
 *
 * The stand-in answers the four `docker` calls the CLI makes for a project `p` with two replicas of
 * one service. A replica's CPU counter runs at its own number of cores, so each replica's figure is
 * only right when its series stays its own. The volume table also lists a volume of a project whose
 * name starts alike, and one the project named itself.
 *
 * Every duration read here is the report's own (`window.endedAt - window.startedAt`), never the
 * process's, so a slow start of `node` cannot fail an arm.
 */
const CLI    = path.resolve(import.meta.dirname, '../../../../../../ai/scripts/benchmark/plane-sampler.mjs'),
      DOCKER = `#!/usr/bin/env node
const [command, ...rest] = process.argv.slice(2), now = Date.now(), out = text => process.stdout.write(text);

if (command === 'ps') out('p-workers-1\\tworkers\\np-workers-2\\tworkers\\n');
if (command === 'volume') out('p_data\\tdata\\nshared-cache\\tcache\\n');
if (command === 'system') out('VOLUME NAME   LINKS   SIZE\\np_data   1   1.5kB\\np_staging_data   1   9GB\\nshared-cache   1   2MB\\n');
if (command === 'exec') {
    const cores = rest[0] === 'p-workers-1' ? 1 : 2;

    out(['anon ' + cores * 1048576 + '\\nfile 0\\n', 'usage_usec ' + now * 1000 * cores + '\\n', '8:0 rbytes=' + now * cores + ' wbytes=0\\n', now + ' ' + now + '\\n'].join('@@\\n'))
}
`,
      names  = ['p-workers-1', 'p-workers-2'];

/**
 * Starts the CLI on a fresh `--out` with the stand-in first on PATH.
 * @param {String}   dir
 * @param {String[]} args `--window` and `--interval`
 * @returns {{child: Object, done: Promise<Number>, out: String}}
 */
function start(dir, args) {
    const out   = path.join(dir, `run-${args.join('-')}`),
          child = spawn(process.execPath, [CLI, '--project', 'p', '--hardware', 'spec', '--out', out, ...args],
              {env: {...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`}, stdio: 'ignore'});

    return {child, done: new Promise(resolve => child.once('close', resolve)), out}
}

const report  = out => JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')),
      elapsed = ({window}) => Date.parse(window.endedAt) - Date.parse(window.startedAt);

test.describe('ai/scripts/benchmark/plane-sampler (CLI)', () => {
    // One arm at a time: each starts real processes, and three at once would load the workers beside it
    test.describe.configure({mode: 'serial'});

    let dir;

    test.beforeAll(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'plane-sampler-'));
        writeFileSync(path.join(dir, 'docker'), DOCKER, {mode: 0o755})
    });

    test.afterAll(() => rmSync(dir, {force: true, recursive: true}));

    test('a window shorter than the interval holds one tick and ends with the window, not with the interval', async () => {
        const {done, out} = start(dir, ['--window', '2s', '--interval', '3s']);

        expect(await done).toBe(0);

        const result = report(out),
              rows   = readFileSync(path.join(out, 'samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

        expect(result.coverage).toEqual({ticks: 1, expectedTicks: 1});
        expect(result.window.stoppedEarly).toBe(false);
        expect(elapsed(result), 'the last wait is cut at the window\'s end').toBeLessThan(2800);
        expect(elapsed(result)).toBeGreaterThanOrEqual(2000);

        // one observation of each replica is no interval: nothing is differenced across them
        expect(Object.keys(result.containers)).toEqual(names);
        expect(rows.map(row => row.container)).toEqual(names);

        for (const name of names) {
            expect(result.containers[name], name).toMatchObject({
                service  : 'workers',
                samples  : 1,
                gaps     : 0,
                resets   : 0,
                intervals: {cpu: 0, io: 0, net: 0},
                cores    : {p50: null, p95: null, max: null},
                bytes    : {ioReadBytes: null, ioWriteBytes: null, netRxBytes: null, netTxBytes: null}
            })
        }

        // the project's two volumes by their labels; the look-alike project's volume is not among them
        expect(result.volumes.atEnd).toEqual({data: 1500, cache: 2000000})
    });

    test('two ticks give each replica its own cores and bytes, with no reset between them', async () => {
        const {done, out} = start(dir, ['--window', '2s', '--interval', '1s']);

        expect(await done).toBe(0);

        const result      = report(out),
              [one, two] = names.map(name => result.containers[name]);

        expect(result.coverage).toEqual({ticks: 2, expectedTicks: 2});

        for (const [replica, cores] of [[one, 1], [two, 2]]) {
            expect(replica).toMatchObject({samples: 2, resets: 0, intervals: {cpu: 1, io: 1, net: 1}});
            expect(replica.cores.max).toBeGreaterThan(cores * 0.8);
            expect(replica.cores.max).toBeLessThan(cores * 1.2);
            expect(replica.bytes.ioReadBytes).toBeGreaterThan(0);
            expect(replica.bytes.ioWriteBytes).toBe(0)
        }
    });

    test('a stop inside the window ends the wait at once and writes a report that says so', async () => {
        const {child, done, out} = start(dir, ['--window', '30s', '--interval', '10s']),
              samples            = path.join(out, 'samples.jsonl');

        await expect.poll(() => existsSync(samples) && readFileSync(samples, 'utf8').length > 0, {timeout: 10000}).toBe(true);
        child.kill('SIGINT');

        expect(await done).toBe(0);

        const result = report(out);

        expect(result.window.stoppedEarly).toBe(true);
        expect(result.coverage).toEqual({ticks: 1, expectedTicks: 3});
        expect(elapsed(result), 'the ten-second wait did not run out').toBeLessThan(5000)
    })
});
