import aiConfig       from './config.mjs';
import {createLogger} from '../../../cloud/mcp/server/shared/logger.mjs';

export default createLogger(aiConfig, {
    defaultLevel: 'warn',
    fileSink    : false,
    stderrMode  : 'threshold'
});
