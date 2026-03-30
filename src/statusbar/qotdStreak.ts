// src/statusbar/qotdStreak.ts
// Status bar item showing the student's Question of the Day streak

import * as vscode from 'vscode';

const QOTD_CACHE_KEY = 'newton.qotdStreak';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export class QotdStatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            200
        );

        // Set default state
        this.statusBarItem.text = '$(flame) QOTD';
        this.statusBarItem.tooltip =
            'Newton School — Question of the Day. Open Copilot to check your streak!';
        this.statusBarItem.command = {
            command: 'workbench.panel.chat.view.copilot.focus',
            title: 'Open Copilot Chat',
        };

        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);

        // Restore cached data
        const cached = context.globalState.get<{ streak: number; title: string }>(QOTD_CACHE_KEY);
        if (cached) {
            this.updateDisplay(cached.streak, cached.title);
        }

        // Start refresh timer
        this.refreshTimer = setInterval(() => {
            // Status bar data is refreshed when the user interacts with Copilot.
            // This timer is a reminder to keep the visual fresh.
        }, REFRESH_INTERVAL_MS);
    }

    /**
     * Update the QOTD display with new data.
     * Called externally when QOTD data is fetched.
     */
    updateDisplay(streak: number, title: string): void {
        this.statusBarItem.text = `$(flame) ${streak}`;
        this.statusBarItem.tooltip = `QOTD Streak: ${streak} days\n${title}\n\nClick to open Copilot Chat`;

        // Cache the data
        this.context.globalState.update(QOTD_CACHE_KEY, { streak, title });
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.statusBarItem.dispose();
    }
}
