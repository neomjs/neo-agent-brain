import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import path           from 'node:path';

/**
 * @summary The deploy surfaces name the Agent OS repository as their source — never the Engine.
 *
 * Since the 2026-08-27 split the Engine tree (`neomjs/neo`) carries no `ai/`, so a source stage that
 * fetches it has nothing this image can run, and a pin resolved against it cannot be fetched from the
 * Brain remote (`upload-pack: not our ref`). This spec reads exactly the surfaces an operator or a
 * build consults to learn WHERE the Agent OS comes from — the Dockerfile default, the reference
 * pipeline's default, and the documented pin commands — and refuses any of them naming the Engine
 * (#406). It is scoped to those surfaces on purpose: content sources such as the Knowledge Base's
 * Engine corpus projection legitimately name the Engine and are outside this read.
 */

const
    repoRoot = path.resolve(process.cwd()),
    BRAIN    = 'https://github.com/neomjs/neo-agent-brain.git',
    ENGINE   = 'neomjs/neo.git',

    SOURCE_SURFACES = [
        'deploy/cloud/Dockerfile',
        'ai/examples/cloud-deployment/deploy-pipeline.sh',
        'learn/agentos/cloud-deployment/PipelineWiring.md',
        'learn/agentos/cloud-deployment/Day0Tutorial.md',
        'ai/scripts/lifecycle/local-agent-os/README.md'
    ],

    read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test.describe('deploy surfaces name the Brain as the Agent OS source (#406)', () => {
    for (const surface of SOURCE_SURFACES) {
        test(`${surface} names the Brain repository and never the Engine`, () => {
            const text = read(surface);

            // The positive half comes first so a gutted file cannot pass by naming nothing.
            expect(text, `${surface} names no source repository at all`).toContain(BRAIN);
            expect(text, `${surface} still names the Engine as a source`).not.toContain(ENGINE);
        });
    }

    test('the Dockerfile default, the pipeline default and the four compose defaults agree', () => {
        const
            dockerfileDefault = read('deploy/cloud/Dockerfile').match(/^ARG NEO_REPO_URL=(\S+)$/m)?.[1],
            pipelineDefault   = read('ai/examples/cloud-deployment/deploy-pipeline.sh')
                .match(/^NEO_REPO_URL="\$\{NEO_REPO_URL:-(\S+)\}"$/m)?.[1],
            composeDefaults   = [...read('deploy/cloud/docker-compose.yml')
                .matchAll(/NEO_REPO_URL\s*:\s*\$\{NEO_REPO_URL:-(\S+)\}/g)].map(match => match[1]);

        expect(dockerfileDefault).toBe(BRAIN);
        expect(pipelineDefault).toBe(BRAIN);
        // Four Neo-derived services, one source each; a fifth or a divergent one is drift.
        expect(composeDefaults).toEqual([BRAIN, BRAIN, BRAIN, BRAIN]);
    });
});
