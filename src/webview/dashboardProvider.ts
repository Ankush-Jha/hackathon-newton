// src/webview/dashboardProvider.ts
// Newton School Dashboard — Single-page student-first layout.
// Sections: DO NOW (assignments + QOTD) → YOUR STATS → NEXT UP (schedule) → PRACTICE (collapsible)

import * as vscode from 'vscode';
import { McpClient } from '../mcp/mcpClient';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'newton.dashboardView';
  private _view?: vscode.WebviewView;
  private mcpClient: McpClient;

  constructor(private readonly extensionUri: vscode.Uri, mcpClient: McpClient) {
    this.mcpClient = mcpClient;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _tok: vscode.CancellationToken
  ): void | Thenable<void> {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    this._update();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'connect') { await this.connectToServer(); }
      else if (msg.command === 'callTool') { await this.handleToolCall(msg.tool, msg.args || {}); }
      else if (msg.command === 'fetchQuestion') {
        if (msg.url && msg.url.includes('/assignment/')) {
          // Route assignments to the API-powered assignment panel
          vscode.commands.executeCommand('newton.openAssignment', msg.url);
        } else if (msg.questionData) {
          vscode.commands.executeCommand('newton.openProblemDirect', msg.questionData);
        } else {
          vscode.commands.executeCommand('newton.fetchQuestion', msg.url);
        }
      }
      else if (msg.command === 'openExternal' && msg.url) {
        // Newton login URLs must go through our Puppeteer-managed Chrome, not the OS browser
        if (msg.url.includes('newtonschool.co/login') || msg.url.includes('newtonschool.co/register')) {
          vscode.commands.executeCommand('newton.connect');
        } else {
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
      }
      else if (msg.command === 'relogin') {
        // Full reconnect: restart MCP server + open login browser
        vscode.commands.executeCommand('newton.connect');
      }
    });
  }

  private _update(): void {
    if (!this._view) { return; }
    this._view.webview.html = this._getHtml(this._view.webview);
  }

  private async connectToServer(): Promise<void> {
    this.post('status', { state: 'connecting', message: 'Starting Newton School server...' });
    try {
      // Always dispose and restart to pick up fresh credentials
      this.mcpClient.dispose();
      await this.mcpClient.start();
      this.post('status', { state: 'connected', message: 'Connected!' });
      // Auto-fetch all essential data in parallel
      await this.handleToolCall('list_courses', {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthErr = /unauthorized|session|invalid|expired|not logged/i.test(msg);
      this.post('status', { state: 'error', message: msg, isAuthError: isAuthErr });
    }
  }

  private async handleToolCall(tool: string, args: Record<string, unknown>): Promise<void> {
    this.post('loading', { tool });
    try {
      if (!this.mcpClient.isRunning) { await this.mcpClient.start(); }
      const result = await this.mcpClient.callTool(tool, args);
      this.post('toolResult', { tool, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthErr = /unauthorized|session|invalid|expired|not logged/i.test(msg);
      this.post('toolError', { tool, error: msg, isAuthError: isAuthErr });
    }
  }

  private post(command: string, data: Record<string, unknown>): void {
    this._view?.webview.postMessage({ command, ...data });
  }

  public refresh(): void {
    if (this._view && this.mcpClient.isRunning) { this.handleToolCall('list_courses', {}); }
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Newton School</title>
<style>
:root {
  --bg: #E8FAF9; --sf-low: #E1F5F4; --sf-ctr: #D7EDEC; --sf-high: #D0E7E6;
  --sf-max: #C8E2E1; --on-sf: #223131; --on-sf-var: #4E5F5E;
  --outline: #697A79; --outline-var: #9FB1B0;
  --pri: #00675F; --pri-ctr: #7EF0E2; --sec: #705900; --sec-ctr: #FDD34D;
  --tert: #9B3D37; --tert-ctr: #FF9288;
  --white: #FFFFFF; --border: #223131;
  --err: #B31B25; --err-ctr: #FB5151; --green: #00675F;
  --easy: #00675F; --medium: #705900; --hard: #9B3D37;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg); color: var(--on-sf);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px; overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--outline); border-radius: 10px; }

/* Header */
.hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; background: var(--bg);
  border-bottom: 2px solid var(--border);
  position: sticky; top: 0; z-index: 50;
  box-shadow: 4px 4px 0 0 rgba(34,49,49,0.06);
}
.hdr-title { font-weight: 900; font-size: 16px; color: var(--on-sf); text-transform: uppercase; letter-spacing: -0.5px; }
.hdr-actions { display: flex; gap: 8px; align-items: center; }
.hdr-actions span { cursor: pointer; font-size: 16px; transition: transform 0.15s; }
.hdr-actions span:active { transform: scale(0.9); }

.main { padding: 14px; }

/* Status */
.status {
  text-align: center; padding: 8px 12px; border-radius: 10px;
  font-size: 11px; font-weight: 700; margin: 0 14px 8px;
  border: 2px solid var(--border);
}
.status-conn { background: rgba(253,211,77,0.2); color: var(--sec); }
.status-ok { background: rgba(126,240,226,0.2); color: var(--pri); }
.status-err { background: rgba(255,146,136,0.15); color: var(--tert); }

/* Connect page */
.connect-page { text-align: center; padding: 30px 14px; }
.connect-page h2 { font-size: 18px; font-weight: 900; color: var(--on-sf); margin-bottom: 8px; }
.connect-page p { font-size: 11px; color: var(--on-sf-var); line-height: 1.5; margin-bottom: 16px; }
.btn-main {
  width: 100%; height: 48px; border: 2px solid var(--border);
  border-radius: 12px;
  background: linear-gradient(135deg, var(--pri), var(--pri-ctr));
  color: #BFFFF5; font-weight: 800; font-size: 13px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  box-shadow: 4px 4px 0 0 rgba(34,49,49,0.15);
  transition: all 0.15s;
}
.btn-main:hover { opacity: 0.95; }
.btn-main:active { transform: translate(2px,2px); box-shadow: 0 0 0 0 transparent; }
.btn-main:disabled { opacity: 0.4; cursor: wait; }

/* Section headers */
.section-hdr {
  font-size: 11px; font-weight: 800; text-transform: uppercase;
  letter-spacing: 1.5px; color: var(--outline); margin: 20px 0 10px;
  display: flex; align-items: center; gap: 6px;
}
.section-hdr span { font-size: 13px; }

/* Neo-card base */
.neo-card {
  background: var(--white); border: 2px solid var(--border);
  border-radius: 12px; padding: 12px;
  box-shadow: 2px 2px 0 0 rgba(34,49,49,1);
  transition: all 0.15s; cursor: pointer;
}
.neo-card:active { transform: translate(1px,1px); box-shadow: 0 0 0 0 transparent; }

/* Cards */
.card {
  background: var(--white); border-radius: 12px; padding: 12px;
  border: 2px solid var(--border); margin-bottom: 8px;
  box-shadow: 2px 2px 0 0 rgba(34,49,49,0.08);
}
.card:hover { background: var(--sf-low); }

/* Assignment cards */
.asgn-card {
  background: var(--white); border-radius: 10px; padding: 10px 12px;
  margin-bottom: 6px; cursor: pointer; transition: all 0.15s;
  border: 2px solid var(--border);
  box-shadow: 2px 2px 0 0 rgba(34,49,49,1);
}
.asgn-card:hover { background: var(--sf-low); }
.asgn-card:active { transform: translate(1px,1px); box-shadow: 0 0 0 0 transparent; }
.asgn-title { font-weight: 800; font-size: 12px; color: var(--on-sf); }
.asgn-meta { font-size: 10px; color: var(--on-sf-var); margin-top: 3px; }
.asgn-badge {
  display: inline-block; padding: 2px 8px; border-radius: 6px;
  font-size: 9px; font-weight: 800;
}
.asgn-due { background: rgba(253,211,77,0.3); color: var(--sec); border: 1px solid var(--sec); }
.asgn-overdue { background: rgba(255,146,136,0.2); color: var(--tert); border: 1px solid var(--tert); }
.asgn-btn {
  padding: 4px 12px; border-radius: 8px; background: var(--pri);
  color: #BFFFF5; border: 2px solid var(--border); font-size: 10px;
  font-weight: 800; cursor: pointer;
  box-shadow: 2px 2px 0 0 rgba(34,49,49,1);
  transition: all 0.15s;
}
.asgn-btn:active { transform: translate(1px,1px); box-shadow: none; }

/* Stats bento grid */
.stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat-card {
  background: var(--sf-low); border-radius: 12px; padding: 12px;
  text-align: left; border: 2px solid var(--border);
}
.stat-card.gold { background: var(--sec-ctr); box-shadow: 2px 2px 0 0 var(--border); }
.stat-card.coral { background: var(--tert-ctr); box-shadow: 2px 2px 0 0 var(--border); }
.stat-val { font-size: 22px; font-weight: 900; line-height: 1.2; color: var(--on-sf); }
.stat-label { font-size: 10px; font-weight: 800; color: var(--outline); text-transform: uppercase; letter-spacing: 0.5px; }

/* Progress bar */
.progress-bar {
  margin-top: 10px; background: var(--sf-ctr); border: 2px solid var(--border);
  border-radius: 999px; height: 16px; overflow: hidden; position: relative;
}
.progress-fill {
  position: absolute; inset: 0; right: auto;
  background: linear-gradient(90deg, var(--pri), var(--pri-ctr));
  border-right: 2px solid var(--border);
}
.progress-text {
  position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; font-size: 9px; font-weight: 900;
  text-transform: uppercase; letter-spacing: 1px; color: var(--on-sf);
}

/* Timeline */
.timeline { position: relative; padding-left: 24px; }
.timeline::before {
  content: ''; position: absolute; left: 6px; top: 4px; bottom: 4px;
  width: 0; border-left: 2px dashed var(--outline-var);
}
.timeline-item { position: relative; margin-bottom: 16px; }
.timeline-dot {
  position: absolute; left: -22px; top: 4px;
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--border); background: var(--white);
  box-sizing: border-box;
}
.timeline-dot.active { background: var(--pri); box-shadow: 0 0 0 3px var(--bg); }

/* Schedule items */
.sch-item {
  background: var(--white); border-radius: 10px; padding: 8px 12px;
  margin-bottom: 4px; border: 2px solid var(--border);
  border-left: 4px solid var(--pri);
}
.sch-item.contest { border-left-color: var(--tert); }

/* Leaderboard horizontal scroll */
.lb-scroll {
  display: flex; gap: 10px; overflow-x: auto; padding: 4px 0 8px;
  -webkit-overflow-scrolling: touch;
}
.lb-scroll::-webkit-scrollbar { height: 3px; }
.lb-scroll::-webkit-scrollbar-thumb { background: var(--outline); border-radius: 10px; }
.lb-card {
  flex-shrink: 0; width: 110px; border: 2px solid var(--border);
  border-radius: 12px; padding: 10px; background: var(--white);
  box-shadow: 3px 3px 0 0 var(--border);
}
.lb-card.me { background: var(--pri); color: var(--white); }
.lb-card.me .lb-rank-label { color: var(--pri-ctr); }
.lb-card.me .lb-rank-num { color: var(--white); }
.lb-card.me .lb-name { color: var(--white); }
.lb-rank-label { font-size: 9px; font-weight: 900; text-transform: uppercase; color: var(--outline); margin-bottom: 4px; }
.lb-rank-num { font-size: 24px; font-weight: 900; line-height: 1; color: var(--on-sf); }
.lb-rank-suffix { font-size: 10px; font-weight: 800; color: var(--outline); }
.lb-name { font-size: 10px; font-weight: 700; color: var(--on-sf); margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Collapsible sections */
.collapse-hdr {
  display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; padding: 8px 0;
}
.collapse-hdr .arrow { font-size: 10px; color: var(--on-sf-var); transition: transform 0.2s; }
.collapse-body { overflow: hidden; max-height: 0; transition: max-height 0.3s ease-out; }
.collapse-body.open { max-height: 2000px; }

/* Buttons */
.btn-tool {
  width: 100%; padding: 10px 12px; border: 2px solid var(--border);
  border-radius: 10px; background: var(--white); color: var(--on-sf);
  font-size: 12px; font-weight: 700; cursor: pointer;
  display: flex; align-items: center; gap: 8px; text-align: left;
  transition: all 0.15s; margin-bottom: 4px;
  box-shadow: 2px 2px 0 0 rgba(34,49,49,0.08);
}
.btn-tool:hover { background: var(--sf-low); }
.btn-tool:active { transform: translate(1px,1px); box-shadow: none; }
.btn-tool:disabled { opacity: 0.4; cursor: wait; }
.btn-tool .arrow { margin-left: auto; color: var(--pri); font-size: 12px; font-weight: 800; }

.open-ext-btn, .fetch-q-btn { cursor: pointer; }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

/* Spinner */
.spinner {
  display: inline-block; width: 12px; height: 12px;
  border: 2px solid var(--outline-var); border-top-color: var(--pri);
  border-radius: 50%; animation: spin 0.6s linear infinite;
  vertical-align: middle; margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Loading skeleton */
.skel {
  height: 50px; background: linear-gradient(90deg, var(--sf-ctr) 25%, var(--sf-high) 50%, var(--sf-ctr) 75%);
  background-size: 200% 100%; border-radius: 10px; margin-bottom: 6px;
  border: 2px solid var(--outline-var);
  animation: shimmer 1.5s infinite;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* Result area */
.result-area {
  background: var(--white); border-radius: 12px; padding: 12px;
  border: 2px solid var(--border); margin-top: 8px; display: none;
  box-shadow: 2px 2px 0 0 rgba(34,49,49,0.08);
}
.result-area .res-title {
  font-size: 10px; font-weight: 900; text-transform: uppercase;
  letter-spacing: 1.5px; color: var(--pri); margin-bottom: 6px;
}
.result-area .res-content {
  font-size: 11px; line-height: 1.6; white-space: pre-wrap;
  word-break: break-word; max-height: 320px; overflow-y: auto;
}

/* Period tabs */
.period-btn {
  border: 2px solid var(--border) !important; border-radius: 8px !important;
  font-weight: 800 !important; cursor: pointer;
  transition: all 0.15s;
}
.period-btn.active { background: var(--sec-ctr) !important; color: var(--sec) !important; }

.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; border: 1px solid var(--border); }
.hidden { display: none !important; }
</style>
</head>
<body>
<header class="hdr">
  <div style="display:flex;align-items:center;gap:8px">
    <span style="font-size:18px;color:var(--pri)">&#128187;</span>
    <span class="hdr-title">Newton</span>
  </div>
  <div class="hdr-actions">
    <span id="hdr-refresh" title="Refresh" style="color:var(--outline)">&#128260;</span>
  </div>
</header>

<div id="status-area"></div>

<!-- CONNECT PAGE (shown initially) -->
<div id="pg-connect" class="connect-page">
  <h2>&#9889; AI Learning Companion</h2>
  <p>Master coding with real-time AI guidance directly in your IDE.</p>
  <button class="btn-main" id="btn-connect">&#9889; Connect to Newton School</button>
  <p style="font-size:10px;color:var(--on-sf-var);margin-top:10px">Starts the MCP server and loads your data</p>
</div>

<!-- MAIN DASHBOARD (hidden until connected) -->
<div id="dashboard" class="main" style="display:none">

  <!-- ═══ DO NOW ═══ -->
  <div class="section-hdr">&#127919; DO NOW <span style="width:6px;height:6px;border-radius:50%;background:var(--tert);display:inline-block;animation:pulse 2s infinite;margin-left:auto"></span></div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
    <!-- QOTD Card -->
    <div class="neo-card" id="qotd-card">
      <div style="font-size:10px;font-weight:800;color:var(--pri);text-transform:uppercase;margin-bottom:4px">Daily Q</div>
      <div style="font-weight:800;font-size:12px;line-height:1.3" id="qotd-title">Loading...</div>
      <div style="font-size:9px;color:var(--on-sf-var);margin-top:4px" id="qotd-meta"></div>
    </div>
    <!-- Active Assignment Highlight -->
    <div class="neo-card" id="active-asgn-card" style="background:var(--pri-ctr)">
      <div style="font-size:10px;font-weight:800;color:var(--pri);text-transform:uppercase;margin-bottom:4px">Active</div>
      <div style="font-weight:800;font-size:12px;line-height:1.3;color:var(--on-sf)" id="active-asgn-title">&#8212;</div>
    </div>
  </div>

  <!-- Assignments -->
  <div id="assignments-area">
    <div class="skel"></div><div class="skel"></div>
  </div>

  <!-- ═══ YOUR STATS ═══ -->
  <div class="section-hdr">&#128202; YOUR STATS</div>

  <div class="stats-grid" id="stats-grid">
    <div class="stat-card"><div class="stat-label">Total XP</div><div class="stat-val" id="s-xp">&mdash;</div></div>
    <div class="stat-card gold"><div class="stat-label">Rank</div><div class="stat-val" id="s-rank">&mdash;</div></div>
    <div class="stat-card"><div class="stat-label">Level</div><div class="stat-val" id="s-level">&mdash;</div></div>
    <div class="stat-card coral"><div class="stat-label">Streak</div><div class="stat-val" id="s-streak">&mdash;</div></div>
  </div>
  <div class="progress-bar" id="progress-bar" style="display:none">
    <div class="progress-fill" id="progress-fill" style="width:0%"></div>
    <div class="progress-text" id="progress-text">Milestone</div>
  </div>

  <!-- ═══ LEADERBOARD ═══ -->
  <div class="section-hdr">&#127942; LEADERBOARD</div>
  <div style="display:flex;gap:6px;margin-bottom:8px">
    <button class="period-btn active" data-period="weekly" style="padding:4px 10px;font-size:10px;background:var(--sec-ctr);color:var(--sec)">Weekly</button>
    <button class="period-btn" data-period="monthly" style="padding:4px 10px;font-size:10px;background:var(--white);color:var(--on-sf-var)">Monthly</button>
    <button class="period-btn" data-period="" style="padding:4px 10px;font-size:10px;background:var(--white);color:var(--on-sf-var)">All Time</button>
  </div>
  <div id="lb-results">
    <button class="btn-tool" data-tool="get_leaderboard" data-args='{"period":"weekly"}'>&#127942; Load Leaderboard <span class="arrow">&#8594;</span></button>
  </div>

  <!-- Expandable: Course Overview -->
  <div class="card" style="padding:0;border:none;background:transparent;margin-bottom:4px">
    <div class="collapse-hdr" data-collapse="overview-body">
      <span style="font-weight:700;font-size:12px">&#128202; Course Overview</span>
      <span class="arrow">&#9660;</span>
    </div>
    <div class="collapse-body" id="overview-body">
      <button class="btn-tool" data-tool="get_course_overview">&#128202; Load Overview <span class="arrow">&#8594;</span></button>
      <div id="overview-results"></div>
    </div>
  </div>

  <!-- ═══ NEXT UP ═══ -->
  <div class="section-hdr">&#128197; NEXT UP</div>
  <div id="schedule-area">
    <button class="btn-tool" data-tool="get_upcoming_schedule" data-args='{"days":7}'>&#128197; Load Schedule (7 days) <span class="arrow">&#8594;</span></button>
  </div>
  <div id="schedule-results"></div>

  <!-- Expandable: Recent Lectures -->
  <div class="card" style="padding:0;border:none;background:transparent;margin-bottom:4px">
    <div class="collapse-hdr" data-collapse="lectures-body">
      <span style="font-weight:700;font-size:12px">&#127909; Recent Lectures</span>
      <span class="arrow">&#9660;</span>
    </div>
    <div class="collapse-body" id="lectures-body">
      <button class="btn-tool" data-tool="get_recent_lectures" data-args='{"limit":5}'>&#127909; Load Recent Lectures <span class="arrow">&#8594;</span></button>
      <div id="lecture-results"></div>
    </div>
  </div>

  <!-- ═══ PRACTICE ═══ -->
  <div class="section-hdr">&#128170; PRACTICE</div>
  <div class="grid2">
    <button class="btn-tool" data-tool="search_practice_questions" data-args='{"difficulty":"easy","limit":5}'>
      <span class="dot" style="background:var(--easy);width:8px;height:8px"></span> Easy <span class="arrow">&#8594;</span>
    </button>
    <button class="btn-tool" data-tool="search_practice_questions" data-args='{"difficulty":"medium","limit":5}'>
      <span class="dot" style="background:var(--medium);width:8px;height:8px"></span> Medium <span class="arrow">&#8594;</span>
    </button>
    <button class="btn-tool" data-tool="search_practice_questions" data-args='{"difficulty":"hard","limit":5}'>
      <span class="dot" style="background:var(--hard);width:8px;height:8px"></span> Hard <span class="arrow">&#8594;</span>
    </button>
    <button class="btn-tool" data-tool="search_practice_questions" data-args='{"limit":10}'>
      &#128293; All <span class="arrow">&#8594;</span>
    </button>
  </div>
  <button class="btn-tool" data-tool="get_arena_filters" style="margin-top:2px">&#128203; Browse Topics <span class="arrow">&#8594;</span></button>

  <!-- ═══ MORE ═══ -->
  <div class="section-hdr">&#128100; MORE</div>
  <button class="btn-tool" data-tool="get_me">&#128100; My Profile <span class="arrow">&#8594;</span></button>
  <button class="btn-tool" data-tool="get_qotd_history">&#128220; QOTD History <span class="arrow">&#8594;</span></button>

  <!-- Generic result area for any tool -->
  <div class="result-area" id="result-area">
    <div class="res-title" id="res-title">Results</div>
    <div class="res-content" id="res-content"></div>
  </div>

</div>

<script nonce="${nonce}">
(function() {
  var vscode = acquireVsCodeApi();
  var connected = false;

  // ── Helpers ──
  function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function diffBadge(d) {
    var c = d === 'Easy' ? '#4CAF50' : d === 'Medium' ? '#FF9800' : d === 'Hard' ? '#F44336' : '#888';
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:' + c + '22;color:' + c + '">' + esc(d) + '</span>';
  }
  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleDateString('en-IN', { day:'numeric', month:'short' }) + ' ' + d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
  }
  function fmtDay(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return days[d.getDay()] + ', ' + d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  }
  function timeDiff(ts) {
    if (!ts) return '';
    var diff = ts - Date.now();
    if (diff < 0) return 'OVERDUE';
    var hours = Math.floor(diff / 3600000);
    if (hours < 24) return hours + 'h left';
    return Math.floor(hours / 24) + 'd left';
  }

  // ── Connect ──
  document.getElementById('btn-connect').addEventListener('click', function() {
    this.disabled = true; this.textContent = 'Connecting...';
    vscode.postMessage({ command: 'connect' });
  });

  document.getElementById('hdr-refresh').addEventListener('click', function() {
    if (!connected) return;
    vscode.postMessage({ command: 'callTool', tool: 'get_assignments', args: {} });
    vscode.postMessage({ command: 'callTool', tool: 'get_arena_stats', args: {} });
    vscode.postMessage({ command: 'callTool', tool: 'get_question_of_the_day', args: {} });
    vscode.postMessage({ command: 'callTool', tool: 'get_upcoming_schedule', args: { days: 7 } });
  });

  // ── QOTD click ──
  document.getElementById('qotd-card').addEventListener('click', function() {
    vscode.postMessage({ command: 'callTool', tool: 'get_question_of_the_day', args: {} });
  });

  // ── Collapsible sections ──
  document.querySelectorAll('.collapse-hdr').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      var targetId = this.getAttribute('data-collapse');
      var body = document.getElementById(targetId);
      var arrow = this.querySelector('.arrow');
      if (body.classList.contains('open')) {
        body.classList.remove('open');
        arrow.style.transform = 'rotate(0deg)';
      } else {
        body.classList.add('open');
        arrow.style.transform = 'rotate(180deg)';
      }
    });
  });

  // ── Period tabs ──
  document.querySelectorAll('.period-btn').forEach(function(tab) {
    tab.addEventListener('click', function(e) {
      e.stopPropagation();
      document.querySelectorAll('.period-btn').forEach(function(t) {
        t.style.background = 'var(--sf-max)'; t.style.color = 'var(--on-sf-var)';
      });
      this.style.background = 'rgba(255,152,0,0.15)'; this.style.color = 'var(--medium)';
      var p = this.getAttribute('data-period');
      var lbBtn = document.querySelector('[data-tool="get_leaderboard"]');
      if (lbBtn) lbBtn.setAttribute('data-args', JSON.stringify(p ? { period: p } : {}));
    });
  });

  // ── Generic click handler for tool buttons and action buttons ──
  document.addEventListener('click', function(e) {
    var extBtn = e.target.closest('.open-ext-btn');
    if (extBtn) {
      var url = extBtn.getAttribute('data-url');
      if (url) vscode.postMessage({ command: 'openExternal', url: url });
      return;
    }
    var fetchBtn = e.target.closest('.fetch-q-btn');
    if (fetchBtn) {
      var qData = fetchBtn.getAttribute('data-question');
      if (qData) {
        try { vscode.postMessage({ command: 'fetchQuestion', questionData: JSON.parse(qData) }); } catch(ex) {}
      } else {
        var furl = fetchBtn.getAttribute('data-url');
        if (furl) vscode.postMessage({ command: 'fetchQuestion', url: furl });
      }
      return;
    }
    var btn = e.target.closest('[data-tool]:not(.period-btn)');
    if (!btn || btn.disabled) return;
    var tool = btn.getAttribute('data-tool');
    var argsStr = btn.getAttribute('data-args');
    var args = {};
    if (argsStr) { try { args = JSON.parse(argsStr); } catch(ex) {} }
    document.querySelectorAll('.btn-tool').forEach(function(b) { b.disabled = true; });
    vscode.postMessage({ command: 'callTool', tool: tool, args: args });
  });

  // ── Render functions ──

  function renderAssignments(data) {
    var h = '';
    var sections = [
      { label: '\\u{1F4CB} Assignments', items: data.assignments || [], icon: '\\u{1F4CB}' },
      { label: '\\u{1F3C6} Contests', items: data.contests || [], icon: '\\u{1F3C6}' }
    ];
    sections.forEach(function(sec) {
      if (sec.items.length === 0) return;
      sec.items.forEach(function(a) {
        var due = a.end_timestamp ? timeDiff(a.end_timestamp) : '';
        var isExpired = a.end_timestamp && a.end_timestamp < Date.now();
        var badgeClass = isExpired ? 'asgn-overdue' : 'asgn-due';
        h += '<div class="asgn-card" style="opacity:' + (isExpired ? '0.5' : '1') + '">';
        h += '<div style="display:flex;justify-content:space-between;align-items:center">';
        h += '<div class="asgn-title">' + esc(a.title || 'Assignment') + '</div>';
        var fetchAttr = a.url ? ' data-url="' + esc(a.url) + '"' : '';
        h += '<button class="asgn-btn fetch-q-btn"' + fetchAttr + '>Open \\u2192</button>';
        h += '</div>';
        h += '<div class="asgn-meta">';
        if (a.subject_name) h += esc(a.subject_name) + ' | ';
        h += (a.total_questions || 0) + ' questions';
        if (due) h += ' <span class="asgn-badge ' + badgeClass + '">\\u23F0 ' + due + '</span>';
        h += '</div></div>';
      });
    });
    return h || '<div style="color:var(--on-sf-var);font-size:11px;padding:8px">No pending assignments.</div>';
  }

  function renderLeaderboard(data) {
    var users = data.entries || [];
    if (!users.length) return '<div style="color:var(--on-sf-var);font-size:11px;padding:8px">No data.</div>';
    var h = '<div class="lb-scroll">';
    users.forEach(function(u) {
      var isMe = u.is_current_user;
      var suffix = u.rank === 1 ? 'st' : u.rank === 2 ? 'nd' : u.rank === 3 ? 'rd' : 'th';
      h += '<div class="lb-card' + (isMe ? ' me' : '') + '">';
      h += '<div class="lb-rank-label">Rank</div>';
      h += '<div><span class="lb-rank-num">' + u.rank + '</span><span class="lb-rank-suffix">' + suffix + '</span></div>';
      h += '<div class="lb-name">' + esc(u.name || 'User') + (isMe ? ' (You)' : '') + '</div>';
      h += '<div style="font-size:9px;font-weight:800;color:' + (isMe ? 'var(--pri-ctr)' : 'var(--pri)') + ';margin-top:2px">' + (u.xp || 0) + ' XP</div>';
      h += '</div>';
    });
    h += '</div>';
    return h;
  }

  function renderSchedule(data) {
    var lectures = data.upcoming_lectures || [];
    var contests = data.upcoming_contests || [];
    var all = lectures.concat(contests);
    if (all.length === 0) return '<div style="color:var(--on-sf-var);font-size:11px;padding:8px">No upcoming events in the next ' + (data.days_ahead || 7) + ' days.</div>';
    var byDay = {};
    all.forEach(function(item) {
      var dayKey = fmtDay(item.start_timestamp);
      if (!byDay[dayKey]) byDay[dayKey] = [];
      byDay[dayKey].push(item);
    });
    var h = '';
    Object.keys(byDay).forEach(function(day) {
      h += '<div style="font-weight:700;font-size:11px;color:var(--pri);margin:8px 0 4px">' + esc(day) + '</div>';
      byDay[day].forEach(function(item) {
        var type = item.type || 'lecture';
        h += '<div class="sch-item' + (type === 'contest' ? ' contest' : '') + '">';
        h += '<div style="display:flex;justify-content:space-between;align-items:center">';
        h += '<span style="font-weight:700;font-size:12px">' + esc(item.subject_name || item.title || 'Class') + '</span>';
        h += '<span style="font-size:10px;color:var(--on-sf-var)">' + fmtTime(item.start_timestamp) + ' - ' + fmtTime(item.end_timestamp) + '</span>';
        h += '</div>';
        if (item.title && item.subject_name) h += '<div style="font-size:10px;color:var(--on-sf-var);margin-top:2px">' + esc(item.title) + '</div>';
        if (item.url) h += '<button class="open-ext-btn" data-url="' + esc(item.url) + '" style="margin-top:4px;padding:3px 10px;border-radius:6px;background:var(--sf-max);color:var(--pri);border:none;font-size:10px;font-weight:700;cursor:pointer">Open \\u2197</button>';
        h += '</div>';
      });
    });
    return h;
  }

  function renderLectures(data) {
    var items = data.lectures || data.recent_lectures || [];
    if (items.length === 0) return '<div style="color:var(--on-sf-var)">No recent lectures.</div>';
    var h = '';
    items.forEach(function(item) {
      var hasRec = item.has_recording || item.recording_available;
      var recUrl = item.recording_url || item.recording_link || '';
      h += '<div style="background:var(--white);border-radius:10px;padding:8px 12px;margin-bottom:4px;border:2px solid var(--border)">';
      h += '<div style="font-weight:800;font-size:12px">' + esc(item.title || item.subject_name || 'Lecture') + '</div>';
      h += '<div style="font-size:10px;color:var(--on-sf-var);margin-top:2px">';
      if (item.start_timestamp) h += fmtDate(item.start_timestamp) + ' ';
      if (hasRec && recUrl) {
        h += '<button class="open-ext-btn" data-url="' + esc(recUrl) + '" style="padding:2px 10px;border-radius:6px;background:var(--pri);color:#BFFFF5;border:2px solid var(--border);font-size:10px;font-weight:800;cursor:pointer;margin-left:4px;box-shadow:1px 1px 0 0 var(--border)">\\u25B6 Play</button>';
      } else if (hasRec) {
        h += '<span style="color:var(--pri);font-weight:800">\\u25B6 Recording Available</span>';
      }
      h += '</div></div>';
    });
    return h;
  }

  function renderPractice(data) {
    if (!data.questions) return '<div style="color:var(--on-sf-var)">No questions found.</div>';
    var h = '';
    data.questions.forEach(function(q) {
      var solved = q.is_solved ? '<span style="color:var(--pri);font-size:10px;font-weight:800"> \\u2713 Solved</span>' : '';
      var link = q.link || q.url || '';
      var qObj = JSON.stringify({ title: q.title, difficulty: q.difficulty, topics: q.topics, companies: q.companies, url: link }).replace(/"/g, '&quot;');
      h += '<div style="background:var(--white);border-radius:10px;padding:10px 12px;margin-bottom:6px;border:2px solid var(--border);border-left:4px solid ' + (q.difficulty === 'Easy' ? 'var(--easy)' : q.difficulty === 'Medium' ? 'var(--medium)' : 'var(--hard)') + '">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
      h += '<span style="font-weight:800;font-size:12px">' + esc(q.title) + solved + '</span>';
      h += '<button class="asgn-btn fetch-q-btn" data-question="' + qObj + '">Open</button>';
      h += '</div>';
      h += '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">' + diffBadge(q.difficulty || '') + '</div>';
      h += '<div style="font-size:10px;color:var(--on-sf-var);margin-top:2px">' + (q.solve_count || 0) + ' solved / ' + (q.attempt_count || 0) + ' attempts</div>';
      h += '</div>';
    });
    return h;
  }

  function renderCourseOverview(data) {
    var xp = data.xp || {};
    var perf = data.performance || {};
    var h = '<div style="font-weight:700;font-size:13px;margin-bottom:8px">' + esc(data.course_title || '') + '</div>';
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">';
    var stats = [
      { label: 'Total XP', value: xp.total_earned || 0, color: 'var(--pri)' },
      { label: 'Rank', value: xp.overall_rank ? '#' + xp.overall_rank : 'N/A', color: 'var(--sec)' },
      { label: 'Students', value: xp.student_count || 0, color: 'var(--tert)' },
      { label: 'Lectures', value: (perf.lectures_attended || 0) + '/' + (perf.total_lectures || 0), color: 'var(--pri)' }
    ];
    stats.forEach(function(s) {
      h += '<div style="background:var(--white);border-radius:10px;padding:10px;text-align:center;border:2px solid var(--border)">';
      h += '<div style="font-size:18px;font-weight:900;color:' + s.color + '">' + esc(String(s.value)) + '</div>';
      h += '<div style="font-size:9px;font-weight:800;color:var(--outline);text-transform:uppercase">' + s.label + '</div></div>';
    });
    h += '</div>';
    h += '<div style="font-weight:700;font-size:11px;color:var(--pri);margin:6px 0 4px">Performance</div>';
    var bars = [
      { label: 'Assignments', done: perf.completed_assignment_questions || 0, total: perf.total_assignment_questions || 1 },
      { label: 'Contests', done: perf.completed_contest_questions || 0, total: perf.total_contest_questions || 1 },
      { label: 'Assessments', done: perf.completed_assessments || 0, total: perf.total_assessments || 1 }
    ];
    bars.forEach(function(b) {
      var pct = Math.round((b.done / b.total) * 100);
      var color = pct >= 70 ? 'var(--pri)' : pct >= 30 ? 'var(--sec)' : 'var(--tert)';
      h += '<div style="background:var(--white);border-radius:10px;padding:8px 10px;margin-bottom:4px;border:2px solid var(--border)">';
      h += '<div style="display:flex;justify-content:space-between;font-size:10px;font-weight:700;margin-bottom:4px"><span>' + b.label + '</span><span>' + b.done + '/' + b.total + ' (' + pct + '%)</span></div>';
      h += '<div style="height:6px;background:var(--sf-ctr);border-radius:999px;border:1px solid var(--outline-var)"><div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:999px"></div></div></div>';
    });
    return h;
  }

  function renderProfile(data) {
    var h = '<div style="text-align:center;padding:12px">';
    h += '<div style="font-weight:800;font-size:16px">' + esc(data.first_name + ' ' + (data.last_name || '')) + '</div>';
    h += '<div style="font-size:11px;color:var(--on-sf-var)">' + esc(data.username || '') + '</div>';
    h += '<div style="font-size:10px;color:var(--on-sf-var);margin-top:4px">' + esc(data.email || '') + '</div>';
    h += '</div>';
    return h;
  }

  function renderQotd(data) {
    var h = '<div style="background:var(--white);border-radius:12px;padding:14px;border:2px solid var(--border);box-shadow:2px 2px 0 0 var(--border)">';
    h += '<div style="font-weight:900;font-size:14px;margin-bottom:6px">' + esc(data.title) + '</div>';
    h += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">';
    if (data.difficulty) h += diffBadge(data.difficulty);
    h += '<span style="font-size:10px;color:var(--on-sf-var)">\\u{1F525} Streak: ' + (data.current_streak || 0) + ' (Best: ' + (data.longest_streak || 0) + ')</span>';
    h += '</div>';
    var link = data.url || '';
    if (link) h += '<button class="btn-main fetch-q-btn" data-url="' + esc(link) + '" style="margin-top:8px;height:36px;font-size:12px">Open Problem</button>';
    h += '</div>';
    return h;
  }

  function renderGeneric(result) {
    if (!result) return 'No data returned.';
    if (result.content && Array.isArray(result.content)) {
      return '<div style="color:var(--on-sf-var);font-size:11px;white-space:pre-wrap">' + esc(result.content.map(function(c) { return c.text || ''; }).join('\\n\\n')) + '</div>';
    }
    return '<div style="color:var(--on-sf-var);font-size:11px;white-space:pre-wrap">' + esc(typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)) + '</div>';
  }

  // ── Route tool results to the right container ──
  function routeResult(tool, parsed, raw) {
    var targetId = null;
    var html = '';

    if (tool === 'get_assignments' && parsed) {
      document.getElementById('assignments-area').innerHTML = renderAssignments(parsed);
      return;
    }
    if (tool === 'get_leaderboard' && parsed) {
      document.getElementById('lb-results').innerHTML = renderLeaderboard(parsed);
      return;
    }
    if ((tool === 'get_upcoming_schedule' || tool === 'get_calendar') && parsed) {
      document.getElementById('schedule-results').innerHTML = renderSchedule(parsed);
      return;
    }
    if (tool === 'get_recent_lectures' && parsed) {
      document.getElementById('lecture-results').innerHTML = renderLectures(parsed);
      return;
    }
    if (tool === 'get_course_overview' && parsed) {
      document.getElementById('overview-results').innerHTML = renderCourseOverview(parsed);
      return;
    }
    if (tool === 'get_question_of_the_day' && parsed && parsed.title) {
      document.getElementById('qotd-title').textContent = parsed.title;
      var meta = [];
      if (parsed.difficulty) meta.push(parsed.difficulty);
      meta.push('Streak: ' + (parsed.current_streak || 0));
      document.getElementById('qotd-meta').textContent = meta.join(' | ');
    }

    // For everything else, show in the generic result area
    var resArea = document.getElementById('result-area');
    resArea.style.display = 'block';
    document.getElementById('res-title').textContent = tool.replace(/_/g, ' ');

    if (tool === 'search_practice_questions' && parsed) {
      document.getElementById('res-content').innerHTML = renderPractice(parsed);
    } else if (tool === 'get_me' && parsed && parsed.first_name) {
      document.getElementById('res-content').innerHTML = renderProfile(parsed);
    } else if (tool === 'get_question_of_the_day' && parsed && parsed.title) {
      document.getElementById('res-content').innerHTML = renderQotd(parsed);
    } else if (tool === 'get_arena_filters' && parsed) {
      var fh = '';
      if (parsed.topics) {
        fh += '<div style="font-weight:700;font-size:11px;color:var(--pri);margin-bottom:4px">Topics</div><div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px">';
        (parsed.topics || []).slice(0, 20).forEach(function(t) {
          var name = typeof t === 'string' ? t : (t.name || t.slug || '');
          fh += '<span style="padding:2px 6px;border-radius:6px;font-size:9px;background:var(--sf-max);color:var(--on-sf-var)">' + esc(name) + '</span>';
        });
        fh += '</div>';
      }
      if (parsed.companies) {
        fh += '<div style="font-weight:700;font-size:11px;color:var(--pri);margin-bottom:4px">Companies</div><div style="display:flex;flex-wrap:wrap;gap:3px">';
        (parsed.companies || []).slice(0, 20).forEach(function(c) {
          var name = typeof c === 'string' ? c : (c.name || c.slug || '');
          fh += '<span style="padding:2px 6px;border-radius:6px;font-size:9px;background:rgba(138,76,252,0.15);color:var(--pri)">' + esc(name) + '</span>';
        });
        fh += '</div>';
      }
      document.getElementById('res-content').innerHTML = fh || '<div style="color:var(--on-sf-var)">No filters.</div>';
    } else if (tool === 'get_qotd_history' && parsed && (parsed.history || parsed.past_questions)) {
      var items = parsed.history || parsed.past_questions || [];
      var qh = '';
      items.forEach(function(q, i) {
        qh += '<div style="background:var(--sf-ctr);border-radius:8px;padding:6px 10px;margin-bottom:4px;display:flex;align-items:center;gap:6px">';
        qh += '<span style="font-size:10px;color:var(--on-sf-var);min-width:20px">#' + (i+1) + '</span>';
        qh += '<span style="font-weight:600;font-size:11px;flex:1">' + esc(q.title || '') + '</span>';
        if (q.difficulty) qh += diffBadge(q.difficulty);
        qh += '</div>';
      });
      document.getElementById('res-content').innerHTML = qh || '<div style="color:var(--on-sf-var)">No history.</div>';
    } else if (tool === 'get_arena_stats' && parsed) {
      // already handled in updateStats, but show nicely too
      resArea.style.display = 'none';
    } else {
      document.getElementById('res-content').innerHTML = renderGeneric(raw);
    }
  }

  // ── Update stat cards ──
  function updateStats(tool, data) {
    if (tool === 'get_arena_stats') {
      if (data.solved_count !== undefined) document.getElementById('s-solved').textContent = data.solved_count;
    }
    if (tool === 'get_course_overview') {
      var xp = data.xp || {};
      if (xp.overall_rank) document.getElementById('s-rank').textContent = '#' + xp.overall_rank;
      if (xp.total_earned) document.getElementById('s-xp').textContent = xp.total_earned;
    }
  }

  function enableBtns() {
    document.querySelectorAll('.btn-tool').forEach(function(b) { b.disabled = false; });
  }

  // ── Auth expired handler ──
  function showAuthExpired(errMsg) {
    connected = false;
    // Switch back to connect page with an auth-expired message
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('pg-connect').style.display = 'block';
    var statusEl = document.getElementById('status-area');
    statusEl.innerHTML = '<div class="status status-err" style="margin:0 0 10px">\u274C ' + esc(errMsg || 'Newton session is invalid or expired. Please login again.') + '</div>';
    var connectPage = document.getElementById('pg-connect');
    // Inject a re-login guidance card if not already present
    if (!document.getElementById('relogin-card')) {
      var card = document.createElement('div');
      card.id = 'relogin-card';
      card.style.cssText = 'background:rgba(255,146,136,0.1);border:2px solid var(--tert);border-radius:12px;padding:14px;margin-top:12px;text-align:center';
      card.innerHTML = '<div style="font-size:13px;font-weight:800;color:var(--tert);margin-bottom:6px">\uD83D\uDD12 Session Expired</div>'
        + '<div style="font-size:11px;color:var(--on-sf-var);margin-bottom:12px;line-height:1.5">Your Newton School session has expired.<br>Click below to log in again via Chrome.</div>'
        + '<button id="btn-relogin" class="btn-main" style="background:linear-gradient(135deg,var(--tert),var(--tert-ctr));color:#fff">\uD83D\uDD12 Log In Again</button>';
      connectPage.appendChild(card);
      document.getElementById('btn-relogin').addEventListener('click', function() {
        this.disabled = true;
        this.textContent = 'Opening login browser...';
        vscode.postMessage({ command: 'relogin' });
      });
    }
    // Also reset the main connect button
    var b = document.getElementById('btn-connect');
    if (b) { b.disabled = false; b.textContent = '\u21BA Reconnect'; }
  }

  // ── Message handler ──
  window.addEventListener('message', function(ev) {
    var msg = ev.data;

    if (msg.command === 'status') {
      var el = document.getElementById('status-area');
      if (msg.state === 'connecting') {
        el.innerHTML = '<div class="status status-conn"><span class="spinner"></span>' + msg.message + '</div>';
      } else if (msg.state === 'connected') {
        el.innerHTML = '<div class="status status-ok">' + msg.message + '</div>';
        connected = true;
        // Show dashboard, hide connect page
        document.getElementById('pg-connect').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        setTimeout(function() { el.innerHTML = ''; }, 2000); // fade status after 2s
      } else if (msg.state === 'error') {
        if (msg.isAuthError) {
          showAuthExpired(msg.error);
        } else {
          el.innerHTML = '<div class="status status-err">' + esc(msg.message) + '</div>';
          var b = document.getElementById('btn-connect');
          if (b) { b.disabled = false; b.textContent = '\u21BA Retry'; }
        }
      }
    }

    if (msg.command === 'loading') {
      // For routed tools, show inline loading; for others, show in result area
      var routedTools = ['get_assignments','get_leaderboard','get_upcoming_schedule','get_calendar','get_recent_lectures','get_course_overview'];
      if (routedTools.indexOf(msg.tool) === -1) {
        var resArea = document.getElementById('result-area');
        resArea.style.display = 'block';
        document.getElementById('res-title').textContent = msg.tool.replace(/_/g, ' ');
        document.getElementById('res-content').innerHTML = '<span class="spinner"></span> Fetching...';
      }
    }

    if (msg.command === 'toolResult') {
      enableBtns();
      var parsed = null;
      try {
        var text = '';
        if (msg.result && msg.result.content) {
          text = msg.result.content.map(function(c) { return c.text || ''; }).join('');
        }
        if (text) parsed = JSON.parse(text);
      } catch(e) {}

      if (parsed) updateStats(msg.tool, parsed);

      // On list_courses, auto-fetch the 4 essential data sets
      if (msg.tool === 'list_courses') {
        if (!connected) { connected = true; document.getElementById('pg-connect').style.display = 'none'; document.getElementById('dashboard').style.display = 'block'; }
        vscode.postMessage({ command: 'callTool', tool: 'get_assignments', args: {} });
        vscode.postMessage({ command: 'callTool', tool: 'get_arena_stats', args: {} });
        vscode.postMessage({ command: 'callTool', tool: 'get_question_of_the_day', args: {} });
        vscode.postMessage({ command: 'callTool', tool: 'get_upcoming_schedule', args: { days: 7 } });
        vscode.postMessage({ command: 'callTool', tool: 'get_course_overview', args: {} });
        return; // don't render list_courses raw data
      }

      routeResult(msg.tool, parsed, msg.result);
    }

    if (msg.command === 'toolError') {
      enableBtns();
      if (msg.isAuthError) {
        // Session expired — show the re-login state
        showAuthExpired(msg.error);
      } else {
        var resArea = document.getElementById('result-area');
        resArea.style.display = 'block';
        document.getElementById('res-title').textContent = 'Error';
        document.getElementById('res-content').textContent = msg.error;
      }
    }
  });
})();
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let t = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { t += c.charAt(Math.floor(Math.random() * c.length)); }
  return t;
}
