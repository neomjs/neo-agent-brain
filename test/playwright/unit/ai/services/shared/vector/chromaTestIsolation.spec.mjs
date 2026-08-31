import {test, expect} from '@playwright/test';
import {
    assertChromaCoordinateCoherence,
    CHROMA_PRODUCTION_DATABASE,
    CHROMA_TEST_DATABASE,
    dropChromaTestDatabase,
    ensureChromaTestDatabase,
    isChromaAlreadyExistsError,
    isChromaTestDatabaseName,
    KB_CHROMA_TEST_DATABASE_PREFIX,
    kbChromaTestDatabaseName,
    listChromaDatabases
} from '../../../../../../../ai/services/shared/vector/chromaTestIsolation.mjs';

/**
 * Self-test for the unit-test Chroma database-isolation helpers. chromadb 3.x has no
 * getOrCreateDatabase and manages databases on a separate AdminClient, so these helpers ensure the
 * dedicated test database exists before collection ops and drop it wholesale for cleanup. The
 * AdminClient is injected here (no live Chroma server), and the critical assertion is the
 * defense-in-depth guard: `dropChromaTestDatabase` must NEVER reach `default_database`.
 */
test.describe('chromaTestIsolation helpers', () => {
    test('constants: the test database is isolated from production', () => {
        expect(CHROMA_TEST_DATABASE).not.toBe(CHROMA_PRODUCTION_DATABASE);
        expect(CHROMA_PRODUCTION_DATABASE).toBe('default_database');
    });

    test('ensureChromaTestDatabase is a no-op create when the database already exists', async () => {
        const calls       = [];
        const adminClient = {
            getDatabase   : async args => { calls.push(['get',    args]) },
            createDatabase: async args => { calls.push(['create', args]) }
        };

        const result = await ensureChromaTestDatabase({database: CHROMA_TEST_DATABASE, adminClient});

        expect(calls.map(c => c[0])).toEqual(['get']); // getDatabase resolved → createDatabase NOT called
        expect(result).toBe(CHROMA_TEST_DATABASE);
    });

    test('ensureChromaTestDatabase creates the database when getDatabase rejects (not-found)', async () => {
        const created     = [];
        const adminClient = {
            getDatabase   : async () => { throw new Error('database not found') },
            createDatabase: async args => { created.push(args) }
        };

        const result = await ensureChromaTestDatabase({
            database: CHROMA_TEST_DATABASE, tenant: 'default_tenant', adminClient
        });

        expect(created).toEqual([{name: CHROMA_TEST_DATABASE, tenant: 'default_tenant'}]);
        expect(result).toBe(CHROMA_TEST_DATABASE);
    });

    test('ensureChromaTestDatabase treats a concurrent already-exists create as success', async () => {
        const calls       = [];
        const adminClient = {
            getDatabase   : async args => { calls.push(['get', args]); throw new Error('database not found') },
            createDatabase: async args => {
                calls.push(['create', args]);
                const error = new Error('The resource already exists');
                error.name = 'ChromaUniqueError';
                throw error
            }
        };

        const result = await ensureChromaTestDatabase({
            database: CHROMA_TEST_DATABASE, tenant: 'default_tenant', adminClient
        });

        expect(calls.map(c => c[0])).toEqual(['get', 'create']);
        expect(result).toBe(CHROMA_TEST_DATABASE);
    });

    test('isChromaAlreadyExistsError detects Chroma duplicate-create signatures', () => {
        const named = new Error('The resource already exists');
        named.name = 'ChromaUniqueError';

        expect(isChromaAlreadyExistsError(named)).toBe(true);
        expect(isChromaAlreadyExistsError(new Error('already exists'))).toBe(true);
        expect(isChromaAlreadyExistsError(new Error('connection refused'))).toBe(false);
    });

    test('ensureChromaTestDatabase rejects when database is missing', async () => {
        await expect(ensureChromaTestDatabase({adminClient: {}})).rejects.toThrow(/`database` is required/);
    });

    test('dropChromaTestDatabase drops the named test database', async () => {
        const deleted     = [];
        const adminClient = {deleteDatabase: async args => { deleted.push(args) }};

        const result = await dropChromaTestDatabase({
            database: CHROMA_TEST_DATABASE, tenant: 'default_tenant', adminClient
        });

        expect(deleted).toEqual([{name: CHROMA_TEST_DATABASE, tenant: 'default_tenant'}]);
        expect(result).toBe(CHROMA_TEST_DATABASE);
    });

    test('dropChromaTestDatabase REFUSES to drop the production database', async () => {
        const deleted     = [];
        const adminClient = {deleteDatabase: async args => { deleted.push(args) }};

        await expect(dropChromaTestDatabase({database: CHROMA_PRODUCTION_DATABASE, adminClient}))
            .rejects.toThrow(/refusing to drop the production database/);

        expect(deleted).toEqual([]); // deleteDatabase must never be reached for default_database
    });

    test('dropChromaTestDatabase rejects when database is missing', async () => {
        await expect(dropChromaTestDatabase({adminClient: {}})).rejects.toThrow(/`database` is required/);
    });
});

/**
 * Coverage for the `#285` surface: three empty `neo-kb-unit-test-*` databases were found sitting
 * inside the PRODUCTION Chroma instance. The generator and the detector of that name shape must not
 * be able to drift apart, the boot refusal must fire on exactly the leak combination and on nothing
 * else, and the enumeration must not truncate.
 */
test.describe('#285 — test-database name shape', () => {
    test('the KB generator and the detector agree by construction', () => {
        // The point of the shared constant: the name the config actually mints is the name the
        // census actually flags. If someone edits one, this fails rather than the census going
        // quietly blind.
        expect(kbChromaTestDatabaseName(3044)).toBe('neo-kb-unit-test-3044');
        expect(isChromaTestDatabaseName(kbChromaTestDatabaseName(3044))).toBe(true);
        expect(isChromaTestDatabaseName(kbChromaTestDatabaseName())).toBe(true);
    });

    test('detects both generated shapes and the three databases actually found in production', () => {
        expect(isChromaTestDatabaseName(CHROMA_TEST_DATABASE)).toBe(true);

        ['neo-kb-unit-test-78286', 'neo-kb-unit-test-15240', 'neo-kb-unit-test-3044'].forEach(name => {
            expect(isChromaTestDatabaseName(name)).toBe(true)
        });
    });

    test('does NOT flag production or look-alike names', () => {
        // The kill matrix. Each of these would make the detector useless in a different way: the
        // first by flagging production itself, the rest by flagging any corpus whose name merely
        // resembles the shape. A prefix-only or substring detector passes the test above and fails
        // every row here.
        [
            CHROMA_PRODUCTION_DATABASE,
            'default_database',
            'neo-kb-unit-test-',            // prefix with no pid
            'neo-kb-unit-test-abc',         // non-numeric suffix
            'neo-kb-unit-test-3044-backup', // trailing content past the pid
            'prod-neo-kb-unit-test-3044',   // shape embedded, not anchored
            'neo-unit-test-2',              // the stable name with a suffix is a different database
            ''
        ].forEach(name => {
            expect(isChromaTestDatabaseName(name), name).toBe(false)
        });

        expect(isChromaTestDatabaseName(undefined)).toBe(false);
        expect(isChromaTestDatabaseName(null)).toBe(false);
        expect(isChromaTestDatabaseName({})).toBe(false);
    });

    test('the prefix is the single authority both sides read', () => {
        expect(kbChromaTestDatabaseName(7).startsWith(KB_CHROMA_TEST_DATABASE_PREFIX)).toBe(true);
    });
});

test.describe('#285 — boot refusal (both directions)', () => {
    const productionCoordinates = {productionHost: 'localhost', productionPort: 8000};

    test('REFUSES a test database resolved against production coordinates', () => {
        // The exact combination measured on `dev`: UNIT_TEST_MODE on, NEO_CHROMA_PORT exported, so
        // the database resolves test-shaped while host/port resolve production.
        expect(() => assertChromaCoordinateCoherence({
            database    : 'neo-kb-unit-test-24521',
            testDatabase: 'neo-kb-unit-test-24521',
            host        : 'localhost',
            port        : 8000,
            ...productionCoordinates
        })).toThrow(/PRODUCTION Chroma instance/);
    });

    test('the refusal names both the database and the resolved coordinates', () => {
        // An operator reading this in a boot log needs to know WHICH database and WHERE, or the
        // message sends them back to re-derive what the process already knew.
        let message = '';

        try {
            assertChromaCoordinateCoherence({
                database    : 'neo-kb-unit-test-999',
                testDatabase: 'neo-kb-unit-test-999',
                host        : 'localhost',
                port        : 8000,
                ...productionCoordinates
            })
        } catch (error) {
            message = error.message
        }

        expect(message).toContain('neo-kb-unit-test-999');
        expect(message).toContain('localhost:8000');
    });

    test('PASSES a test database on test coordinates — the normal unit run', () => {
        expect(() => assertChromaCoordinateCoherence({
            database    : 'neo-kb-unit-test-24521',
            testDatabase: 'neo-kb-unit-test-24521',
            host        : 'localhost',
            port        : 18180,
            ...productionCoordinates
        })).not.toThrow();
    });

    test('PASSES the production database on production coordinates', () => {
        expect(() => assertChromaCoordinateCoherence({
            database    : CHROMA_PRODUCTION_DATABASE,
            testDatabase: 'neo-kb-unit-test-24521',
            host        : 'localhost',
            port        : 8000,
            ...productionCoordinates
        })).not.toThrow();
    });

    test('refuses on a string port — an env-sourced coordinate must not slip past', () => {
        // Leaf types this as a number, but the whole defect class here is an env var arriving where
        // it was not expected. A strict === on the port would let `'8000'` read as "not production".
        expect(() => assertChromaCoordinateCoherence({
            database    : 'neo-kb-unit-test-1',
            testDatabase: 'neo-kb-unit-test-1',
            host        : 'localhost',
            port        : '8000',
            ...productionCoordinates
        })).toThrow(/PRODUCTION Chroma instance/);
    });

    test('host alone does not decide it — hostTest and hostProd share a default', () => {
        // `hostTest` defaults to 'localhost', identical to `hostProd`. If the guard keyed on host it
        // would fire on every ordinary unit run; the port is what discriminates.
        expect(() => assertChromaCoordinateCoherence({
            database    : 'neo-kb-unit-test-1',
            testDatabase: 'neo-kb-unit-test-1',
            host        : 'localhost',
            port        : 18180,
            ...productionCoordinates
        })).not.toThrow();
    });
});

test.describe('#285 — listChromaDatabases pagination', () => {
    test('pages to exhaustion rather than stopping at the default limit', async () => {
        // The trap this exists for: `listDatabases` defaults to limit 100, so an instance holding
        // more than a page would census as exactly one page and still read as complete. A
        // single-call implementation returns 100 here and passes every other test in this file.
        const all = Array.from({length: 250}, (_, i) => ({name: `db-${i}`}));

        const adminClient = {
            listDatabases: async ({limit, offset}) => all.slice(offset, offset + limit)
        };

        const names = await listChromaDatabases({adminClient});

        expect(names).toHaveLength(250);
        expect(names[0]).toBe('db-0');
        expect(names[249]).toBe('db-249');
    });

    test('accepts bare-string entries as well as records', async () => {
        const adminClient = {listDatabases: async () => ['default_database', {name: 'neo-unit-test'}]};

        expect(await listChromaDatabases({adminClient})).toEqual(['default_database', 'neo-unit-test']);
    });

    test('stops cleanly on an empty instance', async () => {
        expect(await listChromaDatabases({adminClient: {listDatabases: async () => []}})).toEqual([]);
    });
});
