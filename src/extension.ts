// src/extension.ts
// Newton School VS Code Extension — Main entry point
//
// Unified auth: newton.connect does MCP start + browser login in one step.
// Single status bar item. No dead AuthManager or separate status items.

import * as vscode from 'vscode';
import * as path from 'path';
import { registerNewtonMcpServer } from './mcp/serverProvider';
import { McpClient } from './mcp/mcpClient';
import { DashboardViewProvider } from './webview/dashboardProvider';
import { ProblemPanel } from './webview/problemPanel';
import { fetchQuestion, fetchQuestionByTitle, setProfileDir, openLoginBrowser } from './scraper/questionFetcher';
import { openAssignmentPanel } from './webview/assignmentPanel';

let mcpClient: McpClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
    console.log('Newton School extension activating...');

    try {
        // ── Initialize persistent Chrome profile for scraper login ────
        const profileDir = path.join(context.globalStorageUri.fsPath, 'chrome-profile');
        setProfileDir(profileDir);

        // ── Shared MCP Client ─────────────────────────────────────────
        mcpClient = new McpClient();
        context.subscriptions.push({ dispose: () => mcpClient?.dispose() });

        // ── MCP Server Registration (for Copilot, if available) ─────────
        registerNewtonMcpServer(context);

        // ── Single Status Bar Item ──────────────────────────────────────
        const statusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right, 100
        );
        statusBar.text = '$(mortar-board) Newton';
        statusBar.tooltip = 'Newton School — Click to open dashboard';
        statusBar.command = 'newton.openDashboard';
        statusBar.show();
        context.subscriptions.push(statusBar);

        // ── Dashboard Webview (powered by direct MCP client) ────────────
        const dashboardProvider = new DashboardViewProvider(
            context.extensionUri,
            mcpClient
        );
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                DashboardViewProvider.viewType,
                dashboardProvider
            )
        );

        // ── Commands ────────────────────────────────────────────────────
        context.subscriptions.push(
            // Unified connect: MCP start + browser login in sequence
            vscode.commands.registerCommand('newton.connect', async () => {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: '🔐 Newton School: Connecting...',
                        cancellable: false
                    },
                    async (progress) => {
                        try {
                            // Step 1: Start MCP server
                            progress.report({ message: 'Step 1/2: Starting MCP server...' });
                            if (!mcpClient!.isRunning) {
                                await mcpClient!.start();
                            }
                            statusBar.text = '$(check) Newton';

                            // Step 2: Open browser for login
                            progress.report({ message: 'Step 2/2: Opening browser for login...' });
                            await openLoginBrowser();

                            vscode.window.showInformationMessage('✅ Newton School: Connected! Open the dashboard to get started.');
                        } catch (err) {
                            vscode.window.showErrorMessage(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                );
            }),

            // Legacy login alias (just browser login)
            vscode.commands.registerCommand('newton.login', async () => {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: '🔐 Opening Chrome for Newton School login...',
                        cancellable: false
                    },
                    async () => {
                        try {
                            await openLoginBrowser();
                            vscode.window.showInformationMessage('✅ Newton School: Login session saved!');
                        } catch (err) {
                            vscode.window.showErrorMessage(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                );
            }),

            vscode.commands.registerCommand('newton.openDashboard', () => {
                vscode.commands.executeCommand('newton.dashboardView.focus');
            }),

            vscode.commands.registerCommand('newton.refreshStatus', () => {
                dashboardProvider.refresh();
                vscode.window.showInformationMessage('Newton School: Refreshing data...');
            }),

            vscode.commands.registerCommand('newton.fetchQuestion', async (urlArg?: string) => {
                const url = urlArg || await vscode.window.showInputBox({
                    prompt: 'Enter Newton School question URL',
                    placeHolder: 'https://my.newtonschool.co/playground/...',
                    validateInput: (v) => v.includes('newtonschool') || v.includes('http') ? null : 'Enter a valid URL'
                });
                if (!url) { return; }
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: '🔍 Fetching question via Chrome...' },
                    async () => {
                        try {
                            const data = await fetchQuestion(url);
                            ProblemPanel.show(context.extensionUri, data);
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            if (msg === 'NOT_LOGGED_IN') {
                                const action = await vscode.window.showWarningMessage(
                                    'You need to log in to Newton School first.', 'Login Now'
                                );
                                if (action === 'Login Now') {
                                    vscode.commands.executeCommand('newton.login');
                                }
                            } else {
                                vscode.window.showErrorMessage(`Failed to fetch: ${msg}`);
                            }
                        }
                    }
                );
            }),

            vscode.commands.registerCommand('newton.openProblemDirect', async (questionData: Record<string, unknown>) => {
                const title = String(questionData.title || 'Problem');
                const arenaUrl = String(questionData.url || '');
                const metadata = {
                    title,
                    difficulty: String(questionData.difficulty || ''),
                    topics: Array.isArray(questionData.topics) ? questionData.topics as string[] : [],
                    companies: Array.isArray(questionData.companies) ? questionData.companies as string[] : []
                };

                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `🔍 Fetching "${title}"...`, cancellable: false },
                    async () => {
                        try {
                            const data = await fetchQuestionByTitle(title, arenaUrl, metadata);
                            ProblemPanel.show(context.extensionUri, data);
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            if (msg === 'NOT_LOGGED_IN') {
                                const action = await vscode.window.showWarningMessage(
                                    'You need to log in to Newton School first.', 'Login Now'
                                );
                                if (action === 'Login Now') {
                                    await vscode.commands.executeCommand('newton.login');
                                    vscode.window.showInformationMessage(`Try opening "${title}" again after logging in.`);
                                }
                            } else {
                                ProblemPanel.show(context.extensionUri, {
                                    title,
                                    description: `Could not fetch full content.\n\nError: ${msg}`,
                                    inputFormat: '', outputFormat: '',
                                    examples: [], constraints: '', fullText: '',
                                    url: arenaUrl,
                                    difficulty: metadata.difficulty,
                                    topics: metadata.topics,
                                    companies: metadata.companies
                                });
                            }
                        }
                    }
                );
            }),

            // Open assignment panel — API-first approach (no scraping)
            vscode.commands.registerCommand('newton.openAssignment', async (url: string) => {
                if (!url) {
                    url = await vscode.window.showInputBox({
                        prompt: 'Enter Newton School assignment URL',
                        placeHolder: 'https://my.newtonschool.co/course/.../assignment/...',
                    }) || '';
                }
                if (url) {
                    await openAssignmentPanel(url, context, mcpClient);
                }
            })
        );

        console.log('Newton School extension activated successfully!');
    } catch (err) {
        console.error('Newton School: Activation failed:', err);
        vscode.window.showErrorMessage(
            `Newton School extension failed to activate: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

export function deactivate(): void {
    mcpClient?.dispose();
    console.log('Newton School extension deactivated.');
}
