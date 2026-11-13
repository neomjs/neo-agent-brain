import {percentile} from './stats.mjs';

/**
 * @module ai/scripts/benchmark/helpers/planeSamplerCore
 * @summary The pure core of the plane sampler: one container's cgroup read in, per-container series
 * and a window report out, in which every figure carries its coverage.
 *
 * **Why a pure module**: the sampler's CLI owns the clock, `docker` and the files. This module owns
 * every rule a unit spec must pin, as data transforms over injected reads. No Neo import, no config
 * read, no clock read.
 *
 * **The unit is the container.** Cumulative counters belong to one container's lifetime, so a
 * series is one container's and never a service's: a service with replicas has one entry per
 * replica, each naming its service, and nothing is summed or differenced across replicas.
 *
 * **Honesty contract** (after `servingCostCore.mjs`):
 * - resident heap is the cgroup's anonymous memory. File-backed pages are kept beside it and never
 *   added to it: `docker stats` counts the active ones as used memory;
 * - a failed read is a gap and adds no sample, and a missing tick is never interpolated;
 * - an I/O or network part that failed or is malformed is unknown (`null`), while an empty one (no
 *   block device, no interface but `lo`) is a measured zero;
 * - an interval in which any cumulative counter went backwards is a reset, usually a container
 *   restart: it is dropped whole and counted, so no figure is ever negative or doubled;
 * - a figure without a usable interval is `null`, never 0, and `intervals` says on how many
 *   intervals each figure rests.
 */

/**
 * Printed in place of a part whose read failed.
 * @type {String}
 */
const FAILED = '!!';

/**
 * The read one `docker exec` performs per container and tick. `@@` separates its four parts:
 * `memory.stat`, `cpu.stat`, `io.stat`, and one `rx tx` line per network interface except `lo`.
 * A part whose read fails prints `!!` instead, so the last command's success cannot hide it.
 * @type {String}
 */
export const CGROUP_READ = ['memory.stat', 'cpu.stat', 'io.stat'].map(file => `cat /sys/fs/cgroup/${file} || echo '${FAILED}'`).join('; echo @@; ') +
    `; echo @@; (for i in /sys/class/net/*; do [ "\${i##*/}" = lo ] && continue; rx=$(cat "$i/statistics/rx_bytes") || exit 1; ` +
    `tx=$(cat "$i/statistics/tx_bytes") || exit 1; echo "$rx $tx"; done) || echo '${FAILED}'`;

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
 * Memory and CPU are required: without `anon`, `file` and `usage_usec` this is no cgroup v2 read and
 * the call throws, so its caller records a gap. The I/O and network parts are optional knowledge: a
 * failed or malformed part gives `null` for its two counters, an empty part gives 0.
 * @param {String} text
 * @returns {{anonBytes: Number, fileBytes: Number, cpuUsec: Number, ioReadBytes: Number|null, ioWriteBytes: Number|null, netRxBytes: Number|null, netTxBytes: Number|null}}
 */
export function parseCgroupRead(text) {
    const [memory = '', cpu = '', io = '', net = ''] = String(text).split('@@\n'),
          lines   = block => block.trim().split('\n').filter(Boolean),
          stat    = block => Object.fromEntries(lines(block).map(line => line.split(' ')).map(([key, value]) => [key, Number(value)])),
          mem     = stat(memory),
          cpuUsec = stat(cpu).usage_usec,
          // every device line carries both counters, or the part is not an io.stat
          devices = lines(io).map(line => [/\brbytes=(\d+)/.exec(line), /\bwbytes=(\d+)/.exec(line)]),
          ioKnown = devices.every(([read, write]) => read && write),
          pairs   = lines(net).map(line => line.split(' ').map(Number)),
          netKnown = pairs.every(pair => pair.length === 2 && pair.every(Number.isFinite)),
          sum     = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);

    if (![mem.anon, mem.file, cpuUsec].every(Number.isFinite)) {
        throw new Error('not a cgroup v2 read: memory.stat anon and file and cpu.stat usage_usec are required')
    }

    return {
        anonBytes   : mem.anon,
        fileBytes   : mem.file,
        cpuUsec,
        ioReadBytes : ioKnown  ? sum(devices, ([read])    => Number(read[1]))  : null,
        ioWriteBytes: ioKnown  ? sum(devices, ([, write]) => Number(write[1])) : null,
        netRxBytes  : netKnown ? sum(pairs, ([rx])   => rx) : null,
        netTxBytes  : netKnown ? sum(pairs, ([, tx]) => tx) : null
    }
}

/**
 * @summary Folds one tick's reads into the per-container series: a read that failed counts as a gap
 * of its container and adds no sample.
 * @param {Object}   series
 * @param {Object}   series.gaps Gap count per container
 * @param {Object}   series.rows Ordered samples per container
 * @param {Object[]} reads       `{container, service, atMs, ...sample}` or `{container, service, atMs, gap}`
 */
export function foldTick({gaps, rows}, reads) {
    reads.forEach(read => read.gap ? gaps[read.container]++ : rows[read.container].push(read))
}

/**
 * @summary Summarizes one container's ordered samples.
 *
 * Heap figures come from every sample; CPU and byte figures from the intervals between neighbours.
 * An interval in which any counter known at both ends went backwards is a reset: dropped whole and
 * counted. A byte counter unknown at either end leaves its interval out of that counter's total.
 * The percentile is the one definition of `stats.mjs`.
 * @param {Object[]} samples Ordered `{atMs, ...parseCgroupRead}` rows of one container
 * @returns {Object} samples, resets, intervals, heapGiB and cores as `{p50, p95, max}`, byte totals
 */
export function summarizeContainer(samples) {
    const cores     = [],
          counters  = {io: ['ioReadBytes', 'ioWriteBytes'], net: ['netRxBytes', 'netTxBytes']},
          intervals = {cpu: 0, io: 0, net: 0},
          totals    = {ioReadBytes: null, ioWriteBytes: null, netRxBytes: null, netTxBytes: null},
          round     = value => +value.toFixed(3),
          spread    = (values, scale = 1) => Object.fromEntries([['p50', 0.5], ['p95', 0.95], ['max', 1]]
              .map(([name, p]) => [name, values.length ? round(percentile(values, p) / scale) : null]));
    let resets = 0;

    for (let i = 1; i < samples.length; i++) {
        const prev  = samples[i - 1],
              cur   = samples[i],
              known = Object.fromEntries(Object.entries(counters).map(([family, keys]) =>
                  [family, keys.every(key => prev[key] !== null && cur[key] !== null)]));

        if (cur.cpuUsec < prev.cpuUsec || Object.entries(counters).some(([family, keys]) => known[family] && keys.some(key => cur[key] < prev[key]))) {
            resets++;
            continue
        }

        intervals.cpu++;
        cores.push((cur.cpuUsec - prev.cpuUsec) / ((cur.atMs - prev.atMs) * 1e3));

        Object.entries(counters).forEach(([family, keys]) => {
            if (known[family]) {
                intervals[family]++;
                keys.forEach(key => totals[key] += cur[key] - prev[key])
            }
        })
    }

    return {
        samples: samples.length,
        resets,
        intervals,
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
 * @summary Reads the volumes of a project out of `docker volume ls --filter label=com.docker.compose.project=<project>
 * --format '{{.Name}}\t{{.Label "com.docker.compose.volume"}}'`.
 *
 * Membership is the project's own label, never a name prefix: a prefix also matches a volume of
 * a project whose name merely starts alike, and misses a volume the project gave a name of its own.
 * @param {String} text
 * @returns {{key: String, name: String}[]} `key` is the volume's name inside the compose file
 */
export function parseVolumeList(text) {
    return text.trim().split('\n').filter(Boolean).map(line => {
        const [name, key] = line.split('\t');

        return {key: key || name, name}
    })
}

/**
 * @summary Looks the listed volumes up in `docker system df -v` by their exact names.
 * @param {String}   text
 * @param {Object[]} volumes The result of {@link parseVolumeList}
 * @returns {Object} bytes per volume key; `null` for a volume the table does not list
 */
export function parseVolumeSizes(text, volumes) {
    const sizes = new Map(text.split('\n').map(line => line.trim().split(/\s+/)).filter(columns => columns.length >= 3)
        .map(columns => [columns[0], columns.at(-1)]));

    return Object.fromEntries(volumes.map(({key, name}) => [key, sizes.has(name) ? parseDockerSize(sizes.get(name)) : null]))
}

/**
 * @summary Reads the containers of a project out of `docker ps --format '{{.Names}}\t{{.Label "com.docker.compose.service"}}'`.
 * @param {String} text
 * @returns {{container: String, service: String}[]}
 */
export function parseContainerList(text) {
    return text.trim().split('\n').filter(Boolean).map(line => {
        const [container, service] = line.split('\t');

        return {container, service}
    })
}

/**
 * @summary Builds the window's report from the folded series. The caller injects every timestamp.
 *
 * A window holds a tick at its start and one per full interval inside it, so its expected ticks
 * round up. A stop counts as early only inside the requested window: a signal after the window is
 * complete is the caller's cleanup.
 * @param {Object}      data
 * @param {String}      data.command
 * @param {Object[]}    data.containers    `{container, service}` of every sampled container
 * @param {Number}      data.endedAtMs
 * @param {Object}      data.gaps          Gap count per container
 * @param {String}      data.hardware
 * @param {Number}      data.intervalMs
 * @param {String}      data.project
 * @param {Object}      data.rows          Ordered samples per container
 * @param {Number}      data.startedAtMs
 * @param {Number|null} [data.stoppedAtMs] When a stop signal arrived, if one did
 * @param {Number}      data.ticks
 * @param {Object}      data.volumes       `{atStart, atEnd}`
 * @param {Number}      data.windowMs
 * @returns {Object}
 */
export function buildReport({command, containers, endedAtMs, gaps, hardware, intervalMs, project, rows, startedAtMs, stoppedAtMs = null, ticks, volumes, windowMs}) {
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
        coverage  : {ticks, expectedTicks: Math.ceil(windowMs / intervalMs)},
        containers: Object.fromEntries(containers.map(({container, service}) =>
            [container, {service, ...summarizeContainer(rows[container]), gaps: gaps[container]}])),
        volumes
    }
}
