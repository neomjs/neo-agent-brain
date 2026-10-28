/**
 * @summary Retired unfenced direct-SQL restore example; refuses before opening storage.
 * Supported graph restoration belongs to ai/scripts/maintenance/restore.mjs and its guarded
 * DatabaseService path. Whole-file recovery requires separately admitted reconciliation.
 */
console.error('This direct-SQL graph restore example is retired. Use ai/scripts/maintenance/restore.mjs and its documented admission guards.');
process.exitCode = 1;
