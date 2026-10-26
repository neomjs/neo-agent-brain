import BaseServer              from '../BaseServer.mjs';
import aiConfig                from './config.mjs';
import logger                  from './logger.mjs';
import ConnectionService       from '../../../services/neural-link/ConnectionService.mjs';
import HealthService           from '../../../services/neural-link/HealthService.mjs';
import {listTools, callTool}   from './toolService.mjs';
import {attestDiagnosticPaths} from './diagnosticPathAttestation.mjs';
import {formatWithImages}      from './imageContent.mjs';
import {isParentProcessAlive}  from './standalone.mjs';

let _turnId = 0;

export const getCurrentTurnId = () => _turnId;

/**
 * @summary Resolves the server-instance forced tool-projection mode from its launch sources, in
 * precedence order: the explicit `--tool-projection-mode` CLI flag wins; else the
 * `NEO_NL_TOOL_PROJECTION_MODE` env var (an explicit server-launch ceiling); else `null`
 * (unforced → the full developer/operator surface). Fleet-managed launches leave this unset.
 * The single testable authority for this resolution.
 * @param {String|null} [cliMode] The `--tool-projection-mode` value (null/undefined when the flag is absent).
 * @param {Object} [env=process.env] Env source (injectable for tests).
 * @returns {String|null}
 */
export const resolveToolProjectionMode = (cliMode, env = process.env) =>
    cliMode ?? env.NEO_NL_TOOL_PROJECTION_MODE ?? null;

/**
 * @summary The Neural Link MCP Server application.
 *
 * Bridges AI agents to the live browser application via WebSocket. Uses a non-canonical
 * bootstrap order: the stdio MCP transport is connected EARLY (before `ConnectionService`
 * is awaited) so the MCP client handshake succeeds even when the Bridge process is down or
 * still spawning. The Bridge readiness then proceeds asynchronously while the server is
 * already responsive to MCP-side health and tool inquiries.
 *
 * @class Neo.ai.mcp.server.neural-link.Server
 * @extends Neo.ai.mcp.server.BaseServer
 */
class Server extends BaseServer {
    static config = {
        /**
         * @member {String} className='Neo.ai.mcp.server.neural-link.Server'
         * @protected
         */
        className: 'Neo.ai.mcp.server.neural-link.Server'
    }

    aiConfig = aiConfig
    logger   = logger

    /**
     * Disposer returned by {@link #installStdioLifecycle}.
     * @member {Function|null} #disposeStdioLifecycle=null
     */
    #disposeStdioLifecycle = null

    /**
     * In-flight {@link #shutdown} promise so repeated EOF/signal events coalesce onto one exit sequence.
     * @member {Promise<void>|null} #shutdownPromise=null
     */
    #shutdownPromise = null

    /**
     * Bridge daemon working directory; passed via CLI / env. When set, propagated to
     * `ConnectionService.cwd` before its `ready()` is awaited so the Bridge spawn uses the
     * correct working tree.
     * @member {String|null} bridgeCwd=null
     */
    bridgeCwd = null

    /**
     * @summary Expected commitment for the Genesis probe's resolved writable sinks. Normal launches leave
     * this unset; the MCP entrypoint injects it only for an isolated diagnostic child.
     * @member {String|null} diagnosticPathAttestation=null
     */
    diagnosticPathAttestation = null

    /**
     * @summary MCP server identity for `createMcpServer()`.
     * @returns {{name: String, capabilities: Object}}
     */
    getServerMetadata() {
        return {
            name        : 'neo-neural-link',
            version     : '1.0.0',
            capabilities: {
                tools: {listChanged: false}
            }
        };
    }

    /**
     * @summary Per-server tool registry for ListTools / CallTool dispatch. Increments the
     * module-level `_turnId` counter on every CallTool dispatch (consumed by `getCurrentTurnId()`
     * for transcript-correlation).
     * @returns {{listTools: Function, callTool: Function}}
     */
    getToolService() {
        return {
            listTools,
            callTool: async (name, args, options) => {
                _turnId++;
                return callTool(name, args, options);
            }
        };
    }

    /**
     * @summary Resolves the Neural Link harness projection context for ListTools / CallTool.
     *
     * **Server-instance forced mode is the ceiling.** When this instance was launched with a forced
     * {@link toolProjectionMode} (explicitly selected via `--tool-projection-mode` or its environment
     * variable), every request is pinned to it and the client `_meta` is ignored — a
     * client can NEVER widen its surface by omitting or altering `_meta`. Capability binds to what the
     * server instance *is*, not to what the client *claims*.
     *
     * When NOT forced (trusted dev/operator launch), the client `_meta.neoToolProjection` hint selects
     * the projection (`'harness-embedded'` → fail-closed read surface); absent → `null` → the full
     * developer/operator surface (back-compat).
     *
     * @param {Object} context
     * @param {Object} context.request The raw MCP request.
     * @returns {Object|null}
     */
    buildToolProjectionContext({request}) {
        // Forced server-instance mode wins and is the ceiling — client `_meta` cannot widen past it.
        // Only null/undefined is "unset"; an empty/malformed configured value stays a forced mode and
        // fails closed downstream (a truthiness check would erase `''` into full-surface — fail-OPEN).
        if (this.toolProjectionMode != null) {
            return {mode: this.toolProjectionMode};
        }

        // Unforced: the client hint selects the projection; absent → full developer/operator surface.
        const projection = request?.params?._meta?.neoToolProjection;
        return projection === undefined ? null : {mode: projection};
    }

    /**
     * @summary HealthService for the healthcheck gate + startup-status logging.
     * @returns {Object}
     */
    getHealthService() {
        return HealthService;
    }

    /**
     * @summary Tools allowed without the healthcheck gate. `manage_connection` runs while the
     * Bridge is unhealthy by design — it's the operator's recovery path.
     * @returns {Array<String>}
     */
    getHealthExemptTools() {
        return ['healthcheck', 'manage_connection'];
    }

    /**
     * @summary Delivers the image artifacts a result declares as MCP image content after its JSON text, so a model
     * sees a draw receipt's frame in the same answer instead of reading its base64. A result without artifacts, and
     * every error, formats as `BaseServer` formats it. The walk and its bounds live in `imageContent.mjs`.
     * @param {*} result
     * @returns {Object}
     */
    formatToolResult(result) {
        return formatWithImages(result, value => super.formatToolResult(value));
    }

    /**
     * @summary Custom boot order (override of `BaseServer.boot`): transport connects EARLY
     * so MCP-client handshake succeeds even when the Bridge is down or still spawning. The
     * canonical order would await `ConnectionService.ready()` before `connectTransport()`,
     * which would race against MCP clients trying to connect during Bridge spawn.
     *
     * Sequence:
     * 1. Load custom config
     * 2. Attest resolved diagnostic paths when the Genesis launcher supplied a commitment
     * 3. Construct mcpServer + wire request handlers
     * 4. Connect stdio transport (early — handshake-tolerance for Bridge-down scenarios)
     * 5. Await ConnectionService.ready (non-fatal: logged but doesn't throw, so the server
     *    stays alive to report health errors via the MCP healthcheck tool)
     * 6. Healthcheck + startup-status log
     *
     * @returns {Promise<void>}
     */
    async boot() {
        await this.loadCustomConfig();

        const diagnosticMarker = attestDiagnosticPaths({
            expectedCommitment: this.diagnosticPathAttestation,
            role              : 'mcp',
            sinks             : {
                database: this.aiConfig.memoryCoreDbPath,
                logs    : this.aiConfig.logPath
            }
        });

        if (diagnosticMarker) {
            process.stderr.write(`${diagnosticMarker}\n`)
        }

        this.mcpServer = this.createMcpServer();

        // Connect transport EARLY — see method JSDoc for rationale.
        await this.connectTransport();
        this.logger.info('Neural Link MCP Server transport connected');

        if (this.transport) {
            this.installStdioLifecycle()
        }

        // ConnectionService — set cwd then ready, with non-fatal error tolerance.
        try {
            if (this.bridgeCwd) {
                ConnectionService.cwd = this.bridgeCwd;
            }
            await ConnectionService.ready();

            // Drive the connect HERE, after cwd is assigned. `initAsync()` defers the auto-connect
            // while cwd is unresolved, and it always is at that point — the singleton is constructed
            // by this file's own import, several steps before `this.bridgeCwd` exists. This is the
            // first moment the Bridge can be spawned from the directory the operator actually named.
            if (ConnectionService.cwd && aiConfig.autoConnect) {
                await ConnectionService.ensureBridgeAndConnect();
            }
        } catch (e) {
            this.logger.error('ConnectionService failed to initialize:', e);
            // Do not throw — server stays alive to report health errors via MCP healthcheck.
        }

        await this.runHealthcheckAndLogStatus();

        this.logger.info('Neural Link MCP Server started');
    }

    /**
     * @summary Installs stdio EOF/close, termination-signal, and parent-orphan exit handlers for the
     * stdio MCP server process.
     *
     * `@modelcontextprotocol/sdk`'s `StdioServerTransport` attaches only `data` and `error` listeners
     * to `process.stdin`. When the MCP client closes `stdin` or when an `npx` / shell launcher receives
     * `SIGTERM` without forwarding it to its grandchildren, an active Bridge WebSocket or reconnect
     * timer would otherwise keep the server event loop alive indefinitely.
     *
     * @param {Object} [options={}]
     * @param {Number} [options.pollIntervalMs=200]
     * @param {Object} [options.proc=process]
     * @param {Object} [options.stdin=process.stdin]
     * @returns {Function} Disposer that removes the installed listeners and interval.
     */
    installStdioLifecycle({pollIntervalMs = 200, proc = process, stdin = process.stdin} = {}) {
        this.#disposeStdioLifecycle?.();

        const
            initialPpid = proc.ppid,
            onStdinEnd  = () => void this.shutdown({exitCode: 0, proc}),
            onSignal    = () => void this.shutdown({exitCode: 0, proc}),
            parentTimer = Number.isInteger(initialPpid) && initialPpid > 1
                ? setInterval(() => {
                    if (proc.ppid !== initialPpid || !isParentProcessAlive(initialPpid, proc)) {
                        void this.shutdown({exitCode: 0, proc})
                    }
                }, pollIntervalMs)
                : null;

        parentTimer?.unref();

        stdin.once('end',   onStdinEnd);
        stdin.once('close', onStdinEnd);
        proc.once('SIGINT',  onSignal);
        proc.once('SIGTERM', onSignal);
        proc.once('SIGHUP',  onSignal);

        const dispose = () => {
            if (parentTimer) {
                clearInterval(parentTimer)
            }
            stdin.off('end',   onStdinEnd);
            stdin.off('close', onStdinEnd);
            proc.off('SIGINT',  onSignal);
            proc.off('SIGTERM', onSignal);
            proc.off('SIGHUP',  onSignal);

            if (this.#disposeStdioLifecycle === dispose) {
                this.#disposeStdioLifecycle = null
            }
        };

        this.#disposeStdioLifecycle = dispose;

        if (stdin.readableEnded || stdin.destroyed) {
            void this.shutdown({exitCode: 0, proc})
        }

        return dispose
    }

    /**
     * @summary Tears down the active Bridge client socket, reconnect timer, and MCP server before
     * exiting the process.
     * @param {Object} [options={}]
     * @param {Number} [options.exitCode=0]
     * @param {Object} [options.proc=process]
     * @returns {Promise<void>}
     */
    async shutdown({exitCode = 0, proc = process} = {}) {
        if (this.#shutdownPromise) {
            return this.#shutdownPromise
        }

        this.#shutdownPromise = (async () => {
            this.#disposeStdioLifecycle?.();
            this.stopHeapObservation();
            ConnectionService.disconnectFromBridge();

            if (this.mcpServer) {
                try {
                    await this.mcpServer.close()
                } catch {}
            }

            proc.exit(exitCode)
        })();

        return this.#shutdownPromise
    }

    /**
     * @summary Cleans up stdio lifecycle listeners when the instance is destroyed in-process.
     * @param {...*} args
     */
    destroy(...args) {
        this.#disposeStdioLifecycle?.();
        super.destroy(...args)
    }

    /**
     * @summary neural-link-specific startup status formatting with session + window counts on
     * healthy paths.
     * @param {Object} health
     */
    logStartupStatus(health) {
        if (health.status === 'unhealthy') {
            logger.warn('⚠️  [Startup] Neural Link is unhealthy. Server will start but tools will fail until resolved.');
            health.details?.forEach(detail => logger.warn(`    ${detail}`));
        } else {
            logger.info('✅ [Startup] Neural Link health check passed');
            logger.info(`   - Active Sessions: ${health.sessions.length}`);
            logger.info(`   - Connected Windows: ${health.windows.length}`);
        }
    }
}

export default Neo.setupClass(Server);
