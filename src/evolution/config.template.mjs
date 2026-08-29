// Tests and fresh installs bind the committed Tier-1 template before this context child.
import '../../ai/config.template.mjs';
import ConfigBase          from './configBase.mjs';
import {createConfigProxy} from '../../ai/ConfigProvider.mjs';

/**
 * @summary Committed template singleton for Evolution configuration.
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
