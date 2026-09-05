import {test, expect}  from '@playwright/test';
import {execFileSync}  from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse}         from 'acorn';
import * as contract   from 'neo-agent-brain/fleet-contract';

const root         = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const contractRoot = path.join(root, 'src/fleet/contract');

/**
 * @summary Follows the public entry's actual module graph and rejects any runtime dependency.
 * The entry's relative exports are the positive control: an empty walk cannot pass.
 * @returns {string[]} Absolute module paths.
 */
function clientModules() {
    const seen  = new Set();
    const visit = file => {
        if (seen.has(file)) return;
        seen.add(file);
        const ast  = parse(fs.readFileSync(file, 'utf8'), {ecmaVersion: 'latest', sourceType: 'module'});
        const walk = node => {
            if (!node || typeof node !== 'object') return;
            expect(node.type, 'the public contract has no dynamic loader').not.toBe('ImportExpression');
            if (node.type === 'Identifier') {
                expect(['process', 'require', 'globalThis', 'fetch', 'eval'], 'no ambient runtime authority')
                    .not.toContain(node.name);
            }
            for (const value of Object.values(node)) {
                if (Array.isArray(value)) value.forEach(walk);
                else if (value && typeof value === 'object') walk(value);
            }
        };
        walk(ast);
        for (const node of ast.body) {
            if (!node.source) continue;
            const specifier = node.source.value;
            expect(specifier.startsWith('.'), 'no package or Node builtin in the client graph').toBe(true);
            const resolved = path.resolve(path.dirname(file), specifier);
            expect(resolved.startsWith(contractRoot + path.sep)).toBe(true);
            visit(resolved);
        }
    };
    visit(path.join(contractRoot, 'index.mjs'));
    return [...seen];
}

test.describe('installed Fleet client contract', () => {
    test('keeps the entire import graph client-safe and private policy unexported', () => {
        const modules = clientModules();
        expect(modules.length).toBeGreaterThan(1);
        expect(modules).toContain(path.join(contractRoot, 'wire.mjs'));
        expect(modules).toContain(path.join(contractRoot, 'mcpServers.mjs'));
        for (const name of ['REMOTE_MCP_CREDENTIAL_ENV_VAR', 'normalizeMcpTarget',
            'supportsTenantMcpTarget', 'FLEET_CREDENTIAL_METHODS', 'resolveFleetBearer']) {
            expect(contract).not.toHaveProperty(name);
        }
    });

    test('offers caller-owned catalogs while rejecting unknown vocabulary', () => {
        const harnesses = contract.listHarnessTypes();
        const original  = harnesses[0].label;
        harnesses[0].label = 'changed by caller';
        expect(contract.listHarnessTypes()[0].label).toBe(original);
        expect(contract.resolveHarnessType('unknown-harness')).toBeNull();
        expect(() => contract.normalizeMcpOverrides({unknown: true})).toThrow(/Unknown MCP server/);
        expect(() => contract.normalizeMcpOverrides({'memory-core': 'yes'})).toThrow(/must be boolean/);
        expect(contract.normalizeMcpOverrides(contract.defaultMcpMatrix())).toBeNull();
        expect(contract.resolveMcpMatrix({'memory-core': 'yes'})['memory-core']).toBe(false);
    });

    test('preserves fail-closed negotiation and response validation', () => {
        const offer = contract.createFleetWireOffer();
        expect(contract.selectFleetWireContract(offer).ok).toBe(true);
        expect(contract.selectFleetWireContract({versions: [999], capabilities: []}).state)
            .toBe(contract.FLEET_WIRE_RESPONSE_STATES.unsupportedProtocol);
        expect(contract.selectFleetWireContract({versions: offer.versions, capabilities: []}).state)
            .toBe(contract.FLEET_WIRE_RESPONSE_STATES.unsupportedCapability);
        expect(() => contract.createFleetWireRequest('getManager', {})).toThrow(/not on the client contract/);

        const response = contract.createFleetWireResponse(contract.FLEET_WIRE_RESPONSE_STATES.ok, {result: []});
        expect(contract.inspectFleetWireResponse(response, offer)).toEqual({ok: true});
        expect(contract.inspectFleetWireResponse({...response, ok: false}, offer).ok).toBe(false);
        expect(contract.inspectFleetWireResponse({
            ...response,
            protocol: {...response.protocol, capabilities: [...response.protocol.capabilities, 'unoffered']}
        }, offer).ok).toBe(false);
    });

    test('loads from an isolated node_modules package with no Brain dependencies or runtime root', () => {
        const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-contract-package-'));
        try {
            const installed = path.join(consumer, 'node_modules/neo-agent-brain');
            fs.mkdirSync(path.join(installed, 'src/fleet'), {recursive: true});
            fs.copyFileSync(path.join(root, 'package.json'), path.join(installed, 'package.json'));
            fs.cpSync(contractRoot, path.join(installed, 'src/fleet/contract'), {recursive: true});
            const program = [
                "const before = typeof globalThis.Neo;",
                "const contract = await import('neo-agent-brain/fleet-contract');",
                "let privateImport;",
                "try { await import('neo-agent-brain/ai/services/fleet/fleetLaunchContract.mjs'); }",
                "catch (error) { privateImport = error.code; }",
                "console.log(JSON.stringify({before, after: typeof globalThis.Neo, privateImport,",
                "valid: contract.selectFleetWireContract(contract.createFleetWireOffer()).ok,",
                "globals: Object.keys(globalThis).filter(key => key.startsWith('Neo'))}));"
            ].join('\n');
            const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
                cwd: consumer, encoding: 'utf8', env: {PATH: process.env.PATH}
            });
            expect(JSON.parse(output)).toEqual({
                before: 'undefined', after: 'undefined', privateImport: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
                valid : true, globals: []
            });
            expect(fs.existsSync(path.join(installed, 'ai'))).toBe(false);
            expect(fs.existsSync(path.join(consumer, '.neo-ai-data'))).toBe(false);
        } finally {
            fs.rmSync(consumer, {recursive: true, force: true});
        }
    });
});
