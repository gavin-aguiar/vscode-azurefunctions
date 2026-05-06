/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type DebugConfiguration, type WorkspaceFolder } from 'vscode';
import { hostStartTaskName, localhost } from '../constants';
import { localize } from '../localize';
import { FuncDebugProviderBase } from './FuncDebugProviderBase';

export const defaultGoDebugPort: number = 2345;

export const goDebugConfig: DebugConfiguration = {
    name: localize('attachGo', 'Attach to Go Functions'),
    type: 'go',
    request: 'attach',
    mode: 'remote',
    port: defaultGoDebugPort,
    host: localhost,
    preLaunchTask: hostStartTaskName
};

export class GoDebugProvider extends FuncDebugProviderBase {
    public readonly workerArgKey: string = 'GOLANG_WORKER_DEBUG_FLAGS';
    protected readonly defaultPortOrPipeName: number = defaultGoDebugPort;
    protected readonly debugConfig: DebugConfiguration = goDebugConfig;

    // Track the background dlv attach process so we can clean up
    private _dlvAttachPromise: Promise<void> | undefined;

    public async getWorkerArgValue(_folder: WorkspaceFolder): Promise<string> {
        return '-gcflags="all=-N -l"';
    }

    public async resolveDebugConfiguration(
        folder: WorkspaceFolder | undefined,
        debugConfiguration: DebugConfiguration,
        token?: import('vscode').CancellationToken
    ): Promise<DebugConfiguration | undefined> {
        const result = await super.resolveDebugConfiguration(folder, debugConfiguration, token);
        if (result && result.mode === 'remote') {
            const port = result.port || defaultGoDebugPort;
            // Fire-and-forget: poll for app.exe and spawn dlv concurrently with preLaunchTask.
            // The preLaunchTask (func host start) builds and runs app.exe.
            // This poller detects app.exe and spawns dlv attach before VS Code connects.
            this._dlvAttachPromise = pollAndAttachDlv(port);
            this._dlvAttachPromise.catch((err) => {
                console.error('Failed to auto-attach dlv:', err);
            });
        }
        return result;
    }
}

/**
 * Polls for the Go worker process (`app` / `app.exe`) and spawns `dlv attach`
 * in headless mode once found. This runs concurrently with the preLaunchTask
 * so that dlv is listening by the time VS Code tries to connect.
 */
async function pollAndAttachDlv(port: number): Promise<void> {
    // Kill any stale dlv processes listening on this port from previous sessions
    await killStaleDlv(port);

    // Poll for the Go worker process (up to 120 seconds to account for build time)
    const pid = await pollForGoWorkerPid(120_000);
    if (!pid) {
        console.warn('Could not find Go worker process "app". Skipping dlv auto-attach.');
        return;
    }

    // Double-check port isn't taken (another dlv may have started)
    if (await isPortInUse(port)) {
        return;
    }

    const { spawn } = await import('child_process');

    const dlvProcess = spawn('dlv', [
        'attach', pid.toString(),
        '--headless',
        '--continue',
        `--listen=:${port}`,
        '--api-version=2',
        '--accept-multiclient'
    ], {
        detached: true,
        stdio: 'ignore'
    });
    dlvProcess.unref();

    // Wait for dlv to start listening
    await waitForPort(port, 10_000);
}

/**
 * Kills any stale dlv.exe processes that are listening on the target port.
 */
async function killStaleDlv(port: number): Promise<void> {
    if (!await isPortInUse(port)) {
        return;
    }

    try {
        const { execSync } = await import('child_process');

        if (process.platform === 'win32') {
            // Find the PID using the port, then check if it's dlv
            const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            const match = output.match(/LISTENING\s+(\d+)/);
            if (match) {
                const pid = match[1];
                // Verify it's dlv before killing
                const taskInfo = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
                if (taskInfo.includes('dlv.exe')) {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
                    // Wait briefly for port to be freed
                    await sleep(1000);
                }
            }
        } else {
            const output = execSync(`lsof -ti :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            const pid = output.trim();
            if (pid) {
                // Verify it's dlv before killing
                const procInfo = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
                if (procInfo.trim() === 'dlv') {
                    execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
                    await sleep(1000);
                }
            }
        }
    } catch {
        // Ignore errors during cleanup
    }
}

/**
 * Polls for the Go worker process every second until found or timeout.
 */
async function pollForGoWorkerPid(timeoutMs: number): Promise<number | undefined> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const pid = await findGoWorkerPid();
        if (pid) {
            return pid;
        }
        await sleep(1000);
    }

    return undefined;
}

async function findGoWorkerPid(): Promise<number | undefined> {
    try {
        const { execSync } = await import('child_process');

        if (process.platform === 'win32') {
            const output = execSync('tasklist /FI "IMAGENAME eq app.exe" /FO CSV /NH', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            const match = output.match(/"app\.exe","(\d+)"/);
            return match ? parseInt(match[1]) : undefined;
        } else {
            const output = execSync('pgrep -x app', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            const pid = parseInt(output.trim().split('\n')[0]);
            return isNaN(pid) ? undefined : pid;
        }
    } catch {
        return undefined;
    }
}

async function isPortInUse(port: number): Promise<boolean> {
    const { createConnection } = await import('net');
    return new Promise<boolean>((resolve) => {
        const socket = createConnection({ port, host: '127.0.0.1' }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => {
            resolve(false);
        });
    });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
    const { createConnection } = await import('net');
    const start = Date.now();

    return new Promise<void>((resolve, reject) => {
        function tryConnect(): void {
            if (Date.now() - start > timeoutMs) {
                reject(new Error(`Timed out waiting for dlv to start on port ${port}`));
                return;
            }

            const socket = createConnection({ port, host: '127.0.0.1' }, () => {
                socket.destroy();
                resolve();
            });
            socket.on('error', () => {
                setTimeout(tryConnect, 500);
            });
        }
        tryConnect();
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

