// src/auth/authManager.ts
// Manages authentication state for Newton School extension

import * as vscode from 'vscode';

const AUTH_STATE_KEY = 'newton.authState';

export type AuthState = 'logged-in' | 'logged-out' | 'unknown';

/**
 * Manages the Newton School authentication lifecycle.
 * 
 * The actual authentication is handled by the MCP server itself (browser OAuth).
 * This manager tracks the auth state within VS Code for UI purposes (status bar, etc).
 */
export class AuthManager {
    private _onDidChangeAuthState = new vscode.EventEmitter<AuthState>();
    readonly onDidChangeAuthState = this._onDidChangeAuthState.event;

    private _state: AuthState = 'unknown';

    constructor(private readonly context: vscode.ExtensionContext) {
        // Restore last known state
        const saved = context.globalState.get<AuthState>(AUTH_STATE_KEY);
        this._state = saved ?? 'unknown';
    }

    get state(): AuthState {
        return this._state;
    }

    /**
     * Triggers the login flow.
     * The MCP server handles OAuth via browser — we just need to ensure
     * the server is started (which triggers login if needed).
     */
    async login(): Promise<void> {
        try {
            // Show a message guiding the user
            const action = await vscode.window.showInformationMessage(
                'Newton School: The MCP server will open your browser for login when it starts. ' +
                'Make sure the Newton School MCP server is running in Copilot.',
                'Open Copilot Chat'
            );

            if (action === 'Open Copilot Chat') {
                await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
            }

            // Update state optimistically — the MCP server handles the actual auth
            this.updateState('logged-in');
        } catch (error) {
            vscode.window.showErrorMessage(
                `Newton School login failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * Logs user out by clearing local state.
     * The actual credential clearing happens when the MCP server's `logout` tool is called.
     */
    async logout(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Newton School: Are you sure you want to log out?',
            { modal: true },
            'Log Out'
        );

        if (confirm === 'Log Out') {
            this.updateState('logged-out');
            vscode.window.showInformationMessage(
                'Newton School: Logged out. Use the `logout` tool in Copilot chat to clear server credentials.'
            );
        }
    }

    private updateState(newState: AuthState): void {
        this._state = newState;
        this.context.globalState.update(AUTH_STATE_KEY, newState);
        this._onDidChangeAuthState.fire(newState);
    }

    dispose(): void {
        this._onDidChangeAuthState.dispose();
    }
}
