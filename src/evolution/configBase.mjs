import ConfigProvider, {leaf} from '../../ai/ConfigProvider.mjs';

/**
 * @summary Extendable reactive configuration authority for Evolution REM-digestion policy.
 *
 * Deployment-wide provider selection and the shared REM-state path stay inherited from Tier 1.
 * Only Evolution-owned batching, retry, and retention policy is declared here.
 *
 * @class Neo.brain.evolution.ConfigBase
 * @extends Neo.ai.ConfigProvider
 */
class ConfigBase extends ConfigProvider {
    static config = {
        className: 'Neo.brain.evolution.ConfigBase',
        data     : {
            /**
             * Page size for reading retained session summaries and raw turns during REM scans.
             * This is distinct from Memory Core's summarization batch policy.
             * @type {Number}
             */
            sessionScanPageLimit: leaf(2000),
            /**
             * Maximum number of undigested sessions processed by one REM cycle.
             * @type {Number}
             */
            remSleepBatchLimit: leaf(10, 'NEO_REM_SLEEP_BATCH_LIMIT', 'number'),
            /**
             * Maximum terminal extraction attempts before a retry-exhausted session leaves cadence.
             * @type {Number}
             */
            maxDigestAttempts: leaf(3, 'NEO_REM_MAX_DIGEST_ATTEMPTS', 'number'),
            /**
             * Fresh-session reserve inside each bounded REM batch.
             * @type {Number}
             */
            undigestedSessionFreshReserve: leaf(2, 'NEO_REM_UNDIGESTED_FRESH_RESERVE', 'number'),
            /**
             * Maximum retained REM run-state artifacts.
             * @type {Number}
             */
            remRunRetentionLimit: leaf(200, 'NEO_REM_RUN_RETENTION_LIMIT', 'number')
        }
    }
}

export default Neo.setupClass(ConfigBase);
