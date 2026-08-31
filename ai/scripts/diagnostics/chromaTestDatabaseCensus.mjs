#!/usr/bin/env node
/**
 * @module ai/scripts/diagnostics/chromaTestDatabaseCensus
 * @summary Enumerates EVERY database in a Chroma instance and flags the ones a test-database
 * generator minted. Read-only: it lists and reports, and the only file it writes is the `--json`
 * report path when one is supplied. It never creates, drops, or mutates a database or collection.
 *
 * ## Why this script exists
 *
 * Three empty `neo-kb-unit-test-*` databases were found sitting beside `default_database` in the
 * local agent-OS Chroma instance (`neo-local-agent-os-chroma-1`, `#285`) — by hand, during an
 * unrelated investigation, and they would not have been found otherwise. The residue was harmless;
 * the absence of any layer that NOTICES was not. This is that layer.
 *
 * ## Why it censuses every database rather than the configured one
 *
 * A census that inherits the configured database can only ever see inside `default_database`, and
 * the leak IS a database sitting beside it. Scoping to the configured coordinates is precisely the
 * blind spot that hid this, so this script goes to the tenant and enumerates — and the enumeration
 * pages to exhaustion, because `listDatabases` defaults to `limit: 100` and one short read of a
 * large instance is indistinguishable from a complete one.
 *
 * ## What a clean result does and does not mean
 *
 * Clean means: no database in this tenant matches a name shape this repository's generators
 * produce. Both test-database names are also env-overridable (`NEO_CHROMA_DATABASE_TEST`,
 * `NEO_KB_CHROMA_DATABASE_TEST`), so a run that overrode either to an arbitrary string leaks a
 * database no detector keyed on the generated shape can recognise. The report states that bound in
 * its own output rather than letting "no matches" be read as "no test databases" — an unrecognised
 * name is outside the instrument, not absent.
 *
 * Clean is also scoped to the ONE instance the run reached. The defaults resolve to whatever the
 * production leaves point at, which on a developer host is the local agent-OS container above
 * (`127.0.0.1:8000`). The cloud-plane Chroma publishes no host port, so a host-edge run cannot open
 * it at all and a `leaked = 0` here carries no statement about that store. Name the instance a
 * result belongs to before reading it as coverage.
 *
 * Exit code is the point of the script, not a courtesy: `1` when leaked databases are present, so a
 * scheduled run surfaces without anyone reading the output. `--allow-leaks` reports and exits `0`
 * for the case where the disposition is already known and the operator only wants the listing.
 *
 * Usage:
 *   node ai/scripts/diagnostics/chromaTestDatabaseCensus.mjs
 *   node ai/scripts/diagnostics/chromaTestDatabaseCensus.mjs --host localhost --port 8000
 *   node ai/scripts/diagnostics/chromaTestDatabaseCensus.mjs --json <path>
 *   node ai/scripts/diagnostics/chromaTestDatabaseCensus.mjs --allow-leaks
 */

// The Neo class system first: every `ai/services/**` and `ai/mcp/**` module is a `Neo.setupClass`
// class and `ai/Env.mjs` gatekeeps at module scope, so a config import before this line throws
// `ReferenceError: Neo is not defined`. The idiom every service-touching `ai/scripts/**` file uses.
import Neo from 'neo.mjs/src/Neo.mjs';
import      'neo.mjs/src/core/_export.mjs';

import {Command}                 from 'commander';
import aiConfig                  from '../../mcp/server/knowledge-base/config.mjs';
import fs                        from 'fs-extra';
import {
    CHROMA_DEFAULT_TENANT,
    isChromaTestDatabaseName,
    listChromaDatabases
}                                from '../../services/shared/vector/chromaTestIsolation.mjs';

/**
 * @summary Builds the CLI surface. A fresh `Command` per call so unit tests get isolation, and
 * Commander owns help, defaults, unknown-option rejection and missing-value rejection (ADR 0016).
 *
 * Coordinates default to the resolved PRODUCTION leaves rather than to `host`/`port`. Those two
 * resolve to the test instance under a test selector, and a census that followed them would
 * cheerfully report the unit harness clean while never once looking at the store the leaked
 * databases sit in.
 * @returns {Command}
 */
export function createProgram() {
    return new Command()
        .name('chromaTestDatabaseCensus')
        .description('Lists every Chroma database in a tenant and flags test-generated ones. Read-only.')
        .option('--host <host>', 'Chroma host', aiConfig.engines.chroma.hostProd)
        .option('--port <port>', 'Chroma port', String(aiConfig.engines.chroma.portProd))
        .option('--tenant <tenant>', 'Chroma tenant', CHROMA_DEFAULT_TENANT)
        .option('--json <path>', 'Also write the census as JSON to this path')
        .option('--allow-leaks', 'Report leaked databases but still exit 0', false)
        .allowExcessArguments(false);
}

/**
 * @summary Splits an enumerated database list into leaked and retained sets.
 *
 * Pure and exported so the detection can be tested against a known population without a live Chroma
 * — the red control the ticket asks for runs here, not against a live instance.
 * @param {String[]} databases Every database name in the tenant.
 * @returns {{databases: String[], leaked: String[], clean: String[], total: Number}}
 */
export function foldChromaDatabaseCensus(databases) {
    const leaked = databases.filter(isChromaTestDatabaseName);

    return {
        databases,
        leaked,
        clean: databases.filter(name => !isChromaTestDatabaseName(name)),
        total: databases.length
    }
}

/**
 * @summary Renders the census for a terminal reader.
 * @param {Object} census
 * @param {Object} coordinates
 * @returns {String}
 */
export function formatChromaDatabaseCensus(census, {host, port, tenant}) {
    const lines = [
        `# chroma test-database census`,
        `instance = ${host}:${port}  tenant = ${tenant}`,
        `databases = ${census.total}  leaked = ${census.leaked.length}`,
        ''
    ];

    census.databases.forEach(name => {
        lines.push(`${isChromaTestDatabaseName(name) ? 'LEAKED ' : '       '}${name}`)
    });

    lines.push('');

    if (census.leaked.length > 0) {
        lines.push(
            `${census.leaked.length} test-generated database(s) inside this instance.`,
            'Removal is operator-gated — this script never drops anything.'
        )
    } else {
        lines.push('No database matches a generated test-database name shape.')
    }

    // Stated on BOTH branches deliberately. On the clean branch it is the bound that stops the
    // result reading as "no test databases exist"; on the leaked branch it is the reason the count
    // is a floor rather than a total.
    lines.push(
        'Bound: recognises generated shapes only. NEO_CHROMA_DATABASE_TEST / NEO_KB_CHROMA_DATABASE_TEST',
        'can override either name to an arbitrary string, which no shape-keyed detector can see.'
    );

    return lines.join('\n')
}

/**
 * @summary Runs the census and reports. Returns the process exit code rather than calling
 * `process.exit`, so the behaviour is testable.
 * @param {String[]} [argv=process.argv]
 * @returns {Promise<Number>}
 */
export async function main(argv = process.argv) {
    const
        program = createProgram().parse(argv),
        options = program.opts(),
        host    = options.host,
        port    = Number(options.port),
        tenant  = options.tenant,
        census  = foldChromaDatabaseCensus(await listChromaDatabases({host, port, tenant}));

    console.log(formatChromaDatabaseCensus(census, {host, port, tenant}));

    if (options.json) {
        await fs.outputJson(options.json, {...census, host, port, tenant}, {spaces: 2});
        console.log(`\nJSON written to ${options.json}`)
    }

    return census.leaked.length > 0 && !options.allowLeaks ? 1 : 0
}

// `process.argv[1]` is the SYMLINK path when a script is invoked through one, while
// `import.meta.url` is the resolved realpath — comparing them directly makes a symlinked entrypoint
// load its module and silently never run `main`, exiting 0. Compare against the realpath.
if (process.argv[1] && (await fs.realpath(process.argv[1])) === (await fs.realpath(new URL(import.meta.url).pathname))) {
    process.exitCode = await main()
}
