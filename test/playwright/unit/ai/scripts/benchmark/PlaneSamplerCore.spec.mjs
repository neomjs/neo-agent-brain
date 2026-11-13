import {test, expect} from '@playwright/test';

import {percentile} from '../../../../../../ai/scripts/benchmark/helpers/stats.mjs';
import {
    buildReport,
    CGROUP_READ,
    foldTick,
    parseCgroupRead,
    parseDockerSize,
    parseDuration,
    parseServiceList,
    parseVolumeSizes,
    summarizeService
} from '../../../../../../ai/scripts/benchmark/helpers/planeSamplerCore.mjs';

/**
 * @summary Coverage for `ai/scripts/benchmark/helpers/planeSamplerCore.mjs`, the pure core of the
 * plane sampler. Every arm runs on injected text and timestamps: no `docker`, no clock, no files.
 *
 * The arms pin the honesty contract of the module doc: anonymous memory alone is the heap, a gap
 * adds no sample, a backwards counter is a restart whose delta is dropped, and a service without
 * samples reports `null`.
 */
const GiB    = 2 ** 30,
      // One container's read, as CGROUP_READ prints it: two block devices, two interfaces
      read   = ({anon, file, usec, rx = [100, 50], tx = [200, 25]}) => [
          `anon ${anon}\nfile ${file}\nkernel 4096\n`,
          `usage_usec ${usec}\nuser_usec 1\nsystem_usec 1\n`,
          '254:0 rbytes=1000 wbytes=2000 rios=1 wios=1\n254:16 rbytes=24 wbytes=48 rios=1 wios=1\n',
          `${rx[0]} ${tx[0]}\n${rx[1]} ${tx[1]}\n`
      ].join('@@\n'),
      sample = (atMs, values) => ({atMs, ioReadBytes: 0, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0, fileBytes: 0, ...values});

test.describe('ai/scripts/benchmark/helpers/planeSamplerCore', () => {
    test('the read asks for the four parts the parser splits', () => {
        expect(CGROUP_READ.split('echo @@')).toHaveLength(4);

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

    test('a container without block devices or interfaces reads as zero bytes, not as a failure', () => {
        expect(parseCgroupRead('anon 1\nfile 2\n@@\nusage_usec 3\n@@\n@@\n'))
            .toEqual({anonBytes: 1, fileBytes: 2, cpuUsec: 3, ioReadBytes: 0, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0})
    });

    test('a read that is no cgroup v2 read throws, so its caller counts a gap', () => {
        // cgroup v1 names the fields `rss` and `cache`
        expect(() => parseCgroupRead('rss 1\ncache 2\n@@\nusage_usec 3\n@@\n@@\n')).toThrow(/cgroup v2/);
        expect(() => parseCgroupRead('anon 1\nfile 2\n@@\nuser_usec 3\n@@\n@@\n')).toThrow(/cgroup v2/);
        expect(() => parseCgroupRead('')).toThrow(/cgroup v2/)
    });

    test('a failed read counts as a gap of its service and adds no sample', () => {
        const series = {gaps: {chroma: 0, orchestrator: 0}, rows: {chroma: [], orchestrator: []}};

        foldTick(series, [{service: 'chroma', atMs: 1000, anonBytes: 1}, {service: 'orchestrator', atMs: 1000, gap: 'no such container'}]);
        foldTick(series, [{service: 'chroma', atMs: 2000, anonBytes: 2}, {service: 'orchestrator', atMs: 2000, anonBytes: 9}]);

        expect(series.gaps).toEqual({chroma: 0, orchestrator: 1});
        expect(series.rows.chroma.map(row => row.atMs)).toEqual([1000, 2000]);
        expect(series.rows.orchestrator.map(row => row.atMs)).toEqual([2000])
    });

    test('heap is the anonymous memory alone, and CPU is cores from the counter deltas', () => {
        // ten seconds apart: 5 s, 10 s and 20 s of CPU time are 0.5, 1 and 2 cores
        const summary = summarizeService([
            sample(0,     {anonBytes: 1 * GiB, fileBytes: 40 * GiB, cpuUsec: 0}),
            sample(10000, {anonBytes: 2 * GiB, fileBytes: 40 * GiB, cpuUsec: 5000000,  ioReadBytes: 10, netTxBytes: 7}),
            sample(20000, {anonBytes: 4 * GiB, fileBytes: 40 * GiB, cpuUsec: 15000000, ioReadBytes: 30, netTxBytes: 8}),
            sample(30000, {anonBytes: 3 * GiB, fileBytes: 40 * GiB, cpuUsec: 35000000, ioReadBytes: 30, netTxBytes: 9})
        ]);

        expect(summary).toEqual({
            samples : 4,
            restarts: 0,
            heapGiB : {p50: 2, p95: 4, max: 4},
            cores   : {p50: 1, p95: 2, max: 2},
            bytes   : {ioReadBytes: 30, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 9}
        })
    });

    test('the percentile is the definition of stats.mjs', () => {
        const heap = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10].map(value => value * GiB),
              {heapGiB} = summarizeService(heap.map((anonBytes, index) => sample(index * 1000, {anonBytes, cpuUsec: index})));

        expect(heapGiB).toEqual({p50: percentile(heap, 0.5) / GiB, p95: percentile(heap, 0.95) / GiB, max: percentile(heap, 1) / GiB});
        expect(heapGiB).toEqual({p50: 5, p95: 10, max: 10})
    });

    test('a counter that goes backwards is a restart: its delta is dropped and counted', () => {
        const summary = summarizeService([
            sample(0,     {anonBytes: GiB, cpuUsec: 90000000, netTxBytes: 500}),
            sample(10000, {anonBytes: GiB, cpuUsec: 100000000, netTxBytes: 600}),
            // the container came back: its counters start again
            sample(20000, {anonBytes: GiB, cpuUsec: 2000000,   netTxBytes: 10}),
            sample(30000, {anonBytes: GiB, cpuUsec: 7000000,   netTxBytes: 40})
        ]);

        expect(summary.restarts).toBe(1);
        expect(summary.cores).toEqual({p50: 0.5, p95: 1, max: 1});
        expect(summary.bytes.netTxBytes, 'the two deltas outside the restart').toBe(130);
        expect(summary.samples, 'every sample still counts for the heap').toBe(4)
    });

    test('a service without samples reports null figures, never 0', () => {
        expect(summarizeService([])).toEqual({
            samples : 0,
            restarts: 0,
            heapGiB : {p50: null, p95: null, max: null},
            cores   : {p50: null, p95: null, max: null},
            bytes   : {ioReadBytes: 0, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0}
        });

        // one sample has a heap and no delta
        expect(summarizeService([sample(0, {anonBytes: GiB, cpuUsec: 5})])).toMatchObject({
            samples: 1,
            heapGiB: {p50: 1, p95: 1, max: 1},
            cores  : {p50: null, p95: null, max: null}
        })
    });

    test('docker size strings become bytes, and the volumes of one project are read from the df table', () => {
        expect(['0B', '2.146kB', '512MB', '17.14GB', '1.5TB'].map(parseDockerSize)).toEqual([0, 2146, 512000000, 17140000000, 1500000000000]);
        expect(() => parseDockerSize('n/a')).toThrow(/unparseable docker size/);

        const df = [
            'Local Volumes space usage:',
            '',
            'VOLUME NAME                    LINKS     SIZE',
            'neo-local-agent-os_chroma-data 1         17.14GB',
            'neo-local-agent-os_backups     2         2.146kB',
            'other-project_chroma-data      1         9GB'
        ].join('\n');

        expect(parseVolumeSizes(df, 'neo-local-agent-os')).toEqual({'chroma-data': 17140000000, backups: 2146})
    });

    test('the service list pairs each container with its compose service', () => {
        expect(parseServiceList('plane-chroma-1\tchroma\nplane-mc-server-1\tmc-server\n\n'))
            .toEqual([{container: 'plane-chroma-1', service: 'chroma'}, {container: 'plane-mc-server-1', service: 'mc-server'}]);
        expect(parseServiceList('')).toEqual([])
    });

    test('the report carries its coverage, and a stop counts as early only inside the window', () => {
        const startedAtMs = Date.UTC(2026, 10, 13, 5, 0, 0),
              base        = {
                  command    : 'node ai/scripts/benchmark/plane-sampler.mjs --window 10m',
                  gaps       : {chroma: 2, kb: 0},
                  hardware   : 'reference-host',
                  intervalMs : 30000,
                  project    : 'plane',
                  rows       : {chroma: [sample(0, {anonBytes: GiB, cpuUsec: 0}), sample(30000, {anonBytes: GiB, cpuUsec: 30000000})], kb: []},
                  startedAtMs,
                  ticks      : 18,
                  volumes    : {atStart: {data: 1}, atEnd: {data: 2}},
                  windowMs   : 600000
              },
              complete    = buildReport({...base, endedAtMs: startedAtMs + 600000});

        expect(complete).toMatchObject({
            instrument: 'ai/scripts/benchmark/plane-sampler.mjs',
            project   : 'plane',
            hardware  : 'reference-host',
            intervalMs: 30000,
            window    : {requestedMs: 600000, startedAt: '2026-11-13T05:00:00.000Z', endedAt: '2026-11-13T05:10:00.000Z', stoppedEarly: false},
            // two ticks short of the twenty the window holds
            coverage  : {ticks: 18, expectedTicks: 20},
            volumes   : {atStart: {data: 1}, atEnd: {data: 2}}
        });
        expect(complete.services.chroma).toMatchObject({samples: 2, gaps: 2, restarts: 0, cores: {p50: 1, p95: 1, max: 1}});
        expect(complete.services.kb).toMatchObject({samples: 0, gaps: 0, heapGiB: {p50: null, p95: null, max: null}});

        expect(buildReport({...base, endedAtMs: startedAtMs + 240000, stoppedAtMs: startedAtMs + 240000}).window)
            .toMatchObject({endedAt: '2026-11-13T05:04:00.000Z', stoppedEarly: true});
        expect(buildReport({...base, endedAtMs: startedAtMs + 600500, stoppedAtMs: startedAtMs + 600200}).window.stoppedEarly,
            'a signal after the window is the caller\'s cleanup').toBe(false)
    })
});
