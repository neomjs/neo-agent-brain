import {test, expect} from '@playwright/test';
import fs             from 'node:fs';

import {
    findImplicitGraphStoreDefaults,
    runExplicitGraphStoreOwnershipLint
} from '../../../../../../ai/scripts/lint/explicitGraphStoreOwnership.mjs';

test.describe('explicit graph-store ownership', () => {
    test('rejects an import.meta.url-derived default beside a direct SQLite handle', () => {
        const findings = findImplicitGraphStoreDefaults(`
            import Database from 'better-sqlite3';
            function open({rootDir = fileURLToPath(new URL('../', import.meta.url))} = {}) {
                return new Database(path.join(rootDir, 'graph.sqlite'));
            }
        `);

        expect(findings).toEqual([expect.objectContaining({
            code     : 'implicit-graph-store-default',
            parameter: 'rootDir',
            source   : 'import-meta-url'
        })]);
    });

    test('rejects a cwd-derived default beside a direct SQLite handle', () => {
        const findings = findImplicitGraphStoreDefaults(`
            import Database from 'better-sqlite3';
            const open = ({dbPath = path.join(process.cwd(), 'graph.sqlite')} = {}) => new Database(dbPath);
        `);

        expect(findings[0]).toMatchObject({parameter: 'dbPath', source: 'process-cwd'});
    });

    test('preserves explicit path plus fail-closed validation as the reference shape', () => {
        const findings = findImplicitGraphStoreDefaults(`
            import Database from 'better-sqlite3';
            function open({dbPath} = {}) {
                if (!dbPath) throw new Error('dbPath is required');
                return new Database(dbPath, {readonly: true, fileMustExist: true});
            }
        `);

        expect(findings).toEqual([]);
    });

    test('does not classify checkout defaults in modules that open no SQLite handle', () => {
        expect(findImplicitGraphStoreDefaults(`
            export function resolveDocs({root = process.cwd()} = {}) { return root; }
        `)).toEqual([]);
    });

    test('the mailbox read-state probe remains an explicit, fail-closed production exemplar', () => {
        const source = fs.readFileSync(
            new URL('../../../../../../ai/scripts/diagnostics/mailboxReadStateProbe.mjs', import.meta.url),
            'utf8'
        );

        expect(findImplicitGraphStoreDefaults(source)).toEqual([]);
        expect(source).toContain('dbPath must be an explicit non-empty path');
    });

    test('the live Brain production tree has a zero baseline', () => {
        const logger = {log() {}, error() {}};
        const result = runExplicitGraphStoreOwnershipLint({logger});

        expect(result.exitCode, JSON.stringify(result.findings)).toBe(0);
        expect(result.findings).toEqual([]);
        expect(result.filesRead).toBeGreaterThan(0);
    });
});
