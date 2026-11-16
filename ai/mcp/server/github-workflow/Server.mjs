import BaseServer                              from '../BaseServer.mjs';
import aiConfig                                from './config.mjs';
import logger                                  from './logger.mjs';
import HealthService                           from '../../../services/github-workflow/HealthService.mjs';
import RepositoryService                       from '../../../services/github-workflow/RepositoryService.mjs';
import SyncService                             from '../../../services/github-workflow/SyncService.mjs';
import {buildToolCatalog, listTools, callTool} from './toolService.mjs';
import {createIdentityPublicationClient}       from '../../../services/shared/identityPublicationClient.mjs';
import {normalizeAgentIdentity, normalizeExpectedPlaneTarget, normalizeSecureMcpEndpoint, planeMcpResources}
    from '../../../services/fleet/mcpWireParsing.mjs';

/** @summary Names reader unavailability without changing ordinary GitHub startup or exposing credentials. */
const familySourceUnavailable = code => Object.freeze({state: 'unavailable', code});

/**
 * @summary The GitHub Workflow MCP Server application.
 *
 * Handles initialization, configuration, and lifecycle management for the GitHub Workflow MCP server.
 * It sets up the MCP server instance, connects the stdio transport, registers tool handlers,
 * and performs initial health checks and permission validation.
 *
 * @class Neo.ai.mcp.server.github-workflow.Server
 * @extends Neo.ai.mcp.server.BaseServer
 */
class Server extends BaseServer {
    static config = {
        /**
         * @member {String} className='Neo.ai.mcp.server.github-workflow.Server'
         * @protected
         */
        className: 'Neo.ai.mcp.server.github-workflow.Server'
    }

    aiConfig = aiConfig
    logger   = logger

    /** @member {Object|null} identityPublicationClient One Server-owned, explicitly bound MC reader. */
    identityPublicationClient = null;
    /** @member {Promise|null} identityPublicationClosing Shared close barrier for this reader epoch. @private */
    identityPublicationClosing = null;
    /** @member {Promise|null} identityPublicationConnection Observed optional proof, never a server boot dependency. @private */
    identityPublicationConnection = null;
    /** @member {Object} identityPublicationState Connection/refusal state, never retained family history. */
    identityPublicationState = familySourceUnavailable('family-source-uninitialized');

    /**
     * @summary MCP server identity for `createMcpServer()`.
     * @returns {{name: String, version: String, capabilities: Object}}
     */
    getServerMetadata() {
        return {
            name        : 'neo-github-workflow',
            version     : process.env.npm_package_version || '1.0.0',
            capabilities: {
                tools: {listChanged: false}
            }
        };
    }

    /**
     * @summary Per-server tool registry for ListTools / CallTool dispatch.
     * @returns {{listTools: Function, callTool: Function}}
     */
    getToolService() {
        return {buildToolCatalog, listTools, callTool};
    }

    /**
     * @summary Singleton services to await ready() before transport-connect. SyncService runs
     * a startup sync against GitHub; we wait for it to settle before announcing the server ready.
     * @returns {Array<Object>}
     */
    getDependentServices() {
        return [SyncService];
    }

    /**
     * @summary HealthService for the healthcheck gate + startup-status logging.
     * @returns {Object}
     */
    getHealthService() {
        return HealthService;
    }

    /**
     * @summary Tools allowed without the healthcheck gate. The github-workflow OpenAPI spec
     * declares a single canonical `healthcheck` operation; matches the original substring-based
     * exemption (`name.includes('healthcheck')`) since no other tool name contains it.
     * @returns {Array<String>}
     */
    getHealthExemptTools() {
        return ['healthcheck'];
    }

    /**
     * @summary Fetches the current authenticated viewer, then constructs its independently bound MC reader.
     * GitHub startup does not await the optional family connection. The fresh API response owns
     * expected identity; neither a stale viewer cache nor local RequestContext proves a remote caller.
     * @param {Object} health
     */
    async afterHealthcheck(health) {
        await this.closeIdentityPublicationClient();
        if (this.isDestroying || this.isDestroyed) return;
        this.identityPublicationState = familySourceUnavailable('family-source-viewer-unavailable');
        if (health?.status === 'unhealthy') return;

        const permission = await RepositoryService.fetchAndCacheViewerPermission();
        if (this.isDestroying || this.isDestroyed) return;
        const expectedIdentity = normalizeAgentIdentity(RepositoryService.viewerLogin);
        if (typeof permission !== 'string' || !expectedIdentity) return;

        let expectedTarget = null;
        try {
            // Authority-bearing bootstrap metadata stays atomic through Provider inheritance.
            if (typeof this.aiConfig.seat.planeTarget === 'string') {
                expectedTarget = normalizeExpectedPlaneTarget(JSON.parse(this.aiConfig.seat.planeTarget));
            }
        } catch {}
        const endpoint = normalizeSecureMcpEndpoint(this.aiConfig.seat.planeBase);
        if (!expectedTarget || !endpoint || typeof this.aiConfig.seat.planeBearer !== 'string' || !this.aiConfig.seat.planeBearer.trim()) {
            this.identityPublicationState = familySourceUnavailable('family-source-configuration-unavailable');
            return;
        }
        try {
            this.identityPublicationClosing = null;
            const client = this.identityPublicationClient = createIdentityPublicationClient({
                baseUrl   : planeMcpResources(endpoint)['memory-core'].url,
                credential: this.aiConfig.seat.planeBearer,
                expectedIdentity,
                expectedTarget
            });
            this.identityPublicationState = familySourceUnavailable('family-source-connecting');
            this.identityPublicationConnection = this.observeIdentityPublicationClient(client);
        } catch {
            await this.closeIdentityPublicationClient();
            if (!this.isDestroying && !this.isDestroyed) {
                this.identityPublicationState = familySourceUnavailable('family-source-unavailable');
            }
        }
    }

    /**
     * @summary Observes a reader's proof without holding the ordinary GitHub transport.
     * Family reads await the client's shared initialization themselves. A retired reader's late
     * completion cannot overwrite its successor or resurrect a destroyed Server.
     * @param {Object} client This Server's newly constructed reader.
     * @returns {Promise<Object>} Connection or bounded refusal state, including teardown failure.
     */
    async observeIdentityPublicationClient(client) {
        try {
            const state = await client.connect();
            if (this.identityPublicationClient === client && !this.isDestroying && !this.isDestroyed) {
                this.identityPublicationState = state;
            }
            return state;
        } catch {
            if (this.identityPublicationClient !== client || this.isDestroying || this.isDestroyed) {
                return familySourceUnavailable('family-source-closed');
            }
            try {await this.closeIdentityPublicationClient();} catch {}
            const state = familySourceUnavailable('family-source-unavailable');
            if (!this.identityPublicationClient && !this.isDestroying && !this.isDestroyed) {
                this.identityPublicationState = state;
            }
            return state;
        }
    }

    /** @summary Supplies a fresh qualified observation to family consumers without caching history. @returns {Promise<Object>} */
    async readIdentityPublicationSnapshot() {
        if (this.isDestroying || this.isDestroyed) return familySourceUnavailable('family-source-closed');
        return this.identityPublicationClient
            ? this.identityPublicationClient.readSnapshot()
            : this.identityPublicationState;
    }

    /** @summary Detaches the owned reader before awaiting its terminal resource barrier. @returns {Promise<void>} */
    closeIdentityPublicationClient() {
        const client = this.identityPublicationClient;
        this.identityPublicationClient = null;
        this.identityPublicationConnection = null;
        this.identityPublicationState = familySourceUnavailable('family-source-closed');
        this.identityPublicationClosing ??= (async () => {
            if (client) {
                try {await client.close();} finally {client.destroy();}
            }
        })();
        return this.identityPublicationClosing;
    }

    /** @summary Retires the optional reader with its Server owner. @param {...*} args */
    destroy(...args) {
        this.closeIdentityPublicationClient().catch(() => {});
        super.destroy(...args);
    }

    /**
     * @summary github-workflow-specific startup status formatting with `gh` CLI tip on unhealthy.
     * @param {Object} health
     */
    logStartupStatus(health) {
        if (health.status === 'unhealthy') {
            logger.warn('⚠️  [Startup] GitHub CLI is not available. Server will start but tools will fail until resolved.');
            health.githubCli.details.forEach(detail => logger.warn(`    ${detail}`));
            logger.warn('    The server will periodically retry and recover automatically once dependencies are met.');
        } else if (health.status === 'degraded') {
            logger.warn('⚠️  [Startup] GitHub CLI is partially configured. Some operations may fail.');
            health.githubCli.details.forEach(detail => logger.warn(`    ${detail}`));
        } else {
            logger.info('✅ [Startup] GitHub CLI health check passed');
        }
    }
}

export default Neo.setupClass(Server);
