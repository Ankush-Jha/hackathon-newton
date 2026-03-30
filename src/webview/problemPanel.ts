// src/webview/problemPanel.ts
// Full-tab WebviewPanel that displays a fetched Newton School question
// with title, description, I/O format, examples, test cases, and actions.

import * as vscode from 'vscode';
import { QuestionData } from '../scraper/questionFetcher';
import { runTestCases, TestCase } from '../runner/testRunner';
import { submitSolution, fetchPlayground, resolveLanguageId, getSubmissionStatus, setSessionCookie, hasAuth } from '../api/newtonApi';
import { getCookiesForDomain } from '../scraper/questionFetcher';

export class ProblemPanel {
  public static current: ProblemPanel | undefined;
  private static readonly viewType = 'newton.problemView';

  private readonly panel: vscode.WebviewPanel;
  private questionData: QuestionData | null = null;
  private disposables: vscode.Disposable[] = [];

  public static show(extensionUri: vscode.Uri, data: QuestionData): void {
    if (ProblemPanel.current) {
      ProblemPanel.current.questionData = data;
      ProblemPanel.current.update();
      ProblemPanel.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ProblemPanel.viewType,
      data.title || 'Problem',
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri], retainContextWhenHidden: true }
    );
    ProblemPanel.current = new ProblemPanel(panel, extensionUri, data);
  }

  private constructor(panel: vscode.WebviewPanel, private extensionUri: vscode.Uri, data: QuestionData) {
    this.panel = panel;
    this.questionData = data;
    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'createFile') {
        await this.createSolutionFile();
      } else if (msg.command === 'runTests') {
        await this.handleRunTests(msg.tests as TestCase[]);
      } else if (msg.command === 'openExternal') {
        if (msg.url) { vscode.env.openExternal(vscode.Uri.parse(msg.url)); }
      } else if (msg.command === 'submitToNewton') {
        await this.handleSubmitToNewton(msg.language as string);
      }
    }, null, this.disposables);
  }

  private async createSolutionFile(): Promise<void> {
    const title = this.questionData?.title || 'solution';
    const safeName = title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().substring(0, 40);
    const header = [
      `# ${this.questionData?.title}`,
      `# ${this.questionData?.url}`,
      `# Difficulty: ${this.questionData?.difficulty || 'Unknown'}`,
      '',
      '# Write your solution below',
      '',
      ''
    ].join('\n');

    const doc = await vscode.workspace.openTextDocument({
      content: header,
      language: 'python'
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
  }

  private async handleRunTests(tests: TestCase[]): Promise<void> {
    this.panel.webview.postMessage({ command: 'testRunning' });
    try {
      const results = await runTestCases(tests);
      this.panel.webview.postMessage({ command: 'testResults', results });
    } catch (err) {
      this.panel.webview.postMessage({
        command: 'testError',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async handleSubmitToNewton(language: string): Promise<void> {
    const playgroundHash = this.questionData?.playgroundHash;
    if (!playgroundHash) {
      this.panel.webview.postMessage({
        command: 'submitError',
        error: 'No playground hash found for this problem. Try re-opening it.'
      });
      return;
    }

    // Get code from active editor
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
      const editors = vscode.window.visibleTextEditors;
      if (editors.length > 0) {
        editor = editors[editors.length - 1]; // pick the last (likely the solution)
      }
    }
    if (!editor) {
      this.panel.webview.postMessage({
        command: 'submitError',
        error: 'No active editor. Open your solution file first.'
      });
      return;
    }

    const code = editor.document.getText();
    if (!code.trim()) {
      this.panel.webview.postMessage({
        command: 'submitError',
        error: 'Solution file is empty.'
      });
      return;
    }

    this.panel.webview.postMessage({ command: 'submitRunning' });

    try {
      // Ensure auth is set up
      if (!hasAuth()) {
        const cookies = await getCookiesForDomain();
        setSessionCookie(cookies);
      }

      // Fetch playground data for language mapping
      const playground = await fetchPlayground(playgroundHash);
      const languageId = resolveLanguageId(playground.raw, language);

      // Submit and poll
      const response = await submitSolution(playgroundHash, languageId, code, playground.raw);

      // Get normalized status
      const status = await getSubmissionStatus(playgroundHash);

      this.panel.webview.postMessage({
        command: 'submitResult',
        result: {
          status: status.status,
          runtime: status.runtime,
          memory: status.memory ? (status.memory / 1000).toFixed(1) : undefined,
          submissionId: response.submissionId
        }
      });
    } catch (err) {
      this.panel.webview.postMessage({
        command: 'submitError',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private update(): void {
    if (!this.questionData) { return; }
    this.panel.title = this.questionData.title || 'Problem';
    this.panel.webview.html = this.getHtml();
  }

  private dispose(): void {
    ProblemPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  private getHtml(): string {
    const nonce = getNonce();
    const d = this.questionData!;
    const examplesJson = JSON.stringify(d.examples || []).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${this.escHtml(d.title)}</title>
<style>
:root {
  --bg: #E8FAF9; --surface: #FFFFFF; --sf-low: #E1F5F4; --sf-ctr: #D7EDEC; --sf-high: #D0E7E6;
  --sf-max: #C8E2E1; --on-sf: #223131; --on-sf-var: #4E5F5E;
  --outline: #697A79; --outline-var: #9FB1B0;
  --pri: #00675F; --pri-ctr: #7EF0E2; --sec: #705900; --sec-ctr: #FDD34D;
  --border: #223131;
  --green: #00675F; --easy: #00675F; --medium: #705900; --hard: #9B3D37;
  --err: #B31B25;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg); color: var(--on-sf);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px; line-height: 1.6; padding: 24px; max-width: 800px; margin: 0 auto;
  -webkit-font-smoothing: antialiased;
}
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: var(--outline-var); border-radius: 10px; }

h1 {
  font-size: 24px; font-weight: 900; letter-spacing: -0.5px;
  color: var(--on-sf);
  margin-bottom: 12px;
}
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.badge {
  padding: 3px 10px; border-radius: 8px; font-size: 11px; font-weight: 800;
  border: 2px solid var(--border);
  box-shadow: 2px 2px 0 0 var(--border);
}
.badge-easy { background: rgba(0,103,95,0.15); color: var(--easy); }
.badge-medium { background: rgba(112,89,0,0.15); color: var(--medium); }
.badge-hard { background: rgba(155,61,55,0.15); color: var(--hard); }
.badge-info { background: var(--surface); color: var(--on-sf-var); }

.section {
  background: var(--surface); border-radius: 12px; padding: 18px;
  margin-bottom: 16px; border: 2px solid var(--border);
  box-shadow: 4px 4px 0 0 rgba(34,49,49,1);
}
.section:hover { background: var(--sf-low); }
.section h3 {
  font-size: 12px; font-weight: 800; text-transform: uppercase;
  letter-spacing: 1px; color: var(--pri); margin-bottom: 10px;
  display: flex; align-items: center; gap: 8px;
}
.section h3::before { content: none; }
pre {
  background: var(--sf-ctr); padding: 12px; border-radius: 8px;
  overflow-x: auto; white-space: pre-wrap; font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12px; border: 2px solid var(--border);
}
.description { white-space: pre-wrap; line-height: 1.7; }

.test-card {
  background: var(--surface); border-radius: 10px; padding: 14px;
  margin-bottom: 10px; border: 2px solid var(--border);
  box-shadow: 2px 2px 0 0 rgba(34,49,49,1);
}
.test-card.pass { border-left: 6px solid var(--green); }
.test-card.fail { border-left: 6px solid var(--err); }
.test-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 8px; font-weight: 800; font-size: 12px;
}
.test-pass { color: var(--green); font-weight: 900; }
.test-fail { color: var(--err); font-weight: 900; }
.test-label {
  font-size: 10px; font-weight: 800; text-transform: uppercase;
  color: var(--on-sf-var); margin-bottom: 4px;
}
.test-pre {
  background: #1a2e2d; color: var(--pri-ctr); padding: 8px; border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; margin-bottom: 8px;
  white-space: pre-wrap; border: 2px solid var(--border);
}
.actual-output {
  margin-top: 8px;
}

.btn {
  width: 100%; padding: 10px 12px; border: 2px solid var(--border); border-radius: 10px;
  font-weight: 800; font-size: 13px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  margin-bottom: 8px; transition: all 0.15s;
  box-shadow: 3px 3px 0 0 var(--border);
}
.btn:hover { opacity: 0.95; }
.btn:active { transform: translate(2px,2px); box-shadow: 0 0 0 0 transparent; }
.btn:disabled { opacity: 0.5; cursor: wait; transform: none; box-shadow: 3px 3px 0 0 var(--border); }
.btn-create { background: var(--sec-ctr); color: var(--sec); }
.btn-run { background: var(--pri); color: #BFFFF5; }
.btn-submit { background: var(--pri); color: #BFFFF5; }
.btn-open { background: var(--surface); color: var(--on-sf); }

.lang-select {
  background: var(--surface); color: var(--on-sf); border: 2px solid var(--border);
  border-radius: 8px; padding: 8px 12px; font-size: 12px; width: 100%;
  margin-bottom: 8px; cursor: pointer; box-shadow: 2px 2px 0 0 var(--border); font-weight: 700;
}
.lang-select:focus { outline: none; border-color: var(--pri); }

.submit-result {
  background: var(--sf-low); border-radius: 12px; padding: 16px;
  margin-top: 12px; border: 2px solid var(--border); display: none;
}
.submit-result h4 {
  font-size: 12px; font-weight: 800; text-transform: uppercase;
  letter-spacing: 1px; color: var(--pri); margin-bottom: 10px;
}
.result-status {
  font-size: 18px; font-weight: 900; margin-bottom: 8px;
}
.result-accepted { color: var(--green); }
.result-wrong { color: var(--err); }
.result-tle { color: var(--medium); }
.result-error { color: var(--err); }
.result-pending { color: var(--on-sf-var); }
.result-meta {
  display: flex; gap: 16px; font-size: 12px; color: var(--on-sf-var); font-weight: 700;
}

.add-form {
  background: var(--surface); border-radius: 10px; padding: 14px;
  margin-top: 10px; display: none; border: 2px solid var(--border);
  box-shadow: 2px 2px 0 0 rgba(34,49,49,1);
}
.add-form textarea {
  width: 100%; background: var(--sf-low); color: var(--on-sf);
  border: 2px solid var(--border); border-radius: 6px;
  padding: 8px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px;
  resize: vertical; min-height: 60px;
}
.add-form label { font-size: 11px; font-weight: 800; color: var(--on-sf-var); margin-bottom: 4px; display: block; }
.form-btns { display: flex; gap: 8px; margin-top: 10px; }
.form-btns button { flex: 1; }

.footer {
  text-align: center; margin-top: 24px; font-size: 11px; font-weight: 700;
  color: var(--on-sf-var); opacity: 0.6;
}
</style>
</head>
<body>
<h1>${this.escHtml(d.title)}</h1>
<div class="meta">
  ${d.difficulty ? `<span class="badge badge-${d.difficulty.toLowerCase()}">${this.escHtml(d.difficulty)}</span>` : ''}
  ${d.timeLimit ? `<span class="badge badge-info">Time: ${this.escHtml(d.timeLimit)}</span>` : ''}
  ${d.memoryLimit ? `<span class="badge badge-info">Mem: ${this.escHtml(d.memoryLimit)}</span>` : ''}
</div>

${d.description ? `<div class="section"><h3>Description</h3><div class="description">${this.escHtml(d.description)}</div></div>` : ''}
${d.inputFormat ? `<div class="section"><h3>Input Format</h3><pre>${this.escHtml(d.inputFormat)}</pre></div>` : ''}
${d.outputFormat ? `<div class="section"><h3>Output Format</h3><pre>${this.escHtml(d.outputFormat)}</pre></div>` : ''}
${d.constraints ? `<div class="section"><h3>Constraints</h3><pre>${this.escHtml(d.constraints)}</pre></div>` : ''}

<div class="section">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <h3 style="margin:0">Test Cases</h3>
    <button class="btn btn-open" id="addTestBtn" style="width:auto;padding:4px 12px;font-size:11px;margin:0">+ Add</button>
  </div>
  <div id="test-cases"></div>
  <div class="add-form" id="add-form">
    <label>Input:</label>
    <textarea id="new-input" rows="3"></textarea>
    <label style="margin-top:8px">Expected Output:</label>
    <textarea id="new-output" rows="3"></textarea>
    <div class="form-btns">
      <button class="btn btn-create" id="saveTestBtn" style="font-size:11px;padding:8px">Save</button>
      <button class="btn btn-open" id="cancelTestBtn" style="font-size:11px;padding:8px">Cancel</button>
    </div>
  </div>
</div>

<button class="btn btn-run" id="runBtn">&#9654; Run All Tests</button>
<button class="btn btn-create" id="createBtn">&#128196; Create Solution File</button>

<div class="section" style="margin-top:16px">
  <h3>Submit to Newton</h3>
  <select class="lang-select" id="langSelect">
    <option value="python">Python</option>
    <option value="javascript">JavaScript</option>
    <option value="cpp">C++</option>
    <option value="java">Java</option>
  </select>
  <button class="btn btn-submit" id="submitBtn">&#128640; Submit to Newton</button>
  <div class="submit-result" id="submitResult">
    <h4>Submission Result</h4>
    <div class="result-status" id="resultStatus"></div>
    <div class="result-meta" id="resultMeta"></div>
  </div>
</div>

${d.url ? `<button class="btn btn-open" id="openBtn" style="margin-top:8px">&#127760; Open in Browser</button>` : ''}

<div class="footer">Newton School &#8212; Problem Viewer</div>

<script nonce="${nonce}">
(function() {
  var vscode = acquireVsCodeApi();
  var tests = ${examplesJson}.map(function(t, i) {
    return { id: i, input: t.input || '', output: t.output || '' };
  });

  function renderTests() {
    var container = document.getElementById('test-cases');
    container.innerHTML = '';
    tests.forEach(function(test, idx) {
      var cls = test.status === 'pass' ? 'pass' : test.status === 'fail' ? 'fail' : '';
      var statusText = test.status === 'pass' ? 'PASS' : test.status === 'fail' ? 'FAIL' : 'Case #' + (idx + 1);
      var statusCls = test.status === 'pass' ? 'test-pass' : test.status === 'fail' ? 'test-fail' : '';

      var html = '<div class="test-card ' + cls + '">';
      html += '<div class="test-header"><span class="' + statusCls + '">' + statusText + '</span>';
      html += '<button class="btn btn-open del-btn" data-idx="' + idx + '" style="width:auto;padding:2px 8px;font-size:10px;margin:0">Delete</button></div>';
      html += '<div class="test-label">Input</div><div class="test-pre">' + escHtml(test.input) + '</div>';
      html += '<div class="test-label">Expected Output</div><div class="test-pre">' + escHtml(test.output) + '</div>';
      if (test.actual !== undefined) {
        html += '<div class="actual-output"><div class="test-label" style="color:var(--err)">Actual Output</div>';
        html += '<div class="test-pre" style="border:2px solid var(--err)">' + escHtml(test.actual) + '</div></div>';
      }
      html += '</div>';
      container.innerHTML += html;
    });

    document.querySelectorAll('.del-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        tests.splice(parseInt(this.getAttribute('data-idx')), 1);
        renderTests();
      });
    });
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  renderTests();

  document.getElementById('createBtn').addEventListener('click', function() {
    vscode.postMessage({ command: 'createFile' });
  });

  var openBtn = document.getElementById('openBtn');
  if (openBtn) {
    openBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'openExternal', url: '${d.url}' });
    });
  }

  document.getElementById('runBtn').addEventListener('click', function() {
    this.disabled = true; this.textContent = 'Running...';
    tests.forEach(function(t) { t.status = undefined; t.actual = undefined; });
    renderTests();
    vscode.postMessage({ command: 'runTests', tests: tests.map(function(t) { return { input: t.input, output: t.output }; }) });
  });

  document.getElementById('addTestBtn').addEventListener('click', function() {
    document.getElementById('add-form').style.display = 'block';
    this.style.display = 'none';
  });

  document.getElementById('cancelTestBtn').addEventListener('click', function() {
    document.getElementById('add-form').style.display = 'none';
    document.getElementById('addTestBtn').style.display = 'block';
    document.getElementById('new-input').value = '';
    document.getElementById('new-output').value = '';
  });

  document.getElementById('saveTestBtn').addEventListener('click', function() {
    var inp = document.getElementById('new-input').value;
    var out = document.getElementById('new-output').value;
    if (inp && out) {
      tests.push({ id: tests.length, input: inp, output: out });
      renderTests();
      document.getElementById('cancelTestBtn').click();
    }
  });

  // Submit to Newton handler
  document.getElementById('submitBtn').addEventListener('click', function() {
    this.disabled = true;
    this.textContent = 'Submitting...';
    var result = document.getElementById('submitResult');
    result.style.display = 'none';
    var lang = document.getElementById('langSelect').value;
    vscode.postMessage({ command: 'submitToNewton', language: lang });
  });

  window.addEventListener('message', function(ev) {
    var msg = ev.data;
    if (msg.command === 'testResults') {
      var results = msg.results;
      tests.forEach(function(t, i) {
        if (results[i]) {
          t.status = results[i].passed ? 'pass' : 'fail';
          t.actual = results[i].actual;
        }
      });
      renderTests();
      var btn = document.getElementById('runBtn');
      btn.disabled = false;
      btn.innerHTML = '&#9654; Run All Tests';
    }
    if (msg.command === 'testRunning') {
      document.getElementById('runBtn').disabled = true;
      document.getElementById('runBtn').textContent = 'Running...';
    }
    if (msg.command === 'testError') {
      document.getElementById('runBtn').disabled = false;
      document.getElementById('runBtn').innerHTML = '&#9654; Run All Tests';
    }
    if (msg.command === 'submitRunning') {
      document.getElementById('submitBtn').disabled = true;
      document.getElementById('submitBtn').textContent = 'Submitting...';
      document.getElementById('submitResult').style.display = 'none';
    }
    if (msg.command === 'submitResult') {
      var r = msg.result;
      var submitBtn = document.getElementById('submitBtn');
      submitBtn.disabled = false;
      submitBtn.innerHTML = '&#128640; Submit to Newton';
      var resultDiv = document.getElementById('submitResult');
      resultDiv.style.display = 'block';
      var statusEl = document.getElementById('resultStatus');
      var metaEl = document.getElementById('resultMeta');
      var icons = {
        'Accepted': '✅', 'Wrong Answer': '❌', 'TLE': '⏱️',
        'Runtime Error': '💥', 'Compilation Error': '🔧', 'Pending': '⏳'
      };
      var classes = {
        'Accepted': 'result-accepted', 'Wrong Answer': 'result-wrong', 'TLE': 'result-tle',
        'Runtime Error': 'result-error', 'Compilation Error': 'result-error', 'Pending': 'result-pending'
      };
      statusEl.className = 'result-status ' + (classes[r.status] || '');
      statusEl.textContent = (icons[r.status] || '') + ' ' + r.status;
      var meta = '';
      if (r.runtime !== undefined) meta += '⚡ Runtime: ' + r.runtime + 'ms';
      if (r.memory !== undefined) meta += (meta ? '  ·  ' : '') + '💾 Memory: ' + r.memory + ' MB';
      metaEl.textContent = meta;
    }
    if (msg.command === 'submitError') {
      var se = document.getElementById('submitBtn');
      se.disabled = false;
      se.innerHTML = '&#128640; Submit to Newton';
      var rd = document.getElementById('submitResult');
      rd.style.display = 'block';
      document.getElementById('resultStatus').className = 'result-status result-error';
      document.getElementById('resultStatus').textContent = '⚠️ Error';
      document.getElementById('resultMeta').textContent = msg.error;
    }
  });
})();
</script>
</body>
</html>`;
  }

  private escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

function getNonce(): string {
  let t = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { t += c.charAt(Math.floor(Math.random() * c.length)); }
  return t;
}
