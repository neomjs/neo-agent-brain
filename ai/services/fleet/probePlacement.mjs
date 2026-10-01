import {execFile} from 'node:child_process';
import os         from 'node:os';
import {promisify} from 'node:util';

/**
 * @module ai/services/fleet/probePlacement
 * @summary The first-run recipe's placement probe: reads the machine that will bear a workload and
 * reports two RAM budgets kept apart — the host's (total minus every consumer, each once) and the
 * guest's (a VM's cap minus what its containers hold) — with pressure, uncertainty and a running
 * plane named explicitly. It carries no preset sizing threshold: {@link fitsPreset} compares a
 * preset's declared workload against both budgets and answers nothing without one.
 *
 * A cap is a limit, never consumption: raising a VM's cap moves the guest budget and leaves the host
 * budget alone. A loaded-but-idle model still holds its weights. `os.freemem()` is not availability
 * on macOS, so pressure comes from swap and compressed memory (the one named classifier here), and a
 * host that swaps gets no local fit whatever the arithmetic says. Every reader is injectable; one that
 * fails lands in `uncertainty`, the budget it feeds is marked incomplete, and an incomplete budget
 * never yields an affirmative fit. The probe reads the machine it runs on and nothing else — a remote
 * target is probed on the target, and its JSON is carried over.
 *
 * **One owner per process population.** The host inventory comes back partitioned: the VM's own
 * processes, the model servers, and everything else. A VM population is replaced by the observed
 * host reservation only when a VM topology was actually observed; a model server's resident set is
 * replaced by its loaded weights only when that server's inventory was actually read; container
 * processes on a host-native engine are already in the inventory and are never added a second time.
 */

const execFileAsync = promisify(execFile);

/** @summary One gibibyte (1024³), the unit every budget here is reasoned in. */
export const GiB = 1073741824;

/**
 * @summary The named share of total memory held by the compressor above which a host reads as
 * swapping even with no swap file in use — the 2026-09-23 specimen sat at 19 %.
 */
export const SWAPPING_COMPRESSED_SHARE = 0.15;

/**
 * @summary The conservative policy applied when a VM topology was observed but its host reservation
 * was not: the containers' residency plus two gibibytes of hypervisor overhead, counted once on the
 * host side.
 */
export const VM_RESERVATION_POLICY = 'vm-reservation=residency+2GiB';

/** @summary The canonical compose project of a local Agent OS plane — the one-plane-per-host detector's key. */
export const DEFAULT_PLANE_PROJECT = 'neo-local-agent-os';

/** @summary The readers whose observations the host budget is computed from; a failed one makes it incomplete. */
export const HOST_BUDGET_READERS = Object.freeze(['totalmem', 'hostUse', 'vmInfo', 'loadedModels']);

/**
 * @summary Probe the machine for the recipe's placement step.
 * @param {Object}   [options]
 * @param {Object}   [options.target={kind: 'local'}] Which machine this JSON describes; echoed back.
 * @param {Object}   [options.readers]        Backend readers (see {@link createDefaultReaders}); any
 *                                            subset, the rest default to the production shells.
 * @param {String}   [options.planeProject]   The compose project that counts as the canonical plane.
 * @param {Function} [options.now]            Clock, for `probedAt`.
 * @returns {Promise<Object>} `{host, guest, disk, cores, accelerator, runningPlane, observed, uncertainty, probedAt, target}`
 *   — `host.availableBytes = total − Σ consumers` (each consumer once, a cap never among them) or
 *   `null` while `host.complete` is false; `guest.availableBytes = cap − residency` or `guest: null`
 *   when the engine was observed running on the host itself; `host.pressure` one of
 *   `'ok' | 'swapping' | 'unknown'`; `observed` one boolean per reader; `uncertainty` one
 *   `{reader, reason}` per reader that failed or answered an unusable shape.
 */
export async function probePlacement({target = {kind: 'local'}, readers = {}, planeProject = DEFAULT_PLANE_PROJECT, now = () => new Date()} = {}) {
    const
        read        = {...createDefaultReaders(), ...readers},
        uncertainty = [],
        observed    = {},
        attempt     = async (name, ...args) => {
            if (typeof read[name] !== 'function') {
                observed[name] = false;
                uncertainty.push({reader: name, reason: 'no reader'});
                return undefined
            }
            try {
                const value = await read[name](...args);
                observed[name] = true;
                return value
            } catch (error) {
                observed[name] = false;
                uncertainty.push({reader: name, reason: error?.message || String(error)});
                return undefined
            }
        },
        unusable = (name, reason) => {
            observed[name] = false;
            uncertainty.push({reader: name, reason})
        };

    let totalBytes = await attempt('totalmem');
    if (observed.totalmem && !isByteCount(totalBytes)) { unusable('totalmem', 'not a byte count'); totalBytes = undefined }

    let inventory = await attempt('hostUse');
    if (observed.hostUse && !isConsumerList(inventory)) { unusable('hostUse', 'not a consumer list'); inventory = undefined }

    // `null` is an observation (the engine runs on the host itself); a throw or an unusable shape is not
    let vm = await attempt('vmInfo');
    if (observed.vmInfo && vm !== null && !isVmInfo(vm)) { unusable('vmInfo', 'not a VM description'); vm = undefined }

    let containers = await attempt('containerStats');
    if (observed.containerStats && !isConsumerList(containers)) { unusable('containerStats', 'not a container list'); containers = undefined }

    let modelInventory = await attempt('loadedModels');
    if (observed.loadedModels && !isModelInventory(modelInventory)) { unusable('loadedModels', 'not a model inventory'); modelInventory = undefined }

    const
        swap        = await attempt('swap'),
        disk        = await attempt('statfs'),
        cores       = await attempt('cores'),
        accelerator = await attempt('accelerator'),
        composeRows = await attempt('composeLs'),
        vmObserved  = observed.vmInfo && vm !== undefined,
        hasVm       = vmObserved && vm !== null,
        residency   = Array.isArray(containers) ? containers.reduce((sum, row) => sum + row.bytes, 0) : null,
        consumers   = [];

    // ---- the host budget: one owner per population ----------------------------------------------

    for (const row of inventory ?? []) {
        const population = row.population ?? 'other';

        if (population === 'vm' && hasVm) continue;                       // owned by the VM consumer below
        if (population === 'model-server' && modelInventory && row.inventory && modelInventory.inventories.includes(row.inventory)) continue; // owned by its loaded weights

        consumers.push({name: row.name, bytes: row.bytes, source: row.source, population})
    }

    for (const model of modelInventory?.models ?? []) {
        consumers.push({name: model.name, bytes: model.bytes, source: `loaded model (${model.state ?? 'loaded'}; weights stay resident)`, population: 'model'})
    }

    let guest = null;

    if (hasVm) {
        // the VM is one host consumer: an explicitly observed reservation, else its own processes'
        // resident sets from the inventory, else the named policy — never its cap, never its
        // containers' sum (that is the guest's residency, inside the VM)
        const
            explicit  = typeof read.vmReservation === 'function' ? await attempt('vmReservation', vm) : undefined,
            fromPs    = (inventory ?? []).filter(row => row.population === 'vm').reduce((sum, row) => sum + row.bytes, 0),
            reserved  = isByteCount(explicit) ? explicit : fromPs > 0 ? fromPs : null,
            policyOn  = reserved === null && residency !== null;

        if (reserved !== null) {
            consumers.push({name: `vm:${vm.backend}`, bytes: reserved, source: isByteCount(explicit) ? 'host reservation (observed)' : 'host reservation (the VM processes\' resident sets)', population: 'vm'})
        } else if (policyOn) {
            consumers.push({name: `vm:${vm.backend}`, bytes: residency + 2 * GiB, source: `policy:${VM_RESERVATION_POLICY}`, population: 'vm'});
            uncertainty.push({reader: 'vmReservation', reason: `host reservation unobservable; ${VM_RESERVATION_POLICY} applied`})
        }

        guest = {
            backend          : vm.backend,
            capBytes         : vm.capBytes,
            cores            : vm.cores ?? null,
            guestOs          : vm.guestOs ?? null,
            residencyBytes   : residency,
            availableBytes   : residency === null ? null : vm.capBytes - residency,
            reservationPolicy: reserved !== null ? null : policyOn ? VM_RESERVATION_POLICY : null,
            complete         : residency !== null && (reserved !== null || policyOn)
        }
    }
    // a host-native engine: its container processes are already in the inventory, once; the stats
    // rows are reported for display and never added to the budget

    const
        hostComplete = HOST_BUDGET_READERS.every(name => observed[name]) && vm !== undefined && (!hasVm || guest.complete),
        consumed     = consumers.reduce((sum, row) => sum + row.bytes, 0);

    return {
        host: {
            totalBytes    : totalBytes ?? null,
            consumers,
            // listed for display only on an observed host-native engine; unknown topology lists nothing
            containers    : vmObserved && !hasVm && Array.isArray(containers) ? containers : null,
            availableBytes: hostComplete ? totalBytes - consumed : null,
            complete      : hostComplete,
            pressure      : classifyPressure(swap, totalBytes)
        },
        guest,
        disk        : disk ?? null,
        cores       : cores ?? null,
        accelerator : accelerator ?? null,
        runningPlane: await detectRunningPlane(composeRows ?? [], planeProject, attempt),
        observed,
        uncertainty,
        probedAt    : now().toISOString(),
        target
    }
}

/**
 * @summary Compare a preset's declared workload against both budgets. Pure: no workload, no verdict;
 * a malformed workload, an incomplete budget, or a swapping host and a local preset are refusals,
 * never an affirmative fit.
 *
 * The workload is **additional demand**: a new plane's peak plus its models, on top of everything the
 * probe already counted. The plane's containers live in the VM when there is one, and the VM's
 * memory is host memory, so the host backs the plane's peak with or without a VM; the guest budget
 * must hold the same peak under the cap. Raising the cap alone therefore never changes the host margin.
 * @param {Object} probe    A {@link probePlacement} result.
 * @param {Object} workload `{planeIdleBytes, planePeakBytes, modelsBytes, vmCapRecommendedBytes}` —
 *                          the presets leaf's data; `modelsBytes > 0` is what makes a preset local.
 * @returns {Object|null} `{fits, margins: {host, guest}, reasons}` or `null` without a workload.
 */
export function fitsPreset(probe, workload) {
    if (workload === undefined || workload === null) return null;

    const reasons = [];

    if (!isPlainObject(workload) || !isByteCount(workload.planePeakBytes) || !isByteCount(workload.modelsBytes)) {
        return {fits: false, margins: {host: null, guest: null}, reasons: ['the workload is malformed: planePeakBytes and modelsBytes must be byte counts']}
    }

    const
        {planePeakBytes, modelsBytes, vmCapRecommendedBytes = null} = workload,
        local     = modelsBytes > 0,
        host      = probe?.host ?? {},
        guest     = probe?.guest ?? null,
        hostNeed  = modelsBytes + planePeakBytes,
        margins   = {
            host : host.complete && isByteCount(host.availableBytes) ? host.availableBytes - hostNeed : null,
            guest: guest?.complete && isByteCount(guest.availableBytes) ? guest.availableBytes - planePeakBytes : null
        };

    if (!host.complete || margins.host === null) {
        const missing = Object.entries(probe?.observed ?? {}).filter(([, ok]) => !ok).map(([name]) => name);

        reasons.push(`the host budget is incomplete${missing.length ? ` (unobserved: ${missing.join(', ')})` : ''}`)
    } else if (margins.host < 0) {
        reasons.push(`the host budget falls ${((-margins.host) / GiB).toFixed(1)} GiB short`)
    }

    if (guest && (!guest.complete || margins.guest === null)) {
        reasons.push('the guest budget is incomplete')
    } else if (guest && margins.guest < 0) {
        reasons.push(`the guest budget falls ${((-margins.guest) / GiB).toFixed(1)} GiB short`)
    }

    if (local && host.pressure === 'swapping') {
        reasons.push('the host is swapping: no local preset fits, whatever the arithmetic says')
    }
    if (local && host.pressure !== 'ok' && host.pressure !== 'swapping') {
        reasons.push('host pressure is unknown: a local preset is not called a fit')
    }
    if (guest && isByteCount(vmCapRecommendedBytes) && guest.capBytes < vmCapRecommendedBytes) {
        reasons.push(`the VM cap is below the preset's recommended ${(vmCapRecommendedBytes / GiB).toFixed(0)} GiB`)
    }

    return {fits: reasons.length === 0, margins, reasons}
}

// ---- shape guards ---------------------------------------------------------------------------------

const isPlainObject   = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isByteCount     = value => Number.isFinite(value) && value >= 0;
const isConsumerList  = value => Array.isArray(value) && value.every(row => isPlainObject(row) && typeof row.name === 'string' && isByteCount(row.bytes));
const isVmInfo        = value => isPlainObject(value) && typeof value.backend === 'string' && isByteCount(value.capBytes);
const isModelInventory = value => isPlainObject(value) && Array.isArray(value.inventories) && isConsumerList(value.models);

/**
 * @summary `'swapping'` when swap is in use or the compressor holds the named share of memory;
 * `'unknown'` when neither could be read. `os.freemem()` plays no part.
 * @param {Object|undefined} swap       `{swapUsedBytes, compressedBytes}` or `undefined` on a failed read.
 * @param {Number|undefined} totalBytes
 * @returns {String}
 * @private
 */
function classifyPressure(swap, totalBytes) {
    if (!isPlainObject(swap) || !isByteCount(totalBytes)) return 'unknown';

    const {swapUsedBytes = 0, compressedBytes = 0} = swap;

    if (!isByteCount(swapUsedBytes) || !isByteCount(compressedBytes)) return 'unknown';

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
    const row = Array.isArray(rows) ? rows.find(entry => entry?.name === planeProject && /^running/i.test(entry.status ?? '')) : null;

    if (!row) return null;

    const ports = await attempt('composePorts', row.name);

    return {
        project    : row.name,
        status     : row.status,
        ports      : Array.isArray(ports) ? ports : [],
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

/** @summary Byte multipliers for the unit suffixes the instruments print — binary and decimal, by prefix letter. */
const BYTE_UNITS = {
    binary : {k: 1024, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776},
    decimal: {k: 1000, K: 1000, M: 1000000, G: 1000000000, T: 1000000000000}
};

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
 * @summary Parse `lms ps --json` into loaded models `{name, bytes, state}` — an idle model still
 * counts, and a row without a finite size is an unreadable inventory, never zero bytes.
 * @param {String} json
 * @returns {Object[]}
 */
export function parseLmsPs(json) {
    return JSON.parse(json).map(model => {
        if (!Number.isFinite(model?.sizeBytes) || model.sizeBytes < 0) {
            throw new Error(`lms ps row '${model?.identifier ?? model?.modelKey ?? '?'}' carries no sizeBytes`)
        }

        return {name: model.identifier ?? model.modelKey, bytes: model.sizeBytes, state: model.status ?? 'loaded'}
    })
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
 * @summary The processes Docker Desktop has been seen to run its VM under: Apple's Virtualization
 * framework XPC service on macOS 26+ (8.8 GiB resident on the 2026-10-01 specimen), its own
 * virtualization helper before that, and QEMU on hosts that run a VM.
 */
export const VM_PROCESS_PATTERNS = [/com\.apple\.Virtualization\.VirtualMachine/i, /com\.docker\.virtualization/i, /qemu-system/i];

/**
 * @summary Model servers and the inventory that lists their loaded weights: LM Studio's bundled
 * runtime lives under `~/.lmstudio/` and `lms ps` is its inventory; Ollama and llama-server have no
 * inventory read here, so their resident sets stay host consumers as observed.
 */
export const MODEL_SERVER_PATTERNS = [
    {pattern: /\.lmstudio\//i, name: 'lm-studio', inventory: 'lms'},
    {pattern: /LM Studio/i,    name: 'lm-studio', inventory: 'lms'},
    {pattern: /\bollama\b/i,   name: 'ollama',    inventory: null},
    {pattern: /llama-server/i, name: 'llama-server', inventory: null}
];

/**
 * @summary Partition `ps -axo rss=,comm=` output (KiB → bytes) into the host inventory: one
 * `os-and-harnesses` row for everything unmatched, one row per matched VM process pattern
 * (`population: 'vm'`) and one per model server (`population: 'model-server'`, with the inventory
 * that could replace it). Nothing is discarded here — the probe decides each population's owner.
 * @param {String} text
 * @returns {Object[]}
 */
export function partitionProcessInventory(text) {
    const
        rows   = [],
        groups = new Map();
    let other = 0;

    for (const line of String(text ?? '').split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);

        if (!match) continue;

        const
            bytes   = Number(match[1]) * 1024,
            command = match[2],
            server  = MODEL_SERVER_PATTERNS.find(entry => entry.pattern.test(command));

        if (VM_PROCESS_PATTERNS.some(pattern => pattern.test(command))) {
            groups.set('vm', {name: 'vm-processes', bytes: (groups.get('vm')?.bytes ?? 0) + bytes, source: 'ps -axo rss (the VM\'s own processes)', population: 'vm'})
        } else if (server) {
            const key = `model-server:${server.name}`;

            groups.set(key, {name: key, bytes: (groups.get(key)?.bytes ?? 0) + bytes, source: 'ps -axo rss (the model server\'s own processes)', population: 'model-server', inventory: server.inventory})
        } else {
            other += bytes
        }
    }

    rows.push({name: 'os-and-harnesses', bytes: other, source: 'ps -axo rss (every process except the VM and the model servers)', population: 'other'});
    rows.push(...groups.values());

    return rows
}

/**
 * @summary Build the production readers over an injectable command runner — thin shells over the
 * instruments the ticket measured, one each; every entry may throw, and the probe turns a throw into
 * an `uncertainty` entry and an incomplete budget.
 * @param {Object}   [options]
 * @param {Function} [options.run]      `(file, args) => Promise<String>` returning stdout.
 * @param {String}   [options.hostType] `os.type()` override for tests.
 * @returns {Object}
 */
export function createDefaultReaders({run = defaultRun, hostType = os.type()} = {}) {
    return {
        totalmem: () => os.totalmem(),
        cores   : () => os.cpus().length,

        hostUse       : async () => partitionProcessInventory(await run('ps', ['-axo', 'rss=,comm='])),
        vmInfo        : async () => parseDockerInfo(await run('docker', ['info', '--format', '{{.MemTotal}} {{.NCPU}} {{.OperatingSystem}}']), hostType),
        containerStats: async () => (await run('docker', ['stats', '--no-stream', '--format', '{{json .}}'])).split('\n').filter(Boolean).map(line => parseDockerStatsRow(JSON.parse(line))),
        loadedModels  : async () => ({inventories: ['lms'], models: parseLmsPs(await run('lms', ['ps', '--json']))}),

        async swap() {
            if (hostType !== 'Darwin') {
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
    }
}

/** @private */
async function defaultRun(file, args) {
    return (await execFileAsync(file, args, {encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024})).stdout
}

/** @summary The production readers over the real command runner. */
export const defaultReaders = createDefaultReaders();
