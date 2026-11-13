import {test, expect} from '@playwright/test';

import {percentile} from '../../../../../../ai/scripts/benchmark/helpers/stats.mjs';
import {
    buildReport,
    CGROUP_READ,
    foldTick,
    parseCgroupRead,
    parseContainerList,
    parseDockerSize,
    parseDuration,
    parseVolumeList,
    parseVolumeSizes,
    summarizeContainer
} from '../../../../../../ai/scripts/benchmark/helpers/planeSamplerCore.mjs';

/**
 * @summary Coverage for `ai/scripts/benchmark/helpers/planeSamplerCore.mjs`, the pure core of the
 * plane sampler. Every arm runs on injected text and timestamps: no `docker`, no clock, no files.
 *
 * The arms pin the honesty contract of the module doc: a series is one container's, anonymous
 * memory alone is the heap, a gap adds no sample, an interval with a counter that went backwards is
 * dropped, an unknown counter is `null` and a measured zero is 0.
 */
const GiB    = 1024 * 1024 * 1024,
      // One container's read, as CGROUP_READ prints it: two block devices, two interfaces
      read   = ({anon = GiB, file = 0, usec = 1, io = '254:0 rbytes=1000 wbytes=2000 rios=1\n254:16 rbytes=24 wbytes=48 rios=1\n', net = '100 200\n50 25\n'} = {}) =>
          [`anon ${anon}\nfile ${file}\nkernel 4096\n`, `usage_usec ${usec}\nuser_usec 1\n`, io, net].join('@@\n'),
      sample = (atMs, values) => ({atMs, anonBytes: GiB, fileBytes: 0, cpuUsec: 0, ioReadBytes: 0, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0, ...values}),
      nulls  = {p50: null, p95: null, max: null};

test.describe('ai/scripts/benchmark/helpers/planeSamplerCore', () => {
    test('the read asks for four parts, and each part marks its own failure', () => {
        expect(CGROUP_READ.split('echo @@')).toHaveLength(4);
        expect(CGROUP_READ.match(/\|\| echo '!!'/g)).toHaveLength(4);

        for (const file of ['memory.stat', 'cpu.stat', 'io.stat', 'statistics/rx_bytes', 'statistics/tx_bytes']) {
            expect(CGROUP_READ).toContain(file)
        }
    });

    test('a duration parses in seconds, minutes, hours and days, and anything else is refused', () => {
        expect(['90s', '10m', '8h', '7d', ' 30s '].map(parseDuration)).toEqual([90000, 600000, 28800000, 604800000, 30000]);

        for (const value of ['0s', '10', 'ten minutes', '1.5h', '-5m', '']) {
            expect(() => parseDuration(value), value).toThrow(/positive duration/)
        }
    });

    test('a cgroup read becomes one sample: anonymous and file memory apart, devices and interfaces summed', () => {
        expect(parseCgroupRead(read({anon: 3 * GiB, file: 5 * GiB, usec: 7000000}))).toEqual({
            anonBytes   : 3 * GiB,
            fileBytes   : 5 * GiB,
            cpuUsec     : 7000000,
            ioReadBytes : 1024,
            ioWriteBytes: 2048,
            netRxBytes  : 150,
            netTxBytes  : 225
        })
    });

    test('no block device and no interface are measured zeros; a failed or malformed part is unknown', () => {
        const io  = {ioReadBytes: 1024, ioWriteBytes: 2048},
              net = {netRxBytes: 150, netTxBytes: 225},
              off = {io: {ioReadBytes: null, ioWriteBytes: null}, net: {netRxBytes: null, netTxBytes: null}};

        expect(parseCgroupRead(read({io: '', net: ''}))).toMatchObject({ioReadBytes: 0, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0});

        // the read failed, a device line lacks a counter, the part is something else
        for (const part of ['!!\n', '254:0 rbytes=5\n', '254:0 rbytes=5 wbytes=6\nnot an io line\n']) {
            expect(parseCgroupRead(read({io: part})), part).toMatchObject({...off.io, ...net})
        }

        // the read failed after one interface, a line lacks its second counter, a counter is no number
        for (const part of ['100 200\n!!\n', '100\n', '100 many\n']) {
            expect(parseCgroupRead(read({net: part})), part).toMatchObject({...io, ...off.net})
        }
    });

    test('a read without cgroup v2 memory and CPU throws, so its caller counts a gap', () => {
        // cgroup v1 names the fields `rss` and `cache`
        expect(() => parseCgroupRead('rss 1\ncache 2\n@@\nusage_usec 3\n@@\n@@\n')).toThrow(/cgroup v2/);
        expect(() => parseCgroupRead('anon 1\nfile 2\n@@\nuser_usec 3\n@@\n@@\n')).toThrow(/cgroup v2/);
        expect(() => parseCgroupRead('!!\n@@\nusage_usec 3\n@@\n@@\n')).toThrow(/cgroup v2/);
        expect(() => parseCgroupRead('')).toThrow(/cgroup v2/)
    });

    test('ticks fold per container: a failed read is a gap of that container and adds no sample', () => {
        const series = {gaps: {'p-workers-1': 0, 'p-workers-2': 0}, rows: {'p-workers-1': [], 'p-workers-2': []}},
              one    = {container: 'p-workers-1', service: 'workers'},
              two    = {container: 'p-workers-2', service: 'workers'};

        foldTick(series, [{...one, atMs: 1000, cpuUsec: 1}, {...two, atMs: 1000, gap: 'no such container'}]);
        foldTick(series, [{...one, atMs: 2000, cpuUsec: 2}, {...two, atMs: 2000, cpuUsec: 9}]);

        expect(series.gaps).toEqual({'p-workers-1': 0, 'p-workers-2': 1});
        expect(series.rows['p-workers-1'].map(row => row.cpuUsec), 'one replica never receives the other one\'s sample').toEqual([1, 2]);
        expect(series.rows['p-workers-2'].map(row => row.atMs)).toEqual([2000])
    });

    test('heap is the anonymous memory alone, and CPU is cores from the counter deltas', () => {
        // ten seconds apart: 5 s, 10 s and 20 s of CPU time are 0.5, 1 and 2 cores
        expect(summarizeContainer([
            sample(0,     {anonBytes: 1 * GiB, fileBytes: 40 * GiB, cpuUsec: 0}),
            sample(10000, {anonBytes: 2 * GiB, fileBytes: 40 * GiB, cpuUsec: 5000000,  ioReadBytes: 10, netTxBytes: 7}),
            sample(20000, {anonBytes: 4 * GiB, fileBytes: 40 * GiB, cpuUsec: 15000000, ioReadBytes: 30, netTxBytes: 8}),
            sample(30000, {anonBytes: 3 * GiB, fileBytes: 40 * GiB, cpuUsec: 35000000, ioReadBytes: 30, netTxBytes: 9})
        ])).toEqual({
            samples  : 4,
            resets   : 0,
            intervals: {cpu: 3, io: 3, net: 3},
            heapGiB  : {p50: 2, p95: 4, max: 4},
            cores    : {p50: 1, p95: 2, max: 2},
            bytes    : {ioReadBytes: 30, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 9}
        })
    });

    test('the percentile is the definition of stats.mjs', () => {
        const heap      = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10].map(value => value * GiB),
              {heapGiB} = summarizeContainer(heap.map((anonBytes, index) => sample(index * 1000, {anonBytes, cpuUsec: index})));

        expect(heapGiB).toEqual({p50: percentile(heap, 0.5) / GiB, p95: percentile(heap, 0.95) / GiB, max: percentile(heap, 1) / GiB});
        expect(heapGiB).toEqual({p50: 5, p95: 10, max: 10})
    });

    test('an interval in which any counter went backwards is dropped whole and counted', () => {
        // the container came back: every counter starts again
        const restarted = summarizeContainer([
            sample(0,     {cpuUsec: 90000000,  netTxBytes: 500}),
            sample(10000, {cpuUsec: 100000000, netTxBytes: 600}),
            sample(20000, {cpuUsec: 2000000,   netTxBytes: 10}),
            sample(30000, {cpuUsec: 7000000,   netTxBytes: 40})
        ]);

        expect(restarted).toMatchObject({samples: 4, resets: 1, intervals: {cpu: 2, io: 2, net: 2}, cores: {p50: 0.5, p95: 1, max: 1}});
        expect(restarted.bytes.netTxBytes, 'the two deltas outside the reset').toBe(130);

        // one I/O counter alone starts again while the CPU counter goes on
        for (const key of ['ioReadBytes', 'ioWriteBytes', 'netRxBytes', 'netTxBytes']) {
            const summary = summarizeContainer([
                sample(0,     {cpuUsec: 0,        [key]: 900}),
                sample(10000, {cpuUsec: 10000000, [key]: 1000}),
                sample(20000, {cpuUsec: 20000000, [key]: 10}),
                sample(30000, {cpuUsec: 30000000, [key]: 15})
            ]);

            expect(summary.resets, key).toBe(1);
            expect(summary.bytes[key], `${key}: 100 before the reset and 5 after it, never -990`).toBe(105);
            expect(summary.intervals.cpu, key).toBe(2)
        }
    });

    test('an unknown counter leaves its interval out of its total, and no usable interval is null, never 0', () => {
        const unknown = {ioReadBytes: null, ioWriteBytes: null};

        // the I/O part failed at the second tick only: one usable I/O interval, three for CPU and network
        expect(summarizeContainer([
            sample(0,     {cpuUsec: 0, ioReadBytes: 100}),
            sample(10000, {cpuUsec: 1, ...unknown}),
            sample(20000, {cpuUsec: 2, ioReadBytes: 300}),
            sample(30000, {cpuUsec: 3, ioReadBytes: 350})
        ])).toMatchObject({resets: 0, intervals: {cpu: 3, io: 1, net: 3}, bytes: {ioReadBytes: 50, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0}});

        // the I/O part never read: unknown, beside a network that measured zero
        expect(summarizeContainer([sample(0, unknown), sample(10000, {cpuUsec: 1, ...unknown})]))
            .toMatchObject({intervals: {cpu: 1, io: 0, net: 1}, bytes: {...unknown, netRxBytes: 0, netTxBytes: 0}});

        expect(summarizeContainer([])).toEqual({
            samples  : 0,
            resets   : 0,
            intervals: {cpu: 0, io: 0, net: 0},
            heapGiB  : nulls,
            cores    : nulls,
            bytes    : {ioReadBytes: null, ioWriteBytes: null, netRxBytes: null, netTxBytes: null}
        });

        // one sample has a heap and no interval
        expect(summarizeContainer([sample(0, {cpuUsec: 5, ioReadBytes: 7})])).toMatchObject({
            samples: 1,
            heapGiB: {p50: 1, p95: 1, max: 1},
            cores  : nulls,
            bytes  : {ioReadBytes: null, ioWriteBytes: null, netRxBytes: null, netTxBytes: null}
        })
    });

    test('two replicas of one service are two series: one tick gives no delta, two ticks give each its own', () => {
        const containers = [{container: 'p-workers-1', service: 'workers'}, {container: 'p-workers-2', service: 'workers'}],
              tick       = (atMs, usec, readBytes) => containers.map((entry, index) =>
                  ({...entry, ...sample(atMs, {cpuUsec: usec * (index + 1), ioReadBytes: readBytes[index]})})),
              fold       = ticks => {
                  const series = {gaps: {'p-workers-1': 0, 'p-workers-2': 0}, rows: {'p-workers-1': [], 'p-workers-2': []}};

                  ticks.forEach(reads => foldTick(series, reads));

                  return Object.fromEntries(Object.keys(series.rows).map(name => [name, summarizeContainer(series.rows[name])]))
              },
              once       = fold([tick(0, 5000000, [1000, 2000])]),
              // the first replica runs one core and reads 100 bytes, the second two cores and 10 bytes
              twice      = fold([tick(0, 5000000, [1000, 2000]), tick(10000, 15000000, [1100, 2010])]);

        for (const name of Object.keys(once)) {
            expect(once[name], name).toMatchObject({samples: 1, resets: 0, intervals: {cpu: 0, io: 0, net: 0}, cores: nulls, bytes: {ioReadBytes: null}})
        }

        expect(twice['p-workers-1']).toMatchObject({samples: 2, resets: 0, cores: {p50: 1, max: 1}, bytes: {ioReadBytes: 100}});
        expect(twice['p-workers-2']).toMatchObject({samples: 2, resets: 0, cores: {p50: 2, max: 2}, bytes: {ioReadBytes: 10}})
    });

    test('docker size strings become bytes', () => {
        expect(['0B', '2.146kB', '512MB', '17.14GB', '1.5TB'].map(parseDockerSize)).toEqual([0, 2146, 512000000, 17140000000, 1500000000000]);
        expect(() => parseDockerSize('n/a')).toThrow(/unparseable docker size/)
    });

    test('a volume belongs to a project by its label, and its size is found by its exact name', () => {
        // project `app`: one volume named by compose, one it named itself
        const volumes = parseVolumeList('app_data\tdata\nshared-cache\tcache\nunlabelled\t\n'),
              df      = [
                  'Local Volumes space usage:',
                  '',
                  'VOLUME NAME        LINKS     SIZE',
                  'app_data           1         17.14GB',
                  // project `app_staging` owns this one: a name prefix would have taken it for `app`
                  'app_staging_data   1         9GB',
                  'shared-cache       2         2.146kB'
              ].join('\n');

        expect(volumes).toEqual([{key: 'data', name: 'app_data'}, {key: 'cache', name: 'shared-cache'}, {key: 'unlabelled', name: 'unlabelled'}]);
        expect(parseVolumeSizes(df, volumes), 'a listed volume the table lacks is unknown').toEqual({data: 17140000000, cache: 2146, unlabelled: null});
        expect(parseVolumeList('')).toEqual([])
    });

    test('the container list pairs each container with its compose service', () => {
        expect(parseContainerList('plane-chroma-1\tchroma\nplane-workers-1\tworkers\nplane-workers-2\tworkers\n\n')).toEqual([
            {container: 'plane-chroma-1',  service: 'chroma'},
            {container: 'plane-workers-1', service: 'workers'},
            {container: 'plane-workers-2', service: 'workers'}
        ]);
        expect(parseContainerList('')).toEqual([])
    });

    test('the report is keyed by container, counts a window\'s ticks rounded up, and marks a stop early only inside the window', () => {
        const startedAtMs = Date.UTC(2026, 10, 13, 5, 0, 0),
              base        = {
                  command    : 'node ai/scripts/benchmark/plane-sampler.mjs --window 10m',
                  containers : [{container: 'p-chroma-1', service: 'chroma'}, {container: 'p-kb-1', service: 'kb'}],
                  gaps       : {'p-chroma-1': 2, 'p-kb-1': 0},
                  hardware   : 'reference-host',
                  intervalMs : 30000,
                  project    : 'p',
                  rows       : {'p-chroma-1': [sample(0, {}), sample(30000, {cpuUsec: 30000000})], 'p-kb-1': []},
                  startedAtMs,
                  ticks      : 18,
                  volumes    : {atStart: {data: 1}, atEnd: {data: 2}},
                  windowMs   : 600000
              },
              complete    = buildReport({...base, endedAtMs: startedAtMs + 600000});

        expect(complete).toMatchObject({
            instrument: 'ai/scripts/benchmark/plane-sampler.mjs',
            project   : 'p',
            hardware  : 'reference-host',
            intervalMs: 30000,
            window    : {requestedMs: 600000, startedAt: '2026-11-13T05:00:00.000Z', endedAt: '2026-11-13T05:10:00.000Z', stoppedEarly: false},
            // two ticks short of the twenty the window holds
            coverage  : {ticks: 18, expectedTicks: 20},
            volumes   : {atStart: {data: 1}, atEnd: {data: 2}}
        });
        expect(complete.containers['p-chroma-1']).toMatchObject({service: 'chroma', samples: 2, gaps: 2, resets: 0, cores: {p50: 1, p95: 1, max: 1}});
        expect(complete.containers['p-kb-1']).toMatchObject({service: 'kb', samples: 0, gaps: 0, heapGiB: nulls, bytes: {netTxBytes: null}});

        // a tick at the start and one per full interval inside the window
        expect([[2000, 3000], [3000, 3000], [100000, 30000], [600000, 30000]]
            .map(([windowMs, intervalMs]) => buildReport({...base, endedAtMs: startedAtMs + windowMs, intervalMs, windowMs}).coverage.expectedTicks))
            .toEqual([1, 1, 4, 20]);

        expect(buildReport({...base, endedAtMs: startedAtMs + 240000, stoppedAtMs: startedAtMs + 240000}).window)
            .toMatchObject({endedAt: '2026-11-13T05:04:00.000Z', stoppedEarly: true});
        expect(buildReport({...base, endedAtMs: startedAtMs + 600500, stoppedAtMs: startedAtMs + 600200}).window.stoppedEarly,
            'a signal after the window is the caller\'s cleanup').toBe(false)
    })
});
