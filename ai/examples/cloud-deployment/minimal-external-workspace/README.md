# Minimal External Workspace — Cloud-Native KB Ingestion

A worked non-Neo workspace whose `.proto` schema files are indexed into the Knowledge Base. It demonstrates legacy full-corpus extraction, push-mode parsing, and the profile-based pull route. See the [`cloud-deployment/`](../../../learn/agentos/cloud-deployment/Overview.md) guide tree.

## Layout

| Path | Role |
|---|---|
| `package.json` | Declares `neo.mjs` as a dependency — the external-workspace shape (`npx neo app`-style). |
| `proto/example.proto` | Sample content — a Protobuf schema with two messages and a service. |
| `src/ProtoParser.mjs` | Custom **Parser** — `parseIngestionFile()` turns a `.proto` file into `parsed-chunk-v1` records (the push path). See [Custom Parsers](../../../learn/agentos/cloud-deployment/CustomParsers.md). |
| `src/ProtoSource.mjs` | Custom **Source** — `extract()` indexes the `proto/` tree in the full-corpus build. See [Custom Sources](../../../learn/agentos/cloud-deployment/CustomSources.md). |

## Registering the custom classes

A KB deployment registers them through its `aiConfig` (see [Configuration](../../../learn/agentos/cloud-deployment/Configuration.md)) — in `config.mjs`:

```js
import ProtoParser from './src/ProtoParser.mjs';
import ProtoSource from './src/ProtoSource.mjs';

customParsers : [{ParserClass: ProtoParser, parserId: 'proto'}],
customSources : [{SourceClass: ProtoSource, sourceName: 'ProtoSource'}],
sourcePaths   : {ProtoSource: '<absolute path to this workspace>/proto'}
```

…or programmatically — `SourceRegistry.registerParser(ProtoParser, {parserId: 'proto'})`
and `SourceRegistry.registerSource(ProtoSource, {sourceName: 'ProtoSource'})`.

The programmatic `SourceRegistry` form above is a **legacy full-corpus compatibility surface**. It stays operational while the extract-all builder exists, but repository-profile execution does not consult it and tenant-declared extractors must never enter the process singleton.

For pull mode, mount `ProtoParser.mjs` below the deployment's read-only `tenantParserRoot`, then keep the parser declaration and repository route in tenant config:

```yaml
tenants:
  example-tenant:
    customParsers:
      - parserId: proto
        parserModule: ProtoParser.mjs
    tenantRepos:
      - repoSlug: example-org/proto-workspace
        cloneUrl: https://github.com/example-org/proto-workspace.git
        credentialRef: none
        branchRef: main
        extractionProfile:
          profileSchemaVersion: 1
          routes:
            - territory:
                roots: [proto]
                include: ['**/*.proto']
                exclude: []
              extractorId: ParserSource
              options:
                parserId: proto
                parserVersion: 1.0.0
          fallback:
            action: exclude
```

`ParserSource` executes the declared parser through the tenant-local resolver and fails closed if it cannot load or dispatch. The profile, parser version, and descriptor version participate in extraction identity, so changing any of them forces a full materialization even when the repository SHA is unchanged.

## Smoke test

Push `proto/example.proto` through the bulk facade. With no `parserId` on the record,
`KnowledgeBaseIngestionService.resolveFileChunks` applies its `raw-text` fallback — the
file ingests as a single whole-file chunk; no server-side registration is needed:

```bash
npm install
export NEO_AGENTOS_RUNTIME_ROOT=/absolute/path/to/neo-agent-brain
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({sourcePath:"proto/example.proto",content:fs.readFileSync("proto/example.proto","utf8")})+"\n")' \
  | node "$NEO_AGENTOS_RUNTIME_ROOT/ai/scripts/maintenance/ingestTenant.mjs" example-tenant --from-stdin
```

A successful run prints a JSON summary — `{ingested, embeddingsGenerated, deleted, ...}`,
and the chunk is scoped to the `example-tenant` tenant.

To chunk *per protobuf message* instead, register `ProtoParser` (see above) and add
`parserId: "proto"` to the record — `resolveFileChunks` then dispatches to it rather
than the `raw-text` fallback:

```bash
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({sourcePath:"proto/example.proto",content:fs.readFileSync("proto/example.proto","utf8"),parserId:"proto"})+"\n")' \
  | node "$NEO_AGENTOS_RUNTIME_ROOT/ai/scripts/maintenance/ingestTenant.mjs" example-tenant --from-stdin
```
