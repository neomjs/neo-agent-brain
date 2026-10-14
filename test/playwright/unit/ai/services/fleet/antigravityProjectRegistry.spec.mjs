import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect, test} from '@playwright/test';
import {writeFileAtomic} from '../../../../../../ai/services/shared/atomicFileWrite.mjs';
import {MCP_SERVERS} from '../../../../../../src/fleet/contract/mcpServers.mjs';
import {registerAntigravityProject} from '../../../../../../ai/services/fleet/antigravityProjectRegistry.mjs';

const
    RULES = MCP_SERVERS.map(({key}) => `mcp(neo-mjs-${key}/*)`),
    RECEIPT = '.neo-fleet-project-binding.json';

/** @summary Prove registration is create-only and project-scoped across a seat-local profile receipt. */
test.describe('registerAntigravityProject', () => {
    let tempRoot, registryDirectory, profileDirectory, projectRoot;

    test.beforeEach(() => {
        tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-project-register-')));
        registryDirectory = path.join(tempRoot, 'native', 'config', 'projects');
        profileDirectory = path.join(tempRoot, 'profile');
        projectRoot = path.join(tempRoot, 'checkouts', 'neo');
        fs.mkdirSync(registryDirectory, {recursive: true});
        fs.mkdirSync(profileDirectory, {recursive: true});
        fs.mkdirSync(projectRoot, {recursive: true})
    });

    test.afterEach(() => fs.rmSync(tempRoot, {recursive: true, force: true}));

    const register = overrides => registerAntigravityProject({
        registryDirectory,
        profileDirectory,
        projectRoot,
        name: 'Neo Brain',
        projectMcpAllowRules: RULES,
        idFactory: () => '154e7ad7-ab8c-4445-bd6b-9ac6bdddcd0f',
        ...overrides
    });

    test('creates one native project record and a private profile-only UUID receipt', async () => {
        const result = await register(),
              receiptPath = path.join(profileDirectory, RECEIPT),
              projectPath = path.join(registryDirectory, `${result.projectId}.json`),
              receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')),
              record = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

        expect(result).toMatchObject({verified: true, created: true, projectId: receipt.projectId, projectRoot});
        expect(receipt).toEqual({version: 1, projectId: result.projectId, projectName: 'Neo Brain', projectRoot});
        expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
        expect(record).toMatchObject({
            id: result.projectId,
            name: 'Neo Brain',
            projectResources: {resources: [{folderUri: expect.stringMatching(/^file:/)}]},
            permissionGrants: {permissionGrants: {allow: RULES}},
            settings: {},
            isWorkspaceOnly: false
        });
        expect(JSON.stringify(record)).not.toMatch(/identity|credential|token|mcp\(\*\)/i)
    });

    test('reuses its receipt and preserves project settings and existing grants while merging only canonical rules', async () => {
        const first = await register(), projectPath = path.join(registryDirectory, `${first.projectId}.json`),
              original = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
        original.permissionGrants.permissionGrants.allow.push('mcp(operator-approved-local-tool/*)');
        original.settings = {theme: 'dark', retained: true};
        fs.writeFileSync(projectPath, JSON.stringify(original));

        const second = await register(), updated = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

        expect(second).toMatchObject({verified: true, created: false, projectId: first.projectId});
        expect(updated.settings).toEqual(original.settings);
        expect(updated.permissionGrants.permissionGrants.allow).toEqual([
            ...original.permissionGrants.permissionGrants.allow,
            ...RULES.filter(rule => !original.permissionGrants.permissionGrants.allow.includes(rule))
        ])
    });

    test('refuses a name or root change against the profile-owned receipt', async () => {
        await register();
        const otherRoot = path.join(tempRoot, 'checkouts', 'other');
        fs.mkdirSync(otherRoot, {recursive: true});

        await expect(register({name: 'Renamed'})).rejects.toMatchObject({code: 'project-receipt-mismatch'});
        await expect(register({projectRoot: otherRoot})).rejects.toMatchObject({code: 'project-receipt-mismatch'})
    });

    test('rejects a global MCP wildcard or any noncanonical rule set before writing', async () => {
        await expect(register({projectMcpAllowRules: ['mcp(*)']})).rejects.toMatchObject({code: 'project-mcp-rules-invalid'});
        expect(fs.existsSync(path.join(profileDirectory, RECEIPT))).toBe(false);
        expect(fs.readdirSync(registryDirectory)).toEqual([])
    });

    test('refuses a receipt-owned native project whose registered root diverged', async () => {
        const first = await register(), projectPath = path.join(registryDirectory, `${first.projectId}.json`),
              record = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
        record.projectResources.resources = [{folderUri: 'file:///private/tmp/foreign'}];
        fs.writeFileSync(projectPath, JSON.stringify(record));

        await expect(register()).rejects.toMatchObject({code: 'project-registry-mismatch'})
    });

    test('refuses symlinked receipt and native project files instead of following or replacing them', async () => {
        const receiptPath = path.join(profileDirectory, RECEIPT),
              receiptTarget = path.join(tempRoot, 'receipt-target.json');
        fs.writeFileSync(receiptTarget, JSON.stringify({version: 1, projectId: '154e7ad7-ab8c-4445-bd6b-9ac6bdddcd0f', projectName: 'Neo Brain', projectRoot}), {mode: 0o600});
        fs.symlinkSync(receiptTarget, receiptPath);
        await expect(register()).rejects.toMatchObject({code: 'project-file-unproven'});
        fs.unlinkSync(receiptPath);

        const first = await register(), projectPath = path.join(registryDirectory, `${first.projectId}.json`),
              foreignTarget = path.join(tempRoot, 'foreign-project.json');
        fs.writeFileSync(foreignTarget, '{}');
        fs.unlinkSync(projectPath);
        fs.symlinkSync(foreignTarget, projectPath);

        await expect(register()).rejects.toMatchObject({code: 'project-file-unproven'});
        expect(fs.readFileSync(foreignTarget, 'utf8')).toBe('{}')
    });

    test('recovers a receipt-first interrupted create using the same ID', async () => {
        let failedNativeWrite = false;
        await expect(register({writeAtomic: async (target, content, options) => {
            if (target.endsWith('.json') && target.startsWith(registryDirectory)) {
                failedNativeWrite = true;
                throw new Error('simulated native record write failure')
            }
            return writeFileAtomic(target, content, options)
        }})).rejects.toMatchObject({code: 'project-write-failed'});

        expect(failedNativeWrite).toBe(true);
        const receipt = JSON.parse(fs.readFileSync(path.join(profileDirectory, RECEIPT), 'utf8')),
              retry = await register();

        expect(retry).toMatchObject({verified: true, created: true, projectId: receipt.projectId});
        expect(fs.existsSync(path.join(registryDirectory, `${receipt.projectId}.json`))).toBe(true)
    });

    test('refuses symlinked profile, registry and checkout roots', async () => {
        const linked = path.join(tempRoot, 'linked-profile');
        fs.symlinkSync(profileDirectory, linked);
        await expect(register({profileDirectory: linked})).rejects.toMatchObject({code: 'project-path-unproven'});

        const linkedRegistry = path.join(tempRoot, 'linked-registry');
        fs.symlinkSync(registryDirectory, linkedRegistry);
        await expect(register({registryDirectory: linkedRegistry})).rejects.toMatchObject({code: 'project-path-unproven'});

        const linkedRoot = path.join(tempRoot, 'linked-root');
        fs.symlinkSync(projectRoot, linkedRoot);
        await expect(register({projectRoot: linkedRoot})).rejects.toMatchObject({code: 'project-path-unproven'})
    });
});
