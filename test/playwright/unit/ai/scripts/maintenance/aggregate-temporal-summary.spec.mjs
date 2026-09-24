import {setup} from '../../../../setup.mjs';

setup({
    appConfig: {
        name: 'AiAggregateTemporalSummaryTest'
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import logger         from '../../../../../../ai/mcp/server/memory-core/logger.mjs';

import {reportAggregationFailure} from '../../../../../../ai/scripts/maintenance/aggregate-temporal-summary.mjs';

test.describe('aggregate-temporal-summary failure report (#448)', () => {
    test('a failed cycle writes its reason on stderr, keeps the file-sink line and exits 1', () => {
        const errors      = [],
              fileLines   = [],
              loggerError = logger.error,
              failure     = Object.assign(new Error('temporal record write refused'), {code: 'TEMPORAL_SUMMARY_WRITE_FAILED'});

        logger.error = (...args) => fileLines.push(args);

        try {
            const exitCode = reportAggregationFailure(failure, {
                output: {error: value => errors.push(value)},
                exit  : code => code
            });

            expect(exitCode).toBe(1);
            expect(errors).toEqual(['[temporal-summary] Aggregation cycle failed: TEMPORAL_SUMMARY_WRITE_FAILED — temporal record write refused']);
            expect(fileLines).toHaveLength(1);
            expect(fileLines[0][1]).toBe(failure)
        } finally {
            logger.error = loggerError
        }
    });
});
