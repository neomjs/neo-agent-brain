// Tier 1 must register before this context child resolves inherited Brain-wide leaves.
import '../../ai/config.mjs';
import ConfigBase          from './configBase.mjs';
import {createConfigProxy} from '../../ai/ConfigProvider.mjs';

/**
 * @summary Canonical thin singleton for Evolution configuration.
 *
 * Defaults live in {@link Neo.brain.evolution.ConfigBase}; this class only claims the runtime
 * namespace so a future operator overlay can remain a delta-only child.
 *
 * @class Neo.brain.evolution.Config
 * @extends Neo.brain.evolution.ConfigBase
 * @singleton
 */
class Config extends ConfigBase {
    static config = {
        className: 'Neo.brain.evolution.Config',
        singleton: true
    }
}

export default createConfigProxy(Neo.setupClass(Config));
