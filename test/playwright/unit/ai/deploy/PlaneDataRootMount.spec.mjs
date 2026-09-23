import {test, expect}     from '@playwright/test';
import fs                 from 'node:fs';
import path               from 'node:path';
import {load as loadYaml} from 'js-yaml';
import Neo                from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import ConfigBase         from '../../../../../ai/configBase.mjs';

const repoRoot             = path.resolve(process.cwd());
const composePath          = path.join(repoRoot, 'deploy/cloud/docker-compose.yml');
const CONTAINER_PLANE_ROOT = '/app/.neo-ai-data';
const HEAP_VOLUME          = 'shared-heap-observation-data';
// The services that report their own V8 heap into the channel, and its one reader.
const HEAP_WRITERS         = ['kb-server', 'mc-server'];
const HEAP_READER          = 'orchestrator';

/**
 * @summary Normalizes one Compose volume entry (short or long form) to source, target and mode.
 *
 * The short form is split at the first `:/`, because a host source may carry a `${VAR:-default}`
 * interpolation whose own colon precedes the container target.
 * @param {String|Object} entry Compose service `volumes` entry
 * @returns {{source:String, target:String, readOnly:Boolean}}
 */
function parseMount(entry) {
    if (typeof entry !== 'string') {
        return {source: entry.source, target: entry.target, readOnly: entry.read_only === true}
    }
    const [, source, target, mode] = entry.match(/^(.*?):(\/[^:]*)(?::(ro|rw))?$/);
    return {source, target, readOnly: mode === 'ro'}
}

/**
 * @summary Guards that every path a service writes under the plane data root reaches a volume.
 *
 * `planeConfig.assertPlaneMemberCoherence` already makes every plane member resolve under the data
 * root at boot, so one private volume mounted AT the root covers all of them structurally — a writer
 * added later cannot land in the container's writable layer, where a recreate discards it. The
 * channel volumes (sqlite, handoff, heap-observation, …) mount on top of the root.
 *
 * The heap-observation channel is pinned separately because it already regressed once: its writer
 * mounts vanished from kb-server and mc-server in a merge, and the channel read `unavailable stale`
 * for four weeks while every health check stayed green. Its target is taken from the production
 * config descriptor, not spelled here.
 */
test.describe('plane state reaches a volume (#425)', () => {
    const doc      = loadYaml(fs.readFileSync(composePath, 'utf8').replace(/!override\b/g, ''));
    const services = doc.services || {};
    const mountsOf = service => (service?.volumes || []).map(parseMount);
    const planeServices = Object.entries(services)
        .filter(([, service]) => mountsOf(service).some(mount => mount.target.startsWith(`${CONTAINER_PLANE_ROOT}/`)));

    test('every service with a plane mount also mounts its own writable volume at the plane root', () => {
        // Control: the population is not empty, and it contains the channel's writers.
        expect(planeServices.map(([key]) => key)).toEqual(expect.arrayContaining([...HEAP_WRITERS, HEAP_READER]));

        for (const [key, service] of planeServices) {
            const roots = mountsOf(service).filter(mount => mount.target === CONTAINER_PLANE_ROOT);

            expect(roots, `${key} must mount exactly one volume at ${CONTAINER_PLANE_ROOT}`).toHaveLength(1);
            expect(roots[0].readOnly, `${key}'s plane root must be writable`).toBe(false);
            expect(Object.keys(doc.volumes || {}), `${key}'s plane root must be a declared named volume`)
                .toContain(roots[0].source)
        }
    });

    test('no two services share a plane root', () => {
        // A missing root is the first test's failure; this one judges only the roots that exist.
        const sources = planeServices
            .map(([, service]) => mountsOf(service).find(mount => mount.target === CONTAINER_PLANE_ROOT)?.source)
            .filter(Boolean);

        expect(new Set(sources).size).toBe(sources.length)
    });

    test('every heap writer mounts the shared channel writable, and the reader mounts it read-only', () => {
        const {plane, heapObservation} = ConfigBase.config.data;
        const channelDir               = path.relative(plane.dataRoot.default, heapObservation.dir.default);

        expect(channelDir.startsWith('..'), 'the channel must live under the plane root').toBe(false);

        const target = `${CONTAINER_PLANE_ROOT}/${channelDir}`;

        for (const key of HEAP_WRITERS) {
            expect(mountsOf(services[key]).filter(mount => mount.source === HEAP_VOLUME), `${key} writes the channel`)
                .toEqual([{source: HEAP_VOLUME, target, readOnly: false}])
        }
        expect(mountsOf(services[HEAP_READER]).filter(mount => mount.source === HEAP_VOLUME), 'the orchestrator reads the channel')
            .toEqual([{source: HEAP_VOLUME, target, readOnly: true}])
    })
});
