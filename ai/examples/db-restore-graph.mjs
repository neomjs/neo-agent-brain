/**
 * @summary Retired unfenced restore entrypoint; refuses before opening storage.
 * Supported graph restoration uses ai/scripts/maintenance/restore.mjs and its guarded owner.
 * Whole-file recovery requires separately admitted reconciliation.
 */
console.error('This direct-SQL graph restore example is retired. Use ai/scripts/maintenance/restore.mjs and its documented admission guards.');
process.exitCode = 1;
