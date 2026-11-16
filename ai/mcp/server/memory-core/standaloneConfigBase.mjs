import Neo                                             from 'neo.mjs/src/Neo.mjs';
import ConfigProvider, {createConfigProxy, leaf}       from '../../../ConfigProvider.mjs';
import {assertPlaneDataRootPlacement, parsePlaneIdEnv} from '../../../planeConfig.mjs';
import {standalonePlacement}                           from './standalone.mjs';

const defaultPlacement = standalonePlacement();
export const defaultStandaloneDataRoot = defaultPlacement.NEO_PLANE_DATA_ROOT;

export const STANDALONE_PLANE_MEMBER_PATHS = Object.freeze([
    'memoryWal.dirProd',
    'standaloneIndexPath',
    'logPath'
]);

/**
 * @summary Builds the standalone descriptor tree declared from `standalonePlacement`.
 * @param {Object} [options={}]
 * @param {String} [options.homedir] Optional isolated home directory override for partial-relocation negative tests.
 * @returns {Object}
 */
export function buildStandaloneDescriptorData({homedir} = {}) {
    const placement = homedir ? standalonePlacement({homedir}) : defaultPlacement;

    return {
        /**
         * Global debug flag controlling stderr log mirroring.
         * @type {boolean}
         */
        debug: leaf(false, 'NEO_DEBUG', 'boolean'),
        /**
         * MCP transport mode, pinned to `'stdio'` with no env override on the standalone `npx` runtime.
         * @type {string}
         */
        transport: leaf('stdio'),
        /**
         * Standalone plane identity and durable per-user data-root anchor (`~/.neo-ai/memory-core`).
         * @type {Object}
         */
        plane: {
            /**
             * Opaque standalone plane identifier (`neo-standalone-memory-core`).
             * @type {string}
             */
            id: leaf(placement.NEO_PLANE_ID, 'NEO_PLANE_ID', 'string', {parse: parsePlaneIdEnv}),
            /**
             * Durable per-user plane root from which all 3 standalone plane members derive.
             * @type {string}
             */
            dataRoot: leaf(placement.NEO_PLANE_DATA_ROOT, 'NEO_PLANE_DATA_ROOT', 'string', {
                planeMember      : false,
                planeMemberReason: 'Anchor leaf for the standalone memory-core plane root.'
            }),
            /**
             * Pinned with no env override: this package is a durable plane other than its host's
             * canonical one by construction, so the coherence assertion requires its own id.
             * @type {boolean}
             */
            standalone: leaf(true)
        },
        /**
         * Canonical JSONL write-ahead log segment storage for standalone episodic turns.
         * @type {Object}
         */
        memoryWal: {
            /**
             * Directory holding unmarked `wal-YYYY-MM-DD.jsonl` segments (`<dataRoot>/wal`).
             * @type {string}
             */
            dirProd: leaf(placement.NEO_MEMORY_WAL_DIR, 'NEO_MEMORY_WAL_DIR', 'string', {
                planeMember: true
            })
        },
        /**
         * File path for the rebuildable `node:sqlite` WAL/FTS5 BM25 index (`<dataRoot>/index.sqlite`).
         * @type {string}
         */
        standaloneIndexPath: leaf(
            placement.NEO_MC_STANDALONE_INDEX_PATH,
            'NEO_MC_STANDALONE_INDEX_PATH',
            'string',
            {planeMember: true}
        ),
        /**
         * Directory for daily-rotated standalone MCP diagnostic log files (`<dataRoot>/logs`).
         * @type {string}
         */
        logPath: leaf(
            placement.NEO_MC_LOG_PATH,
            'NEO_MC_LOG_PATH',
            'string',
            {planeMember: true}
        ),
        /**
         * Retention policy for standalone MCP diagnostic log files (`mc-standalone-YYYY-MM-DD.log`).
         * @type {Object}
         */
        loggerRetention: {
            enabled      : leaf(true, 'NEO_MC_LOG_RETENTION_ENABLED', 'boolean'),
            maxAgeDays   : leaf(14, 'NEO_MC_LOG_RETENTION_MAX_AGE_DAYS', 'number'),
            maxFiles     : leaf(30, 'NEO_MC_LOG_RETENTION_MAX_FILES', 'number'),
            maxTotalBytes: leaf(100 * 1024 * 1024, 'NEO_MC_LOG_RETENTION_MAX_TOTAL_BYTES', 'number')
        },
        /**
         * Shared MCP logger policy (`ai/mcp/server/shared/logger.mjs`): file sink plus debug-gated stderr.
         * @type {Object}
         */
        logger: leaf({
            filePrefix    : 'mc-standalone',
            fileSink      : true,
            flush         : true,
            stderrMode    : 'debug',
            timestampStyle: 'plain'
        }),
        /**
         * Optional explicit workspace slug or target directory (`--workspace` / `NEO_MC_WORKSPACE`).
         * @type {string}
         */
        workspace: leaf('', 'NEO_MC_WORKSPACE', 'string'),
        /**
         * Optional default session identifier for `add_memory` calls (`--session-id` / `NEO_MC_SESSION_ID`).
         * @type {string}
         */
        sessionId: leaf('', 'NEO_MC_SESSION_ID', 'string')
    };
}

/**
 * @summary Standalone `ConfigProvider` root for the zero-daemon Memory Core `npx` package.
 * @class Neo.ai.mcp.server.memory-core.StandaloneConfigBase
 * @extends Neo.ai.ConfigProvider
 */
class StandaloneConfigBase extends ConfigProvider {
    static config = {
        /**
         * @member {String} className='Neo.ai.mcp.server.memory-core.StandaloneConfigBase'
         * @protected
         */
        className: 'Neo.ai.mcp.server.memory-core.StandaloneConfigBase',
        /**
         * @member {Object} data
         */
        data: buildStandaloneDescriptorData()
    }

    /**
     * Descriptor tree matching this provider's build-time or test-isolated home anchor.
     * @member {Object} descriptorData
     */
    descriptorData = StandaloneConfigBase.config.data

    /**
     * @summary Detaches the standalone config provider from the Tier-1 full-plane `Neo.ai.Config` parent chain.
     * @returns {null}
     * @override
     */
    getParent() {
        return null;
    }
}

const RegisteredStandaloneConfigBase = Neo.setupClass(StandaloneConfigBase);

/**
 * @summary Creates an isolated standalone config proxy with optional bounded env overrides and test home anchor.
 * @param {Object} [options={}]
 * @param {Object<String,*>} [options.envOverrides] Optional env-var-keyed overrides applied at construction.
 * @param {String} [options.homedir] Optional isolated home directory for partial-relocation negative tests.
 * @returns {Proxy}
 */
export function createStandaloneConfig({envOverrides, homedir} = {}) {
    const descriptorData = homedir
        ? buildStandaloneDescriptorData({homedir})
        : StandaloneConfigBase.config.data;

    const provider = Neo.create(
        RegisteredStandaloneConfigBase,
        homedir ? {data: descriptorData, descriptorData} : {}
    );

    if (envOverrides && typeof envOverrides === 'object') {
        for (const [envName, value] of Object.entries(envOverrides)) {
            if (value !== undefined) {
                provider.setEnvOverride(envName, value);
            }
        }
        assertPlaneDataRootPlacement(provider.getData('plane.dataRoot'), {requireWritable: true});
    }

    return createConfigProxy(provider);
}

export default RegisteredStandaloneConfigBase;
