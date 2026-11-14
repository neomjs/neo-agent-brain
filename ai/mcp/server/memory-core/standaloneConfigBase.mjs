import os                                              from 'node:os';
import path                                            from 'node:path';
import Neo                                             from 'neo.mjs/src/Neo.mjs';
import ConfigProvider, {createConfigProxy, leaf}       from '../../../ConfigProvider.mjs';
import {assertPlaneDataRootPlacement, parsePlaneIdEnv} from '../../../planeConfig.mjs';

export const DEFAULT_STANDALONE_PLANE_ID = 'neo-standalone-memory-core';
export const defaultStandaloneDataRoot   = path.resolve(os.homedir(), '.neo-ai', 'memory-core');

export const STANDALONE_PLANE_MEMBER_PATHS = Object.freeze([
    'memoryWal.dirProd',
    'standaloneIndexPath',
    'logPath'
]);

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
        data: {
            debug    : leaf(false, 'NEO_DEBUG', 'boolean'),
            transport: leaf('stdio', 'NEO_TRANSPORT', 'string'),
            plane    : {
                id      : leaf(DEFAULT_STANDALONE_PLANE_ID, 'NEO_PLANE_ID', 'string', {parse: parsePlaneIdEnv}),
                dataRoot: leaf(defaultStandaloneDataRoot, 'NEO_PLANE_DATA_ROOT', 'string', {
                    planeMember      : false,
                    planeMemberReason: 'Anchor leaf for the standalone memory-core plane root.'
                })
            },
            memoryWal: {
                dirProd: leaf(path.resolve(defaultStandaloneDataRoot, 'wal'), 'NEO_MEMORY_WAL_DIR', 'string', {
                    planeMember: true
                })
            },
            standaloneIndexPath: leaf(
                path.resolve(defaultStandaloneDataRoot, 'index.sqlite'),
                'NEO_MC_STANDALONE_INDEX_PATH',
                'string',
                {planeMember: true}
            ),
            logPath: leaf(
                path.resolve(defaultStandaloneDataRoot, 'logs', 'mcp.log'),
                'NEO_MC_LOG_PATH',
                'string',
                {planeMember: true}
            ),
            workspace: leaf('', 'NEO_MC_WORKSPACE', 'string'),
            sessionId: leaf('', 'NEO_MC_SESSION_ID', 'string')
        }
    }

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
 * @summary Creates an isolated standalone config proxy with optional bounded env overrides.
 * @param {Object} [options={}]
 * @param {Object<String,*>} [options.envOverrides] Optional env-var-keyed overrides applied at construction.
 * @returns {Proxy}
 */
export function createStandaloneConfig({envOverrides} = {}) {
    const provider = Neo.create(RegisteredStandaloneConfigBase);

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
