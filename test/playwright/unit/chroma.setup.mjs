import {test as setup}                                  from '@playwright/test';
import os                                               from 'node:os';
import path                                             from 'node:path';
import {fileURLToPath}                                  from 'node:url';
import {reapUnitChromaOrphans, recordUnitChromaOwnership} from '../chromaOwnership.mjs';
import {resolveFreePortSync}                            from '../resolveFreePort.mjs';
import {
    cleanupChromaArtifacts, ownsChromaDataDir, startChromaProcess, stopDetachedProcess
} from '../chromaProcess.mjs';

const
    __dirname = path.dirname(fileURLToPath(import.meta.url)),
    repoRoot  = path.resolve(__dirname, '../../..');

setup.setTimeout(130000);

setup('start run-scoped Chroma for Brain unit tests', async () => {
    await reapUnitChromaOrphans({repoRoot});

    const
        runId       = `${process.pid}-${Date.now()}`,
        ownsDataDir = ownsChromaDataDir(),
        dataDir     = process.env.NEO_CHROMA_DATA_DIR_TEST ||
            path.join(os.tmpdir(), `neo-chroma-unit-test-${runId}`),
        host        = process.env.NEO_CHROMA_HOST_TEST || '127.0.0.1',
        port        = resolveFreePortSync(process.env.NEO_CHROMA_PORT_TEST),
        logPath     = ownsDataDir ? `${dataDir}.log` :
            path.join(os.tmpdir(), `neo-chroma-unit-test-${runId}.log`);

    delete process.env.NEO_UNIT_CHROMA_PID;

    Object.assign(process.env, {
        NEO_CHROMA_DATA_DIR_TEST     : dataDir,
        NEO_CHROMA_HOST_TEST         : host,
        NEO_CHROMA_PORT_TEST         : String(port),
        NEO_UNIT_CHROMA_DATA_DIR_AUTO: String(ownsDataDir),
        NEO_UNIT_CHROMA_LOG_PATH     : logPath
    });

    let pid;

    try {
        pid = await startChromaProcess({
            dataDir,
            host,
            logPath,
            port,
            repoRoot
        });
        process.env.NEO_UNIT_CHROMA_PID = String(pid);

        // Playwright's runner forks this setup worker; the runner outlives dependency workers.
        // A setup-worker PID would falsely classify an active suite as abandoned.
        recordUnitChromaOwnership({
            chromaPid: pid,
            dataDir,
            logPath,
            ownsDataDir,
            repoRoot,
            runnerPid: process.ppid
        })
    } catch (error) {
        if (pid && !(await stopDetachedProcess(pid)).groupEmpty) {
            throw new Error(`Chroma process group ${pid} survived failed setup; artifacts retained`, {cause: error})
        }

        cleanupChromaArtifacts({dataDir, logPath, ownsDataDir});
        throw error
    }
});
