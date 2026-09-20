import {execFile}  from 'node:child_process';
import fs          from 'node:fs/promises';
import os          from 'node:os';
import path        from 'node:path';
import {promisify} from 'node:util';

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {
    parseArgs,
    resolveExitCode,
    runOperatorReconciliation,
    validateArgs
} from '../../../../../../ai/scripts/maintenance/reconcileGithubCommunity.mjs';

const
    execFileAsync  = promisify(execFile),
    cliPath        = path.resolve(process.cwd(), 'ai/scripts/maintenance/reconcileGithubCommunity.mjs'),
    reviewedPolicy = {
        recordedActorDispositions: {},
        responseBearingKinds     : ['issue-comment', 'discussion-comment'],
        rosteredActorIds         : []
    };

/** @summary Provides explicit operator choices for isolated CLI boundary cases. */
function validArgs(overrides = {}) {
    return {
        attentionPolicyFile : '/tmp/reviewed-community-policy.json',
        maxAdmissionAttempts: 3,
        mode                : 'manual',
        sourceInstanceIds   : [],
        tenantId            : 'trusted-tenant',
        ...overrides
    };
}

/** @summary Observes the real tenant context without opening runtime storage. */
function runtimeFixture({admissionPolicy = null, result = {status: 'completed'}} = {}) {
    const calls     = [];
    const admission = {attentionPolicy: admissionPolicy};

    return {
        calls,
        admission,
        runtimeLoader: async () => ({
            admission,
            context    : RequestContextService,
            coordinator: {
                async runOnce(options) {
                    calls.push({contextUserId: RequestContextService.getUserId(), options});
                    return result
                }
            }
        })
    }
}

/** @summary Exercises the actual CLI in a bounded disposable child process. */
async function runCli(args, env = {}) {
    try {
        const result = await execFileAsync(process.execPath, [cliPath, ...args], {
            cwd      : process.cwd(),
            env      : {...process.env, ...env},
            timeout  : 10000,
            maxBuffer: 1024 * 1024
        });

        return {code: 0, stderr: result.stderr, stdout: result.stdout};
    } catch (error) {
        return {
            code  : typeof error.code === 'number' ? error.code : 1,
            stderr: error.stderr ?? '',
            stdout: error.stdout ?? ''
        };
    }
}

test.describe('reconcileGithubCommunity trusted CLI boundary (#104)', () => {
    test('parses the explicit operator surface and refuses incomplete arguments before runtime loading', async () => {
        expect(parseArgs([
            '--mode', 'shadow',
            '--tenant-id', 'tenant-a',
            '--max-admission-attempts', '4',
            '--source-instance-id', 'source-a',
            '--source-instance-id', 'source-b'
        ])).toEqual({
            attentionPolicyFile : null,
            help                : false,
            maxAdmissionAttempts: 4,
            mode                : 'shadow',
            sourceInstanceIds   : ['source-a', 'source-b'],
            tenantId            : 'tenant-a'
        });

        const invalidCases = [
            ['tenant', validArgs({tenantId: null})],
            ['mode', validArgs({mode: 'provider'})],
            ['attempts', validArgs({maxAdmissionAttempts: 0})],
            ['policyfile', validArgs({attentionPolicyFile: null})]
        ];

        for (const [label, args] of invalidCases) {
            let runtimeLoads = 0;

            expect(validateArgs(args), label).not.toEqual([]);
            await expect(runOperatorReconciliation({
                args,
                runtimeLoader: async () => {
                    runtimeLoads++;
                    throw new Error('runtime must not load');
                }
            })).rejects.toThrow('COMMUNITY_RECONCILIATION_ARGUMENTS_INVALID');
            expect(runtimeLoads, `${label} must refuse before runtime loading`).toBe(0);
        }
    });

    test('invalid policy fails before runtime import and never exposes its raw text', async () => {
        let   runtimeLoads    = 0;
        const rawProviderText = 'RAW_PROVIDER_RESPONSE token=should-never-print';

        await expect(runOperatorReconciliation({
            args      : validArgs(),
            readPolicy: () => {
                throw new Error(rawProviderText);
            },
            runtimeLoader: async () => {
                runtimeLoads++;
                throw new Error('runtime must not load');
            }
        })).rejects.toThrow(rawProviderText);

        expect(runtimeLoads).toBe(0);

        const tempDir    = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-community-cli-')),
              policyPath = path.join(tempDir, 'malformed-policy.json');

        try {
            await fs.writeFile(policyPath, `{"provider":"${rawProviderText}"`);

            const result = await runCli([
                '--tenant-id', 'tenant-a',
                '--max-admission-attempts', '2',
                '--attention-policy-file', policyPath
            ]);
            const output = `${result.stdout}\n${result.stderr}`;

            expect(result.code).toBe(1);
            expect(output).toContain('COMMUNITY_RECONCILIATION_FAILED');
            expect(output).not.toContain(rawProviderText);
            expect(output).not.toContain('Unexpected end');
        } finally {
            await fs.rm(tempDir, {force: true, recursive: true});
        }
    });

    test('binds the trusted tenant through the real request context and restores it afterward', async () => {
        const fixture = runtimeFixture();
        let observedOutsideContext;

        expect(await runOperatorReconciliation({
            args         : validArgs(),
            readPolicy   : () => reviewedPolicy,
            runtimeLoader: fixture.runtimeLoader
        })).toEqual({status: 'completed'});

        observedOutsideContext = RequestContextService.getUserId();

        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0].contextUserId).toBe('trusted-tenant');
        expect(fixture.calls[0].options).toEqual({
            maxAdmissionAttempts: 3,
            mode                : 'manual',
            sourceInstanceIds   : null
        });
        expect(fixture.calls[0].options).not.toHaveProperty('tenantId');
        expect(fixture.admission.attentionPolicy).toEqual(reviewedPolicy);
        expect(observedOutsideContext).toBeUndefined();
    });

    test('shadow mode neither reads policy nor writes admission policy', async () => {
        const fixture     = runtimeFixture({result: {status: 'skipped'}});
        let   policyReads = 0;

        const result = await runOperatorReconciliation({
            args      : validArgs({attentionPolicyFile: null, mode: 'shadow'}),
            readPolicy: () => {
                policyReads++;
                throw new Error('shadow must not read policy');
            },
            runtimeLoader: fixture.runtimeLoader
        });

        expect(result).toEqual({status: 'skipped'});
        expect(policyReads).toBe(0);
        expect(fixture.admission.attentionPolicy).toBeNull();
        expect(fixture.calls[0].options.mode).toBe('shadow');
    });

    test('manual mode reads and injects policy once, but refuses a prebound policy', async () => {
        let   policyReads  = 0;
        const boundFixture = runtimeFixture({admissionPolicy: {already: 'bound'}});

        await expect(runOperatorReconciliation({
            args      : validArgs(),
            readPolicy: () => {
                policyReads++;
                return reviewedPolicy;
            },
            runtimeLoader: boundFixture.runtimeLoader
        })).rejects.toThrow('COMMUNITY_RECONCILIATION_POLICY_ALREADY_BOUND');

        expect(policyReads).toBe(1);
        expect(boundFixture.calls).toEqual([]);
        expect(boundFixture.admission.attentionPolicy).toEqual({already: 'bound'});

        const fixture         = runtimeFixture();
        let   successfulReads = 0;

        await runOperatorReconciliation({
            args      : validArgs(),
            readPolicy: () => {
                successfulReads++;
                return reviewedPolicy;
            },
            runtimeLoader: fixture.runtimeLoader
        });

        expect(successfulReads).toBe(1);
        expect(fixture.admission.attentionPolicy).toEqual(reviewedPolicy);
    });

    test('partial results return exit code 1 while completed and skipped results are clean', () => {
        expect(resolveExitCode({status: 'partial'})).toBe(1);
        expect(resolveExitCode({status: 'failed'})).toBe(1);
        expect(resolveExitCode({status: 'completed'})).toBe(0);
        expect(resolveExitCode({status: 'skipped'})).toBe(0);
    });

    test('the real shadow CLI completes against an isolated empty tenant without provider acquisition', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'community-cli-'));
        try {
            const result = await runCli(['--mode', 'shadow', '--tenant-id', 'empty-tenant',
                '--max-admission-attempts', '1'], {
                UNIT_TEST_MODE: 'true', NEO_MEMORY_DB_PATH_TEST: path.join(directory, 'store.sqlite')
            });
            expect(result.code, result.stderr).toBe(0);
            expect(result.stdout).toContain('"status": "skipped"');
            expect(result.stdout).toContain('"sourceCount": 0');
        } finally {
            await fs.rm(directory, {recursive: true, force: true});
        }
    });

    test('the real CLI help and missing-argument paths do not open runtime storage', async () => {
        const help = await runCli(['--help']);
        expect(help.code).toBe(0);
        expect(help.stdout).toContain('Usage: npm run ai:community-reconcile');
        expect(help.stdout).toContain('--attention-policy-file');
        expect(help.stdout).not.toContain('COMMUNITY_RECONCILIATION_FAILED');

        const missing = await runCli([]);
        const output  = `${missing.stdout}\n${missing.stderr}`;

        expect(missing.code).toBe(2);
        expect(output).toContain('--tenant-id is required');
        expect(output).toContain('--max-admission-attempts must be an explicit positive integer');
        expect(output).toContain('--attention-policy-file is required');
        expect(output).not.toContain('COMMUNITY_RECONCILIATION_FAILED');
    });
});
