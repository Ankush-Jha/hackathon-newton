// src/webview/assignmentPanel.ts
// Assignment Panel: Shows all questions in an assignment with full details.
// Uses the ported newton-submit-mcp API functions for robust data fetching.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    listAssignmentsWithQuestions,
    fetchAssignmentQuestionDetail,
    fetchPlayground,
    submitSolutionToNewton,
    setBearerToken,
    setSessionCookie,
    hasAuth,
    PlaygroundProblem,
    AssignmentQuestionRef,
} from '../api/newtonApi';
import { getCookiesForDomain } from '../scraper/questionFetcher';

let currentPanel: vscode.WebviewPanel | undefined;

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Newton submission status codes */
const STATUS_MAP: Record<number, string> = {
    1: 'Compiling', 2: 'Running', 3: 'Accepted', 4: 'Wrong Answer',
    5: 'Time Limit Exceeded', 6: 'Compilation Error', 7: 'Runtime Error',
    8: 'Memory Limit Exceeded', 9: 'Output Limit', 10: 'Internal Error', 11: 'Processing',
};

/** Handle submission from webview: reads editor code, submits to Newton, sends result back */
async function handleSubmitCode(
    playgroundHash: string,
    languageId: number,
    questionId: string,
    panel: vscode.WebviewPanel
): Promise<void> {
    try {
        // Get code from active editor
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            const editors = vscode.window.visibleTextEditors;
            if (editors.length > 0) editor = editors[editors.length - 1];
        }
        if (!editor) {
            panel.webview.postMessage({ command: 'submitError', questionId, error: 'No active editor — open your solution file first.' });
            return;
        }
        const code = editor.document.getText();
        if (!code.trim()) {
            panel.webview.postMessage({ command: 'submitError', questionId, error: 'Solution file is empty.' });
            return;
        }

        // Ensure auth
        if (!hasAuth()) {
            const cookies = await getCookiesForDomain();
            setSessionCookie(cookies);
        }

        // Submit and poll for result
        const response = await submitSolutionToNewton(playgroundHash, languageId, code);
        const raw = response.raw as Record<string, any>;

        // --- Parse result using Newton's actual response structure ---
        // current_status is NUMERIC: 3=Accepted, 4=Wrong Answer, 5=TLE, 6=CE, 7=RE, etc.
        const statusCode = typeof raw.current_status === 'number' ? raw.current_status : 0;
        const status = STATUS_MAP[statusCode] || (typeof raw.current_status === 'string' ? raw.current_status : 'Unknown');
        const isPass = statusCode === 3 || raw.wrong_submission === false;

        // Test case data lives in submission_test_case_mappings[]
        const testCases: any[] = Array.isArray(raw.submission_test_case_mappings) ? raw.submission_test_case_mappings : [];
        const totalCount = testCases.length || (typeof raw.number_of_test_cases_passing === 'number' ? undefined : undefined);
        const passedCount = typeof raw.number_of_test_cases_passing === 'number'
            ? raw.number_of_test_cases_passing
            : testCases.filter((tc: any) => tc?.status === 3 || String(tc?.status_text || '').toLowerCase() === 'accepted').length;

        // Aggregate runtime & memory from test cases
        let bestTime = 0, maxMemory = 0;
        for (const tc of testCases) {
            if (typeof tc?.time === 'number' && tc.time > bestTime) bestTime = tc.time;
            if (typeof tc?.memory === 'number' && tc.memory > maxMemory) maxMemory = tc.memory;
        }
        const runtime = bestTime > 0 ? `${bestTime}s` : undefined;
        const memory = maxMemory > 0 ? maxMemory : undefined;
        const score = typeof raw.score === 'number' ? raw.score : typeof raw.marks_obtained === 'number' ? raw.marks_obtained : undefined;

        panel.webview.postMessage({
            command: 'submitResult',
            questionId,
            result: { status, runtime, memory, score, passedCount, totalCount: totalCount || testCases.length, isPass }
        });

        // VS Code notification
        if (isPass) {
            vscode.window.showInformationMessage(`✅ ${status} — ${passedCount}/${testCases.length} test cases passed!`);
        } else {
            vscode.window.showWarningMessage(`❌ ${status} — ${passedCount}/${testCases.length} test cases passed`);
        }
    } catch (err) {
        panel.webview.postMessage({
            command: 'submitError',
            questionId,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}

/**
 * Parse an assignment URL to extract course/subject hash and assignment hash.
 * URL format: /course/{hash}/assignment/{hash}
 */
function parseAssignmentUrl(url: string): { courseHash: string; assignmentHash: string } | null {
    const m = url.match(/\/course\/([a-z0-9]+)\/assignment\/([a-z0-9]+)/i);
    return m ? { courseHash: m[1], assignmentHash: m[2] } : null;
}

/**
 * Ensure auth is set up for direct API calls.
 */
async function ensureAuth(): Promise<void> {
    if (hasAuth()) return;
    try {
        const cookies = await getCookiesForDomain();
        if (cookies) {
            setSessionCookie(cookies);
            // Also extract bearer token from cookies
            const tokenMatch = cookies.match(/access_token_ns_student_web=([^;]+)/);
            if (tokenMatch) {
                setBearerToken(tokenMatch[1]);
            }
        }
    } catch {
        // Auth will fail later with a clear error
    }
}

/**
 * Open the assignment panel and load all questions.
 */
export async function openAssignmentPanel(
    url: string,
    context: vscode.ExtensionContext,
    _mcpClient?: unknown
): Promise<void> {
    const parsed = parseAssignmentUrl(url);
    if (!parsed) {
        vscode.window.showErrorMessage('Invalid assignment URL.');
        return;
    }

    // Always create fresh panel to avoid stale script cache
    if (currentPanel) {
        currentPanel.dispose();
        currentPanel = undefined;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'newtonAssignment', '📚 Loading...', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    currentPanel.onDidDispose(() => { currentPanel = undefined; });

    currentPanel.webview.html = loadingHtml();

    // Set up message handler
    currentPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'openExternal' && msg.url) {
            vscode.env.openExternal(vscode.Uri.parse(msg.url));
        } else if (msg.type === 'createSolution' && msg.question) {
            await createSolutionFile(msg.question, context);
        } else if (msg.type === 'submitCode' && msg.playgroundHash) {
            await handleSubmitCode(msg.playgroundHash, msg.languageId, msg.questionId, currentPanel!);
        }
    });

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '📚 Loading assignment...', cancellable: false },
        async (progress) => {
            try {
                await ensureAuth();

                progress.report({ message: 'Fetching questions...' });

                // Step 1: Get all assignment questions for this course
                const allRefs = await listAssignmentsWithQuestions(parsed.courseHash);

                // Filter to just this assignment
                const questionRefs = allRefs.filter(r => r.assignmentHash === parsed.assignmentHash);
                const assignmentTitle = questionRefs[0]?.assignmentTitle ?? 'Assignment';

                if (questionRefs.length === 0) {
                    if (currentPanel) {
                        currentPanel.title = 'Assignment';
                        currentPanel.webview.html = errorHtml(
                            'No questions found',
                            `Could not find questions for this assignment. It may have expired or require different access.`,
                            url
                        );
                    }
                    return;
                }

                // Step 2: Try to fetch full question details
                // First, log what we got from the assignment listing to debug
                const loadedProblems: (PlaygroundProblem | null)[] = new Array(questionRefs.length).fill(null);
                const errorDetails: { idx: number; title: string; error: string }[] = [];

                // Try fetching each question - one at a time to avoid rate limits
                for (let i = 0; i < questionRefs.length; i++) {
                    const ref = questionRefs[i];
                    progress.report({ message: `Loading question ${i + 1}/${questionRefs.length}: ${ref.questionTitle || '...'}` });

                    try {
                        // Step 2a: Get the question detail (which contains playground hash)
                        const detail = await fetchAssignmentQuestionDetail(
                            parsed.courseHash, ref.assignmentHash, ref.questionHash
                        );

                        // Try multiple possible field names for the playground hash
                        const pgHash = (
                            detail.hash ??
                            detail.playground_hash ??
                            detail.playgroundHash ??
                            detail.playground ??
                            (detail.assignment_question as Record<string, unknown>)?.hash ??
                            (detail.assignment_question as Record<string, unknown>)?.playground_hash
                        ) as string | undefined;

                        if (!pgHash) {
                            // Log what keys we DID get so we can find the right field
                            const keys = Object.keys(detail).join(', ');
                            errorDetails.push({
                                idx: i,
                                title: ref.questionTitle || ref.questionHash,
                                error: `No playground hash found. Available keys: [${keys}]`
                            });
                            continue;
                        }

                        // Step 2b: Fetch full problem from playground
                        const problem = await fetchPlayground(pgHash);
                        loadedProblems[i] = problem;

                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        errorDetails.push({
                            idx: i,
                            title: ref.questionTitle || ref.questionHash,
                            error: msg
                        });
                    }
                }

                // Step 3: Render the panel with whatever we got + error details
                if (currentPanel) {
                    currentPanel.title = assignmentTitle;
                    const loadedCount = loadedProblems.filter(p => p !== null).length;
                    currentPanel.webview.html = renderAssignment(
                        assignmentTitle, loadedProblems, questionRefs, url,
                        currentPanel.webview, errorDetails, loadedCount
                    );
                }

            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (currentPanel) {
                    currentPanel.webview.html = errorHtml('Failed to load', msg, url);
                }
            }
        }
    );
}

/**
 * Create a solution file with boilerplate code for a question.
 */
async function createSolutionFile(question: { title: string; slug: string; boilerplate: string; langSlug: string }, _context: vscode.ExtensionContext): Promise<void> {
    const extMap: Record<string, string> = {
        javascript: 'js', typescript: 'ts', python: 'py', cpp: 'cpp', c: 'c',
        java: 'java', go: 'go', rust: 'rs', csharp: 'cs', mysql: 'sql',
    };
    const ext = extMap[question.langSlug] ?? question.langSlug;
    const fileName = `${question.slug || question.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}.${ext}`;

    const folders = vscode.workspace.workspaceFolders;
    const dir = folders?.[0]?.uri.fsPath ?? require('os').homedir();
    const filePath = path.join(dir, 'newton-solutions', fileName);

    if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, question.boilerplate || `// ${question.title}\n`);
    }

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
}

// ── HTML Renderers ──

function loadingHtml(): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
body { background: #E8FAF9; color: #223131; font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; }
.loader { text-align: center; }
.spinner { width: 40px; height: 40px; border: 3px solid #9FB1B0; border-top: 3px solid #00675F; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style></head><body><div class="loader"><div class="spinner"></div><p>Loading assignment questions...</p></div></body></html>`;
}

function errorHtml(title: string, message: string, url: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
body { background: #E8FAF9; color: #223131; font-family: -apple-system, sans-serif; padding: 40px; display: flex; justify-content: center; }
.card { max-width: 500px; background: #FFFFFF; border: 2px solid #223131; border-radius: 12px; padding: 32px; text-align: center; box-shadow: 4px 4px 0 0 #223131; }
h2 { color: #9B3D37; margin-bottom: 12px; font-weight: 900; }
p { color: #4E5F5E; line-height: 1.6; }
.btn { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #00675F; color: #BFFFF5; border: 2px solid #223131; border-radius: 10px; font-weight: 800; cursor: pointer; text-decoration: none; box-shadow: 3px 3px 0 0 #223131; }
</style></head><body><div class="card">
<h2>❌ ${esc(title)}</h2>
<p>${esc(message)}</p>
<a class="btn" href="${esc(url)}">Open in Browser</a>
</div></body></html>`;
}

function renderAssignment(
    title: string,
    problems: (PlaygroundProblem | null)[],
    refs: AssignmentQuestionRef[],
    url: string,
    webview?: vscode.Webview,
    errorDetails?: { idx: number; title: string; error: string }[],
    loadedCount?: number
): string {
    const nonce = getNonce();
    const errors = errorDetails || [];
    const errorMap = new Map(errors.map(e => [e.idx, e.error]));

    // Render each question — use full problem data when available, fallback otherwise
    const questionsHtml = refs.map((ref, i) => {
        const p = problems[i];
        if (p) {
            return renderQuestion(p, i);
        }
        // Fallback: show error + Open in Browser
        const qUrl = `https://my.newtonschool.co/course/${ref.assignmentHash}/playground/${ref.questionHash}`;
        const errMsg = errorMap.get(i) || 'Unknown error';
        return `
            <div class="q-card" data-idx="${i}">
                <div class="q-header">
                    <span class="q-num">${i + 1}</span>
                    <span class="q-title">${esc(ref.questionTitle || 'Question')}</span>
                    <span class="q-type">${esc(ref.questionType || 'coding')}</span>
                    <span class="q-arrow">▼</span>
                </div>
                <div class="q-body">
                    <div class="error-detail">
                        <div class="error-label">⚠️ Failed to load details:</div>
                        <pre class="error-msg">${esc(errMsg)}</pre>
                    </div>
                    <button class="btn-open" data-url="${esc(qUrl)}">🌐 Open in Browser</button>
                </div>
            </div>
        `;
    }).join('\n');

    // Build CSP - use webview.cspSource if available, otherwise permissive
    const cspSource = webview?.cspSource ?? '*';
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource};`;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root {
    --bg: #E8FAF9; --surface: #FFFFFF; --surface2: #E1F5F4;
    --border: #223131; --text: #223131; --text2: #4E5F5E;
    --pri: #00675F; --pri-ctr: #7EF0E2; --green: #00675F; --red: #9B3D37;
    --yellow: #705900; --yellow-ctr: #FDD34D; --blue: #00675F;
    --outline: #697A79; --outline-var: #9FB1B0;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; -webkit-font-smoothing: antialiased; }
.container { max-width: 800px; margin: 0 auto; }

.header { padding: 20px 24px; background: var(--surface); border: 2px solid var(--border); border-radius: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; box-shadow: 4px 4px 0 0 rgba(34,49,49,0.15); }
.header h1 { font-size: 20px; font-weight: 900; }
.header .meta { color: var(--text2); font-size: 13px; font-weight: 700; }

.q-card { background: var(--surface); border: 2px solid var(--border); border-radius: 12px; margin-bottom: 10px; overflow: hidden; transition: all 0.2s; box-shadow: 2px 2px 0 0 rgba(34,49,49,1); }
.q-card:hover { box-shadow: 4px 4px 0 0 rgba(34,49,49,1); }
.q-header { padding: 14px 18px; display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; }
.q-num { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; background: var(--pri); color: #BFFFF5; border-radius: 8px; font-size: 12px; font-weight: 900; flex-shrink: 0; border: 2px solid var(--border); }
.q-title { flex: 1; font-weight: 800; font-size: 14px; }
.q-type { font-size: 11px; color: var(--text2); text-transform: uppercase; font-weight: 800; }
.q-arrow { font-size: 12px; color: var(--text2); transition: transform 0.3s; }
.q-body { max-height: 0; overflow: hidden; padding: 0 18px; border-top: 2px solid transparent; transition: max-height 0.4s ease, padding 0.3s ease, border-color 0.3s; }
.q-card.expanded .q-body { max-height: 5000px; padding: 14px 18px 18px; border-top-color: var(--border); }
.q-card.expanded .q-arrow { transform: rotate(180deg); }

/* Sections */
.q-section { margin-bottom: 20px; }
.q-section:last-child { margin-bottom: 0; }
.section-label { font-size: 11px; font-weight: 800; text-transform: uppercase; color: var(--outline); letter-spacing: 1.5px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }

/* Description */
.desc-box { background: var(--surface2); border-radius: 12px; padding: 16px 18px; border: 2px solid var(--border); }
.desc-para { font-size: 13px; line-height: 1.8; color: var(--text); margin: 0 0 10px; }
.desc-para:last-child { margin-bottom: 0; }
.desc-para code { background: rgba(0,103,95,0.1); color: var(--pri); padding: 2px 6px; border-radius: 4px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; font-weight: 700; border: 1px solid rgba(0,103,95,0.2); }
.desc-para strong { color: var(--text); font-weight: 900; }

/* Constraints */
.constraints-box { background: rgba(253,211,77,0.1); border: 2px solid var(--yellow); border-radius: 12px; padding: 14px 16px; }
.constraint-line { font-size: 13px; font-family: 'SF Mono', 'Fira Code', monospace; color: var(--yellow); font-weight: 700; padding: 3px 0; line-height: 1.6; }
.constraint-line:empty { display: none; }

/* Examples */
.example-card { background: var(--surface); border-radius: 12px; margin-bottom: 10px; overflow: hidden; border: 2px solid var(--border); box-shadow: 2px 2px 0 0 rgba(34,49,49,0.08); }
.example-header { padding: 8px 14px; background: var(--pri); font-size: 11px; font-weight: 900; text-transform: uppercase; color: #BFFFF5; letter-spacing: 1px; border-bottom: 2px solid var(--border); }
.io-grid { display: grid; grid-template-columns: 1fr 1fr; }
.io-block { padding: 12px 14px; background: #1a2e2d; }
.io-block:first-child { border-right: 2px solid var(--border); }
.io-label { font-size: 10px; font-weight: 800; text-transform: uppercase; color: var(--pri-ctr); letter-spacing: 1px; margin-bottom: 6px; }
.io-content { margin: 0; white-space: pre-wrap; word-break: break-all; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: var(--pri-ctr); line-height: 1.5; }
.explanation { padding: 10px 14px; border-top: 2px solid var(--border); font-size: 12px; color: var(--text2); line-height: 1.6; background: var(--surface2); }
.expl-label { font-weight: 800; color: var(--yellow); }

/* Submit / Start Coding */
.submit-section { background: var(--surface); border-radius: 12px; padding: 16px; border: 2px solid var(--border); box-shadow: 2px 2px 0 0 rgba(34,49,49,0.08); }
.submit-hint { font-size: 12px; color: var(--text2); margin: 0 0 10px; font-weight: 700; }
.langs { display: flex; gap: 8px; flex-wrap: wrap; }
.lang-btn { padding: 8px 16px; border-radius: 10px; border: 2px solid var(--border); background: var(--surface); color: var(--text); font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 6px; box-shadow: 2px 2px 0 0 rgba(34,49,49,0.08); }
.lang-btn:hover { border-color: var(--pri); color: var(--pri); background: rgba(0,103,95,0.05); }
.lang-btn:active { transform: translate(1px,1px); box-shadow: none; }
.lang-icon { font-size: 14px; }

.btn-open, .btn-ext { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 10px; border: 2px solid var(--border); background: var(--surface); color: var(--text2); font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.15s; box-shadow: 2px 2px 0 0 rgba(34,49,49,0.08); }
.btn-open:hover, .btn-ext:hover { border-color: var(--pri); color: var(--pri); }
.btn-open:active, .btn-ext:active { transform: translate(1px,1px); box-shadow: none; }

/* Error display */
.error-detail { background: rgba(155,61,55,0.08); border: 2px solid rgba(155,61,55,0.3); border-radius: 10px; padding: 12px; margin-bottom: 12px; }
.error-label { font-size: 12px; font-weight: 800; color: var(--red); margin-bottom: 6px; }
.error-msg { font-size: 11px; color: var(--text2); font-family: 'SF Mono', monospace; line-height: 1.5; margin: 0; white-space: pre-wrap; word-break: break-all; }
.raw-dump { font-size: 11px; color: var(--pri); font-family: 'SF Mono', monospace; line-height: 1.4; margin: 0; white-space: pre-wrap; word-break: break-all; background: #1a2e2d; border: 2px solid var(--border); border-radius: 10px; padding: 14px; max-height: 400px; overflow-y: auto; color: var(--pri-ctr); }
.submit-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.submit-btn { background: var(--pri); color: #BFFFF5; border: 2px solid var(--border); border-radius: 10px; padding: 10px 18px; font-size: 13px; font-weight: 800; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.15s; box-shadow: 3px 3px 0 0 var(--border); }
.submit-btn:hover { opacity: 0.95; }
.submit-btn:active { transform: translate(2px,2px); box-shadow: none; }
.submit-btn:disabled { opacity: 0.5; cursor: wait; transform: none; }
.submit-result { border-radius: 12px; padding: 14px 16px; margin-top: 8px; display: flex; align-items: center; gap: 12px; font-size: 14px; font-weight: 800; border: 2px solid var(--border); }
.submit-result .result-icon { font-size: 24px; }
.submit-result .result-text { flex: 1; }
.submit-result.status-running { background: rgba(0,103,95,0.1); color: var(--pri); }
.submit-result.status-pass { background: rgba(126,240,226,0.2); color: var(--pri); }
.submit-result.status-fail { background: rgba(255,146,136,0.15); color: var(--red); }
.submit-result.status-error { background: rgba(253,211,77,0.15); color: var(--yellow); }
.debug-stats { background: var(--surface2); border: 2px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-top: 16px; font-size: 11px; color: var(--text2); font-weight: 700; }
.debug-stats .ok { color: var(--green); } .debug-stats .fail { color: var(--red); }

#debug-footer { padding: 8px; margin-top: 20px; font-size: 10px; color: var(--text2); text-align: center; opacity: 0.5; }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <h1>${esc(title)}</h1>
            <div class="meta">${refs.length} questions — <span class="ok">${loadedCount ?? 0} loaded</span>, <span class="fail">${errors.length} failed</span></div>
        </div>
        <button class="btn-ext" id="btn-browser-main" data-url="${esc(url)}">🌐 Open in Browser</button>
    </div>

    ${questionsHtml}
</div>
<div id="debug-footer">⏳ Loading scripts...</div>

<script nonce="${nonce}">
(function() {
    var vscode = acquireVsCodeApi();
    var footer = document.getElementById('debug-footer');
    footer.textContent = '✅ JS Active — Click any question to expand';
    footer.style.color = '#00675F';

    // Toggle question cards
    var headers = document.querySelectorAll('.q-header');
    for (var i = 0; i < headers.length; i++) {
        headers[i].addEventListener('click', function() {
            this.parentElement.classList.toggle('expanded');
        });
    }

    // Open in browser buttons
    var openBtns = document.querySelectorAll('.btn-open, .btn-ext[data-url]');
    for (var i = 0; i < openBtns.length; i++) {
        openBtns[i].addEventListener('click', function(e) {
            e.stopPropagation();
            var url = this.getAttribute('data-url');
            if (url) vscode.postMessage({ type: 'openExternal', url: url });
        });
    }

    // Create solution buttons
    var langBtns = document.querySelectorAll('.lang-btn');
    for (var i = 0; i < langBtns.length; i++) {
        langBtns[i].addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({
                type: 'createSolution',
                question: {
                    title: this.getAttribute('data-title'),
                    slug: this.getAttribute('data-slug'),
                    boilerplate: (this.getAttribute('data-bp') || '').replace(/\\\\n/g, '\\n'),
                    langSlug: this.getAttribute('data-lang')
                }
            });
        });
    }

    // Submit solution buttons
    var submitBtns = document.querySelectorAll('.submit-btn');
    for (var i = 0; i < submitBtns.length; i++) {
        submitBtns[i].addEventListener('click', function(e) {
            e.stopPropagation();
            var btn = this;
            var qid = btn.getAttribute('data-qid');
            var resultDiv = document.getElementById('result-' + qid);
            if (resultDiv) {
                resultDiv.style.display = 'block';
                resultDiv.className = 'submit-result status-running';
                resultDiv.innerHTML = '<div class="result-icon">⏳</div><div class="result-text">Submitting & running test cases...</div>';
            }
            btn.disabled = true;
            btn.textContent = '⏳ Submitting...';
            vscode.postMessage({
                type: 'submitCode',
                playgroundHash: btn.getAttribute('data-playground'),
                languageId: parseInt(btn.getAttribute('data-langid') || '0'),
                questionId: qid
            });
        });
    }

    // Handle messages from extension
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.command === 'submitResult' && msg.questionId) {
            var resultDiv = document.getElementById('result-' + msg.questionId);
            if (!resultDiv) return;
            resultDiv.style.display = 'block';
            var r = msg.result;
            resultDiv.className = 'submit-result ' + (r.isPass ? 'status-pass' : 'status-fail');
            var icon = r.isPass ? '✅' : '❌';
            var details = '<div class="result-icon">' + icon + '</div>';
            details += '<div class="result-text"><strong>' + (r.status || 'Unknown') + '</strong>';
            if (r.passedCount !== undefined) details += ' — ' + r.passedCount + '/' + r.totalCount + ' passed';
            if (r.runtime) details += ' — ' + r.runtime;
            if (r.memory) details += ' — ' + (r.memory / 1024).toFixed(1) + ' MB';
            if (r.score !== undefined) details += ' — Score: ' + r.score;
            details += '</div>';
            resultDiv.innerHTML = details;
            // Re-enable submit buttons
            var btns = document.querySelectorAll('.submit-btn[data-qid="' + msg.questionId + '"]');
            for (var i = 0; i < btns.length; i++) {
                btns[i].disabled = false;
            }
        } else if (msg.command === 'submitError' && msg.questionId) {
            var errDiv = document.getElementById('result-' + msg.questionId);
            if (!errDiv) return;
            errDiv.style.display = 'block';
            errDiv.className = 'submit-result status-error';
            errDiv.innerHTML = '<div class="result-icon">⚠️</div><div class="result-text"><strong>Error:</strong> ' + msg.error + '</div>';
            var errBtns = document.querySelectorAll('.submit-btn[data-qid="' + msg.questionId + '"]');
            for (var i = 0; i < errBtns.length; i++) {
                errBtns[i].disabled = false;
            }
        }
    });
})();
</script>
</body>
</html>`;
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

function renderQuestion(p: PlaygroundProblem, idx: number): string {
    // Convert <inlineMath> and LaTeX math notation to readable Unicode symbols
    const cleanMath = (s: string): string => s
        .replace(/<inlineMath>(.*?)<\/inlineMath>/gi, (_, content) => content)  // Strip inlineMath tags
        .replace(/\$([^$]+)\$/g, '$1')  // Remove $ delimiters
        .replace(/\\leq?\b/g, '≤')
        .replace(/\\geq?\b/g, '≥')
        .replace(/\\times\b/g, '×')
        .replace(/\\div\b/g, '÷')
        .replace(/\\neq\b/g, '≠')
        .replace(/\\infty\b/g, '∞')
        .replace(/\\sum\b/g, 'Σ')
        .replace(/\\pi\b/g, 'π')
        .replace(/\\cdot\b/g, '·')
        .replace(/\\ldots\b/g, '…')
        .replace(/\\text\{([^}]+)\}/g, '$1')  // \text{nums} → nums
        .replace(/\^{(\d+)}/g, (_, exp) => {
            const sups: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
            return exp.split('').map((c: string) => sups[c] || c).join('');
        })
        .replace(/\^(\d)/g, (_, exp) => {
            const sups: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
            return sups[exp] || exp;
        })
        .replace(/_\{(\d+)\}/g, (_, sub) => {
            const subs: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
            return sub.split('').map((c: string) => subs[c] || c).join('');
        })
        .replace(/_(\d)/g, (_, sub) => {
            const subs: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
            return subs[sub] || sub;
        })
        .replace(/\\[a-zA-Z]+/g, '');  // Remove remaining LaTeX commands

    // Clean HTML while preserving meaningful content
    const cleanHtml = (s: string): string => {
        if (!s) return '';
        return cleanMath(s)
            .replace(/\r\n/g, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<p[^>]*>/gi, '')
            .replace(/<b>(.*?)<\/b>/gi, '**$1**')
            .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
            .replace(/<em>(.*?)<\/em>/gi, '_$1_')
            .replace(/<code>(.*?)<\/code>/gi, '`$1`')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    };

    // Format a cleaned string into HTML paragraphs
    const toHtmlParagraphs = (text: string): string => {
        if (!text) return '';
        return text.split('\n\n').map(para => {
            const formatted = esc(para.trim())
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/_(.*?)_/g, '<em>$1</em>')
                .replace(/`([^`]+)`/g, '<code>$1</code>')
                .replace(/\n/g, '<br>');
            return `<p class="desc-para">${formatted}</p>`;
        }).join('');
    };

    // Clean description
    const desc = cleanHtml(p.description);
    const descHtml = toHtmlParagraphs(desc);

    // Clean input/output format
    const inputFmt = cleanHtml(p.inputFormat || '');
    const outputFmt = cleanHtml(p.outputFormat || '');

    // Clean constraints  
    const constraintsText = p.constraints ? cleanMath(
        p.constraints
            .replace(/<inlineMath>(.*?)<\/inlineMath>/gi, '$1')
            .replace(/<[^>]+>/g, '')
            .replace(/\r\n/g, '\n')
            .replace(/&nbsp;/g, ' ')
            .trim()
    ) : '';

    // Structured example cards
    const examplesHtml = (p.examples || []).map((ex, i) => `
        <div class="example-card">
            <div class="example-header">Example ${i + 1}</div>
            <div class="io-grid">
                <div class="io-block">
                    <div class="io-label">INPUT</div>
                    <pre class="io-content">${esc(ex.input)}</pre>
                </div>
                <div class="io-block">
                    <div class="io-label">OUTPUT</div>
                    <pre class="io-content">${esc(ex.output)}</pre>
                </div>
            </div>
            ${ex.explanation ? `<div class="explanation"><span class="expl-label">💡 Note:</span> ${esc(ex.explanation)}</div>` : ''}
        </div>
    `).join('');

    // Language buttons with "Start Coding" action
    const langsHtml = p.languages.map(l => {
        const bp = (l.boilerplate || '').replace(/"/g, '&quot;').replace(/\n/g, '\\n');
        return `<button class="lang-btn" data-action="create-solution" data-title="${esc(p.title)}" data-slug="${esc(p.id)}" data-bp="${bp}" data-lang="${esc(l.slug)}">
            <span class="lang-icon">${getLangIcon(l.slug)}</span> ${esc(l.name)}
        </button>`;
    }).join('');




    return `
    <div class="q-card">
        <div class="q-header">
            <span class="q-num">${idx + 1}</span>
            <span class="q-title">${esc(p.title)}</span>
            <span class="q-arrow">▼</span>
        </div>
        <div class="q-body">
            ${desc.trim() ? `
            <div class="q-section">
                <div class="section-label">📝 Problem Description</div>
                <div class="desc-box">${descHtml}</div>
            </div>` : ''}

            ${inputFmt ? `
            <div class="q-section">
                <div class="section-label">📥 Input Format</div>
                <div class="desc-box">${toHtmlParagraphs(inputFmt)}</div>
            </div>` : ''}

            ${outputFmt ? `
            <div class="q-section">
                <div class="section-label">📤 Output Format</div>
                <div class="desc-box">${toHtmlParagraphs(outputFmt)}</div>
            </div>` : ''}

            ${constraintsText ? `
            <div class="q-section">
                <div class="section-label">⚠️ Constraints</div>
                <div class="constraints-box">
                    ${constraintsText.split('\n').filter(l => l.trim()).map(line => `<div class="constraint-line">${esc(line.trim())}</div>`).join('')}
                </div>
            </div>` : ''}

            ${examplesHtml ? `
            <div class="q-section">
                <div class="section-label">🧪 Examples</div>
                ${examplesHtml}
            </div>` : ''}

            ${langsHtml ? `
            <div class="q-section submit-section">
                <div class="section-label">🚀 Start Coding</div>
                <p class="submit-hint">Choose a language to create a solution file with boilerplate code:</p>
                <div class="langs">${langsHtml}</div>
            </div>` : ''}

            <div class="q-section submit-section">
                <div class="section-label">📤 Submit Solution</div>
                <p class="submit-hint">Write your code, then submit to check against test cases:</p>
                <div class="submit-actions">
                    ${p.languages.map(l => `<button class="submit-btn" data-playground="${esc(p.playgroundHash)}" data-langid="${l.id}" data-qid="q-${idx}">
                        <span class="lang-icon">${getLangIcon(l.slug)}</span> Submit ${esc(l.name.split(' ')[0])}
                    </button>`).join('')}
                </div>
                <div class="submit-result" id="result-q-${idx}" style="display:none;"></div>
            </div>
        </div>
    </div>`;
}

function getLangIcon(slug: string): string {
    const icons: Record<string, string> = {
        javascript: '🟡', typescript: '🔵', python: '🐍', cpp: '⚡', c: '🔧',
        java: '☕', go: '🐹', rust: '🦀', csharp: '💜', mysql: '🗄️', sql: '🗄️',
    };
    return icons[slug] || '📄';
}

