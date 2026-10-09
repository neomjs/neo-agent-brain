# Memory Core MCP Server API Design

This guide documents the design of the Memory Core Model Context Protocol (MCP) server for Neo.mjs. This server provides a structured, agent-agnostic interface for AI agents to maintain persistent memory across sessions by exposing a collection of tools.

## Overview

The Memory Core MCP server replaces the retired shell-based memory scripts with a formal set of tools (`add_memory`, `query_raw_memories`, `query_summaries`, and related graph/A2A operations). This provides:

- **Structured Communication**: JSON-based tool calls and responses instead of parsing stdout.
- **Better Error Handling**: Clear error messages within the tool response.
- **Platform Independence**: No shell-specific dependencies.
- **Type Safety**: Tool inputs and outputs are defined by a schema.

## Architecture

The server uses `@modelcontextprotocol/sdk` through Neo's shared MCP server infrastructure, with transport selected by the deployment. The API is defined as a collection of tools in an `openapi.yaml` specification, which provides the single source of truth for the server's capabilities.

### Data Model

The Memory Core manages two primary ChromaDB collections:

#### 1. Memories Collection (`neo-agent-memory`)
Stores authored diary entries for future sessions. The existing fields carry context, a retrospective and continuation:
```json
{
  "id": "mem_2025-10-08T12:00:00.000Z",
  "sessionId": "session_1696800000000",
  "timestamp": "2025-10-08T12:00:00.000Z",
  "prompt": "Summarized task context and constraints",
  "thought": "Authored retrospective of decisions, rationale, lessons and uncertainty",
  "response": "Outcomes, artifact references and continuation",
  "type": "agent-interaction"
}
```

#### 2. Summaries Collection (`neo-agent-sessions`)
Stores high-level session summaries with structured metadata:
```json
{
  "id": "summary_session_1696800000000",
  "sessionId": "session_1696800000000",
  "timestamp": "2025-10-08T12:00:00.000Z",
  "title": "Implement MCP Server Configuration",
  "summary": "Detailed session summary...",
  "category": "feature",
  "memoryCount": 15,
  "quality": 85,
  "productivity": 90,
  "impact": 75,
  "complexity": 60,
  "technologies": ["neo.mjs", "nodejs", "chromadb"]
}
```

### Available Tools

The server exposes the following tools, which are derived from its OpenAPI specification:

| Tool Name | Description |
| :--- | :--- |
| **Health** | |
| `healthcheck` | Confirms the server is running and can connect to the ChromaDB instance. |
| **Diagnostics** | |
| `get_sandman_handoff` | Reads the Sandman handoff (Dream Pipeline morning surface) with freshness metadata (`stale` flag past the window, overridable per call); a missing file returns an explicit null-reason payload. Serves remote/container agents without a repo checkout. |
| **Memories** | |
| `add_memory` | Writes an authored diary entry for future sessions using the existing prompt, thought and response fields. |
| `get_session_memories` | Retrieves all memories for a specific session, in chronological order. |
| `query_raw_memories` | Performs semantic search across all raw memories using vector similarity. |
| **Summaries** | |
| `get_all_summaries` | Retrieves all session summaries, sorted by timestamp. |
| `query_summaries` | Performs semantic search across session summaries. |
| **Sessions** | |
| `summarize_sessions` | Triggers the session summarization process. |
| **Database** | |
| `export_database` | Exports the entire memory database to a JSONL file. |
| `import_database` | Imports a previously exported JSONL file back into the database. |

Database lifecycle is managed outside the MCP tool surface. Agents should use `healthcheck`
to inspect ChromaDB connectivity and the configured topology rather than invoking database
lifecycle commands.

## Tool Specifications

This section details the parameters and behavior of each tool exposed by the Memory Core server.

### Health Tools

#### `healthcheck`
Confirms server health and database connectivity. This tool takes no parameters.

### Memory Tools

#### `add_memory`
Write a newly authored diary entry for future sessions. The reader should be able to recover the
task's intent, understand a consequential choice and its deciding reason, distinguish evidence from
proposals or uncertainty, and continue when the relevant conditions still hold.

Choose what matters and write in your own voice. Preserve useful alternatives, lessons or corrections,
and conditions for revisiting a choice when relevant. Link detailed receipts by stable artifact
references. A routine turn can have a short entry; no fixed length or compulsory decision checklist
is required. The tool's field names, validation, write behavior, session binding and privacy contract
remain the same. Save cadence follows the existing caller protocol.

**Parameters**:
- `prompt` (string, required): Summarized task context, intended outcome and constraints.
- `thought` (string, required): An authored retrospective of decisions, deciding evidence or tradeoffs, lessons and uncertainty.
- `response` (string, required): Outcomes, artifact references and continuation.
- `sessionId` (string, optional): The session ID; when omitted, the existing request-bound `Mcp-Session-Id` header is used when present, otherwise the process's current session is used.

**Worked diary example — a consequential choice:**

This historical example is based on the [release-policy change](https://github.com/neomjs/neo-agent-skills/pull/149)
at `03e403dff85b1f3a78ed9ba56be7ab10b8672739`. Its state is the author's 2026-10-09 source receipt, not a live release claim.

```json
{
  "prompt": "Separate maintainer releases from Dependabot maintenance while retaining validation and human-only merges.",
  "thought": "I chose the exact merged PR's author to classify a release. A human can merge Dependabot, so checking the workflow actor would misclassify the same bot change. Skipping only the pre-merge version check was also insufficient: the post-merge publisher would still run. The version and origin contracts passed, including a human-merged bot control; the actual Acorn8.19 manifests passed a separate source-suite control. These receipts establish source behavior, not the deployed publish exclusion. Revisit if GitHub's author or commit-association contract changes.",
  "response": "Policy PR149 at 03e403d had green CI and awaited cross-family review. Its code and evidence are at https://github.com/neomjs/neo-agent-skills/pull/149. After human merge, rebase PR147, require fresh hosted CI and observe its merge skipping publication and tagging; the same policy must still publish maintainer releases."
}
```

The choice, rejected alternatives and decisive reason are in the entry. The PR carries the full code
and test receipts. A future reader can inspect those artifacts before treating the policy as deployed.

**Simple-turn example — routine review routing:**

This is a historical routing entry from 2026-10-09, before the replacement review was posted.

```json
{
  "prompt": "Reroute the review of https://github.com/neomjs/neo-agent-skills/pull/149 after its reviewer released the seat.",
  "thought": "The previous reviewer reported that no review was posted, which live GitHub confirmed. I retained head 03e403dff85b1f3a78ed9ba56be7ab10b8672739 and requested one replacement reviewer; no code change or new design analysis was needed.",
  "response": "The sole requested reviewer is @neo-fable-clio. PR149 at that unchanged head remains CI green and awaits the review, then a human merge. Recheck the live PR before acting on this dated entry."
}
```

The entry carries the PR reference, exact head and next owner a later session needs, with a dated
state that must be checked live. It does not invent alternative designs for a mechanical handoff.

**Migration from retired CLI**:
- **Old way**: retired shell memory script with prompt flags.
- **New way**: `call_tool('add_memory', {prompt: "...", thought: "...", ...})`

#### `get_session_memories`
Retrieves all memories for a specific session.

**Parameters**:
- `sessionId` (string, required): The session to retrieve memories for.
- `limit` (integer, optional): Maximum memories to return (default: 100).
- `offset` (integer, optional): Pagination offset (default: 0).

#### `query_raw_memories`
Performs semantic search across all memories.

**Parameters**:
- `query` (string, required): The natural language search query.
- `nResults` (integer, optional): Number of results to return (default: 10).
- `sessionId` (string, optional): An optional session ID to scope the search.

**Migration from retired CLI**:
- **Old way**: retired shell memory-query script with query flags.
- **New way**: `call_tool('query_raw_memories', {query: "search query"})`

### Summary Tools

#### `get_all_summaries`
Lists all session summaries with optional filtering.

**Parameters**:
- `limit` (integer, optional): Maximum summaries to return (default: 50).
- `offset` (integer, optional): Pagination offset (default: 0).
- `category` (string, optional): Filter by category (`bugfix`, `feature`, etc.).

#### `query_summaries`
Searches session summaries semantically.

**Parameters**:
- `query` (string, required): The natural language search query.
- `nResults` (integer, optional): Number of results to return (default: 10).
- `category` (string, optional): Filter by category.

### Session Tools

#### `summarize_sessions`
Triggers the session summarization process.

**Parameters**:
- `sessionId` (string, optional): If provided, only this session will be summarized. If omitted, all unsummarized sessions are processed in batch.

**Migration from retired CLI**:
- **Old way**: retired shell summarization script.
- **New way**: `call_tool('summarize_sessions', {})`

### Database Tools

#### `export_database`
Exports the entire memory database to a JSONL file.

**Parameters**:
- `include` (array, optional): Collections to export (`memories`, `summaries`, or both).

**Migration from retired CLI**:
- **Old way**: retired shell export script.
- **New way**: `call_tool('export_database', {})`

#### `import_database`
Imports a previously exported JSONL file.

**Parameters**:
- `file` (string, required): The path to the JSONL backup file.
- `mode` (string, optional): `merge` (default) or `replace`.

**Migration from retired CLI**:
- **Old way**: retired shell import script with a file flag.
- **New way**: `call_tool('import_database', {file: "path/to/file.jsonl"})`

## Error Handling

The server no longer uses HTTP status codes. Instead, errors are communicated within the `CallToolResponse` object. If a tool call fails, the response will have `isError: true` and the `content` will contain a descriptive error message.

**Example Error Response**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "Tool Error: Database connection failed. Message: Could not connect to ChromaDB."
    }
  ],
  "isError": true
}
```

## Implementation Considerations

### Authentication & Authorization
The initial implementation runs locally with no authentication. Future versions should consider:
- API key authentication for remote access
- Rate limiting to prevent abuse
- Role-based access control for multi-user scenarios

### Performance Optimizations
- **Pagination**: Implemented for all list-based tools to handle large datasets.
- **Caching**: Consider caching frequently accessed summaries.
- **Batch Operations**: The `summarize_sessions` tool supports batch mode.
- **Streaming**: Future enhancement for large exports.

### Database Consistency
- **Atomic Operations**: Use transactions where supported by the database.
- **Validation**: Validate all inputs before database operations.
- **Idempotency**: Ensure operations are idempotent where appropriate.

### Monitoring & Logging
- **Health Checks**: The `healthcheck` tool should be monitored periodically.
- **Request Logging**: Memory Core records redacted MCP tool-call telemetry with `tool`, `success`, `duration_ms`, failure stage, bounded error metadata, and payload sizes only.
- **Error Tracking**: Dispatch, policy, and health-gate failures are recorded without raw Memory Core arguments or result JSON.
- **Metrics**: Use `get_memory_core_tool_metrics` for on-demand per-tool call counts, failures, and latency summaries without bloating `healthcheck`.

## OpenAPI Specification

The complete API specification is available in OpenAPI 3.0 format at:
```
ai/mcp/server/memory-core/openapi.yaml
```

This specification can be:
- Used to generate client libraries in multiple languages.
- Imported into API development tools (Postman, Insomnia).
- Used for automated API testing.

## Related Resources

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Agent-Agnostic MCP Configuration](./AgentAgnosticMcpConfig.md)
- [Knowledge Base MCP Server API Design](./KnowledgeBaseMcpApi.md) (coming soon)
- [Strategic AI Workflows](../StrategicWorkflows.md)
