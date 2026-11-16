import {test, expect}     from '@playwright/test';
import fs                 from 'node:fs';
import path               from 'node:path';
import {load as loadYaml} from 'js-yaml';

const
    repoRoot = path.resolve(process.cwd()),
    cloudDir = path.join(repoRoot, 'deploy/cloud'),
    // The one single-file bind left: every plane cut force-recreates both of its consumers, which
    // re-binds the file, and its readers resolve `<neoRootDir>/kb-config.yaml`
    SINGLE_FILE_BINDS = ['./kb-config.yaml'];

/**
 * @summary Parses a Compose file, keeping `volumes: !override` visible as its own key.
 * @param {String} file
 * @returns {Object}
 */
function readCompose(file) {
    const text = fs.readFileSync(path.join(cloudDir, file), 'utf8');

    return loadYaml(text.replace(/^(\s+)volumes: !override\b/gm, '$1volumesOverride:').replace(/!override\b/g, ''))
}

/**
 * @summary Each service's mounts in the local profile: the overlay's list replaces the base list under
 * `!override`, and is appended to it otherwise.
 * @param {Object} base    The base Compose file.
 * @param {Object} overlay The local overlay.
 * @returns {Array<String|Object>}
 */
function effectiveVolumes(base, overlay) {
    const names = new Set([...Object.keys(base.services || {}), ...Object.keys(overlay.services || {})]);

    return [...names].flatMap(name => {
        const local = overlay.services?.[name] || {};

        return local.volumesOverride || [...(base.services?.[name]?.volumes || []), ...(local.volumes || [])]
    })
}

/**
 * @summary A bind's source as written, from the short (`src:dst[:mode]`) or the long form.
 * @param {String|Object} entry
 * @returns {String|null} `null` for a named volume.
 */
function bindSource(entry) {
    if (typeof entry === 'string') {
        const source = entry.match(/^((?:\$\{(?:[^{}]|\{[^{}]*\})*\}|[^:])+)/)?.[1] || '';

        return /^[./~$]/.test(source) ? source : null
    }

    return entry?.type === 'bind' ? entry.source : null
}

/**
 * @summary Resolves Compose interpolation against an empty environment: a default stands in for its
 * variable, and a variable without one is a host input the env file names, so it resolves to nothing.
 * @param {String} value
 * @returns {String} The resolved value; a NUL marks an input with no default.
 */
function interpolate(value) {
    return value.replace(/\$\{([A-Za-z_]\w*)(?::?-((?:[^{}]|\{[^{}]*\})*))?(?::?\?(?:[^{}]|\{[^{}]*\})*)?\}/g,
        (match, name, fallback) => fallback === undefined ? '\0' : interpolate(fallback))
}

/**
 * @summary The local profile's bind sources that resolve to a regular file, as written.
 * @param {Object} base
 * @param {Object} overlay
 * @returns {String[]}
 */
function fileBinds(base, overlay) {
    return [...new Set(effectiveVolumes(base, overlay).map(bindSource).filter(source => {
        const resolved = source && interpolate(source);

        if (!resolved || resolved.includes('\0')) return false;

        const file = path.resolve(cloudDir, resolved);

        return fs.existsSync(file) && fs.statSync(file).isFile()
    }))].sort()
}

/**
 * @summary A merged Caddyfile reaches the local ingress, which the plane cut never recreates: its config
 * comes through a directory bind and `caddy run --watch`. A single-file bind keeps the inode a checkout
 * deleted, so no other single-file bind may join the one reasoned exception.
 */
test.describe('the local ingress sees a merged Caddyfile', () => {
    const
        base    = readCompose('docker-compose.yml'),
        overlay = readCompose('docker-compose.local-agent-os.yml'),
        probe   = (doc, service, entry) => {
            const copy = structuredClone(doc);

            copy.services[service] ??= {};
            (copy.services[service].volumes ??= []).push(entry);
            return copy
        };

    test('the ingress binds its config directory read-only, replacing the base bind, and reloads a change', () => {
        const
            ingress = overlay.services.ingress,
            binds   = (ingress.volumesOverride || []).filter(bindSource),
            source  = path.join(cloudDir, binds[0].source);

        expect(binds).toHaveLength(1);
        expect(binds[0]).toMatchObject({target: '/etc/caddy', read_only: true, bind: {create_host_path: false}});
        expect(fs.statSync(source).isDirectory(), `${binds[0].source} is a directory`).toBe(true);
        expect(fs.existsSync(path.join(source, 'Caddyfile'))).toBe(true);
        expect(ingress.command).toEqual(expect.arrayContaining(['--config', '/etc/caddy/Caddyfile', '--watch']))
    });

    test('the effective local profile binds no single file beyond the reasoned exception', () => {
        expect(fileBinds(base, overlay)).toEqual(SINGLE_FILE_BINDS)
    });

    test('the guard sees a file bind the local profile inherits from the base file', () => {
        expect(fileBinds(probe(base, 'chroma', './Caddyfile:/guard-probe:ro'), overlay)).toContain('./Caddyfile')
    });

    test('the guard sees an interpolated source whose default is a file, but not a host input without one', () => {
        expect(fileBinds(base, probe(overlay, 'chroma', '${PROBE_SOURCE:-./Caddyfile}:/guard-probe:ro')))
            .toContain('${PROBE_SOURCE:-./Caddyfile}');
        expect(fileBinds(base, probe(overlay, 'chroma', '${PROBE_SOURCE:?set it}:/guard-probe:ro'))).toEqual(SINGLE_FILE_BINDS)
    })
});
