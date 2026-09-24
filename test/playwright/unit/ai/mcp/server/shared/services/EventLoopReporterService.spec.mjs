import {setup} from '../../../../../../setup.mjs';

const appName = 'EventLoopReporterTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                 from '@playwright/test';
import {spawnSync}                    from 'node:child_process';
import fs                             from 'node:fs';
import os                             from 'node:os';
import path                           from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import Neo                            from 'neo.mjs/src/Neo.mjs';
import * as core                      from 'neo.mjs/src/core/_export.mjs';
import EventLoopReporterService
    from '../../../../../../../../ai/mcp/server/shared/services/EventLoopReporterService.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../../../');

const busyWait = ms => {
    const start = Date.now();

    while (Date.now() - start < ms) {}
};

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

const makeLogger = () => {
    const warnings = [];

    return {warnings, warn: message => warnings.push(message), writeSync: () => {}}
};

// An interval that never fires inside a test: each arm closes its own windows, so it stays deterministic.
const manualWindows = () => ({checkIntervalMs: 60 * 60 * 1000, stallWarnMs: 300});

/**
 * @summary Runs a real process that starts the reporter with a real file logger and then exits, either
 * because its loop drained (the listener closes) or because it calls `process.exit(0)` with the
 * listener still up. The exit line has to land from an `exit` handler, which only a process that
 * really exits can show.
 * @param {'drain'|'explicit'} mode
 * @returns {{exit: Object, result: Object}}
 */
const runExitWitness = mode => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-exit-witness-')),
          href   = file => JSON.stringify(pathToFileURL(path.join(repoRoot, file)).href),
          script = `
              import http from 'node:http';
              await import('neo.mjs/src/Neo.mjs');
              await import('neo.mjs/src/core/_export.mjs');
              const {createLogger}                     = await import(${href('ai/mcp/server/shared/logger.mjs')});
              const {default: EventLoopReporterService} = await import(${href('ai/mcp/server/shared/services/EventLoopReporterService.mjs')});
              const logger = createLogger({logPath: ${JSON.stringify(logDir)}}, {filePrefix: 'exit-witness', fileSink: true, stderrMode: 'debug'});
              EventLoopReporterService.start({serviceKey: 'exit-witness', logger, readConfig: () => ({checkIntervalMs: 60000, stallWarnMs: 60000})});
              const server = http.createServer().listen(0, '127.0.0.1', () => ${mode === 'drain' ? 'server.close()' : 'process.exit(0)'});
          `;

    try {
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {cwd: repoRoot, encoding: 'utf8', timeout: 30 * 1000}),
              file   = path.join(logDir, `exit-witness-${new Date().toISOString().slice(0, 10)}.log`),
              line   = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').find(entry => entry.includes('[EventLoopReporter] exit-witness exiting'));

        expect(result.error, `the witness did not exit: ${result.error?.message}`).toBeUndefined();
        expect(line, `no exit line in the file log; stderr: ${result.stderr}`).toBeTruthy();

        return {exit: JSON.parse(line.slice(line.indexOf('{'))), line, result}
    } finally {
        fs.rmSync(logDir, {recursive: true, force: true})
    }
};

test.describe('Neo.ai.mcp.server.shared.services.EventLoopReporterService', () => {
    test.afterEach(() => EventLoopReporterService.stop());

    test('a stall above the bound leaves one WARN carrying the measured delay', async () => {
        const logger  = makeLogger(),
              options = {serviceKey: 'stall-witness', logger, stallWarnMs: 300};

        expect(EventLoopReporterService.start({serviceKey: 'stall-witness', logger, readConfig: manualWindows})).toBe(true);

        // The sampler has to be running before the stall, and it measures the stall when the loop
        // resumes and it fires late.
        await tick(50);
        busyWait(600);
        await tick(30);

        EventLoopReporterService.check(options);
        EventLoopReporterService.check(options);

        expect(logger.warnings).toHaveLength(1);
        expect(Number(logger.warnings[0].match(/stalled for up to (\d+) ms/)[1])).toBeGreaterThanOrEqual(500);
        expect(logger.warnings[0]).toContain('bound 300 ms');
    });

    test('a loop that stays under the bound leaves no WARN', async () => {
        const logger = makeLogger();

        EventLoopReporterService.start({serviceKey: 'quiet-witness', logger, readConfig: manualWindows});

        await tick(100);

        EventLoopReporterService.check({serviceKey: 'quiet-witness', logger, stallWarnMs: 5000});

        expect(logger.warnings).toHaveLength(0);
    });

    test('start() closes windows on the configured interval', async () => {
        const logger = makeLogger();

        EventLoopReporterService.start({serviceKey: 'interval-witness', logger, readConfig: () => ({checkIntervalMs: 50, stallWarnMs: 200})});

        await tick(30);
        busyWait(400);
        await tick(150);

        expect(logger.warnings.length).toBeGreaterThanOrEqual(1);
        expect(Number(logger.warnings[0].match(/stalled for up to (\d+) ms/)[1])).toBeGreaterThanOrEqual(300);
    });

    test('start() turns an unreadable config into false and a WARN, never into a failed boot', () => {
        const logger = makeLogger();

        expect(EventLoopReporterService.start({
            serviceKey: 'broken-config',
            logger,
            readConfig: () => {throw new Error('overlay unresolved')}
        })).toBe(false);

        expect(logger.warnings).toEqual(['[EventLoopReporter] NOT started for broken-config: overlay unresolved. Stalls and the exit reason stay unobservable.']);
        expect(EventLoopReporterService.timer).toBe(null);
    });

    test('a restart arms one exit line, and stop() disarms it', () => {
        const before = process.listenerCount('exit');

        EventLoopReporterService.start({serviceKey: 'arm-witness', logger: makeLogger(), readConfig: manualWindows});
        EventLoopReporterService.start({serviceKey: 'arm-witness', logger: makeLogger(), readConfig: manualWindows});

        expect(process.listenerCount('exit')).toBe(before + 1);

        EventLoopReporterService.stop();

        expect(process.listenerCount('exit')).toBe(before);
    });

    test('a drained loop exits with a line that says so, and lists no listener', () => {
        const {exit, result} = runExitWitness('drain');

        expect(result.status).toBe(0);
        expect(exit.code).toBe(0);
        expect(exit.drained).toBe(true);
        expect(exit.activeResources).not.toContain('TCPServerWrap');
        expect(exit.uptimeMs).toBeGreaterThan(0);
        expect(exit.usedHeapBytes).toBeGreaterThan(0);
        expect(exit.heapSizeLimitBytes).toBeGreaterThan(0);
        expect(exit.loopDelay.maxMs).toBeGreaterThanOrEqual(0);
        // The stderr copy is the one `docker logs` shows.
        expect(result.stderr).toContain('[EventLoopReporter] exit-witness exiting');
    });

    test('an exit called with the listener up is told apart from a drained loop', () => {
        const {exit, result} = runExitWitness('explicit');

        expect(result.status).toBe(0);
        expect(exit.code).toBe(0);
        expect(exit.drained).toBe(false);
        expect(exit.activeResources).toContain('TCPServerWrap');
    });
});
