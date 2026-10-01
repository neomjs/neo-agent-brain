import {expect, test} from '@playwright/test';
import {
    DEFAULT_PLANE_PROJECT,
    GiB,
    MODEL_SERVER_PATTERNS,
    VM_PROCESS_PATTERNS,
    VM_RESERVATION_POLICY,
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
    probePlacement,
    sumProcessRss
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
        loadedModels  : () => [{name: 'google/gemma-4-26b-a4b', bytes: 15 * GiB, state: 'idle'}, {name: 'qwen3-embedding-8b', bytes: 5 * GiB, state: 'idle'}],
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
    test('AC-1: Euclid\'s fixture reads 27.5 GiB host headroom and 29.5 GiB guest headroom, every consumer once, no cap in the sum', async () => {
        const probe = await probePlacement({readers: fixtureReaders(), now: NOW});

        expect(probe.host.totalBytes).toBe(64 * GiB);
        expect(probe.host.availableBytes).toBe(27.5 * GiB);
        expect(probe.host.consumers.map(row => row.name)).toEqual(['os-and-harnesses', 'google/gemma-4-26b-a4b', 'qwen3-embedding-8b', 'vm:docker-desktop']);
        expect(probe.host.consumers.find(row => row.name === 'vm:docker-desktop')).toEqual({name: 'vm:docker-desktop', bytes: 2.5 * GiB, source: 'host reservation (observed)'});
        expect(probe.host.consumers.some(row => row.bytes === 32 * GiB)).toBe(false);
        expect(probe.host.pressure).toBe('ok');
        expect(probe.guest).toEqual({
            backend          : 'docker-desktop',
            capBytes         : 32 * GiB,
            cores            : 8,
            guestOs          : 'Ubuntu 24.04.4 LTS',
            residencyBytes   : 2.5 * GiB,
            availableBytes   : 29.5 * GiB,
            reservationPolicy: null
        });
        expect(probe.disk).toEqual({rootFreeBytes: 300 * GiB});
        expect(probe.cores).toBe(16);
        expect(probe.runningPlane).toBeNull();
        expect(probe.uncertainty).toEqual([]);
        expect(probe.probedAt).toBe('2026-10-01T17:00:00.000Z');
        expect(probe.target).toEqual({kind: 'local'})
    });

    test('AC-2: raising only the VM cap moves the guest budget and leaves the host budget alone', async () => {
        const
            before = await probePlacement({readers: fixtureReaders()}),
            after  = await probePlacement({readers: fixtureReaders({vmInfo: () => ({backend: 'docker-desktop', capBytes: 48 * GiB, cores: 8, guestOs: 'Ubuntu 24.04.4 LTS'})})});

        expect(after.host.availableBytes).toBe(before.host.availableBytes);
        expect(after.guest.availableBytes - before.guest.availableBytes).toBe(16 * GiB)
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
        expect(local.margins.host).toBe(71.5 * GiB);
        expect(fitsPreset(probe, HOSTED).fits).toBe(true);

        // compressed memory above the named share is swapping too, with no swap file in use
        const compressed = await probePlacement({readers: fixtureReaders({swap: () => ({swapUsedBytes: 0, compressedBytes: 0.15 * 64 * GiB})})});

        expect(compressed.host.pressure).toBe('swapping')
    });

    test('AC-4: Linux without a VM has no guest budget; containers are host consumers, once', async () => {
        const probe = await probePlacement({readers: fixtureReaders({vmInfo: () => null, vmReservation: () => { throw new Error('must not be asked without a VM') }})});

        expect(probe.guest).toBeNull();
        expect(probe.host.consumers.filter(row => row.name === 'chroma')).toEqual([{name: 'chroma', bytes: 2 * GiB, source: 'container (host-native)'}]);
        expect(probe.host.availableBytes).toBe((64 - 14 - 20 - 2.5) * GiB);
        expect(probe.uncertainty).toEqual([])
    });

    test('AC-5: an unobservable VM reservation names the policy applied and the uncertainty; no consumer is a silent number', async () => {
        const probe = await probePlacement({readers: fixtureReaders({vmReservation: () => null})});

        expect(probe.host.consumers.find(row => row.name === 'vm:docker-desktop')).toEqual({name: 'vm:docker-desktop', bytes: 4.5 * GiB, source: `policy:${VM_RESERVATION_POLICY}`});
        expect(probe.guest.reservationPolicy).toBe(VM_RESERVATION_POLICY);
        expect(probe.uncertainty).toEqual([{reader: 'vmReservation', reason: `host reservation unobservable; ${VM_RESERVATION_POLICY} applied`}]);
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
        expect(unreadable.uncertainty).toEqual([{reader: 'composeLs', reason: 'docker compose ls failed'}])
    });

    test('AC-7: no preset data is no verdict; a 64 GiB fixture fits local-full, a 32 GiB fixture only hosted', async () => {
        const big = await probePlacement({readers: fixtureReaders()});

        expect(fitsPreset(big, undefined)).toBeNull();
        expect(fitsPreset(big, null)).toBeNull();
        expect(fitsPreset(big, LOCAL_FULL)).toEqual({fits: true, margins: {host: 7.5 * GiB, guest: 27 * GiB}, reasons: []});
        expect(fitsPreset(big, HOSTED)).toEqual({fits: true, margins: {host: 27.5 * GiB, guest: 27 * GiB}, reasons: []});

        const small = await probePlacement({readers: fixtureReaders({
            totalmem    : () => 32 * GiB,
            loadedModels: () => [],
            vmInfo      : () => ({backend: 'docker-desktop', capBytes: 16 * GiB, cores: 8, guestOs: 'Ubuntu 24.04.4 LTS'})
        })});

        expect(small.host.availableBytes).toBe(15.5 * GiB);

        const local = fitsPreset(small, LOCAL_FULL);

        expect(local.fits).toBe(false);
        expect(local.reasons).toEqual(['the host budget falls 4.5 GiB short']);
        expect(fitsPreset(small, HOSTED)).toEqual({fits: true, margins: {host: 15.5 * GiB, guest: 11 * GiB}, reasons: []});

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
        expect(probe.host.pressure).toBe('unknown');
        expect(probe.disk).toBeNull();
        expect(probe.uncertainty).toEqual([{reader: 'totalmem', reason: 'sysctl refused'}, {reader: 'statfs', reason: 'df refused'}]);
        expect(fitsPreset(probe, HOSTED)).toEqual({fits: false, margins: {host: null, guest: 27 * GiB}, reasons: ['the host budget could not be computed']});
        expect(fitsPreset(probe, LOCAL_FULL).reasons).toEqual(['host pressure is unknown: a local preset is not called a fit', 'the host budget could not be computed'])
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

    test('macOS memory instruments: swapusage, vm_stat, df, ps', () => {
        expect(parseSwapUsage('total = 10240.00M  used = 9647.56M  free = 592.44M  (encrypted)')).toBe(Math.round(9647.56 * 1024 ** 2));
        expect(() => parseSwapUsage('nothing')).toThrow(/unreadable swapusage/);
        expect(parseVmStatCompressed('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 7000.\nPages occupied by compressor: 2626332.\n')).toBe(2626332 * 16384);
        expect(() => parseVmStatCompressed('')).toThrow(/unreadable vm_stat/);
        expect(parseDfRoot('Filesystem   1024-blocks      Used  Available Capacity iused      ifree %iused  Mounted on\n/dev/disk3s1s1  1948404040  13334172  307607708     5%  484019 3076077080    0%   /\n')).toEqual({rootFreeBytes: 307607708 * 1024});
        expect(() => parseDfRoot('')).toThrow(/unreadable df output/);

        const ps = [
            '9227468 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
            '6920000 /Users/someone/.lmstudio/.internal/utils/node',
            '3880000 /Applications/WebStorm.app/Contents/MacOS/webstorm',
            '   512 /usr/libexec/trustd'
        ].join('\n');

        expect(sumProcessRss(ps, VM_PROCESS_PATTERNS)).toBe(9227468 * 1024);
        expect(sumProcessRss(ps, MODEL_SERVER_PATTERNS)).toBe(6920000 * 1024);
        expect(sumProcessRss(ps, [/./])).toBe((9227468 + 6920000 + 3880000 + 512) * 1024);
        expect(sumProcessRss(ps, [/qemu-system/])).toBeNull()
    });

    test('lms ps --json: a loaded model counts by its weights, idle or not', () => {
        expect(parseLmsPs('[{"type":"llm","modelKey":"google/gemma-4-26b-a4b","sizeBytes":15641352350,"identifier":"google/gemma-4-26b-a4b","status":"idle"},{"type":"embedding","modelKey":"qwen3-embedding-8b","sizeBytes":4680000000,"identifier":"text-embedding-qwen3-embedding-8b","status":"idle"}]'))
            .toEqual([{name: 'google/gemma-4-26b-a4b', bytes: 15641352350, state: 'idle'}, {name: 'text-embedding-qwen3-embedding-8b', bytes: 4680000000, state: 'idle'}]);
        expect(parseLmsPs('[]')).toEqual([])
    });
});
