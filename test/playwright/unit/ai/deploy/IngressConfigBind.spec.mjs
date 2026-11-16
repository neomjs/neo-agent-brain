import {test, expect}     from '@playwright/test';
import fs                 from 'node:fs';
import path               from 'node:path';
import {load as loadYaml} from 'js-yaml';

const
    repoRoot     = path.resolve(process.cwd()),
    cloudDir     = path.join(repoRoot, 'deploy/cloud'),
    localOverlay = path.join(cloudDir, 'docker-compose.local-agent-os.yml'),
    overlayText  = fs.readFileSync(localOverlay, 'utf8'),
    overlay      = loadYaml(overlayText.replace(/!override\b/g, '')),
    // The one single-file bind left: every plane cut force-recreates both of its consumers, which
    // re-binds the file, and its readers resolve `<neoRootDir>/kb-config.yaml`
    SINGLE_FILE_BINDS = ['./kb-config.yaml'];

/**
 * @summary A bind's source as written, from the short (`src:dst[:mode]`) or the long form.
 * @param {String|Object} entry A service `volumes` entry.
 * @returns {String|null} `null` for a named volume.
 */
function bindSource(entry) {
    if (typeof entry === 'string') {
        const source = entry.split(':')[0];

        return /^[./]/.test(source) ? source : null
    }

    return entry?.type === 'bind' ? entry.source : null
}

/**
 * @summary A merged Caddyfile reaches the local ingress, which the plane cut never recreates: its config
 * comes through a directory bind and `caddy run --watch`. A single-file bind keeps the inode a checkout
 * deleted, so no other single-file bind may join the one reasoned exception.
 */
test.describe('the local ingress sees a merged Caddyfile', () => {
    test('the ingress binds its config directory read-only, replacing the base bind, and reloads a change', () => {
        const
            ingress = overlay.services.ingress,
            binds   = ingress.volumes.filter(entry => bindSource(entry)),
            source  = path.join(cloudDir, binds[0].source);

        expect(overlayText, 'the overlay replaces the cloud profile\'s single-file bind').toMatch(/\n {2}ingress:[\s\S]*?\n {4}volumes: !override\n/);
        expect(binds).toHaveLength(1);
        expect(binds[0]).toMatchObject({target: '/etc/caddy', read_only: true, bind: {create_host_path: false}});
        expect(fs.statSync(source).isDirectory(), `${binds[0].source} is a directory`).toBe(true);
        expect(fs.existsSync(path.join(source, 'Caddyfile'))).toBe(true);
        expect(ingress.command).toEqual(expect.arrayContaining(['--config', '/etc/caddy/Caddyfile', '--watch']))
    });

    test('no service binds a single file beyond the reasoned exception, and the exception is still bound', () => {
        const fileBinds = Object.values(overlay.services)
            .flatMap(service => (service.volumes || []).map(bindSource))
            .filter(source => source && fs.existsSync(path.join(cloudDir, source)) && fs.statSync(path.join(cloudDir, source)).isFile());

        expect([...new Set(fileBinds)].sort()).toEqual(SINGLE_FILE_BINDS)
    })
});
