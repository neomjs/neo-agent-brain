import {Command}                      from 'commander';
import {execFile}                     from 'node:child_process';
import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import path                           from 'node:path';
import {promisify}                    from 'node:util';
import {isEntryModule}                from '../../services/shared/isEntryModule.mjs';
import {
    buildReport,
    CGROUP_READ,
    foldTick,
    parseCgroupRead,
    parseContainerList,
    parseDuration,
    parseVolumeList,
    parseVolumeSizes
} from './helpers/planeSamplerCore.mjs';

const run = promisify(execFile);

/**
 * @module ai/scripts/benchmark/plane-sampler
 * @summary Samples the containers of one docker compose project over a window and writes a
 * provenance-stamped report: per container the resident heap, CPU in cores and byte totals, and the
 * project's volume sizes at both ends of the window.
 *
 * Every read goes through `docker exec` into the container's own cgroup, so it is the same read on
 * every host a plane runs on, a VM-backed one included. The rules a figure follows live in
 * `helpers/planeSamplerCore.mjs`. This module owns the clock, `docker` and the two files it writes,
 * both inside `--out`: `samples.jsonl` holds every tick, `report.json` the summary.
 *
 * It reads no configuration: the project's name and the window are its whole input.
 *
 * Run: node ai/scripts/benchmark/plane-sampler.mjs --project <compose project> --hardware <slug> \
 *        --window 10m --interval 30s --out <dir>
 */

/**
 * @summary Runs one window and writes its two files.
 * @param {Object} options
 * @param {String} options.hardware A slug naming the host the figures were taken on
 * @param {String} options.interval Time between ticks, as `parseDuration` reads it
 * @param {String} options.out      The directory that receives `samples.jsonl` and `report.json`
 * @param {String} options.project  The docker compose project
 * @param {String} options.window   How long to sample
 * @returns {Promise<void>}
 */
async function main(options) {
    const intervalMs = parseDuration(options.interval),
          windowMs   = parseDuration(options.window),
          member     = `label=com.docker.compose.project=${options.project}`,
          containers = parseContainerList((await run('docker', ['ps', '--filter', member,
              '--format', '{{.Names}}\t{{.Label "com.docker.compose.service"}}'])).stdout);

    if (!containers.length) {
        throw new Error(`no running containers in compose project "${options.project}"`)
    }

    const samplesLog = path.join(options.out, 'samples.jsonl'),
          series     = {
              gaps: Object.fromEntries(containers.map(({container}) => [container, 0])),
              rows: Object.fromEntries(containers.map(({container}) => [container, []]))
          },
          volumes    = async () => parseVolumeSizes(
              (await run('docker', ['system', 'df', '-v'], {maxBuffer: 16 * 1024 * 1024})).stdout,
              parseVolumeList((await run('docker', ['volume', 'ls', '--filter', member,
                  '--format', '{{.Name}}\t{{.Label "com.docker.compose.volume"}}'])).stdout));

    await mkdir(options.out, {recursive: true});

    // Two runs never share one samples file: an existing one is refused, not appended to
    await writeFile(samplesLog, '', {flag: 'wx'}).catch(error => {
        throw error.code === 'EEXIST' ? new Error(`${samplesLog} exists: give each run its own --out`) : error
    });

    const atStart     = await volumes(),
          startedAtMs = Date.now();
    let stoppedAtMs = null,
        ticks       = 0,
        wake        = null;

    // A stop ends the wait between two ticks at once
    ['SIGINT', 'SIGTERM'].forEach(signal => process.on(signal, () => {
        stoppedAtMs ??= Date.now();
        wake?.()
    }));

    while (stoppedAtMs === null && Date.now() - startedAtMs < windowMs) {
        const tickAt = Date.now();

        ticks++;

        const reads = await Promise.all(containers.map(({container, service}) =>
            run('docker', ['exec', container, 'sh', '-c', CGROUP_READ])
                .then(({stdout}) => ({container, service, atMs: tickAt, ...parseCgroupRead(stdout)}))
                .catch(error => ({container, service, atMs: tickAt, gap: error.message.split('\n')[0]}))));

        foldTick(series, reads);
        await appendFile(samplesLog, reads.map(read => JSON.stringify(read)).join('\n') + '\n');

        // Until the next tick, and never past the window's end
        await new Promise(resolve => {
            const timer = setTimeout(resolve, Math.max(0, Math.min(tickAt + intervalMs, startedAtMs + windowMs) - Date.now()));

            wake = () => {
                clearTimeout(timer);
                resolve()
            };

            stoppedAtMs !== null && wake()
        })
    }

    const reportFile = path.join(options.out, 'report.json');

    await writeFile(reportFile, JSON.stringify(buildReport({
        command   : `node ai/scripts/benchmark/plane-sampler.mjs ${process.argv.slice(2).join(' ')}`,
        containers,
        endedAtMs : Date.now(),
        gaps      : series.gaps,
        hardware  : options.hardware,
        intervalMs,
        project   : options.project,
        rows      : series.rows,
        startedAtMs,
        stoppedAtMs,
        ticks,
        volumes   : {atStart, atEnd: await volumes()},
        windowMs
    }), null, 2) + '\n');

    console.log(JSON.stringify({report: reportFile, samples: samplesLog}))
}

// Hoisted to a const: CodeQL's extractor cannot parse a statement that opens with `import.meta`
const isDirectRun = isEntryModule(import.meta.url);

if (isDirectRun) {
    const options = new Command()
        .name('plane-sampler')
        .description('Samples the containers of one docker compose project over a window')
        .requiredOption('--project <name>', 'the docker compose project to sample')
        .requiredOption('--hardware <slug>', 'names the host the figures were taken on')
        .requiredOption('--window <duration>', 'how long to sample: 90s, 10m, 8h, 7d')
        .requiredOption('--out <dir>', 'receives samples.jsonl and report.json; one run per directory')
        .option('--interval <duration>', 'time between ticks', '30s')
        .parse()
        .opts();

    main(options).catch(error => {
        console.error(`[plane-sampler] ${error.message}`);
        process.exit(1)
    })
}
