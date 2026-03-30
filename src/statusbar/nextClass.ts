// src/statusbar/nextClass.ts
// Status bar item showing the next upcoming class/event

import * as vscode from 'vscode';

const NEXT_CLASS_CACHE_KEY = 'newton.nextClass';

export class NextClassStatusBar {
    private statusBarItem: vscode.StatusBarItem;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            199
        );

        // Default state
        this.statusBarItem.text = '$(book) Schedule';
        this.statusBarItem.tooltip =
            'Newton School — Upcoming schedule. Open Copilot to check!';
        this.statusBarItem.command = {
            command: 'workbench.panel.chat.view.copilot.focus',
            title: 'Open Copilot Chat',
        };

        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);

        // Restore cached data
        const cached = context.globalState.get<{
            subject: string;
            time: string;
        }>(NEXT_CLASS_CACHE_KEY);
        if (cached) {
            this.updateDisplay(cached.subject, cached.time);
        }
    }

    /**
     * Update with next class info.
     * Called externally when schedule data is fetched.
     */
    updateDisplay(subject: string, time: string): void {
        this.statusBarItem.text = `$(book) ${subject} @ ${time}`;
        this.statusBarItem.tooltip = `Next Class: ${subject}\nTime: ${time}\n\nClick to see full schedule`;

        this.context.globalState.update(NEXT_CLASS_CACHE_KEY, { subject, time });
    }

    /**
     * Show "No upcoming classes" state
     */
    showNoClasses(): void {
        this.statusBarItem.text = '$(book) No classes today';
        this.statusBarItem.tooltip = 'No upcoming classes scheduled.\nClick to check full schedule.';
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
