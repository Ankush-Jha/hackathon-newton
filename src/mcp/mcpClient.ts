// src/mcp/mcpClient.ts
// Direct MCP client — spawns the Newton School MCP server as a child process
// and communicates via JSON-RPC 2.0 over stdio.

import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id?: number;
    method?: string;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
    params?: unknown;
}

// Output channel for debugging
const outputChannel = vscode.window.createOutputChannel('Newton School MCP');

function log(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    outputChannel.appendLine(`[${ts}] ${msg}`);
    console.log(`[Newton MCP] ${msg}`);
}

export class McpClient {
    private process: ChildProcess | null = null;
    private nextId = 1;
    private pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (reason: Error) => void;
    }>();
    private buffer = '';
    private _initialized = false;

    /**
     * Start the MCP server process and initialize the connection
     */
    async start(): Promise<void> {
        if (this.process && this._initialized) {
            log('Already connected, skipping start');
            return;
        }

        // Kill any previous process
        this.dispose();

        log('Starting Newton School MCP server...');
        outputChannel.show(true); // Show output channel so user can see progress

        return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                log('ERROR: Connection timed out after 60 seconds');
                reject(new Error('MCP server start timed out. Make sure Node.js/npx is installed.'));
            }, 60000);

            try {
                // Ensure PATH includes common Node.js locations
                const env = { ...process.env };
                const extraPaths = [
                    '/opt/homebrew/bin',
                    '/usr/local/bin',
                    '/usr/bin',
                    `${process.env.HOME}/.nvm/versions/node`,
                    `${process.env.HOME}/.volta/bin`,
                ];
                env.PATH = `${extraPaths.join(':')}:${env.PATH || ''}`;

                log(`Using PATH: ${env.PATH?.substring(0, 200)}...`);
                log('Spawning: npx -y @newtonschool/newton-mcp@latest');

                this.process = spawn('npx', ['-y', '@newtonschool/newton-mcp@latest'], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    shell: true,
                    env,
                });

                log(`Process spawned with PID: ${this.process.pid}`);

                this.process.stdout?.on('data', (data: Buffer) => {
                    const str = data.toString();
                    log(`[stdout] ${str.substring(0, 500)}`);
                    this.handleData(str);
                });

                this.process.stderr?.on('data', (data: Buffer) => {
                    const str = data.toString().trim();
                    if (str) {
                        log(`[stderr] ${str}`);
                    }
                });

                this.process.on('error', (err) => {
                    log(`ERROR: Process error: ${err.message}`);
                    clearTimeout(timeout);
                    reject(err);
                });

                this.process.on('exit', (code, signal) => {
                    log(`Process exited: code=${code}, signal=${signal}`);
                    this._initialized = false;
                    this.process = null;
                    for (const [, handler] of this.pending) {
                        handler.reject(new Error(`MCP server exited (code ${code})`));
                    }
                    this.pending.clear();
                });

                // Wait for process to be ready, then initialize
                // npx might need time to download the package
                const tryInitialize = async (attempt: number): Promise<void> => {
                    if (attempt > 20) {
                        clearTimeout(timeout);
                        reject(new Error('Failed to initialize after 20 attempts'));
                        return;
                    }

                    if (!this.process || this.process.exitCode !== null) {
                        clearTimeout(timeout);
                        reject(new Error('MCP server process died before initialization'));
                        return;
                    }

                    try {
                        log(`Initialize attempt ${attempt}...`);
                        const result = await this.sendRequest('initialize', {
                            protocolVersion: '2024-11-05',
                            capabilities: {},
                            clientInfo: {
                                name: 'newton-vscode',
                                version: '0.1.0',
                            },
                        });

                        log(`Initialize response: ${JSON.stringify(result).substring(0, 300)}`);

                        // Send initialized notification
                        this.sendNotification('notifications/initialized', {});
                        this._initialized = true;
                        clearTimeout(timeout);
                        log('✅ MCP server initialized successfully!');
                        resolve();
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        log(`Initialize attempt ${attempt} failed: ${msg}`);
                        // Retry after 3 seconds
                        setTimeout(() => tryInitialize(attempt + 1), 3000);
                    }
                };

                // Start trying after 3 seconds (give npx time to start)
                setTimeout(() => tryInitialize(1), 3000);

            } catch (err) {
                clearTimeout(timeout);
                const msg = err instanceof Error ? err.message : String(err);
                log(`ERROR: Failed to spawn: ${msg}`);
                reject(err);
            }
        });
    }

    /**
     * Call an MCP tool and return the result
     */
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
        if (!this._initialized) {
            await this.start();
        }

        log(`Calling tool: ${name} with args: ${JSON.stringify(args)}`);
        const result = await this.sendRequest('tools/call', {
            name,
            arguments: args,
        });
        log(`Tool ${name} result received (${JSON.stringify(result).length} bytes)`);
        return result;
    }

    /**
     * List available tools
     */
    async listTools(): Promise<unknown> {
        if (!this._initialized) {
            await this.start();
        }
        return this.sendRequest('tools/list', {});
    }

    private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin) {
                reject(new Error('MCP server not running'));
                return;
            }

            const id = this.nextId++;
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params,
            };

            this.pending.set(id, { resolve, reject });

            const message = JSON.stringify(request);
            log(`>> Sending: ${message.substring(0, 300)}`);

            try {
                this.process.stdin.write(message + '\n');
            } catch (err) {
                this.pending.delete(id);
                reject(err);
                return;
            }

            // Timeout after 30s
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`Request ${method} timed out after 30s`));
                }
            }, 30000);
        });
    }

    private sendNotification(method: string, params?: Record<string, unknown>): void {
        if (!this.process?.stdin) { return; }
        const notification = { jsonrpc: '2.0', method, params };
        try {
            this.process.stdin.write(JSON.stringify(notification) + '\n');
        } catch {
            // Ignore write errors for notifications
        }
    }

    private handleData(data: string): void {
        this.buffer += data;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) { continue; }

            try {
                const response: JsonRpcResponse = JSON.parse(trimmed);

                if (response.id !== undefined && this.pending.has(response.id)) {
                    const handler = this.pending.get(response.id)!;
                    this.pending.delete(response.id);

                    if (response.error) {
                        handler.reject(new Error(response.error.message));
                    } else {
                        handler.resolve(response.result);
                    }
                } else if (response.method) {
                    // Server-initiated notification/request — log it
                    log(`<< Server notification: ${response.method}`);
                }
            } catch {
                log(`<< Non-JSON line: ${trimmed.substring(0, 200)}`);
            }
        }
    }

    get isRunning(): boolean {
        return this._initialized && this.process !== null;
    }

    dispose(): void {
        if (this.process) {
            log('Disposing MCP client, killing process...');
            this.process.kill();
            this.process = null;
            this._initialized = false;
        }
        for (const [, handler] of this.pending) {
            handler.reject(new Error('Client disposed'));
        }
        this.pending.clear();
    }
}
