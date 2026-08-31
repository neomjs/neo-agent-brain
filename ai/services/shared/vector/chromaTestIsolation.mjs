/**
 * @summary Stateless helpers for ephemeral ChromaDB database isolation under `UNIT_TEST_MODE`.
 *
 * ## Why this exists
 *
 * Under `UNIT_TEST_MODE` the Memory Core names its Chroma collections `test-memory-*` /
 * `test-session-*` (`config.template.mjs`), but historically they still landed in the SAME
 * `default_tenant`/`default_database` as production. Interrupted runs (`Ctrl-C`, CI-cancel,
 * bare-`npx` bypasses) skip `afterAll` teardown, so orphan collections accumulate in the prod
 * namespace (the 1,281-orphan backlog `purgeTestCollections.mjs` reclaims).
 *
 * This module is the *prevention* half of that isolation: it routes the unit-test
 * Chroma client to a dedicated, droppable test DATABASE so test collections never enter the prod
 * namespace by construction — the chroma analogue of the graph store's `:memory:` isolation.
 * chromadb 3.x exposes no `getOrCreateDatabase`, and database management lives on a separate
 * `AdminClient`, so the test database must be ensured-to-exist before the first collection op and
 * is droppable wholesale.
 *
 * Stateless functions (not a Neo class), matching the `chromaClientPrimitives.mjs` sibling idiom:
 * the chromadb `AdminClient` is lazy-imported and injectable, so this module is cheap to import
 * (config reads only the constants) and the helpers are unit-testable with a fake admin client.
 *
 * @module ai/services/shared/vector/chromaTestIsolation
 * @see ai/services/shared/vector/chromaClientPrimitives.mjs  Sibling: connection-lifecycle helpers
 */

/**
 * The dedicated ChromaDB database used under `UNIT_TEST_MODE`. Stable (not per-run) so the whole
 * namespace is droppable wholesale and a crashed run leaks — at worst — into THIS database, never
 * `default_database`. Single source of truth consumed by `config.template.mjs` (the active
 * `engines.chroma.database` leaf default under `UNIT_TEST_MODE`) and `purgeTestCollections.mjs`
 * (the wholesale-drop target).
 * @type {String}
 */
export const CHROMA_TEST_DATABASE = 'neo-unit-test';

/**
 * The chromadb production database name. Explicitly named so the prod config branch is verbatim
 * (not an implicit client default) and so {@link dropChromaTestDatabase} can refuse to touch it.
 * @type {String}
 */
export const CHROMA_PRODUCTION_DATABASE = 'default_database';

/**
 * The chromadb default tenant. The isolation is at the database grain; the tenant stays default.
 * @type {String}
 */
export const CHROMA_DEFAULT_TENANT = 'default_tenant';

/**
 * The Knowledge Base's per-process test-database prefix. The KB cannot use the stable
 * {@link CHROMA_TEST_DATABASE} because each Playwright worker is a separate process re-evaluating
 * the config module, so `fullyParallel` workers would share one namespace; the pid suffix is what
 * separates them.
 *
 * Declared HERE rather than inline in the KB config because two independent consumers need it and
 * they must not drift: the config's module-scope anchor BUILDS a name from it (§5.5 of ADR 0019 —
 * a leaf default computed before the Provider exists), and the census DETECTS names against it.
 * A detector carrying its own copy of the shape is the failure this constant exists to prevent —
 * the generator moves, the detector keeps reporting clean, and the report reads as a census.
 * @type {String}
 */
export const KB_CHROMA_TEST_DATABASE_PREFIX = 'neo-kb-unit-test-';

/**
 * @summary Builds the Knowledge Base's per-process test-database name. Consumed by the KB config's
 * module-scope anchor, which cannot read a leaf because the Provider does not exist yet.
 * @param {Number|String} [pid=process.pid] The process id to embed.
 * @returns {String}
 */
export function kbChromaTestDatabaseName(pid = process.pid) {
    return `${KB_CHROMA_TEST_DATABASE_PREFIX}${pid}`
}

/**
 * @summary Answers whether a Chroma database name was minted by one of this repository's
 * test-database generators — the predicate the production-instance census flags on.
 *
 * Two shapes, because there are two generators: Memory Core / Tier-1 uses the stable
 * {@link CHROMA_TEST_DATABASE}, and the Knowledge Base uses {@link kbChromaTestDatabaseName}.
 *
 * **Bound, stated rather than papered over:** this recognises the *generated* shapes only. Both
 * names are also env-overridable (`NEO_CHROMA_DATABASE_TEST`, `NEO_KB_CHROMA_DATABASE_TEST`), so a
 * run that overrode either one to an arbitrary string leaks a database this predicate cannot
 * recognise. The census reports that limit in its own output instead of letting a clean result be
 * read as "no test databases exist" — an unrecognised name is outside the instrument, not absent.
 * @param {String} name
 * @returns {Boolean}
 */
export function isChromaTestDatabaseName(name) {
    if (typeof name !== 'string') {
        return false
    }

    return name === CHROMA_TEST_DATABASE ||
        new RegExp(`^${KB_CHROMA_TEST_DATABASE_PREFIX}\\d+$`).test(name)
}

/**
 * The loopback host spellings that name one endpoint. `127.0.0.0/8` is matched by pattern rather
 * than enumerated, since every address in it loops back.
 * @type {Set<String>}
 */
const CHROMA_LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

/**
 * @summary Answers whether two host spellings address the SAME Chroma endpoint.
 *
 * String equality is not endpoint identity: `localhost`, `127.0.0.1` and `::1` all reach one
 * listener, so a guard comparing hosts as bytes reads `127.0.0.1:8000` and `localhost:8000` as two
 * instances and allows exactly the write it exists to refuse (#286 RA-3). Only the loopback family
 * is normalised — resolving arbitrary names would need DNS, which a boot-path guard must not do.
 *
 * The port is deliberately NOT folded in here: it stays the discriminating coordinate, so widening
 * host identity cannot make an ordinary test instance on `127.0.0.1:18180` read as production.
 * @param {String} host
 * @param {String} otherHost
 * @returns {Boolean}
 */
export function isSameChromaHost(host, otherHost) {
    const normalize = value => {
        const normalized = String(value ?? '').trim().toLowerCase().replace(/^\[|]$/g, '').replace(/\.$/, '');

        return CHROMA_LOOPBACK_HOSTS.has(normalized) || /^127(\.\d{1,3}){3}$/.test(normalized) ? 'localhost' : normalized
    };

    return normalize(host) === normalize(otherHost)
}

/**
 * @summary Refuses a client whose resolved database is test-shaped while its resolved coordinates
 * are the production ones. Throws, or returns silently.
 *
 * ## Why this refuses instead of warning
 *
 * This combination is not a degraded mode that can still do useful work — it is a client about to
 * write a test-named database into whatever store the production leaves resolve to. That is the
 * shape of the three empty `neo-kb-unit-test-*` databases found in the local agent-OS instance
 * (`#285`); this module refuses the pairing that produces them and does not claim to have found
 * what minted those three. A warning on this path produces the store mutation anyway and a log line
 * nobody reads until a census runs by hand.
 *
 * ## Why the coordinates are compared to PRODUCTION, not to the test coordinates
 *
 * Because `hostTest` defaults to `'localhost'` — byte-identical to `hostProd`. Asking "are these the
 * test coordinates?" answers yes for a production host under the default, so the test would pass
 * exactly when it needed to fail. Asking "are these the production coordinates?" is the question
 * with a discriminating answer, and the port is what carries it (8000 vs 18180).
 *
 * The divergence is reachable from ordinary configuration: the KB server's `host`/`port` leaves bind
 * to `NEO_CHROMA_HOST` / `NEO_CHROMA_PORT` — the PRODUCTION variables — while `chromaDatabase`
 * resolves independently from `UNIT_TEST_MODE`. Exporting a production coordinate var during a test
 * run separates them, with no `_TEST` variable involved anywhere.
 * @param {Object} options
 * @param {String} options.database       The resolved database name.
 * @param {String} options.testDatabase   The resolved test-database name for this server.
 * @param {String} options.host           The resolved host.
 * @param {Number} options.port           The resolved port.
 * @param {String} options.productionHost The resolved production host.
 * @param {Number} options.productionPort The resolved production port.
 * @param {String} [options.serverName='knowledge-base'] Named in the error so the message points at a process.
 * @returns {void}
 * @throws {Error} When a test-shaped database is paired with production coordinates.
 */
export function assertChromaCoordinateCoherence({database, testDatabase, host, port, productionHost, productionPort, serverName = 'knowledge-base'} = {}) {
    const
        isTestDatabase       = database === testDatabase || isChromaTestDatabaseName(database),
        // Loose port comparison: the leaf types these as numbers, but an env-sourced value that
        // reached here as a string must not read as "different coordinates" and pass the guard.
        // The host goes through endpoint identity, not byte equality, for the same reason.
        isProductionHostPort = isSameChromaHost(host, productionHost) && Number(port) === Number(productionPort);

    if (isTestDatabase && isProductionHostPort) {
        throw new Error(
            `Refusing to start the ${serverName} Chroma client: the resolved database "${database}" is ` +
            `test-shaped, but the resolved coordinates ${host}:${port} are the PRODUCTION Chroma instance ` +
            `(configured as ${productionHost}:${productionPort} — the same endpoint). ` +
            'Writing there would create a test-named database inside the production store (#285). ' +
            'Most likely NEO_CHROMA_HOST or NEO_CHROMA_PORT is exported while a test selector ' +
            '(UNIT_TEST_MODE / NEO_TEST_CONFIG_TEMPLATES) is on — those are the production coordinate ' +
            'variables and they override the test-resolved default.'
        );
    }
}

/**
 * @summary Lazily constructs a chromadb `AdminClient`. Database/tenant management lives off the
 * `ChromaClient`, so callers that only need collection ops never pay for this import. The lazy
 * import is also what keeps this module cheap for `config.template.mjs` to import (constants only).
 * @param {Object} options
 * @param {String} options.host
 * @param {Number} options.port
 * @param {Boolean} [options.ssl=false]
 * @returns {Promise<Object>} A chromadb `AdminClient` instance.
 */
async function createAdminClient({host, port, ssl = false}) {
    const {AdminClient} = await import('chromadb');
    return new AdminClient({host, port, ssl})
}

/**
 * @summary Detects Chroma's "already exists" response for concurrent createDatabase calls.
 *
 * Fully parallel unit workers can all race through `getDatabase` before any one creates the
 * stable test database. The first create wins; the rest receive `ChromaUniqueError`. That is a
 * successful ensure outcome, not a boot failure.
 * @param {Error} error
 * @returns {Boolean}
 */
export function isChromaAlreadyExistsError(error) {
    return error?.name === 'ChromaUniqueError' || /resource already exists|already exists/i.test(error?.message || '')
}

/**
 * @summary Ensures the unit-test Chroma database exists before the first collection op. chromadb
 * 3.x has no `getOrCreateDatabase`, so this is `getDatabase` → catch → `createDatabase`. Idempotent;
 * safe to call on every connect.
 * @param {Object} options
 * @param {String} options.host
 * @param {Number} options.port
 * @param {Boolean} [options.ssl=false]
 * @param {String} options.database                     The test database name (e.g. {@link CHROMA_TEST_DATABASE}).
 * @param {String} [options.tenant=CHROMA_DEFAULT_TENANT]
 * @param {Object} [options.adminClient]                Injected `AdminClient` seam for unit tests.
 * @returns {Promise<String>} The ensured database name.
 * @throws {Error} When `database` is falsy.
 */
export async function ensureChromaTestDatabase({host, port, ssl = false, database, tenant = CHROMA_DEFAULT_TENANT, adminClient} = {}) {
    if (!database) {
        throw new Error('ensureChromaTestDatabase: `database` is required');
    }

    const admin = adminClient || await createAdminClient({host, port, ssl});

    try {
        await admin.getDatabase({name: database, tenant})
    } catch {
        try {
            await admin.createDatabase({name: database, tenant})
        } catch (error) {
            if (!isChromaAlreadyExistsError(error)) {
                throw error
            }
        }
    }

    return database
}

/**
 * @summary Drops the unit-test Chroma database wholesale — the prevention-era cleanup that
 * supersedes enumerating `test-*` collection names. REFUSES to drop {@link CHROMA_PRODUCTION_DATABASE}
 * (defense-in-depth), so a misconfigured caller can never wipe production.
 * @param {Object} options
 * @param {String} options.host
 * @param {Number} options.port
 * @param {Boolean} [options.ssl=false]
 * @param {String} options.database
 * @param {String} [options.tenant=CHROMA_DEFAULT_TENANT]
 * @param {Object} [options.adminClient]                Injected `AdminClient` seam for unit tests.
 * @returns {Promise<String>} The dropped database name.
 * @throws {Error} When `database` is falsy or is the production database.
 */
export async function dropChromaTestDatabase({host, port, ssl = false, database, tenant = CHROMA_DEFAULT_TENANT, adminClient} = {}) {
    if (!database) {
        throw new Error('dropChromaTestDatabase: `database` is required');
    }

    if (database === CHROMA_PRODUCTION_DATABASE) {
        throw new Error(`dropChromaTestDatabase: refusing to drop the production database "${database}"`);
    }

    const admin = adminClient || await createAdminClient({host, port, ssl});

    await admin.deleteDatabase({name: database, tenant});

    return database
}

/**
 * @summary Describes an unexpected value for a diagnostic message — enough to identify a moved API
 * shape without serialising a payload of unknown size.
 * @param {*} value
 * @returns {String}
 */
function describeChromaEntry(value) {
    if (value === null) {
        return 'null'
    }

    if (Array.isArray(value)) {
        return `an array of ${value.length}`
    }

    if (typeof value === 'object') {
        return `an object with keys [${Object.keys(value).join(', ')}]`
    }

    return `${typeof value} ${JSON.stringify(value)}`
}

/**
 * @summary Extracts one database name from a listing row, REFUSING any row it does not recognise.
 *
 * Fails closed on purpose. The tolerant form — `entry?.name` behind a `.filter(Boolean)` — turns a
 * moved chromadb response shape into an empty census that reads exactly like a clean instance, which
 * is the failure the census exists to detect (#286 RA-4). An unrecognised row is missing evidence,
 * never evidence of absence.
 * @param {String|Object} entry
 * @param {Number} index Absolute listing index, so the diagnostic points at a row.
 * @returns {String}
 * @throws {Error} When the row is not a bare string or a record carrying a non-blank `name`.
 */
function chromaDatabaseNameOf(entry, index) {
    // chromadb returns database records; older shapes returned bare strings. Both are supported —
    // anything else is an API this function has not been taught to read.
    const name = typeof entry === 'string' ? entry : entry?.name;

    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(
            `listChromaDatabases: unrecognised database row at index ${index} — received ` +
            `${describeChromaEntry(entry)}, expected a name string or a record with a non-blank \`name\`. ` +
            'Refusing to census a shape this function cannot read, because dropping the row would ' +
            'report a leaked test database as absent.'
        )
    }

    return name
}

/**
 * @summary Enumerates EVERY database in a Chroma instance, paginating to exhaustion. Read-only.
 *
 * Pagination is the load-bearing part, not a detail. `AdminClient#listDatabases` defaults to
 * `limit: 100`, and a single call returning 100 names is indistinguishable from an instance that
 * holds exactly 100 — so a census built on one call silently truncates and still reads as complete.
 * This pages until a short page proves the end.
 *
 * The `pageSize` is deliberately not exposed as a knob on the census CLI: it changes only how many
 * round-trips the same total answer costs, and a caller who lowered it could not tell from the
 * output that they had.
 * @param {Object} options
 * @param {String} options.host
 * @param {Number} options.port
 * @param {Boolean} [options.ssl=false]
 * @param {String} [options.tenant=CHROMA_DEFAULT_TENANT]
 * @param {Number} [options.pageSize=100]
 * @param {Object} [options.adminClient] Injected `AdminClient` seam for unit tests.
 * @returns {Promise<String[]>} Every database name in the tenant, in listing order.
 * @throws {Error} When a page is not an array, or a row is not a shape this function can read. It
 * fails closed rather than dropping the row: a silently skipped entry would report a leaked test
 * database as absent, which is the exact conclusion this census exists to make trustworthy.
 */
export async function listChromaDatabases({host, port, ssl = false, tenant = CHROMA_DEFAULT_TENANT, pageSize = 100, adminClient} = {}) {
    const
        admin = adminClient || await createAdminClient({host, port, ssl}),
        names = [];

    let offset = 0;

    while (true) {
        const page = await admin.listDatabases({tenant, limit: pageSize, offset});

        if (!Array.isArray(page)) {
            throw new Error(
                `listChromaDatabases: AdminClient#listDatabases returned ${describeChromaEntry(page)} instead of ` +
                'an array at offset ' + offset + '. The census cannot report a complete result it did not read.'
            )
        }

        if (page.length === 0) {
            break
        }

        names.push(...page.map((entry, index) => chromaDatabaseNameOf(entry, offset + index)));

        if (page.length < pageSize) {
            break
        }

        offset += pageSize
    }

    return names
}
