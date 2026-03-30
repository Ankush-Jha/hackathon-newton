// src/mcp/serverProvider.ts
// Registers the Newton School MCP server with VS Code's MCP system

import * as vscode from 'vscode';

/**
 * Registers the Newton School MCP server as an auto-discoverable server.
 * When the extension is installed, the server appears in Copilot Agent Mode
 * without any manual mcp.json configuration.
 *
 * Constructor signature (positional):
 *   McpStdioServerDefinition(label, command, args?, env?, version?)
 */
export function registerNewtonMcpServer(
    context: vscode.ExtensionContext
): void {
    // Guard: MCP API may not exist in older VS Code versions
    if (!vscode.lm?.registerMcpServerDefinitionProvider) {
        console.warn(
            'Newton School: MCP API not available in this VS Code version. ' +
            'Please update to VS Code 1.102+ for full MCP support.'
        );
        vscode.window.showWarningMessage(
            'Newton School: Your VS Code version does not support MCP. ' +
            'Please update VS Code to 1.102 or later.'
        );
        return;
    }

    try {
        const didChangeEmitter = new vscode.EventEmitter<void>();

        const disposable = vscode.lm.registerMcpServerDefinitionProvider(
            'newtonSchoolMcp',
            {
                onDidChangeMcpServerDefinitions: didChangeEmitter.event,

                provideMcpServerDefinitions: async () => {
                    // Constructor: (label, command, args?, env?, version?)
                    const server = new vscode.McpStdioServerDefinition(
                        'Newton School',                         // label
                        'npx',                                   // command
                        ['-y', '@newtonschool/newton-mcp@latest'], // args
                        undefined,                               // env
                        '0.3.2'                                  // version
                    );
                    return [server];
                },

                resolveMcpServerDefinition: async (
                    server: vscode.McpServerDefinition
                ) => {
                    return server;
                },
            }
        );

        context.subscriptions.push(disposable);
        context.subscriptions.push(didChangeEmitter);

        console.log('Newton School: MCP server registered successfully.');
    } catch (err) {
        console.error('Newton School: Failed to register MCP server:', err);
        vscode.window.showErrorMessage(
            `Newton School: Failed to register MCP server. ${err instanceof Error ? err.message : String(err)}`
        );
    }
}
