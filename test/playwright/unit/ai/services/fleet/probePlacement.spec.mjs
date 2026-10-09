import {expect, test} from '@playwright/test';
import {
    DEFAULT_PLANE_PROJECT,
    GiB,
    MODEL_SERVER_PATTERNS,
    VM_PROCESS_PATTERNS,
    VM_RESERVATION_POLICY,
    createDefaultReaders,
    describeUncertainty,
    fitsPreset,
    parseComposeLs,
    parseComposePorts,
    parseDfRoot,
    parseDockerBytes,
    parseDockerInfo,
    parseDockerStatsRow,
    parseLmsPs,
    parseSwapUsage,
    parseVmStatCompressed,
    partitionProcessInventory,
    probePlacement,
    vocabularyMatches
} from '../../../../../../ai/services/fleet/probePlacement.mjs';

// Pure module, injected readers: every arm runs without docker, lms or a VM on the test host.

/**
 * @summary The counterexample fixture that fixed the two-budget rule: a 64 GiB host, 14 GiB other
 * use, 20 GiB resident models, a 32 GiB VM cap at 2.5 GiB residency — host headroom 27.5 GiB,
 * guest 29.5. Subtracting the cap as consumption read −2 GiB here.
 */
function fixtureReaders(overrides = {}) {
    return {
        totalmem      : () => 64 * GiB,
        cores         : () => 16,
        hostUse       : () => [{name: 'os-and-harnesses', bytes: 14 * GiB, source: 'fixture'}],
        vmInfo        : () => ({backend: 'docker-desktop', capBytes: 32 * GiB, cores: 8, guestOs: 'Ubuntu 24.04.4 LTS'}),
        containerStats: () => [{name: 'chroma', bytes: 2 * GiB}, {name: 'mc-server', bytes: 0.5 * GiB}],
        vmReservation : () => 2.5 * GiB,
        loadedModels  : () => ({inventories: ['lms'], models: [{name: 'google/gemma-4-26b-a4b', bytes: 15 * GiB, state: 'idle'}, {name: 'qwen3-embedding-8b', bytes: 5 * GiB, state: 'idle'}]}),
        swap          : () => ({swapUsedBytes: 0, compressedBytes: 1 * GiB}),
        statfs        : () => ({rootFreeBytes: 300 * GiB}),
        accelerator   : () => null,
        composeLs     : () => [],
        composePorts  : () => [],
        ...overrides
    }
}

const
    LOCAL_FULL = {planeIdleBytes: 0.4 * GiB, planePeakBytes: 2.5 * GiB, modelsBytes: 20 * GiB, vmCapRecommendedBytes: 8 * GiB},
    HOSTED     = {planeIdleBytes: 0.4 * GiB, planePeakBytes: 2.5 * GiB, modelsBytes: 0, vmCapRecommendedBytes: 8 * GiB},
    NOW        = () => new Date('2026-10-01T17:00:00.000Z');

test.describe('probePlacement — two budgets kept apart', () => {
    test('AC-1: the fixture reads 27.5 GiB host headroom and 29.5 GiB guest headroom, every consumer once, no cap in the sum', async () => {
        const probe = await probePlacement({readers: fixtureReaders(), now: NOW});

        expect(probe.host.totalBytes).toBe(64 * GiB);
        expect(probe.host.complete).toBe(true);
        expect(probe.host.availableBytes).toBe(27.5 * GiB);
        expect(probe.host.consumers.map(row => row.name)).toEqual(['os-and-harnesses', 'google/gemma-4-26b-a4b', 'qwen3-embedding-8b', 'vm:docker-desktop']);
        expect(probe.host.consumers.find(row => row.name === 'vm:docker-desktop')).toEqual({name: 'vm:docker-desktop', bytes: 2.5 * GiB, source: 'host reservation (observed)', population: 'vm'});
        expect(probe.host.consumers.some(row => row.bytes === 32 * GiB)).toBe(false);
        expect(probe.host.containers).toBeNull();   // inside the VM: they are the guest's residency
        expect(probe.host.pressure).toBe('ok');
        expect(probe.guest).toEqual({
            backend          : 'docker-desktop',
            capBytes         : 32 * GiB,
            cores            : 8,
            guestOs          : 'Ubuntu 24.04.4 LTS',
            residencyBytes   : 2.5 * GiB,
            availableBytes   : 29.5 * GiB,
            reservationPolicy: null,
            complete         : true
        });
        expect(probe.disk).toEqual({rootFreeBytes: 300 * GiB});
        expect(probe.cores).toBe(16);
        expect(probe.runningPlane).toBeNull();
        expect(probe.observed).toMatchObject({totalmem: true, hostUse: true, vmInfo: true, containerStats: true, loadedModels: true, swap: true, vmReservation: true});
        expect(probe.uncertainty).toEqual([]);
        expect(probe.probedAt).toBe('2026-10-01T17:00:00.000Z');
        expect(probe.target).toEqual({kind: 'local'})
    });

    test('AC-2: raising only the VM cap moves the guest budget and leaves the host budget and the host margin alone', async () => {
        const
            before = await probePlacement({readers: fixtureReaders()}),
            after  = await probePlacement({readers: fixtureReaders({vmInfo: () => ({backend: 'docker-desktop', capBytes: 48 * GiB, cores: 8, guestOs: 'Ubuntu 24.04.4 LTS'})})});

        expect(after.host.availableBytes).toBe(before.host.availableBytes);
        expect(after.guest.availableBytes - before.guest.availableBytes).toBe(16 * GiB);
        expect(fitsPreset(after, LOCAL_FULL).margins.host).toBe(fitsPreset(before, LOCAL_FULL).margins.host)
    });

    test('AC-3: the swapping specimen reads pressure swapping, no local preset fits whatever the arithmetic says, and freemem is never read', async () => {
        const
            freemem = [],
            readers = fixtureReaders({
                totalmem: () => 128 * GiB,
                swap    : () => ({swapUsedBytes: 9.4 * GiB, compressedBytes: 40 * GiB}),
                freemem : () => { freemem.push('read'); return 0 }
            }),
            probe   = await probePlacement({readers});

        expect(probe.host.pressure).toBe('swapping');
        expect(probe.host.availableBytes).toBe(91.5 * GiB);   // the arithmetic alone would call local-full a fit
        expect(freemem).toEqual([]);

        const local = fitsPreset(probe, LOCAL_FULL);

        expect(local.fits).toBe(false);
        expect(local.reasons).toEqual(['the host is swapping: no local preset fits, whatever the arithmetic says']);
        expect(local.margins.host).toBe(69 * GiB);
        expect(fitsPreset(probe, HOSTED).fits).toBe(true);

        // compressed memory above the named share is swapping too, with no swap file in use
        const compressed = await probePlacement({readers: fixtureReaders({swap: () => ({swapUsedBytes: 0, compressedBytes: 0.15 * 64 * GiB})})});

        expect(compressed.host.pressure).toBe('swapping')
    });

    test('AC-4: a host-native engine has no guest budget; its container processes are already in the inventory and are never added again', async () => {
        const probe = await probePlacement({readers: fixtureReaders({vmInfo: () => null, vmReservation: () => { throw new Error('must not be asked without a VM') }})});

        expect(probe.guest).toBeNull();
        expect(probe.observed.vmInfo).toBe(true);
        expect(probe.host.complete).toBe(true);
        expect(probe.host.consumers.map(row => row.name)).toEqual(['os-and-harnesses', 'google/gemma-4-26b-a4b', 'qwen3-embedding-8b']);
        expect(probe.host.containers).toEqual([{name: 'chroma', bytes: 2 * GiB}, {name: 'mc-server', bytes: 0.5 * GiB}]);
        expect(probe.host.availableBytes).toBe((64 - 14 - 20) * GiB);
        expect(probe.uncertainty).toEqual([])
    });

    test('AC-5: an unobservable VM reservation names the policy applied and the uncertainty; no consumer is a silent number', async () => {
        const probe = await probePlacement({readers: fixtureReaders({vmReservation: () => null})});

        expect(probe.host.consumers.find(row => row.name === 'vm:docker-desktop')).toEqual({name: 'vm:docker-desktop', bytes: 4.5 * GiB, source: `policy:${VM_RESERVATION_POLICY}`, population: 'vm'});
        expect(probe.guest.reservationPolicy).toBe(VM_RESERVATION_POLICY);
        expect(probe.guest.complete).toBe(true);
        expect(probe.uncertainty).toEqual([{
            reader  : 'vmReservation',
            reason  : `host reservation unobservable; ${VM_RESERVATION_POLICY} applied`,
            cause   : "the VM's host reservation could not be observed; the policy estimate stands in",
            nextStep: 'none: the estimate is conservative'
        }]);
        expect(probe.host.availableBytes).toBe((64 - 14 - 20 - 4.5) * GiB);
        expect(probe.host.consumers.every(row => typeof row.source === 'string' && row.source.length > 0)).toBe(true)
    });

    test('AC-6: the canonical compose project, running, is the running plane with its ports; another project or a stopped one is not', async () => {
        const
            rows  = [{name: DEFAULT_PLANE_PROJECT, status: 'running(6)', configFiles: ['/a/docker-compose.yml', '/a/docker-compose.local-agent-os.yml']}],
            asked = [],
            probe = await probePlacement({readers: fixtureReaders({composeLs: () => rows, composePorts: project => { asked.push(project); return [3102, 8000] }})});

        expect(probe.runningPlane).toEqual({project: DEFAULT_PLANE_PROJECT, status: 'running(6)', ports: [3102, 8000], configFiles: rows[0].configFiles});
        expect(asked).toEqual([DEFAULT_PLANE_PROJECT]);

        const other = await probePlacement({readers: fixtureReaders({composeLs: () => [{name: 'fm-fresh-small', status: 'running(6)', configFiles: []}]})});
        expect(other.runningPlane).toBeNull();

        const stopped = await probePlacement({readers: fixtureReaders({composeLs: () => [{name: DEFAULT_PLANE_PROJECT, status: 'exited(6)', configFiles: []}]})});
        expect(stopped.runningPlane).toBeNull();

        const unreadable = await probePlacement({readers: fixtureReaders({composeLs: () => { throw new Error('docker compose ls failed') }})});
        expect(unreadable.runningPlane).toBeNull();
        expect(unreadable.uncertainty).toEqual([{reader: 'composeLs', reason: 'docker compose ls failed', cause: 'the compose projects could not be read', nextStep: 're-read; if it repeats, report the reason'}]);
        expect(unreadable.host.complete).toBe(true)   // the plane detector is not part of the budget
    });

    test('AC-7: no preset data is no verdict; a 64 GiB fixture fits local-full and hosted, a 32 GiB fixture only hosted', async () => {
        const big = await probePlacement({readers: fixtureReaders()});

        expect(fitsPreset(big, undefined)).toBeNull();
        expect(fitsPreset(big, null)).toBeNull();
        // the host backs the plane's peak as well as the models, with or without a VM
        // a fit is an observed verdict with nothing to say: no cause, no next step
        expect(fitsPreset(big, LOCAL_FULL)).toEqual({fits: true, kind: 'observed', margins: {host: 5 * GiB, guest: 27 * GiB}, observedMargin: 5 * GiB, reasons: [], cause: null, nextStep: null});
        expect(fitsPreset(big, HOSTED)).toEqual({fits: true, kind: 'observed', margins: {host: 25 * GiB, guest: 27 * GiB}, observedMargin: 25 * GiB, reasons: [], cause: null, nextStep: null});

        const small = await probePlacement({readers: fixtureReaders({
            totalmem    : () => 32 * GiB,
            loadedModels: () => ({inventories: ['lms'], models: []}),
            vmInfo      : () => ({backend: 'docker-desktop', capBytes: 16 * GiB, cores: 8, guestOs: 'Ubuntu 24.04.4 LTS'})
        })});

        expect(small.host.availableBytes).toBe(15.5 * GiB);
        expect(fitsPreset(small, LOCAL_FULL)).toMatchObject({fits: false, reasons: ['the host budget falls 7.0 GiB short']});
        expect(fitsPreset(small, HOSTED)).toEqual({fits: true, kind: 'observed', margins: {host: 13 * GiB, guest: 11 * GiB}, observedMargin: 13 * GiB, reasons: [], cause: null, nextStep: null});

        // a VM cap below the preset's recommendation is named even when the budgets fit
        const lowCap = await probePlacement({readers: fixtureReaders({vmInfo: () => ({backend: 'docker-desktop', capBytes: 6 * GiB, cores: 4, guestOs: 'Ubuntu'})})});
        expect(fitsPreset(lowCap, HOSTED).reasons).toEqual(["the VM cap is below the preset's recommended 8 GiB"])
    });

    test('a failed reader lands in uncertainty, the probe still resolves, and what could not be read is null', async () => {
        const probe = await probePlacement({readers: fixtureReaders({
            totalmem: () => { throw new Error('sysctl refused') },
            statfs  : () => Promise.reject(new Error('df refused'))
        })});

        expect(probe.host.totalBytes).toBeNull();
        expect(probe.host.availableBytes).toBeNull();
        expect(probe.host.complete).toBe(false);
        expect(probe.host.pressure).toBe('unknown');
        expect(probe.disk).toBeNull();
        expect(probe.observed).toMatchObject({totalmem: false, statfs: false, hostUse: true});
        expect(probe.uncertainty).toEqual([
            {reader: 'totalmem', reason: 'sysctl refused', cause: "the host's total memory could not be read", nextStep: 're-read; if it repeats, report the reason'},
            {reader: 'statfs',   reason: 'df refused',     cause: 'the disk space could not be read',          nextStep: 're-read; if it repeats, report the reason'}
        ])
    });
});

test.describe('probePlacement — unknown capacity never yields an affirmative fit', () => {
    test('a failed model inventory makes the host budget incomplete: a 40 GiB host with no model reading is not a local fit', async () => {
        const
            unknown = await probePlacement({readers: fixtureReaders({totalmem: () => 40 * GiB, loadedModels: () => { throw new Error('lms unreachable') }})}),
            known   = await probePlacement({readers: fixtureReaders({totalmem: () => 40 * GiB})});

        expect(unknown.host.complete).toBe(false);
        expect(unknown.host.availableBytes).toBeNull();
        // unverified, never a fit: the observed consumers alone (14 + 2.5 GiB) would leave 1 GiB for local-full,
        // and the reader that did not answer gives the verdict its cause and next step
        expect(fitsPreset(unknown, LOCAL_FULL)).toEqual({
            fits: false, kind: 'unverified', margins: {host: null, guest: 27 * GiB}, observedMargin: 1 * GiB,
            reasons : ['the host budget is incomplete (unobserved: loadedModels)'],
            cause   : 'the loaded models could not be read',
            nextStep: 're-read; if it repeats, report the reason'
        });
        expect(fitsPreset(unknown, HOSTED).fits).toBe(false);

        // the same host with the 20 GiB read: 3.5 GiB left, local-full short by 19
        expect(known.host.availableBytes).toBe(3.5 * GiB);
        expect(fitsPreset(known, LOCAL_FULL)).toMatchObject({fits: false, reasons: ['the host budget falls 19.0 GiB short']})
    });

    test('an unobserved VM topology is not a native engine: the budget is incomplete and no fit is affirmed', async () => {
        const failed = await probePlacement({readers: fixtureReaders({vmInfo: () => { throw new Error('docker info failed') }})});

        expect(failed.guest).toBeNull();
        expect(failed.observed.vmInfo).toBe(false);
        expect(failed.host.complete).toBe(false);
        expect(failed.host.containers).toBeNull();
        // a generic failure is never read as Docker stopped: that sentence needs the daemon's own word
        expect(failed.uncertainty).toEqual([{reader: 'vmInfo', reason: 'docker info failed', cause: "the Docker engine's VM could not be read", nextStep: 're-read; if it repeats, report the reason'}]);
        expect(fitsPreset(failed, LOCAL_FULL).fits).toBe(false);
        expect(fitsPreset(failed, LOCAL_FULL).reasons[0]).toBe('the host budget is incomplete (unobserved: vmInfo)');

        // a VM description without a cap is unusable, not a guest with null capacity
        const malformed = await probePlacement({readers: fixtureReaders({vmInfo: () => ({backend: 'docker-desktop'})})});

        expect(malformed.guest).toBeNull();
        expect(malformed.uncertainty).toEqual([{reader: 'vmInfo', reason: 'not a VM description', cause: "the Docker engine's VM answered in an unexpected form", nextStep: 're-read; if it repeats, report the answer'}]);
        expect(fitsPreset(malformed, HOSTED).fits).toBe(false)
    });

    test('a malformed or empty workload is a refusal, never a zero-demand fit', async () => {
        const probe = await probePlacement({readers: fixtureReaders()});

        for (const workload of [{}, [], 'local', 42, {planePeakBytes: 'big', modelsBytes: 0}, {planePeakBytes: 2 * GiB}, {planePeakBytes: -1, modelsBytes: 0}, {planePeakBytes: Infinity, modelsBytes: 0}]) {
            expect(fitsPreset(probe, workload)).toEqual({
                fits: false, kind: 'observed', margins: {host: null, guest: null}, observedMargin: null,
                reasons : ['the workload is malformed: planePeakBytes and modelsBytes must be byte counts'],
                cause   : 'the workload is malformed: planePeakBytes and modelsBytes must be byte counts',
                nextStep: 'choose another preset'
            })
        }
    });

    test('the host backs projected guest growth: 1 GiB of host headroom cannot carry a new 10 GiB plane however much room the VM has', async () => {
        const probe = await probePlacement({readers: fixtureReaders({
            totalmem      : () => 17.5 * GiB,
            hostUse       : () => [{name: 'os-and-harnesses', bytes: 14.5 * GiB, source: 'fixture'}],
            loadedModels  : () => ({inventories: ['lms'], models: []}),
            containerStats: () => [],
            vmReservation : () => 2 * GiB
        })});

        expect(probe.host.availableBytes).toBe(1 * GiB);
        expect(probe.guest.availableBytes).toBe(32 * GiB);

        const fit = fitsPreset(probe, {planePeakBytes: 10 * GiB, modelsBytes: 0});

        expect(fit).toEqual({
            fits: false, kind: 'observed', margins: {host: -9 * GiB, guest: 22 * GiB}, observedMargin: -9 * GiB,
            reasons : ['the host budget falls 9.0 GiB short'],
            cause   : 'the host budget falls 9.0 GiB short',
            nextStep: 'free 9.0 GiB of memory'   // a hosted workload: no hosted preset to point at
        })
    });
});

test.describe('probePlacement — production readers over fixture command output (one owner per population)', () => {
    /** A command runner that answers from fixture text and records what was asked. */
    function fakeRun(answers) {
        const asked = [];
        const run   = async (file, args) => {
            const key = [file, ...args].join(' ');
            asked.push(key);
            for (const [prefix, text] of Object.entries(answers)) {
                if (key.startsWith(prefix)) return typeof text === 'function' ? text() : text
            }
            throw new Error(`no fixture for '${key}'`)
        };
        run.asked = asked;
        return run
    }

    const
        gib    = n => String(Math.round(n * GiB / 1024)),
        ps     = rows => rows.map(([size, command]) => `${gib(size)} ${command}`).join('\n') + '\n',
        LINUX_NATIVE_INFO = '68719476736 16 Ubuntu 24.04.4 LTS\n',
        NO_SWAP = 'MemTotal: 1 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';

    test('a host-visible container process on a native engine is counted once — in the inventory, not again from docker stats', async () => {
        const
            run     = fakeRun({
                'ps -axo'       : ps([[14, '/usr/lib/systemd/systemd'], [1, '/usr/bin/chroma run']]),
                'docker info'   : LINUX_NATIVE_INFO,
                'docker stats'  : '{"Name":"neo-local-agent-os-chroma-1","MemUsage":"1GiB / 12GiB"}\n',
                'lms ps'        : '[]',
                'cat /proc/meminfo': NO_SWAP,
                'docker compose ls': '[]',
                'df -k'         : 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 100 900 10% /\n'
            }),
            readers = {...createDefaultReaders({run, hostType: 'Linux'}), totalmem: () => 64 * GiB, cores: () => 16},
            probe   = await probePlacement({readers});

        expect(probe.guest).toBeNull();
        expect(probe.host.consumers).toEqual([{name: 'os-and-harnesses', bytes: 15 * GiB, source: 'ps -axo rss (every process except the VM and the model servers)', population: 'other'}]);
        expect(probe.host.containers).toEqual([{name: 'neo-local-agent-os-chroma-1', bytes: 1 * GiB}]);
        expect(probe.host.availableBytes).toBe(49 * GiB);
        expect(probe.host.complete).toBe(true);
        expect(probe.uncertainty).toEqual([])
    });

    test('a matched process is never discarded without an owner: an unrelated QEMU and an Ollama outside the LMS inventory stay host consumers', async () => {
        const
            run     = fakeRun({
                'ps -axo'       : ps([[14, '/usr/lib/systemd/systemd'], [8, '/usr/bin/qemu-system-x86_64 -m 8G'], [12, '/usr/local/bin/ollama serve']]),
                'docker info'   : LINUX_NATIVE_INFO,
                'docker stats'  : '',
                'lms ps'        : '[]',
                'cat /proc/meminfo': NO_SWAP,
                'docker compose ls': '[]',
                'df -k'         : 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 100 900 10% /\n'
            }),
            readers = {...createDefaultReaders({run, hostType: 'Linux'}), totalmem: () => 64 * GiB, cores: () => 16},
            probe   = await probePlacement({readers});

        expect(probe.host.consumers.map(row => [row.name, row.bytes / GiB, row.population])).toEqual([
            ['os-and-harnesses', 14, 'other'],
            ['vm-processes', 8, 'vm'],
            ['model-server:ollama', 12, 'model-server']
        ]);
        expect(probe.host.availableBytes).toBe(30 * GiB);
        expect(probe.host.complete).toBe(true)
    });

    test('on a VM topology the VM processes become the observed reservation and LM Studio is replaced by its loaded weights, each once', async () => {
        const
            run     = fakeRun({
                'ps -axo'       : ps([[14, '/usr/lib/systemd/systemd'], [8.8, '/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine'], [6.6, '/Users/x/.lmstudio/.internal/utils/node']]),
                'docker info'   : '33587089408 8 Ubuntu 24.04.4 LTS\n',
                'docker stats'  : '{"Name":"neo-local-agent-os-chroma-1","MemUsage":"11GiB / 16GiB"}\n{"Name":"neo-local-agent-os-mc-server-1","MemUsage":"2GiB / 3GiB"}\n',
                'lms ps'        : '[{"identifier":"google/gemma-4-26b-a4b","sizeBytes":15641352350,"status":"idle"},{"identifier":"text-embedding-qwen3-embedding-8b","sizeBytes":4680000000,"status":"idle"}]',
                'sysctl -n vm.swapusage': 'total = 10240.00M  used = 0.00M  free = 10240.00M  (encrypted)\n',
                'vm_stat'       : 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 1000.\n',
                'docker compose ls': '[{"Name":"neo-local-agent-os","Status":"running(6)","ConfigFiles":"/a/docker-compose.yml"}]',
                'docker compose -p neo-local-agent-os ps': '{"Service":"ingress","Publishers":[{"PublishedPort":3102}]}\n',
                'df -k'         : 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 1948404040 13334172 307607708 5% /\n'
            }),
            readers = {...createDefaultReaders({run, hostType: 'Darwin'}), totalmem: () => 128 * GiB, cores: () => 18},
            probe   = await probePlacement({readers});

        expect(probe.host.consumers.map(row => [row.name, +(row.bytes / GiB).toFixed(1), row.population])).toEqual([
            ['os-and-harnesses', 14, 'other'],
            ['google/gemma-4-26b-a4b', 14.6, 'model'],
            ['text-embedding-qwen3-embedding-8b', 4.4, 'model'],
            ['vm:docker-desktop', 8.8, 'vm']
        ]);
        expect(probe.host.consumers.find(row => row.name === 'vm:docker-desktop').source).toBe('host reservation (the VM processes\' resident sets)');
        expect(probe.guest).toMatchObject({capBytes: 33587089408, residencyBytes: 13 * GiB, reservationPolicy: null, complete: true});
        expect(probe.host.pressure).toBe('ok');
        expect(probe.runningPlane).toEqual({project: 'neo-local-agent-os', status: 'running(6)', ports: [3102], configFiles: ['/a/docker-compose.yml']});
        expect(probe.host.complete).toBe(true);
        expect(probe.uncertainty).toEqual([])
    });

    test('a loaded-model row without a size is an unreadable inventory: the budget stays incomplete rather than reading zero', async () => {
        const
            run     = fakeRun({
                'ps -axo'       : ps([[14, '/usr/lib/systemd/systemd']]),
                'docker info'   : LINUX_NATIVE_INFO,
                'docker stats'  : '',
                'lms ps'        : '[{"identifier":"mystery-model","status":"idle"}]',
                'cat /proc/meminfo': NO_SWAP,
                'docker compose ls': '[]',
                'df -k'         : 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 100 900 10% /\n'
            }),
            readers = {...createDefaultReaders({run, hostType: 'Linux'}), totalmem: () => 64 * GiB, cores: () => 16},
            probe   = await probePlacement({readers});

        expect(probe.observed.loadedModels).toBe(false);
        expect(probe.uncertainty).toEqual([{reader: 'loadedModels', reason: "lms ps row 'mystery-model' carries no sizeBytes", cause: 'the loaded models could not be read', nextStep: 're-read; if it repeats, report the reason'}]);
        expect(probe.host.complete).toBe(false);
        expect(fitsPreset(probe, HOSTED).fits).toBe(false)
    });
});

test.describe('probePlacement — the reader-facing verdict: unobserved is told from unsupported, with a cause and a next step (#956)', () => {
    const DAEMON_DOWN = "Command failed: docker info --format '{{.MemTotal}} {{.NCPU}} {{.OperatingSystem}}'\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

    test('AC-1: the VM reader absent and the rest observed is an unverified recommendation that names Docker and the one thing to do — never a refusal of every preset', async () => {
        const probe = await probePlacement({readers: fixtureReaders({vmInfo: () => { throw new Error(DAEMON_DOWN) }})});

        expect(probe.observed.vmInfo).toBe(false);
        expect(probe.host.complete).toBe(false);
        expect(probe.host.missingReaders).toEqual(['vmInfo']);
        // the observed consumers alone: 14 GiB of other use and 20 GiB of models leave 30 of 64
        expect(probe.host.observedAvailableBytes).toBe(30 * GiB);
        expect(probe.uncertainty).toEqual([{reader: 'vmInfo', reason: DAEMON_DOWN, cause: 'Docker Desktop is not running', nextStep: 'start Docker Desktop, then re-read'}]);

        for (const workload of [LOCAL_FULL, HOSTED]) {
            const fit = fitsPreset(probe, workload);

            expect(fit.fits).toBe(false);
            expect(fit.kind).toBe('unverified');
            expect(fit.cause).toBe('Docker Desktop is not running');
            expect(fit.nextStep).toBe('start Docker Desktop, then re-read');
            expect(fit.reasons[0]).toBe('the host budget is incomplete (unobserved: vmInfo)')
        }

        expect(fitsPreset(probe, LOCAL_FULL).observedMargin).toBe(7.5 * GiB);
        expect(fitsPreset(probe, HOSTED).observedMargin).toBe(27.5 * GiB)
    });

    test('AC-2: the four fixture classes — a fit, an unobserved host, an observed shortfall, observed swapping — and a measured shortfall stays observed while a reader is missing', async () => {
        const
            fit       = fitsPreset(await probePlacement({readers: fixtureReaders()}), LOCAL_FULL),
            unobserved = fitsPreset(await probePlacement({readers: fixtureReaders({vmInfo: () => { throw new Error(DAEMON_DOWN) }})}), LOCAL_FULL),
            short     = fitsPreset(await probePlacement({readers: fixtureReaders({totalmem: () => 32 * GiB, loadedModels: () => ({inventories: ['lms'], models: []}), vmInfo: () => ({backend: 'docker-desktop', capBytes: 16 * GiB, cores: 8, guestOs: 'Ubuntu'})})}), LOCAL_FULL),
            swapping  = fitsPreset(await probePlacement({readers: fixtureReaders({swap: () => ({swapUsedBytes: 1 * GiB, compressedBytes: 0})})}), LOCAL_FULL),
            // 24 GiB total, no model reading: the observed consumers alone (14 + 2.5 GiB) leave 7.5, local-full needs 22.5
            shortUnread = fitsPreset(await probePlacement({readers: fixtureReaders({totalmem: () => 24 * GiB, loadedModels: () => { throw new Error('lms unreachable') }})}), LOCAL_FULL);

        expect(fit).toMatchObject({fits: true, kind: 'observed', cause: null, nextStep: null});
        expect(unobserved).toMatchObject({fits: false, kind: 'unverified', cause: 'Docker Desktop is not running'});
        expect(short).toMatchObject({fits: false, kind: 'observed', cause: 'the host budget falls 7.0 GiB short', nextStep: 'free 7.0 GiB of memory, or choose the hosted preset'});
        expect(swapping).toMatchObject({fits: false, kind: 'observed', cause: 'the host is swapping: no local preset fits, whatever the arithmetic says', nextStep: 'close the applications holding memory, then re-read'});
        expect(shortUnread).toMatchObject({
            fits: false, kind: 'observed', observedMargin: -15 * GiB,
            reasons : ['the host budget falls 15.0 GiB short on the observed consumers alone', 'the host budget is incomplete (unobserved: loadedModels)'],
            cause   : 'the host budget falls 15.0 GiB short on the observed consumers alone',
            nextStep: 'free 15.0 GiB of memory, or choose the hosted preset'
        })
    });

    test('the failure classes come from the reader\'s own word: Docker stopped or missing only from a Docker reader, lms missing only from the model reader, the rest generic', () => {
        expect(describeUncertainty('vmInfo', DAEMON_DOWN)).toEqual({class: 'docker-stopped', cause: 'Docker Desktop is not running', nextStep: 'start Docker Desktop, then re-read'});
        expect(describeUncertainty('containerStats', 'Is the docker daemon running?').class).toBe('docker-stopped');
        expect(describeUncertainty('vmInfo', 'spawn docker ENOENT')).toEqual({class: 'docker-missing', cause: 'Docker is not installed', nextStep: 'install Docker Desktop, then re-read'});
        expect(describeUncertainty('loadedModels', 'spawn lms ENOENT').class).toBe('lms-missing');
        // a non-Docker reader never yields the Docker sentence, whatever its error says
        expect(describeUncertainty('hostUse', 'Is the docker daemon running?')).toEqual({class: 'unreadable', cause: 'the process inventory could not be read', nextStep: 're-read; if it repeats, report the reason'});
        expect(describeUncertainty('totalmem', 'no reader')).toEqual({class: 'reader-missing', cause: "the host's total memory has no reader in this build", nextStep: 're-read once a build with the reader is installed'});
        expect(describeUncertainty('hostUse', 'not a consumer list').class).toBe('unexpected-form');
        expect(describeUncertainty('vmReservation', `host reservation unobservable; ${VM_RESERVATION_POLICY} applied`).class).toBe('vm-reservation-policy')
    });

    test('independent negative evidence survives the unknown-data path: a negative balance and observed swap are observed refusals, never unverified', async () => {
        const
            HOSTED_PLANE = {planeIdleBytes: 0.4 * GiB, planePeakBytes: 2.5 * GiB, modelsBytes: 0},
            // every reader answers; the consumers exceed the total — a measured −4 GiB balance, complete
            overdrawn = await probePlacement({readers: fixtureReaders({
                totalmem: () => 16 * GiB, hostUse: () => [{name: 'everything', bytes: 20 * GiB, source: 'fixture'}],
                loadedModels: () => ({inventories: ['lms'], models: []}), vmInfo: () => null, containerStats: () => []
            })}),
            // the same balance with the VM reader missing — the observed consumers alone are overdrawn
            overdrawnUnread = await probePlacement({readers: fixtureReaders({
                totalmem: () => 16 * GiB, hostUse: () => [{name: 'everything', bytes: 20 * GiB, source: 'fixture'}],
                loadedModels: () => ({inventories: ['lms'], models: []}), vmInfo: () => { throw new Error('docker info failed') }
            })}),
            // the guest's residency exceeds its cap — a measured −2 GiB guest balance while the host has room
            guestOverdrawn = await probePlacement({readers: fixtureReaders({
                vmInfo: () => ({backend: 'docker-desktop', capBytes: 4 * GiB, cores: 4, guestOs: 'Ubuntu'}), containerStats: () => [{name: 'big', bytes: 6 * GiB}]
            })}),
            // the total-memory reader fails, the swap reader reports swap in use — swapping is its own evidence
            swappingUnread = await probePlacement({readers: fixtureReaders({
                totalmem: () => { throw new Error('sysctl refused') }, swap: () => ({swapUsedBytes: 1 * GiB, compressedBytes: 0})
            })});

        expect(overdrawn.host.complete).toBe(true);
        expect(overdrawn.host.availableBytes).toBe(-4 * GiB);
        expect(fitsPreset(overdrawn, HOSTED_PLANE)).toMatchObject({fits: false, kind: 'observed', cause: 'the host budget falls 6.5 GiB short', nextStep: 'free 6.5 GiB of memory'});

        expect(overdrawnUnread.host.complete).toBe(false);
        expect(overdrawnUnread.host.observedAvailableBytes).toBe(-4 * GiB);
        expect(fitsPreset(overdrawnUnread, HOSTED_PLANE)).toMatchObject({fits: false, kind: 'observed', cause: 'the host budget falls 6.5 GiB short on the observed consumers alone', nextStep: 'free 6.5 GiB of memory'});

        expect(guestOverdrawn.guest.availableBytes).toBe(-2 * GiB);
        expect(fitsPreset(guestOverdrawn, HOSTED_PLANE)).toMatchObject({fits: false, kind: 'observed', cause: 'the guest budget falls 4.5 GiB short', nextStep: "raise Docker Desktop's memory limit by 4.5 GiB, then re-read"});

        expect(swappingUnread.host.pressure).toBe('swapping');
        expect(fitsPreset(swappingUnread, LOCAL_FULL)).toMatchObject({fits: false, kind: 'observed', cause: 'the host is swapping: no local preset fits, whatever the arithmetic says'});
        // the unread total is still named, after the measured refusal
        expect(fitsPreset(swappingUnread, LOCAL_FULL).reasons).toContain('the host budget is incomplete (unobserved: totalmem)')
    });

    test('AC-4: every cause and next step a verdict or an uncertainty entry carries is a sentence of the vocabulary, and a foreign sentence is not', async () => {
        const
            probes = await Promise.all([
                probePlacement({readers: fixtureReaders({vmInfo: () => { throw new Error(DAEMON_DOWN) }})}),
                probePlacement({readers: fixtureReaders({totalmem: () => 24 * GiB, loadedModels: () => { throw new Error('lms unreachable') }, statfs: () => { throw new Error('df refused') }})}),
                probePlacement({readers: fixtureReaders({swap: () => ({swapUsedBytes: 1 * GiB, compressedBytes: 0}), vmReservation: () => null})}),
                probePlacement({readers: fixtureReaders({vmInfo: () => ({backend: 'docker-desktop', capBytes: 6 * GiB, cores: 4, guestOs: 'Ubuntu'})})})
            ]),
            sentences = [];

        for (const probe of probes) {
            for (const entry of probe.uncertainty) sentences.push(entry.cause, entry.nextStep);
            for (const workload of [LOCAL_FULL, HOSTED, {}]) {
                const fit = fitsPreset(probe, workload);
                fit.cause !== null && sentences.push(fit.cause, fit.nextStep)
            }
        }

        expect(sentences.length).toBeGreaterThan(8);
        for (const sentence of sentences) expect(vocabularyMatches(sentence), sentence).toBe(true);
        expect(vocabularyMatches('the host is tired')).toBe(false);
        expect(vocabularyMatches('')).toBe(false)
    });
});

test.describe('probePlacement — parsers pinned against lines measured on a real host (2026-10-01)', () => {
    test('docker figures: stats rows, info, compose ls and ps', () => {
        expect(parseDockerBytes('979.2MiB')).toBe(Math.round(979.2 * 1024 ** 2));
        expect(parseDockerBytes('12GiB')).toBe(12 * GiB);
        expect(parseDockerBytes('1.5GB')).toBe(1_500_000_000);
        expect(parseDockerBytes('512kB')).toBe(512_000);
        expect(() => parseDockerBytes('lots')).toThrow(/unreadable docker byte figure/);
        expect(parseDockerStatsRow({Name: 'neo-local-agent-os-chroma-1', MemUsage: '1.029GiB / 3GiB'})).toEqual({name: 'neo-local-agent-os-chroma-1', bytes: Math.round(1.029 * GiB)});

        expect(parseDockerInfo('33587089408 8 Ubuntu 24.04.4 LTS', 'Darwin')).toEqual({backend: 'docker-desktop', capBytes: 33587089408, cores: 8, guestOs: 'Ubuntu 24.04.4 LTS'});
        // the live command's stdout carries a trailing newline — the first host smoke read `guest: null` over it
        expect(parseDockerInfo('33587089408 8 Ubuntu 24.04.4 LTS\n', 'Darwin')).toEqual({backend: 'docker-desktop', capBytes: 33587089408, cores: 8, guestOs: 'Ubuntu 24.04.4 LTS'});
        expect(parseDockerInfo('67000000000 16 Ubuntu 24.04.4 LTS', 'Linux')).toBeNull();
        expect(parseDockerInfo('33587089408 8 Docker Desktop', 'Linux')).toEqual({backend: 'docker-desktop', capBytes: 33587089408, cores: 8, guestOs: 'Docker Desktop'});
        expect(() => parseDockerInfo('', 'Darwin')).toThrow(/unreadable docker info/);

        expect(parseComposeLs('[{"Name":"neo-local-agent-os","Status":"running(6)","ConfigFiles":"/a/docker-compose.yml,/a/docker-compose.local-agent-os.yml"}]'))
            .toEqual([{name: 'neo-local-agent-os', status: 'running(6)', configFiles: ['/a/docker-compose.yml', '/a/docker-compose.local-agent-os.yml']}]);
        expect(parseComposePorts('{"Service":"chroma","Publishers":[{"URL":"127.0.0.1","TargetPort":8000,"PublishedPort":8000,"Protocol":"tcp"}]}\n{"Service":"ingress","Publishers":[{"URL":"127.0.0.1","TargetPort":8080,"PublishedPort":3102,"Protocol":"tcp"},{"URL":"","TargetPort":8080,"PublishedPort":0,"Protocol":"tcp"}]}\n'))
            .toEqual([3102, 8000])
    });

    test('macOS memory instruments: swapusage, vm_stat, df, ps partition', () => {
        expect(parseSwapUsage('total = 10240.00M  used = 9647.56M  free = 592.44M  (encrypted)')).toBe(Math.round(9647.56 * 1024 ** 2));
        expect(() => parseSwapUsage('nothing')).toThrow(/unreadable swapusage/);
        expect(parseVmStatCompressed('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 7000.\nPages occupied by compressor: 2626332.\n')).toBe(2626332 * 16384);
        expect(() => parseVmStatCompressed('')).toThrow(/unreadable vm_stat/);
        expect(parseDfRoot('Filesystem   1024-blocks      Used  Available Capacity iused      ifree %iused  Mounted on\n/dev/disk3s1s1  1948404040  13334172  307607708     5%  484019 3076077080    0%   /\n')).toEqual({rootFreeBytes: 307607708 * 1024});
        expect(() => parseDfRoot('')).toThrow(/unreadable df output/);

        const inventory = partitionProcessInventory([
            '9227468 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
            '6920000 /Users/someone/.lmstudio/.internal/utils/node',
            '3880000 /Applications/WebStorm.app/Contents/MacOS/webstorm',
            '2000000 /usr/local/bin/ollama serve',
            '   512 /usr/libexec/trustd'
        ].join('\n'));

        expect(inventory).toEqual([
            {name: 'os-and-harnesses', bytes: (3880000 + 512) * 1024, source: 'ps -axo rss (every process except the VM and the model servers)', population: 'other'},
            {name: 'vm-processes', bytes: 9227468 * 1024, source: 'ps -axo rss (the VM\'s own processes)', population: 'vm'},
            {name: 'model-server:lm-studio', bytes: 6920000 * 1024, source: 'ps -axo rss (the model server\'s own processes)', population: 'model-server', inventory: 'lms'},
            {name: 'model-server:ollama', bytes: 2000000 * 1024, source: 'ps -axo rss (the model server\'s own processes)', population: 'model-server', inventory: null}
        ]);
        expect(VM_PROCESS_PATTERNS.some(pattern => pattern.test('qemu-system-aarch64'))).toBe(true);
        expect(MODEL_SERVER_PATTERNS.find(entry => entry.pattern.test('/opt/llama-server')).inventory).toBeNull()
    });

    test('lms ps --json: a loaded model counts by its weights, idle or not; a row without a size throws', () => {
        expect(parseLmsPs('[{"type":"llm","modelKey":"google/gemma-4-26b-a4b","sizeBytes":15641352350,"identifier":"google/gemma-4-26b-a4b","status":"idle"},{"type":"embedding","modelKey":"qwen3-embedding-8b","sizeBytes":4680000000,"identifier":"text-embedding-qwen3-embedding-8b","status":"idle"}]'))
            .toEqual([{name: 'google/gemma-4-26b-a4b', bytes: 15641352350, state: 'idle'}, {name: 'text-embedding-qwen3-embedding-8b', bytes: 4680000000, state: 'idle'}]);
        expect(parseLmsPs('[]')).toEqual([]);
        expect(() => parseLmsPs('[{"identifier":"x","status":"idle"}]')).toThrow(/carries no sizeBytes/);
        expect(() => parseLmsPs('[{"identifier":"x","sizeBytes":-1}]')).toThrow(/carries no sizeBytes/)
    });
});
