import fs                              from 'node:fs';
import path                            from 'node:path';
import Neo                             from 'neo.mjs/src/Neo.mjs';
import BaseServer                      from '../BaseServer.mjs';
import {collectPlaneMembers}           from '../../../planeConfig.mjs';
import StandaloneSqliteIndex           from '../../../services/memory-core/helpers/standaloneSqliteIndex.mjs';
import {resolveStandaloneWorkspaceKey} from '../../../services/memory-core/helpers/standaloneWorkspaceKey.mjs';
import StandaloneConfigBase, {
    STANDALONE_PLANE_MEMBER_PATHS,
    createStandaloneConfig
}                                        from './standaloneConfigBase.mjs';
import {createStandaloneToolService}     from './standaloneToolService.mjs';

const STANDALONE_SERVER_VERSION = '1.0.0';

/**
 * @summary Creates a file-and-stderr logger writing to the standalone `logPath` file without touching stdout.
 * @param {Object} options
 * @param {String} options.logFilePath Absolute file path for `mcp.log`.
 * @param {Function} options.isDebug Callback reading the current `debug` boolean.
 * @returns {{debug: Function, error: Function, info: Function, warn: Function}}
 */
function createStandaloneFileLogger({logFilePath, isDebug}) {
    const resolvedFile = path.resolve(logFilePath);
    fs.mkdirSync(path.dirname(resolvedFile), {recursive: true});

    const formatArg = item => {
        if (item instanceof Error) {
            return item.stack || item.message;
        }
        return typeof item === 'object' ? JSON.stringify(item) : String(item);
    };

    const writeEntry = (level, emitStderr, args) => {
        const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatArg).join(' ')}\n`;
        try {
            fs.appendFileSync(resolvedFile, line, 'utf8');
        } catch {}

        if (emitStderr) {
            process.stderr.write(line);
        }
    };

    return {
        debug: (...args) => {
            if (isDebug()) {
                writeEntry('DEBUG', true, args);
            }
        },
        info : (...args) => writeEntry('INFO', Boolean(isDebug()), args),
        warn : (...args) => writeEntry('WARN', Boolean(isDebug()), args),
        error: (...args) => writeEntry('ERROR', true, args)
    };
}

/**
 * @summary Standalone zero-daemon Memory Core MCP server backed by JSONL WAL and `node:sqlite` FTS5.
 * @class Neo.ai.mcp.server.memory-core.StandaloneServer
 * @extends Neo.ai.mcp.server.BaseServer
 */
class StandaloneServer extends BaseServer {
    static config = {
        /**
         * @member {String} className='Neo.ai.mcp.server.memory-core.StandaloneServer'
         * @protected
         */
        className: 'Neo.ai.mcp.server.memory-core.StandaloneServer'
    }

    autoBoot           = true
    connectOnBoot      = true
    cwd                = null
    defaultSessionId   = null
    execGit            = undefined
    ownsConfigInstance = false
    sqliteIndex        = null
    toolProjectionMode = 'standalone'
    workspaceInfo      = null

    #bootPromise   = null
    #healthService = null
    #toolFacade    = null

    /**
     * @summary Declares standalone Memory Core as an active plane member checked fail-closed at boot.
     * @returns {Boolean}
     * @override
     */
    isPlaneMember() {
        return true;
    }

    /**
     * @summary Collects only the 3 standalone plane members without inheriting Tier-1 full-plane members.
     * @returns {Object[]}
     * @override
     */
    getPlaneMembers() {
        return collectPlaneMembers({
            memberPaths   : STANDALONE_PLANE_MEMBER_PATHS,
            resolvedConfig: this.aiConfig,
            descriptorData: StandaloneConfigBase.config.data
        });
    }

    /**
     * @summary Returns MCP server identity metadata for the standalone Memory Core server.
     * @returns {{capabilities: Object, name: String, version: String}}
     * @override
     */
    getServerMetadata() {
        return {
            name        : 'neo-memory-core-standalone',
            version     : STANDALONE_SERVER_VERSION,
            capabilities: {
                tools: {
                    listChanged: false
                }
            }
        };
    }

    /**
     * @summary Returns the active standalone `ToolService` facade.
     * @returns {Object}
     * @override
     */
    getToolService() {
        return this.#toolFacade;
    }

    /**
     * @summary Returns the standalone health service adapter gating non-exempt MCP tool dispatches.
     * @returns {{healthcheck: Function}}
     * @override
     */
    getHealthService() {
        return this.#healthService;
    }

    /**
     * @summary Builds MCP `initialize` instructions directing session-start `query_recent_turns` and turn-end `add_memory`.
     * @param {Object} [options={}]
     * @returns {String}
     * @override
     */
    getServerInstructions(options = {}) {
        const workflowGuidance = [
            'Standalone Memory Core workflow:',
            '1. At session start, call query_recent_turns (and query_raw_memories for targeted lexical lookup) to recover prior cross-harness decisions before re-deriving context.',
            '2. At task or turn completion, call add_memory with prompt, decisionContext, and response so future sessions inherit durable episodic memory.'
        ].join('\n');

        const baseCatalog = super.getServerInstructions(options);
        return [workflowGuidance, baseCatalog].filter(Boolean).join('\n\n');
    }

    /**
     * @summary Computes the standalone `healthcheck` payload over plane identity, workspace resolution, and WAL/SQLite storage.
     * @returns {Object}
     */
    buildHealthcheckPayload() {
        const stats = this.sqliteIndex
            ? this.sqliteIndex.getStorageStats()
            : {walBytes: 0, indexBytes: 0, memoryCount: 0};

        return {
            status   : 'healthy',
            mode     : 'standalone',
            version  : STANDALONE_SERVER_VERSION,
            timestamp: new Date().toISOString(),
            plane    : {
                id      : this.aiConfig.plane.id,
                dataRoot: this.aiConfig.plane.dataRoot
            },
            workspace      : this.workspaceInfo.workspace,
            workspaceSource: this.workspaceInfo.workspaceSource,
            storage        : {
                walBytes       : stats.walBytes,
                indexBytes     : stats.indexBytes,
                memoryCount    : stats.memoryCount,
                retentionPolicy: 'none-v1'
            }
        };
    }

    /**
     * @summary Logs standalone plane and workspace readiness after healthcheck passes.
     * @param {Object|null} health Healthcheck payload.
     * @override
     */
    logStartupStatus(health) {
        if (!health || !this.logger) {
            return;
        }
        this.logger.info(
            `[neo-memory-core-standalone] Ready (plane=${health.plane.id}, workspace=${health.workspace} [${health.workspaceSource}], memories=${health.storage.memoryCount})`
        );
    }

    /**
     * @summary Validates plane coherence first, then initializes logger, workspace key, SQLite FTS5 index, and MCP transport.
     * @returns {Promise<void>}
     * @override
     */
    async boot() {
        if (!this.aiConfig) {
            this.aiConfig           = createStandaloneConfig();
            this.ownsConfigInstance = true;
        }

        await this.loadCustomConfig();

        // Fail closed on plane or member incoherence before creating log or SQLite files on disk.
        this.assertPlaneIdentity();

        if (!this.logger) {
            this.logger = createStandaloneFileLogger({
                logFilePath: this.aiConfig.logPath,
                isDebug    : () => Boolean(this.aiConfig && this.aiConfig.debug)
            });
        }

        this.workspaceInfo = resolveStandaloneWorkspaceKey({
            explicitWorkspace: this.aiConfig.workspace,
            cwd              : this.cwd || process.cwd(),
            ...(this.execGit ? {execGit: this.execGit} : {})
        });

        this.sqliteIndex = new StandaloneSqliteIndex({
            indexPath: this.aiConfig.standaloneIndexPath,
            walDir   : this.aiConfig.memoryWal.dirProd
        });

        this.#healthService = {
            healthcheck: async () => this.buildHealthcheckPayload()
        };

        this.#toolFacade = createStandaloneToolService({
            getConfig       : () => this.aiConfig,
            getSqliteIndex  : () => this.sqliteIndex,
            getWorkspaceInfo: () => this.workspaceInfo,
            runHealthcheck  : async () => this.buildHealthcheckPayload(),
            ...(this.defaultSessionId ? {defaultSessionId: this.defaultSessionId} : {})
        });

        await this.beforeMcpServerInit();
        this.mcpServer = this.createMcpServer();
        await this.waitForDependentServices();
        await this.beforeHealthcheck();
        const health = await this.runHealthcheckAndLogStatus();
        await this.afterHealthcheck(health);

        if (this.connectOnBoot) {
            await this.connectTransport();
            await this.afterTransportConnected();
        }
    }

    /**
     * @summary Captures boot promises so fail-closed startup errors propagate through `ready()` without unhandled rejections.
     * @returns {Promise<void>}
     * @override
     */
    async initAsync() {
        if (!this.autoBoot) {
            return;
        }
        this.#bootPromise = super.initAsync();
        this.#bootPromise.catch(() => {});
        try {
            await this.#bootPromise;
        } catch {
            // Propagated deterministically to callers awaiting ready().
        }
    }

    /**
     * @summary Resolves when standalone boot completes or rejects with the startup failure.
     * @returns {Promise<StandaloneServer>}
     * @override
     */
    async ready() {
        await super.ready();
        if (this.#bootPromise) {
            await this.#bootPromise;
        }
        return this;
    }

    /**
     * @summary Closes the derived SQLite index, tool facade, and owned config instance on shutdown.
     * @override
     */
    destroy() {
        if (this.sqliteIndex) {
            this.sqliteIndex.close();
            this.sqliteIndex = null;
        }
        if (this.#toolFacade) {
            this.#toolFacade.destroy();
            this.#toolFacade = null;
        }
        if (this.ownsConfigInstance && this.aiConfig && typeof this.aiConfig.destroy === 'function') {
            this.aiConfig.destroy();
            this.aiConfig = null;
        }
        super.destroy();
    }
}

export default Neo.setupClass(StandaloneServer);
