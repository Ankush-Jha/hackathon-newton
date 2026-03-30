// src/runner/testRunner.ts
// Runs solutions against test cases locally.
// Supports: Python, C++, JavaScript, Java

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

export interface TestCase {
    input: string;
    output: string;
}

export interface TestResult {
    passed: boolean;
    actual: string;
    error?: string;
}

type LangConfig = {
    ext: string;
    compile?: (filePath: string) => { cmd: string; args: string[]; outFile?: string };
    run: (filePath: string) => { cmd: string; args: string[] };
};

const LANG_MAP: Record<string, LangConfig> = {
    python: {
        ext: '.py',
        run: (f) => ({ cmd: 'python3', args: [f] })
    },
    javascript: {
        ext: '.js',
        run: (f) => ({ cmd: 'node', args: [f] })
    },
    typescript: {
        ext: '.ts',
        run: (f) => ({ cmd: 'npx', args: ['ts-node', '--transpile-only', f] })
    },
    cpp: {
        ext: '.cpp',
        compile: (f) => {
            const out = f.replace(/\.cpp$/, '');
            return { cmd: 'g++', args: ['-O2', '-std=c++17', '-o', out, f], outFile: out };
        },
        run: (f) => ({ cmd: f.replace(/\.cpp$/, ''), args: [] })
    },
    c: {
        ext: '.c',
        compile: (f) => {
            const out = f.replace(/\.c$/, '');
            return { cmd: 'gcc', args: ['-O2', '-o', out, f], outFile: out };
        },
        run: (f) => ({ cmd: f.replace(/\.c$/, ''), args: [] })
    },
    java: {
        ext: '.java',
        compile: (f) => ({ cmd: 'javac', args: [f] }),
        run: (f) => {
            const dir = path.dirname(f);
            const className = path.basename(f, '.java');
            return { cmd: 'java', args: ['-cp', dir, className] };
        }
    }
};

export async function runTestCases(tests: TestCase[]): Promise<TestResult[]> {
    // Get active editor
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        const editors = vscode.window.visibleTextEditors;
        if (editors.length > 0) {
            editor = editors[0];
        } else {
            vscode.window.showErrorMessage('No active editor. Open your solution file.');
            return tests.map(() => ({ passed: false, actual: 'No active editor' }));
        }
    }

    const doc = editor.document;
    const langId = doc.languageId;

    // Map VS Code language IDs to our config
    const langKey = resolveLangKey(langId);
    const config = langKey ? LANG_MAP[langKey] : null;

    if (!config) {
        vscode.window.showErrorMessage(
            `Unsupported language: ${langId}. Supported: Python, C++, C, JavaScript, TypeScript, Java.`
        );
        return tests.map(() => ({ passed: false, actual: `Unsupported language: ${langId}` }));
    }

    const code = doc.getText();
    const tmpDir = os.tmpdir();
    const basename = `newton_sol_${Date.now()}`;
    const tmpFile = path.join(tmpDir, basename + config.ext);

    // For Java, use "Main" class name to avoid naming conflicts
    let javaFile = tmpFile;
    if (langKey === 'java') {
        // Extract class name from code, or default to "Main"
        const classMatch = code.match(/public\s+class\s+(\w+)/);
        const className = classMatch ? classMatch[1] : 'Main';
        javaFile = path.join(tmpDir, className + '.java');
        try { fs.writeFileSync(javaFile, code); } catch {
            return tests.map(() => ({ passed: false, actual: 'Failed to write temp file' }));
        }
    } else {
        try { fs.writeFileSync(tmpFile, code); } catch {
            return tests.map(() => ({ passed: false, actual: 'Failed to write temp file' }));
        }
    }

    const actualFile = langKey === 'java' ? javaFile : tmpFile;
    const cleanupFiles: string[] = [actualFile];

    // ── Compile step (C++, C, Java) ──
    if (config.compile) {
        const compileInfo = config.compile(actualFile);
        if (compileInfo.outFile) { cleanupFiles.push(compileInfo.outFile); }

        const compileResult = await runProcess(compileInfo.cmd, compileInfo.args, '', 10000);
        if (compileResult.stderr || compileResult.exitCode !== 0) {
            cleanup(cleanupFiles);
            const errMsg = `Compilation Error:\n${compileResult.stderr || `Exit code ${compileResult.exitCode}`}`;
            return tests.map(() => ({ passed: false, actual: errMsg, error: errMsg }));
        }
    } else {
        // For interpreted languages, check if the interpreter exists
        const runInfo = config.run(actualFile);
        const exists = await cmdExists(runInfo.cmd);
        if (!exists) {
            cleanup(cleanupFiles);
            vscode.window.showErrorMessage(`${runInfo.cmd} not found. Please install it.`);
            return tests.map(() => ({ passed: false, actual: `${runInfo.cmd} not found` }));
        }
    }

    // ── Run tests ──
    const runInfo = config.run(actualFile);
    const results: TestResult[] = [];

    for (const test of tests) {
        const result = await runProcess(runInfo.cmd, runInfo.args, test.input, 5000);
        const passed = normalize(result.stdout) === normalize(test.output);
        results.push({
            passed,
            actual: result.stdout || result.stderr,
            error: result.stderr || undefined
        });
    }

    cleanup(cleanupFiles);
    return results;
}

function resolveLangKey(langId: string): string | null {
    const map: Record<string, string> = {
        'python': 'python',
        'javascript': 'javascript',
        'javascriptreact': 'javascript',
        'typescript': 'typescript',
        'typescriptreact': 'typescript',
        'cpp': 'cpp',
        'c': 'c',
        'java': 'java',
    };
    return map[langId] || null;
}

function cmdExists(command: string): Promise<boolean> {
    return new Promise((resolve) => {
        const p = spawn(command, ['--version']);
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
    });
}

interface ProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

function runProcess(command: string, args: string[], input: string, timeoutMs: number): Promise<ProcessResult> {
    return new Promise((resolve) => {
        const proc = spawn(command, args);
        let stdout = '';
        let stderr = '';

        const timeout = setTimeout(() => {
            proc.kill();
            resolve({ stdout: '', stderr: `Time Limit Exceeded (${timeoutMs / 1000}s)`, exitCode: null });
        }, timeoutMs);

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.on('close', (code) => {
            clearTimeout(timeout);
            resolve({ stdout, stderr, exitCode: code });
        });

        proc.on('error', (err) => {
            clearTimeout(timeout);
            resolve({ stdout: '', stderr: 'Failed: ' + err.message, exitCode: null });
        });

        proc.stdin.write(input);
        proc.stdin.end();
    });
}

function cleanup(files: string[]): void {
    for (const f of files) {
        try { fs.unlinkSync(f); } catch { /* ok */ }
    }
    // Also clean up .class files for Java
    for (const f of files) {
        if (f.endsWith('.java')) {
            const classFile = f.replace(/\.java$/, '.class');
            try { fs.unlinkSync(classFile); } catch { /* ok */ }
        }
    }
}

function normalize(str: string): string {
    return (str || '').trim().replace(/\r\n/g, '\n');
}
