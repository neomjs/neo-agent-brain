import {percentile} from './stats.mjs';

/**
 * @module ai/scripts/benchmark/helpers/planeSamplerCore
 * @summary The pure core of the plane sampler: one container's cgroup read in, per-service series
 * and a window report out, in which every figure carries its coverage.
 *
 * **Why a pure module**: the sampler's CLI owns the clock, `docker` and the files. This module owns
 * every rule a unit spec must pin, as data transforms over injected reads. No Neo import, no config
 * read, no clock read.
 *
 * **Honesty contract** (after `servingCostCore.mjs`):
 * - resident heap is the cgroup's anonymous memory. File-backed pages are kept beside it and never
 *   added to it: `docker stats` counts the active ones as used memory;
 * - a failed read is a gap and adds no sample, and a missing tick is never interpolated;
 * - a counter that goes backwards is a container restart: its delta is dropped and counted;
 * - a service without samples reports `null` figures, never 0.
 */

/**
 * The read one `docker exec` performs per container and tick. `@@` separates its four parts:
 * `memory.stat`, `cpu.stat`, `io.stat`, and one `rx tx` line per network interface except `lo`.
 * @type {String}
 */
export const CGROUP_READ = 'cat /sys/fs/cgroup/memory.stat; echo @@; cat /sys/fs/cgroup/cpu.stat; echo @@; ' +
    'cat /sys/fs/cgroup/io.stat; echo @@; for i in /sys/class/net/*; do [ "${i##*/}" = lo ] || ' +
    'echo "$(cat $i/statistics/rx_bytes) $(cat $i/statistics/tx_bytes)"; done';

/**
 * @summary Parses '90s', '30m', '8h' or '7d' into milliseconds; anything else is refused.
 * @param {String} value
 * @returns {Number}
 */
export function parseDuration(value) {
    const match = /^(\d+)([smhd])$/.exec(String(value).trim());

    if (!match || Number(match[1]) === 0) {
        throw new Error(`expected a positive duration like 30s / 10m / 8h / 7d, got "${value}"`)
    }

    return Number(match[1]) * {s: 1e3, m: 6e4, h: 36e5, d: 864e5}[match[2]]
}

/**
 * @summary Parses the output of {@link CGROUP_READ} for one container into one sample.
 *
 * A read without `anon`, `file` or `usage_usec` is not a cgroup v2 read and throws, so the caller
 * records a gap instead of a sample made of `NaN`.
 * @param {String} text
 * @returns {{anonBytes: Number, fileBytes: Number, cpuUsec: Number, ioReadBytes: Number, ioWriteBytes: Number, netRxBytes: Number, netTxBytes: Number}}
 */
export function parseCgroupRead(text) {
    const [memory = '', cpu = '', io = '', net = ''] = String(text).split('@@\n'),
          stat    = block => Object.fromEntries(block.trim().split('\n').map(line => line.split(' ')).map(([key, value]) => [key, Number(value)])),
          mem     = stat(memory),
          cpuUsec = stat(cpu).usage_usec,
          sumIo   = key => [...io.matchAll(new RegExp(`${key}=(\\d+)`, 'g'))].reduce((sum, match) => sum + Number(match[1]), 0),
          pairs   = net.trim().split('\n').filter(Boolean).map(line => line.split(' ').map(Number));

    if (![mem.anon, mem.file, cpuUsec].every(Number.isFinite)) {
        throw new Error('not a cgroup v2 read: memory.stat anon and file and cpu.stat usage_usec are required')
    }

    return {
        anonBytes   : mem.anon,
        fileBytes   : mem.file,
        cpuUsec,
        ioReadBytes : sumIo('rbytes'),
        ioWriteBytes: sumIo('wbytes'),
        netRxBytes  : pairs.reduce((sum, [rx]) => sum + rx, 0),
        netTxBytes  : pairs.reduce((sum, [, tx]) => sum + tx, 0)
    }
}

/**
 * @summary Folds one tick's reads into the per-service series: a read that failed counts as a gap
 * of its service and adds no sample.
 * @param {Object}   series
 * @param {Object}   series.gaps Gap count per service
 * @param {Object}   series.rows Ordered samples per service
 * @param {Object[]} reads       `{service, atMs, ...sample}` or `{service, atMs, gap}`
 */
export function foldTick({gaps, rows}, reads) {
    reads.forEach(read => read.gap ? gaps[read.service]++ : rows[read.service].push(read))
}

/**
 * @summary Summarizes one service's ordered samples.
 *
 * Heap figures come from every sample, CPU and byte figures from the deltas between neighbours. A
 * delta across a backwards counter is a restart: dropped and counted, so a restart never reads as
 * negative or doubled use. The percentile is the one definition of `stats.mjs`.
 * @param {Object[]} samples Ordered `{atMs, ...parseCgroupRead}` rows of one service
 * @returns {Object} samples, restarts, heapGiB and cores as `{p50, p95, max}`, and byte totals
 */
export function summarizeService(samples) {
    const cores  = [],
          totals = {ioReadBytes: 0, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0},
          round  = value => value === null ? null : +value.toFixed(3),
          spread = (values, scale = 1) => Object.fromEntries([['p50', 0.5], ['p95', 0.95], ['max', 1]]
              .map(([name, p]) => [name, values.length ? round(percentile(values, p) / scale) : null]));
    let restarts = 0;

    for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1],
              cur  = samples[i];

        if (cur.cpuUsec < prev.cpuUsec || cur.netTxBytes < prev.netTxBytes) {
            restarts++;
            continue
        }

        cores.push((cur.cpuUsec - prev.cpuUsec) / ((cur.atMs - prev.atMs) * 1e3));
        Object.keys(totals).forEach(key => totals[key] += cur[key] - prev[key])
    }

    return {
        samples: samples.length,
        restarts,
        heapGiB: spread(samples.map(sample => sample.anonBytes), 1024 * 1024 * 1024),
        cores  : spread(cores),
        bytes  : totals
    }
}

/**
 * @summary Converts docker's SI size strings ('17.14GB', '2.146kB', '0B') into bytes.
 * @param {String} size
 * @returns {Number}
 */
export function parseDockerSize(size) {
    const match = /^([\d.]+)\s*([kMGT]?)B$/.exec(size);

    if (!match) {
        throw new Error(`unparseable docker size "${size}"`)
    }

    return Math.round(Number(match[1]) * {'': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12}[match[2]])
}

/**
 * @summary Reads one compose project's volume sizes out of `docker system df -v`.
 * @param {String} text
 * @param {String} project
 * @returns {Object} bytes per volume, keyed by the volume's name without the project prefix
 */
export function parseVolumeSizes(text, project) {
    return Object.fromEntries(text.split('\n')
        .filter(line => line.startsWith(`${project}_`))
        .map(line => line.trim().split(/\s+/))
        .map(columns => [columns[0].slice(project.length + 1), parseDockerSize(columns.at(-1))]))
}

/**
 * @summary Reads the containers of a project out of `docker ps --format '{{.Names}}\t{{.Label "com.docker.compose.service"}}'`.
 * @param {String} text
 * @returns {{container: String, service: String}[]}
 */
export function parseServiceList(text) {
    return text.trim().split('\n').filter(Boolean).map(line => {
        const [container, service] = line.split('\t');

        return {container, service}
    })
}

/**
 * @summary Builds the window's report from the folded series. The caller injects every timestamp.
 *
 * A stop counts as early only inside the requested window: a signal after the window is complete is
 * the caller's cleanup.
 * @param {Object}      data
 * @param {String}      data.command
 * @param {Number}      data.endedAtMs
 * @param {Object}      data.gaps          Gap count per service
 * @param {String}      data.hardware
 * @param {Number}      data.intervalMs
 * @param {String}      data.project
 * @param {Object}      data.rows          Ordered samples per service
 * @param {Number}      data.startedAtMs
 * @param {Number|null} [data.stoppedAtMs] When a stop signal arrived, if one did
 * @param {Number}      data.ticks
 * @param {Object}      data.volumes       `{atStart, atEnd}`
 * @param {Number}      data.windowMs
 * @returns {Object}
 */
export function buildReport({command, endedAtMs, gaps, hardware, intervalMs, project, rows, startedAtMs, stoppedAtMs = null, ticks, volumes, windowMs}) {
    return {
        instrument: 'ai/scripts/benchmark/plane-sampler.mjs',
        command,
        project,
        hardware,
        intervalMs,
        window    : {
            requestedMs : windowMs,
            startedAt   : new Date(startedAtMs).toISOString(),
            endedAt     : new Date(endedAtMs).toISOString(),
            stoppedEarly: stoppedAtMs !== null && stoppedAtMs - startedAtMs < windowMs
        },
        // A sleeping host or a stalled docker daemon shows here as ticks below the expected count
        coverage  : {ticks, expectedTicks: Math.floor(windowMs / intervalMs)},
        services  : Object.fromEntries(Object.keys(rows).map(service =>
            [service, {...summarizeService(rows[service]), gaps: gaps[service]}])),
        volumes
    }
}
