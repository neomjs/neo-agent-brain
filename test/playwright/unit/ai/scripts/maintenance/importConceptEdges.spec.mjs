import {setup} from '../../../../setup.mjs';

const appName = 'ImportConceptEdgesCliTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                                     from '@playwright/test';
import {spawnSync}                                        from 'node:child_process';
import fs                                                 from 'node:fs';
import os                                                 from 'node:os';
import path                                               from 'node:path';
import {Readable, Writable}                               from 'node:stream';
import Neo                                                from 'neo.mjs/src/Neo.mjs';
import * as core                                          from 'neo.mjs/src/core/_export.mjs';
import InstanceManager                                    from 'neo.mjs/src/manager/Instance.mjs';
import ConceptService                                     from '../../../../../../ai/services/ConceptService.mjs';
import {createProgram, parseArgs, parseJsonlRows, runCli} from '../../../../../../ai/scripts/maintenance/importConceptEdges.mjs';

function createCaptureStream() {
    let   text   = '';
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            text += chunk.toString('utf8');
            callback();
        }
    });

    return {
        stream,
        read: () => text
    };
}

function createPlaneFixture() {
    const
        planeDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-import-concept-edges-')),
        conceptsDir = path.join(planeDir, 'concepts'),
        nodes       = [
            {id: 'alpha-concept', name: 'Alpha Concept', tier: 1, description: 'Alpha', uniqueToNeo: true,  tags: []},
            {id: 'beta-concept',  name: 'Beta Concept',  tier: 2, description: 'Beta',  uniqueToNeo: false, tags: []}
        ],
        edges       = [
            {source: 'beta-concept', target: 'file:ai/services/RetiredTarget.mjs', type: 'IMPLEMENTED_BY'}
        ];

    fs.mkdirSync(conceptsDir, {recursive: true});
    fs.writeFileSync(
        path.join(conceptsDir, 'nodes.jsonl'),
        `${nodes.map(node => JSON.stringify(node)).join('\n')}\n`,
        'utf8'
    );
    fs.writeFileSync(
        path.join(conceptsDir, 'edges.jsonl'),
        `${edges.map(edge => JSON.stringify(edge)).join('\n')}\n`,
        'utf8'
    );

    return {planeDir, conceptsDir};
}

test.describe('ai/scripts/maintenance/importConceptEdges.mjs', () => {
    test.beforeEach(() => {
        ConceptService.defaultConceptsDir = null;
        ConceptService.loaded             = false;
    });

    test.afterEach(() => {
        ConceptService.defaultConceptsDir = null;
        ConceptService.loaded             = false;
    });

    test('parses valid defaults, supplied options, and --help via Commander while rejecting store-path, unknown, missing-value, and positional arguments', async () => {
        expect(createProgram().name()).toBe('importConceptEdges');

        expect(parseArgs(['--tenant', 'neo-shared'])).toMatchObject({
            tenant: 'neo-shared',
            file  : null,
            dryRun: false,
            help  : false
        });

        expect(parseArgs(['--tenant', 'neo-shared', '--file', 'batch.jsonl', '--dry-run'])).toMatchObject({
            tenant: 'neo-shared',
            file  : 'batch.jsonl',
            dryRun: true,
            help  : false
        });

        const helpParsed = parseArgs(['--help']);
        expect(helpParsed.help).toBe(true);
        expect(helpParsed.helpText).toContain('--tenant <id>');

        const helpOut    = createCaptureStream(),
              helpErr    = createCaptureStream(),
              helpResult = await runCli(['--help'], {stdout: helpOut.stream, stderr: helpErr.stream});

        expect(helpResult.exitCode).toBe(0);
        expect(helpErr.read()).toBe('');
        expect(helpOut.read()).toContain('--tenant <id>');

        for (const forbidden of [
            [],
            ['--dry-run'],
            ['--tenant'],
            ['--tenant', '   '],
            ['--tenant', '--dry-run'],
            ['--tenant', 'neo-shared', '--file'],
            ['--tenant', 'neo-shared', '--file', '   '],
            ['--tenant', 'neo-shared', '--file', '--dry-run'],
            ['--tenant', 'neo-shared', '--store', '/tmp/custom'],
            ['--tenant', 'neo-shared', '--store=/tmp/custom'],
            ['--tenant', 'neo-shared', '--store-path', '/tmp/custom'],
            ['--tenant', 'neo-shared', '--concepts-dir', '/tmp/custom'],
            ['--tenant', 'neo-shared', '--data-root', '/tmp/custom'],
            ['--tenant', 'neo-shared', '/tmp/positional-store'],
            ['--tenant', 'neo-shared', '--unknown-flag']
        ]) {
            expect(() => parseArgs(forbidden), JSON.stringify(forbidden)).toThrow();
        }
    });

    test('supports --dry-run and --file against the plane store via configureStore without mutating shared AiConfig', async () => {
        const {planeDir, conceptsDir} = createPlaneFixture(),
              configureStore          = () => {
                  ConceptService.defaultConceptsDir = conceptsDir;
              };

        try {
            const
                inputFile   = path.join(planeDir, 'batch.jsonl'),
                edgesPath   = path.join(conceptsDir, 'edges.jsonl'),
                beforeBytes = fs.readFileSync(edgesPath, 'utf8');

            fs.writeFileSync(
                inputFile,
                [
                    JSON.stringify({source: 'beta-concept',  target: 'file:ai/services/RetiredTarget.mjs', type: 'IMPLEMENTED_BY', op: 'remove', decision: 'neomjs/neo#19235'}),
                    JSON.stringify({source: 'alpha-concept', target: 'file:src/Neo.mjs',                   type: 'IMPLEMENTED_BY'})
                ].join('\n') + '\n',
                'utf8'
            );

            const dryStdout = createCaptureStream(),
                  dryStderr = createCaptureStream(),
                  dryResult = await runCli(['--tenant', 'neo-shared', '--file', inputFile, '--dry-run'], {
                      stdout: dryStdout.stream,
                      stderr: dryStderr.stream,
                      configureStore
                  });

            expect(dryResult.exitCode).toBe(0);
            expect(dryStderr.read()).toBe('');
            expect(JSON.parse(dryStdout.read())).toMatchObject({
                ok     : true,
                written: false,
                dryRun : true,
                tenant : 'neo-shared',
                counts : {total: 2, added: 1, equal: 0, differs: 0, removed: 1, absent: 0, refused: 0}
            });
            expect(fs.readFileSync(edgesPath, 'utf8')).toBe(beforeBytes);

            const applyStdout = createCaptureStream(),
                  applyStderr = createCaptureStream(),
                  applyResult = await runCli(['--tenant', 'neo-shared', '--file', inputFile], {
                      stdout: applyStdout.stream,
                      stderr: applyStderr.stream,
                      configureStore
                  });

            expect(applyResult.exitCode).toBe(0);
            expect(applyStderr.read()).toBe('');
            expect(JSON.parse(applyStdout.read()).written).toBe(true);
            expect(ConceptService.parseJsonl(edgesPath)).toEqual([
                {source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}
            ]);
        } finally {
            fs.rmSync(planeDir, {recursive: true, force: true});
        }
    });

    test('reads JSONL from stdin when --file is omitted and exits 1 with written: true when valid and refused rows coexist', async () => {
        const {planeDir, conceptsDir} = createPlaneFixture(),
              configureStore          = () => {
                  ConceptService.defaultConceptsDir = conceptsDir;
              };

        try {
            const
                stdinPayload = [
                    JSON.stringify({source: 'alpha-concept', target: 'beta-concept', type: 'PARENT_CONCEPT'}),
                    JSON.stringify({source: 'unknown-concept', target: 'beta-concept', type: 'PARENT_CONCEPT'})
                ].join('\n') + '\n',
                stdout       = createCaptureStream(),
                stderr       = createCaptureStream(),
                result       = await runCli(['--tenant', 'neo-shared'], {
                    stdin : Readable.from([stdinPayload]),
                    stdout: stdout.stream,
                    stderr: stderr.stream,
                    configureStore
                });

            expect(result.exitCode).toBe(1);
            expect(stderr.read()).toBe('');
            const report = JSON.parse(stdout.read());
            expect(report).toMatchObject({
                ok     : false,
                written: true,
                counts : {total: 2, added: 1, refused: 1}
            });
            expect(ConceptService.parseJsonl(path.join(conceptsDir, 'edges.jsonl'))).toEqual([
                {source: 'beta-concept',  target: 'file:ai/services/RetiredTarget.mjs', type: 'IMPLEMENTED_BY'},
                {source: 'alpha-concept', target: 'beta-concept',                       type: 'PARENT_CONCEPT'}
            ]);
        } finally {
            fs.rmSync(planeDir, {recursive: true, force: true});
        }
    });

    test('exits non-zero on malformed JSONL before touching the store', async () => {
        const {planeDir, conceptsDir} = createPlaneFixture();
        let   storeConfigured         = false;

        try {
            const
                edgesPath   = path.join(conceptsDir, 'edges.jsonl'),
                beforeBytes = fs.readFileSync(edgesPath, 'utf8'),
                stdout      = createCaptureStream(),
                stderr      = createCaptureStream(),
                malformed   = [
                    JSON.stringify({source: 'alpha-concept', target: 'file:src/Neo.mjs', type: 'IMPLEMENTED_BY'}),
                    '{not-valid-json'
                ].join('\n');

            expect(() => parseJsonlRows('["array-not-object"]')).toThrow(/JSON object/);

            const result = await runCli(['--tenant', 'neo-shared'], {
                stdin         : Readable.from([malformed]),
                stdout        : stdout.stream,
                stderr        : stderr.stream,
                configureStore: () => {
                    storeConfigured                   = true;
                    ConceptService.defaultConceptsDir = conceptsDir;
                }
            });

            expect(result.exitCode).toBe(1);
            expect(storeConfigured).toBe(false);
            expect(stdout.read()).toBe('');
            expect(stderr.read()).toContain('Malformed JSONL at stdin:2');
            expect(fs.readFileSync(edgesPath, 'utf8')).toBe(beforeBytes);
        } finally {
            fs.rmSync(planeDir, {recursive: true, force: true});
        }
    });

    test('runs end-to-end as a standalone CLI subprocess resolving the plane store from NEO_PLANE_DATA_ROOT', () => {
        const {planeDir, conceptsDir} = createPlaneFixture();

        try {
            const proc = spawnSync(
                process.execPath,
                ['./ai/scripts/maintenance/importConceptEdges.mjs', '--tenant', 'neo-shared'],
                {
                    cwd     : process.cwd(),
                    encoding: 'utf8',
                    input   : `${JSON.stringify({source: 'alpha-concept', target: 'file:ai/services/ConceptService.mjs', type: 'IMPLEMENTED_BY'})}\n`,
                    env     : {
                        ...process.env,
                        NEO_PLANE_DATA_ROOT: planeDir
                    }
                }
            );

            expect(proc.status, proc.stderr).toBe(0);
            const report = JSON.parse(proc.stdout);
            expect(report.ok).toBe(true);
            expect(report.written).toBe(true);
            expect(report.added).toMatchObject([{
                source     : 'alpha-concept',
                target     : 'file:ai/services/ConceptService.mjs',
                type       : 'IMPLEMENTED_BY',
                root       : 'neo-agent-brain',
                rootVersion: expect.stringMatching(/^[a-f0-9]{40}$/)
            }]);
            expect(ConceptService.parseJsonl(path.join(conceptsDir, 'edges.jsonl'))).toHaveLength(2);
        } finally {
            fs.rmSync(planeDir, {recursive: true, force: true});
        }
    });
});
