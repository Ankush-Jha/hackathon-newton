// src/statusbar/authStatus.ts
// Status bar item showing Newton School authentication state

import * as vscode from 'vscode';
import { AuthManager, AuthState } from '../auth/authManager';

export class AuthStatusBar {
    private statusBarItem: vscode.StatusBarItem;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly authManager: AuthManager
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );

        this.update(authManager.state);
        this.statusBarItem.show();

        // Listen for auth state changes
        context.subscriptions.push(
            authManager.onDidChangeAuthState((state) => this.update(state))
        );
        context.subscriptions.push(this.statusBarItem);
    }

    private update(state: AuthState): void {
        switch (state) {
            case 'logged-in':
                this.statusBarItem.text = '$(check) Newton';
                this.statusBarItem.tooltip = 'Newton School — Connected. Click to open dashboard.';
                this.statusBarItem.command = 'newton.openDashboard';
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'logged-out':
                this.statusBarItem.text = '$(sign-in) Newton: Log In';
                this.statusBarItem.tooltip = 'Newton School — Click to log in';
                this.statusBarItem.command = 'newton.login';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                    'statusBarItem.warningBackground'
                );
                break;
            case 'unknown':
            default:
                this.statusBarItem.text = '$(circle-outline) Newton';
                this.statusBarItem.tooltip = 'Newton School — Status unknown. Click to log in.';
                this.statusBarItem.command = 'newton.login';
                this.statusBarItem.backgroundColor = undefined;
                break;
        }
    }
}
