import {test, expect}     from '@playwright/test';
import fs                 from 'node:fs';
import path               from 'node:path';
import {load as loadYaml} from 'js-yaml';

const
    repoRoot     = path.resolve(process.cwd()),
    cloudDir     = path.join(repoRoot, 'deploy/cloud'),
    localOverlay = path.join(cloudDir, 'docker-compose.local-agent-os.yml'),
    ENV_NAME     = 'NEO_WAKE_RECEIVER_RECORDS_DIR',
    SOURCE_VAR   = 'NEO_WAKE_RECEIVER_RECORDS_HOST_DIR',
    // every other profile beside the local overlay: none owns the host wake lane
    otherProfiles = fs.readdirSync(cloudDir).filter(name => /^docker-compose.*\.yml$/.test(name) && name !== 'docker-compose.local-agent-os.yml');

const readCompose = file => loadYaml(fs.readFileSync(file, 'utf8').replace(/!override\b/g, ''));

/**
 * @summary The local Memory Core reads the host wake receiver's dispatch records through one
 * read-only bind whose source the env file must name; no other profile acquires the lane.
 */
test.describe('the local mc-server reads the wake receiver records through a read-only bind (#530)', () => {
    const
        doc      = readCompose(localOverlay),
        mcServer = doc.services?.['mc-server'] || {},
        target   = mcServer.environment?.[ENV_NAME],
        binds    = (mcServer.volumes || []).filter(entry => typeof entry === 'object' && entry.type === 'bind');

    test('the env names the container side of the bind, and exactly one bind serves it read-only', () => {
        expect(typeof target, `${ENV_NAME} must be set on mc-server`).toBe('string');

        const records = binds.filter(entry => entry.target === target);

        expect(records, `exactly one bind must target ${target}`).toHaveLength(1);
        expect(records[0].read_only, 'the container must not write a receiver record').toBe(true);
    });

    test('the source is the required env-file variable, and a missing host directory is never created', () => {
        const bind = binds.find(entry => entry.target === target);

        expect(bind.source, 'the source comes from the env file as a required variable, never a home-directory guess')
            .toMatch(new RegExp(`^\\$\\{${SOURCE_VAR}:\\?`));
        expect(bind.bind?.create_host_path, 'Compose must not create an empty host path').toBe(false);
    });

    test('the local runbook names the source variable, the directory, and the receiver-less case before the plane starts', () => {
        const
            runbook = fs.readFileSync(path.join(repoRoot, 'ai/scripts/lifecycle/local-agent-os/README.md'), 'utf8'),
            start   = runbook.indexOf('## Start the container plane'),
            section = runbook.slice(start, runbook.indexOf('\n## ', start + 1));

        expect(start, 'the plane-start section exists').toBeGreaterThan(-1);
        expect(section, 'the .env prerequisite is named where the plane starts').toContain(`${SOURCE_VAR}=`);
        expect(section, 'the records directory is derived from the receiver state dir, one declaration').toContain(`${SOURCE_VAR}=\${NEO_WAKE_RECEIVER_STATE_DIR}/records`);
        expect(section, 'the directory is created before up, with the mode the receiver accepts').toMatch(/mkdir -p -m 0700 "[^"]*\/records"/);
        expect(section, 'a receiver-less deployment is told what its delivery leg reads').toContain('`no-records`');
    });

    test('no other profile mounts the records or sets the env', () => {
        for (const name of otherProfiles) {
            const services = readCompose(path.join(cloudDir, name)).services || {};

            for (const [serviceKey, service] of Object.entries(services)) {
                expect(service?.environment?.[ENV_NAME], `${name}: ${serviceKey} must not set ${ENV_NAME}`).toBeUndefined();

                for (const entry of service?.volumes || []) {
                    const entryTarget = typeof entry === 'string' ? entry.split(':')[1] : entry?.target;

                    expect(entryTarget, `${name}: ${serviceKey} must not mount the receiver records`).not.toBe(target)
                }
            }
        }
    })
});
