import {test, expect}  from '@playwright/test';
import {execFileSync}  from 'node:child_process';
import {
    assertChromaCoordinateCoherence,
    CHROMA_PRODUCTION_DATABASE,
    CHROMA_TEST_DATABASE,
    dropChromaTestDatabase,
    ensureChromaTestDatabase,
    isChromaAlreadyExistsError,
    isChromaTestDatabaseName,
    isSameChromaHost,
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

test.describe('#286 RA-3 — endpoint identity is not host-string identity', () => {
    const productionCoordinates = {productionHost: 'localhost', productionPort: 8000};

    const testDatabaseArm = overrides => () => assertChromaCoordinateCoherence({
        database    : 'neo-kb-unit-test-24521',
        testDatabase: 'neo-kb-unit-test-24521',
        ...productionCoordinates,
        ...overrides
    });

    // Reviewer-resolved on the live host: both `localhost:8000` and `127.0.0.1:8000` answer at
    // /api/v2/heartbeat. A guard comparing hosts as bytes reads them as two instances and allows the
    // write it exists to refuse — the config arm `--unit + NEO_CHROMA_HOST_TEST=127.0.0.1 +
    // NEO_CHROMA_PORT_TEST=8000` resolves exactly this and reported ALLOWED before this fix.
    for (const host of ['127.0.0.1', '::1', '[::1]', 'LocalHost', 'localhost.', '127.0.0.53']) {
        test(`REFUSES the alias-equivalent production coordinate ${host}:8000`, () => {
            expect(testDatabaseArm({host, port: 8000})).toThrow(/PRODUCTION Chroma instance/);
        });
    }

    test('the refusal names the production spelling too, not just the resolved one', () => {
        // An operator who sees only "127.0.0.1:8000 is production" has to re-derive why; the message
        // has to close the gap it just widened.
        let message = '';

        try {
            testDatabaseArm({host: '127.0.0.1', port: 8000})()
        } catch (error) {
            message = error.message
        }

        expect(message).toContain('127.0.0.1:8000');
        expect(message).toContain('localhost:8000');
    });

    // Pinned controls: widening host identity must not widen the refusal. The port stays the
    // discriminating coordinate, and a non-test database is never refused at all.
    test('PASSES the ordinary test instance on a loopback alias — 127.0.0.1:18180', () => {
        expect(testDatabaseArm({host: '127.0.0.1', port: 18180})).not.toThrow();
    });

    test('PASSES the production database reached through a loopback alias', () => {
        expect(() => assertChromaCoordinateCoherence({
            database    : CHROMA_PRODUCTION_DATABASE,
            testDatabase: 'neo-kb-unit-test-24521',
            host        : '127.0.0.1',
            port        : 8000,
            ...productionCoordinates
        })).not.toThrow();
    });

    test('PASSES a genuinely different host on the production port', () => {
        expect(testDatabaseArm({host: 'chroma.internal', port: 8000})).not.toThrow();
    });

    test('isSameChromaHost normalises the loopback family and nothing else', () => {
        expect(isSameChromaHost('127.0.0.1', 'localhost')).toBe(true);
        expect(isSameChromaHost('::1',       'localhost')).toBe(true);
        expect(isSameChromaHost('127.0.0.2', '127.0.0.1')).toBe(true);
        // No DNS on a boot path: names that may or may not resolve to the same listener stay distinct.
        expect(isSameChromaHost('example.com',     'localhost')).toBe(false);
        expect(isSameChromaHost('chroma.internal', '127.0.0.1')).toBe(false);
        expect(isSameChromaHost('10.0.0.1',        'localhost')).toBe(false);
    });
});

test.describe('#286 RA-3 — the same refusal, reached through actual config resolution', () => {
    // Every arm above hands the guard its coordinates, so it can only confirm the guard's own
    // arithmetic. The incident #285 records was produced by CONFIG: a test selector resolved a
    // test-shaped database while the coordinates resolved to the production instance. So the arm
    // that carries the claim runs the real provider hierarchy and lets `ChromaManager.construct`
    // decide, with nothing hand-fed but the environment.
    //
    // A child process, not an in-process provider: leaves read the environment at resolution time,
    // and a test may not mutate the shared `aiConfig` singleton to change what they read. Resolving
    // a different environment therefore means a different process.
    //
    // `ChromaManager` is a singleton, so the import itself constructs it — and the guard sits before
    // `new ChromaClient`, which is why this reaches a verdict without a Chroma server or a socket.
    const CONSTRUCT_SCRIPT = `
        import 'neo.mjs/src/Neo.mjs';

        // The COMMITTED template, never the gitignored config.mjs overlay -- ADR-0019 C3, and the
        // same ordering every other KB spec uses: seed the canonical config before anything
        // resolves the singleton. Reading the overlay made this witness checkout-dependent: a local
        // data.host override turned the same script from REFUSED into ALLOWED with a socket
        // attempt, so the arm proved whatever the running machine happened to have on disk.
        //
        // No backticks in here: this whole script is a template literal, and one terminates it.
        const {default: kbConfig} = await import('./ai/mcp/server/knowledge-base/config.template.mjs');

        console.log('RESOLVED='   + kbConfig.host + ':' + kbConfig.port);
        console.log('PRODUCTION=' + kbConfig.engines.chroma.hostProd + ':' + kbConfig.engines.chroma.portProd);
        console.log('DATABASE='   + kbConfig.chromaDatabase);

        try {
            await import('./ai/services/knowledge-base/ChromaManager.mjs');
            console.log('OUTCOME=ALLOWED')
        } catch (error) {
            console.log('OUTCOME=REFUSED')
        }
    `;

    /**
     * Resolves the Knowledge Base config in a fresh process under `overrides` and reports what
     * `ChromaManager`'s constructor did with it.
     * @param {Object} overrides Environment applied on top of `UNIT_TEST_MODE`.
     * @returns {String} The child's stdout, carrying RESOLVED / PRODUCTION / DATABASE / OUTCOME.
     */
    const resolveAndConstruct = overrides => {
        const env = {...process.env, UNIT_TEST_MODE: 'true', ...overrides};

        // The production coordinate variables are UNSET here rather than set, and that is the whole
        // arm. `NEO_CHROMA_HOST` / `NEO_CHROMA_PORT` are re-bound by the KB child leaves (the
        // duplicate producer #288 owns), so exporting them resolves `host` straight from the
        // production binding — the refusal then fires on two byte-identical host strings and proves
        // nothing about endpoint identity. Measured: with `NEO_CHROMA_HOST=localhost` exported, this
        // same arm resolves `localhost:8000` and refuses for that unrelated reason. Unset, the
        // production side falls to its declared Tier-1 defaults and the test coordinate is the only
        // thing the environment supplies — which is what makes `127.0.0.1` vs `localhost` the
        // discriminating difference. The child prints both sides rather than letting either be
        // assumed.
        delete env.NEO_CHROMA_HOST;
        delete env.NEO_CHROMA_PORT;

        return execFileSync(process.execPath, ['--input-type=module', '-e', CONSTRUCT_SCRIPT], {
            cwd     : process.cwd(),
            encoding: 'utf8',
            env
        })
    };

    test('REFUSES the config-resolved alias arm — NEO_CHROMA_HOST_TEST=127.0.0.1 on the production port', () => {
        const output = resolveAndConstruct({NEO_CHROMA_HOST_TEST: '127.0.0.1', NEO_CHROMA_PORT_TEST: '8000'});

        // Read the resolution before the verdict: a refusal on coordinates that never resolved as
        // intended would be the same green for a different reason.
        expect(output).toContain('RESOLVED=127.0.0.1:8000');
        expect(output).toContain('PRODUCTION=localhost:8000');
        expect(output).toMatch(/DATABASE=neo-kb-unit-test-\d+/);
        expect(output).toContain('OUTCOME=REFUSED')
    });

    test('ALLOWS the ordinary test coordinate through the same path — 127.0.0.1:18180', () => {
        // Non-vacuity: without this, a child that failed to boot for any reason would read as a
        // refusal, and the arm above would pass on a broken harness.
        const output = resolveAndConstruct({NEO_CHROMA_HOST_TEST: '127.0.0.1', NEO_CHROMA_PORT_TEST: '18180'});

        expect(output).toContain('RESOLVED=127.0.0.1:18180');
        expect(output).toContain('PRODUCTION=localhost:8000');
        expect(output).toContain('OUTCOME=ALLOWED')
    });
});

test.describe('#286 RA-4 — the census fails closed on a row it cannot read', () => {
    // The failure this guards: `entry?.name` behind a `.filter(Boolean)` turns a moved chromadb
    // response shape into an EMPTY census, which reads exactly like a clean production instance.
    // A leaked test database would then be reported as absent. Missing evidence is not absence.
    const refuses = adminClient => expect(listChromaDatabases({adminClient})).rejects.toThrow();

    test('REFUSES a record whose name lives under an unrecognised key', async () => {
        // Reviewer falsifier: returned [] silently before this fix.
        await expect(listChromaDatabases({
            adminClient: {listDatabases: async () => [{database_name: 'neo-kb-unit-test-123'}]}
        })).rejects.toThrow(/unrecognised database row at index 0/);
    });

    test('the diagnostic names the keys it actually received', async () => {
        // Without the observed shape, a maintainer cannot tell an API move from a broken fake.
        await expect(listChromaDatabases({
            adminClient: {listDatabases: async () => [{database_name: 'x', id: '1'}]}
        })).rejects.toThrow(/keys \[database_name, id\]/);
    });

    test('REFUSES a page that is not an array', async () => {
        await refuses({listDatabases: async () => ({databases: ['neo-unit-test']})});
    });

    test('REFUSES a blank name', async () => {
        await refuses({listDatabases: async () => [{name: '   '}]});
    });

    test('REFUSES a null row', async () => {
        await refuses({listDatabases: async () => [null]});
    });

    test('refuses on a later page too — not just the first', async () => {
        // The census pages to exhaustion; a shape change that only appears past page 1 is the same
        // false-clean, and an index that restarted per page could not point at the row.
        const adminClient = {
            listDatabases: async ({offset}) => offset === 0
                ? Array.from({length: 100}, (_, i) => ({name: `db-${i}`}))
                : [{database_name: 'neo-unit-test'}]
        };

        await expect(listChromaDatabases({adminClient})).rejects.toThrow(/row at index 100/);
    });
});
