import aiConfig       from './config.mjs';
import {createLogger} from '../../../cloud/mcp/server/shared/logger.mjs';

export default createLogger(aiConfig, {
    filePrefix    : 'nl-server',
    fileSink      : true,
    stderrMode    : 'tiered',
    timestampStyle: 'bracketed'
});
