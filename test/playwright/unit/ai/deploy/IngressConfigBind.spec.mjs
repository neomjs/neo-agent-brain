import {test, expect}     from '@playwright/test';
import {execFileSync}     from 'node:child_process';
import fs                 from 'node:fs';
import os                 from 'node:os';
import path               from 'node:path';
import {load as loadYaml} from 'js-yaml';

const
    repoRoot = path.resolve(process.cwd()),
    cloudDir = path.join(repoRoot, 'deploy/cloud'),
    // The one single-file bind left: every plane cut force-recreates both of its consumers, which
    // re-binds the file, and its readers resolve `<neoRootDir>/kb-config.yaml`
    SINGLE_FILE_BINDS = ['kb-config.yaml'],
    probe             = source => `services:\n  chroma:\n    volumes:\n      - ${source}:/guard-probe:ro\n`;

/**
 * @summary Whether the `docker compose` CLI can run at all: availability, never validity.
 * @returns {Boolean}
 */
function composeCliAvailable() {
    try {
        execFileSync('docker', ['compose', 'version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
        return true
    } catch {
        return false
    }
}

/**
 * @summary Renders the local profile through Compose itself, which resolves interpolation from the env
 * file and merges mounts by their container target. Only `PATH` and `HOME` reach it, so no variable of the
 * host's shell changes the render.
 * @param {Object} [options]
 * @param {Object} [options.env]        The env file's variables beyond the required receiver directory.
 * @param {String[]} [options.inherited] Compose files merged between the base and the local overlay.
 * @returns {Object} The rendered document.
 */
function renderLocalProfile({env = {}, inherited = []} = {}) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingress-bind-'));

    try {
        const
            envFile = path.join(fixtureDir, 'local.env'),
            between = inherited.map((text, index) => {
                const file = path.join(fixtureDir, `inherited-${index}.yml`);

                fs.writeFileSync(file, text);
                return file
            });

        fs.writeFileSync(envFile, Object.entries({NEO_WAKE_RECEIVER_RECORDS_HOST_DIR: fixtureDir, ...env})
            .map(([key, value]) => `${key}=${value}`).join('\n'));

        return JSON.parse(execFileSync('docker', ['compose', '--env-file', envFile, '-f', 'docker-compose.yml',
            ...between.flatMap(file => ['-f', file]), '-f', 'docker-compose.local-agent-os.yml',
            '--profile', 'ingress', 'config', '--format', 'json'],
        {cwd: cloudDir, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.HOME}, stdio: ['ignore', 'pipe', 'pipe']}))
    } finally {
        fs.rmSync(fixtureDir, {recursive: true, force: true})
    }
}

/**
 * @summary The rendered bind sources that are regular files, relative to `deploy/cloud`.
 * @param {Object} rendered
 * @returns {String[]}
 */
function fileBinds(rendered) {
    return [...new Set(Object.values(rendered.services).flatMap(service => service.volumes || [])
        .filter(mount => mount.type === 'bind' && fs.existsSync(mount.source) && fs.statSync(mount.source).isFile())
        .map(mount => path.relative(cloudDir, mount.source)))].sort()
}

/**
 * @summary A merged Caddyfile reaches the local ingress, which the plane cut never recreates: its config
 * comes through a directory bind and `caddy run --watch`. A single-file bind keeps the inode a checkout
 * deleted, so no other single-file bind may join the one reasoned exception.
 */
test.describe('the local ingress sees a merged Caddyfile', () => {
    test('the ingress binds its config directory read-only, replacing the base bind, and reloads a change', () => {
        const
            overlayText = fs.readFileSync(path.join(cloudDir, 'docker-compose.local-agent-os.yml'), 'utf8'),
            ingress     = loadYaml(overlayText.replace(/!override\b/g, '')).services.ingress,
            binds       = ingress.volumes.filter(entry => entry?.type === 'bind'),
            source      = path.join(cloudDir, binds[0].source);

        expect(overlayText, 'the overlay replaces the cloud profile\'s single-file bind').toMatch(/\n {2}ingress:[\s\S]*?\n {4}volumes: !override\n/);
        expect(binds).toHaveLength(1);
        expect(binds[0]).toMatchObject({target: '/etc/caddy', read_only: true, bind: {create_host_path: false}});
        expect(fs.statSync(source).isDirectory(), `${binds[0].source} is a directory`).toBe(true);
        expect(fs.existsSync(path.join(source, 'Caddyfile'))).toBe(true);
        expect(ingress.command).toEqual(expect.arrayContaining(['--config', '/etc/caddy/Caddyfile', '--watch']))
    });

    test.describe('Compose\'s own render of the local profile', () => {
        test.beforeEach(() => {
            test.skip(!composeCliAvailable(), 'docker compose CLI unavailable; the static shape above still holds the ingress bind');
        });

        test('binds no single file beyond the reasoned exception', () => {
            expect(fileBinds(renderLocalProfile())).toEqual(SINGLE_FILE_BINDS)
        });

        test('sees a file bind the local profile inherits', () => {
            expect(fileBinds(renderLocalProfile({inherited: [probe('./Caddyfile')]}))).toContain('Caddyfile')
        });

        test('sees a required variable whose env-file value is a file', () => {
            expect(fileBinds(renderLocalProfile({inherited: [probe('${PROBE_SOURCE:?set it}')], env: {PROBE_SOURCE: './Caddyfile'}})))
                .toContain('Caddyfile')
        });

        test('passes a file that a directory replaces at the same target', () => {
            expect(fileBinds(renderLocalProfile({inherited: [probe('./Caddyfile'), probe('./ingress-local')]}))).toEqual(SINGLE_FILE_BINDS)
        })
    })
});
