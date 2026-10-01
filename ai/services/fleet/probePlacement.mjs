import {execFile} from 'node:child_process';
import os         from 'node:os';
import {promisify} from 'node:util';

/**
 * @module ai/services/fleet/probePlacement
 * @summary The first-run recipe's placement probe: reads the machine that will bear a workload and
 * reports two RAM budgets kept apart — the host's (total minus every consumer, each once) and the
 * guest's (a VM's cap minus what its containers hold) — with pressure, uncertainty and a running
 * plane named explicitly. It carries no threshold: {@link fitsPreset} compares a preset's declared
 * workload against both budgets and answers nothing without one.
 *
 * A cap is a limit, never consumption: raising a VM's cap moves the guest budget and leaves the host
 * budget alone. A loaded-but-idle model still holds its weights. `os.freemem()` is not availability
 * on macOS, so pressure comes from swap and compressed memory, and a host that swaps gets no local
 * fit whatever the arithmetic says. Every reader is injectable; one that fails lands in
 * `uncertainty` and the budgets are computed from what was read. The probe reads the machine it
 * runs on and nothing else — a remote target is probed on the target, and its JSON is carried over.
 */

const execFileAsync = promisify(execFile);

/** @summary One gibibyte (1024³), the unit every budget here is reasoned in. */
export const GiB = 1073741824;

/** @summary Byte multipliers for the unit suffixes the instruments print — binary and decimal, by prefix letter. */
const BYTE_UNITS = {
    binary : {k: 1024, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776},
    decimal: {k: 1000, K: 1000, M: 1000000, G: 1000000000, T: 1000000000000}
};

/**
 * @summary The named share of total memory held by the compressor above which a host reads as
 * swapping even with no swap file in use — the 2026-09-23 specimen sat at 19 %.
 */
export const SWAPPING_COMPRESSED_SHARE = 0.15;

/**
 * @summary The conservative policy applied when a VM's host reservation cannot be observed: its
 * containers' residency plus two gibibytes of hypervisor overhead, counted once on the host side.
 */
export const VM_RESERVATION_POLICY = 'vm-reservation=residency+2GiB';

/** @summary The canonical compose project of a local Agent OS plane — the one-plane-per-host detector's key. */
export const DEFAULT_PLANE_PROJECT = 'neo-local-agent-os';

/**
 * @summary Probe the machine for the recipe's placement step.
 * @param {Object}   [options]
 * @param {Object}   [options.target={kind: 'local'}] Which machine this JSON describes; echoed back.
 * @param {Object}   [options.readers]        Backend readers (see {@link defaultReaders}); any subset,
 *                                            the rest default to the production shells.
 * @param {String}   [options.planeProject]   The compose project that counts as the canonical plane.
 * @param {Function} [options.now]            Clock, for `probedAt`.
 * @returns {Promise<Object>} `{host, guest, disk, cores, accelerator, runningPlane, uncertainty, probedAt, target}`
 *   — `host.availableBytes = total − Σ consumers` (each consumer once, a cap never among them),
 *   `guest.availableBytes = cap − residency` or `guest: null` without a VM, `host.pressure` one of
 *   `'ok' | 'swapping' | 'unknown'`, `uncertainty` one `{reader, reason}` per reader that failed.
 */
export async function probePlacement({target = {kind: 'local'}, readers = {}, planeProject = DEFAULT_PLANE_PROJECT, now = () => new Date()} = {}) {
    const
        read        = {...defaultReaders, ...readers},
        uncertainty = [],
        attempt     = async (name, ...args) => {
            try {
                return await read[name](...args)
            } catch (error) {
                uncertainty.push({reader: name, reason: error?.message || String(error)});
                return undefined
            }
        };

    const
        totalBytes   = await attempt('totalmem'),
        hostUse      = await attempt('hostUse')        ?? [],
        vm           = await attempt('vmInfo'),
        containers   = await attempt('containerStats') ?? [],
        models       = await attempt('loadedModels')   ?? [],
        swap         = await attempt('swap'),
        disk         = await attempt('statfs'),
        cores        = await attempt('cores'),
        accelerator  = await attempt('accelerator'),
        composeRows  = await attempt('composeLs')      ?? [],
        residency    = containers.reduce((sum, row) => sum + row.bytes, 0),
        consumers    = [
            ...hostUse.map(row => ({name: row.name, bytes: row.bytes, source: row.source})),
            ...models.map(model => ({name: model.name, bytes: model.bytes, source: `loaded model (${model.state ?? 'loaded'}; weights stay resident)`}))
        ];

    let guest = null;

    if (vm) {
        // the VM is one host consumer: its observed reservation, else the named policy — never its
        // cap, and never its containers' sum (that is the guest's residency, inside the VM)
        const reservation = await attempt('vmReservation', vm);

        if (typeof reservation === 'number') {
            consumers.push({name: `vm:${vm.backend}`, bytes: reservation, source: 'host reservation (observed)'})
        } else {
            consumers.push({name: `vm:${vm.backend}`, bytes: residency + 2 * GiB, source: `policy:${VM_RESERVATION_POLICY}`});
            uncertainty.push({reader: 'vmReservation', reason: `host reservation unobservable; ${VM_RESERVATION_POLICY} applied`})
        }

        guest = {
            backend          : vm.backend,
            capBytes         : vm.capBytes,
            cores            : vm.cores ?? null,
            guestOs          : vm.guestOs ?? null,
            residencyBytes   : residency,
            availableBytes   : vm.capBytes - residency,
            reservationPolicy: typeof reservation === 'number' ? null : VM_RESERVATION_POLICY
        }
    } else {
        // no VM: containers are host consumers directly, each once
        consumers.push(...containers.map(row => ({name: row.name, bytes: row.bytes, source: 'container (host-native)'})))
    }

    const consumed = consumers.reduce((sum, row) => sum + row.bytes, 0);

    return {
        host: {
            totalBytes    : totalBytes ?? null,
            consumers,
            availableBytes: typeof totalBytes === 'number' ? totalBytes - consumed : null,
            pressure      : classifyPressure(swap, totalBytes)
        },
        guest,
        disk        : disk ?? null,
        cores       : cores ?? null,
        accelerator : accelerator ?? null,
        runningPlane: await detectRunningPlane(composeRows, planeProject, attempt),
        uncertainty,
        probedAt    : now().toISOString(),
        target
    }
}

/**
 * @summary Compare a preset's declared workload against both budgets. Pure: no preset data, no verdict.
 * @param {Object} probe    A {@link probePlacement} result.
 * @param {Object} workload `{planeIdleBytes, planePeakBytes, modelsBytes, vmCapRecommendedBytes}` —
 *                          the presets leaf's data; `modelsBytes > 0` is what makes a preset local.
 * @returns {Object|null} `{fits, margins: {host, guest}, reasons}` or `null` without a workload.
 */
export function fitsPreset(probe, workload) {
    if (!workload || typeof workload !== 'object') return null;

    const
        {planePeakBytes = 0, modelsBytes = 0, vmCapRecommendedBytes = null} = workload,
        local     = modelsBytes > 0,
        reasons   = [],
        hostAvail = probe?.host?.availableBytes,
        guest     = probe?.guest ?? null,
        // the plane's containers live in the VM when there is one; the models always sit on the host
        hostNeed  = modelsBytes + (guest ? 0 : planePeakBytes),
        guestNeed = guest ? planePeakBytes : 0,
        margins   = {
            host : typeof hostAvail === 'number' ? hostAvail - hostNeed : null,
            guest: guest ? guest.availableBytes - guestNeed : null
        };

    if (local && probe?.host?.pressure === 'swapping') {
        reasons.push('the host is swapping: no local preset fits, whatever the arithmetic says')
    }
    if (local && probe?.host?.pressure === 'unknown') {
        reasons.push('host pressure is unknown: a local preset is not called a fit')
    }
    if (margins.host === null) {
        reasons.push('the host budget could not be computed')
    } else if (margins.host < 0) {
        reasons.push(`the host budget falls ${((-margins.host) / GiB).toFixed(1)} GiB short`)
    }
    if (guest && margins.guest < 0) {
        reasons.push(`the guest budget falls ${((-margins.guest) / GiB).toFixed(1)} GiB short`)
    }
    if (guest && typeof vmCapRecommendedBytes === 'number' && guest.capBytes < vmCapRecommendedBytes) {
        reasons.push(`the VM cap is below the preset's recommended ${(vmCapRecommendedBytes / GiB).toFixed(0)} GiB`)
    }

    return {fits: reasons.length === 0, margins, reasons}
}

/**
 * @summary `'swapping'` when swap is in use or the compressor holds the named share of memory;
 * `'unknown'` when neither could be read. `os.freemem()` plays no part.
 * @param {Object|undefined} swap       `{swapUsedBytes, compressedBytes}` or `undefined` on a failed read.
 * @param {Number|undefined} totalBytes
 * @returns {String}
 * @private
 */
function classifyPressure(swap, totalBytes) {
    if (!swap || typeof totalBytes !== 'number') return 'unknown';

    const {swapUsedBytes = 0, compressedBytes = 0} = swap;

    return swapUsedBytes > 0 || compressedBytes >= SWAPPING_COMPRESSED_SHARE * totalBytes ? 'swapping' : 'ok'
}

/**
 * @summary The one-plane-per-host detector: the canonical compose project, running, with its ports.
 * @param {Object[]} rows         `composeLs` rows `{name, status, configFiles}`.
 * @param {String}   planeProject
 * @param {Function} attempt      The probe's guarded reader call.
 * @returns {Promise<Object|null>} `{project, status, ports, configFiles}` or `null`.
 * @private
 */
async function detectRunningPlane(rows, planeProject, attempt) {
    const row = rows.find(entry => entry.name === planeProject && /^running/i.test(entry.status ?? ''));

    if (!row) return null;

    return {
        project    : row.name,
        status     : row.status,
        ports      : (await attempt('composePorts', row.name)) ?? [],
        configFiles: row.configFiles ?? []
    }
}

// ---- parsers: pure, each pinned against a line measured on a real host -------------------------

/**
 * @summary Parse a docker byte figure (`979.2MiB`, `12GiB`, `1.5GB`, `512kB`) into bytes.
 * @param {String} text
 * @returns {Number}
 */
export function parseDockerBytes(text) {
    const match = /^\s*([\d.]+)\s*([kKMGT]?i?B)\s*$/.exec(text ?? '');

    if (!match) throw new Error(`unreadable docker byte figure '${text}'`);

    const
        value = Number(match[1]),
        unit  = match[2],
        scale = unit === 'B' ? 1 : BYTE_UNITS[unit.endsWith('iB') ? 'binary' : 'decimal'][unit[0]];

    return Math.round(value * scale)
}

/**
 * @summary Parse one `docker stats --no-stream --format '{{json .}}'` row into `{name, bytes}`
 * (the container's own usage — the figure before the slash; the figure after it is its cap).
 * @param {Object} row
 * @returns {Object}
 */
export function parseDockerStatsRow(row) {
    return {name: row.Name, bytes: parseDockerBytes(String(row.MemUsage).split('/')[0])}
}

/**
 * @summary Parse `docker info --format '{{.MemTotal}} {{.NCPU}} {{.OperatingSystem}}'` into the VM
 * description, or `null` when the engine runs on the host itself (no VM, no guest budget).
 * @param {String} line     e.g. `33587089408 8 Ubuntu 24.04.4 LTS`
 * @param {String} hostType `os.type()` — `Darwin` / `Windows_NT` engines always run in a VM.
 * @returns {Object|null}
 */
export function parseDockerInfo(line, hostType = os.type()) {
    // the command's stdout ends in a newline, and `$` matches only the very end of the input in JS
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(String(line ?? '').trim());

    if (!match) throw new Error(`unreadable docker info '${line}'`);

    const guestOs = match[3].trim();

    if (hostType === 'Linux' && !/docker desktop/i.test(guestOs)) return null;

    return {backend: 'docker-desktop', capBytes: Number(match[1]), cores: Number(match[2]), guestOs}
}

/**
 * @summary Parse `sysctl vm.swapusage` (`total = 10240.00M  used = 9647.56M  free = 592.44M`) into bytes used.
 * @param {String} line
 * @returns {Number}
 */
export function parseSwapUsage(line) {
    const match = /used\s*=\s*([\d.]+)([KMG])/.exec(line ?? '');

    if (!match) throw new Error(`unreadable swapusage '${line}'`);

    return Math.round(Number(match[1]) * BYTE_UNITS.binary[match[2]])
}

/**
 * @summary Parse `vm_stat` into the compressor's resident bytes (`Pages occupied by compressor` × page size).
 * @param {String} text
 * @returns {Number}
 */
export function parseVmStatCompressed(text) {
    const
        page  = /page size of (\d+) bytes/.exec(text ?? ''),
        pages = /Pages occupied by compressor:\s*(\d+)/.exec(text ?? '');

    if (!page || !pages) throw new Error('unreadable vm_stat');

    return Number(pages[1]) * Number(page[1])
}

/**
 * @summary Parse `docker compose ls --format json` into `{name, status, configFiles}` rows.
 * @param {String} json
 * @returns {Object[]}
 */
export function parseComposeLs(json) {
    return JSON.parse(json).map(row => ({
        name       : row.Name,
        status     : row.Status,
        configFiles: String(row.ConfigFiles ?? '').split(',').filter(Boolean)
    }))
}

/**
 * @summary Parse `docker compose -p <project> ps --format json` (one JSON object per line) into the
 * published host ports.
 * @param {String} text
 * @returns {Number[]}
 */
export function parseComposePorts(text) {
    const ports = new Set();

    for (const line of String(text ?? '').split('\n').filter(Boolean)) {
        for (const publisher of JSON.parse(line).Publishers ?? []) {
            if (publisher.PublishedPort) ports.add(publisher.PublishedPort)
        }
    }

    return [...ports].sort((a, b) => a - b)
}

/**
 * @summary Parse `lms ps --json` into loaded models `{name, bytes, state}` — an idle model still counts.
 * @param {String} json
 * @returns {Object[]}
 */
export function parseLmsPs(json) {
    return JSON.parse(json).map(model => ({
        name : model.identifier ?? model.modelKey,
        bytes: Number(model.sizeBytes ?? 0),
        state: model.status ?? 'loaded'
    }))
}

/**
 * @summary Parse `df -k /` into the root volume's free bytes (the `Available` column).
 * @param {String} text
 * @returns {Object} `{rootFreeBytes}`
 */
export function parseDfRoot(text) {
    const
        last    = String(text ?? '').trim().split('\n').pop(),
        columns = last.split(/\s+/);

    if (columns.length < 4 || !/^\d+$/.test(columns[3])) throw new Error('unreadable df output');

    return {rootFreeBytes: Number(columns[3]) * 1024}
}

/**
 * @summary Sum the resident set of every process whose command matches one of `patterns` (KiB → bytes),
 * from `ps -axo rss=,comm=` output; `null` when nothing matched.
 * @param {String}   text
 * @param {RegExp[]} patterns
 * @returns {Number|null}
 */
export function sumProcessRss(text, patterns) {
    let found = false, total = 0;

    for (const line of String(text ?? '').split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);

        if (match && patterns.some(pattern => pattern.test(match[2]))) {
            found  = true;
            total += Number(match[1]) * 1024
        }
    }

    return found ? total : null
}

/**
 * @summary The processes Docker Desktop has been seen to run its VM under: Apple's Virtualization
 * framework XPC service on macOS 26+ (8.8 GiB resident on the 2026-10-01 specimen), its own
 * virtualization helper before that, and QEMU on Linux hosts that still run a VM.
 */
export const VM_PROCESS_PATTERNS = [/com\.apple\.Virtualization\.VirtualMachine/i, /com\.docker\.virtualization/i, /qemu-system/i];

/**
 * @summary Model servers whose own resident set is separate from the weights `loadedModels` already
 * count: LM Studio's bundled node runtime lives under `~/.lmstudio/`, Ollama and llama-server by name.
 */
export const MODEL_SERVER_PATTERNS = [/\.lmstudio\//i, /LM Studio/i, /\bollama\b/i, /llama-server/i];

const run = async (file, args) => (await execFileAsync(file, args, {encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024})).stdout;

/**
 * @summary The production readers: thin shells over the instruments the ticket measured, one each.
 * Every entry may throw; the probe turns a throw into an `uncertainty` entry.
 */
export const defaultReaders = {
    totalmem: () => os.totalmem(),
    cores   : () => os.cpus().length,

    // the OS and every harness, once: all resident sets except the VM's (its own consumer) and the
    // model server's (its weights are the loaded models' bytes)
    async hostUse() {
        const
            text   = await run('ps', ['-axo', 'rss=,comm=']),
            all    = sumProcessRss(text, [/./]) ?? 0,
            vm     = sumProcessRss(text, VM_PROCESS_PATTERNS) ?? 0,
            models = sumProcessRss(text, MODEL_SERVER_PATTERNS) ?? 0;

        return [{name: 'os-and-harnesses', bytes: all - vm - models, source: 'ps -axo rss (every process except the VM and the model server)'}]
    },

    vmInfo        : async () => parseDockerInfo(await run('docker', ['info', '--format', '{{.MemTotal}} {{.NCPU}} {{.OperatingSystem}}'])),
    containerStats: async () => (await run('docker', ['stats', '--no-stream', '--format', '{{json .}}'])).split('\n').filter(Boolean).map(line => parseDockerStatsRow(JSON.parse(line))),
    vmReservation : async () => sumProcessRss(await run('ps', ['-axo', 'rss=,comm=']), VM_PROCESS_PATTERNS),
    loadedModels  : async () => parseLmsPs(await run('lms', ['ps', '--json'])),

    async swap() {
        if (os.type() !== 'Darwin') {
            const meminfo = await run('cat', ['/proc/meminfo']),
                  total   = Number(/SwapTotal:\s*(\d+)/.exec(meminfo)?.[1] ?? 0),
                  free    = Number(/SwapFree:\s*(\d+)/.exec(meminfo)?.[1] ?? 0);

            return {swapUsedBytes: (total - free) * 1024, compressedBytes: 0}
        }

        return {
            swapUsedBytes  : parseSwapUsage(await run('sysctl', ['-n', 'vm.swapusage'])),
            compressedBytes: parseVmStatCompressed(await run('vm_stat', []))
        }
    },

    composeLs   : async () => parseComposeLs(await run('docker', ['compose', 'ls', '--format', 'json'])),
    composePorts: async project => parseComposePorts(await run('docker', ['compose', '-p', project, 'ps', '--format', 'json'])),
    statfs      : async () => parseDfRoot(await run('df', ['-k', '/'])),
    accelerator : () => null
};
