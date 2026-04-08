// src/scraper/questionFetcher.ts
// Fetches Newton School questions using puppeteer-core (system Chrome).
// Uses a persistent user data directory so login sessions are preserved.
// Includes in-memory cache with 30-min TTL to avoid redundant scraping.
// Uses a singleton browser to prevent multiple Chrome windows from opening.

import * as puppeteer from 'puppeteer-core';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ── Singleton Browser Manager ────────────────────────────────────────────
// Ensures only ONE Chrome instance runs at a time across all function calls.
// Reference-counted: opens when first needed, closes after IDLE_TIMEOUT_MS
// of no active users, or immediately when headless mode needs to switch.

const IDLE_TIMEOUT_MS = 10_000; // close Chrome if idle for 10 s

let _browser: puppeteer.Browser | null = null;
let _browserHeadless: boolean = true;
let _refCount = 0;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _launchPromise: Promise<puppeteer.Browser> | null = null; // prevents race conditions

/** Acquire a shared browser. Caller MUST call releaseBrowser() when done. */
async function acquireBrowser(headless: boolean): Promise<puppeteer.Browser> {
    // If we need a different headedness, close the existing headless one first
    if (_browser && _browserHeadless !== headless) {
        await forceCloseBrowser();
    }

    // Cancel any pending idle close
    if (_idleTimer) {
        clearTimeout(_idleTimer);
        _idleTimer = null;
    }

    // If already launching, wait for it
    if (_launchPromise) {
        _browser = await _launchPromise;
    }

    if (!_browser) {
        _launchPromise = launchBrowser(headless);
        try {
            _browser = await _launchPromise;
            _browserHeadless = headless;
        } finally {
            _launchPromise = null;
        }
        // Clean up if browser disconnects unexpectedly
        _browser.on('disconnected', () => {
            _browser = null;
            _refCount = 0;
            _launchPromise = null;
        });
    }

    _refCount++;
    return _browser;
}

/** Release the shared browser. Starts idle timer to auto-close. */
function releaseBrowser(): void {
    _refCount = Math.max(0, _refCount - 1);
    if (_refCount === 0 && _browser) {
        _idleTimer = setTimeout(() => {
            forceCloseBrowser().catch(() => { /* ignore */ });
        }, IDLE_TIMEOUT_MS);
    }
}

async function forceCloseBrowser(): Promise<void> {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    const b = _browser;
    _browser = null;
    _refCount = 0;
    _launchPromise = null;
    if (b) { try { await b.close(); } catch { /* already closed */ } }
}

/** Forcefully close the shared browser (e.g. on extension deactivation). */
export async function closeBrowserSingleton(): Promise<void> {
    await forceCloseBrowser();
}

// ── Question Cache ──────────────────────────────────────────────────────
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX = 50;
const _questionCache = new Map<string, { data: QuestionData; ts: number }>();

/** Cache a question by its key (URL or title). */
function cacheSet(key: string, data: QuestionData): void {
    // LRU eviction: remove oldest if at capacity
    if (_questionCache.size >= CACHE_MAX) {
        const oldest = _questionCache.keys().next().value;
        if (oldest) { _questionCache.delete(oldest); }
    }
    _questionCache.set(key, { data, ts: Date.now() });
}

/** Get a cached question if it exists and hasn't expired. */
function cacheGet(key: string): QuestionData | null {
    const entry = _questionCache.get(key);
    if (!entry) { return null; }
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _questionCache.delete(key);
        return null;
    }
    return entry.data;
}

export interface QuestionData {
    title: string;
    description: string;
    inputFormat: string;
    outputFormat: string;
    examples: { input: string; output: string }[];
    constraints: string;
    fullText: string;
    url: string;
    difficulty?: string;
    timeLimit?: string;
    memoryLimit?: string;
    topics?: string[];
    companies?: string[];
    playgroundHash?: string;
}

/**
 * Extract playground hash from a Newton School URL.
 * e.g. /playground/coding/h/vmc8l6qyfh90/ → "vmc8l6qyfh90"
 */
function extractPlaygroundHash(url: string): string | undefined {
    const match = url.match(/\/playground\/coding\/h\/([a-z0-9]+)/i);
    return match?.[1];
}

/**
 * Extract session cookies from the persistent Chrome profile for API authentication.
 * Uses the shared browser singleton — no extra Chrome window is opened.
 * Returns the cookie string in "name=value; name2=value2" format.
 */
export async function getCookiesForDomain(): Promise<string> {
    const browser = await acquireBrowser(true);
    try {
        const page = await browser.newPage();
        try {
            await page.goto('https://my.newtonschool.co', {
                waitUntil: 'networkidle2',
                timeout: 15000
            });
            const cookies = await page.cookies();
            return cookies.map(c => `${c.name}=${c.value}`).join('; ');
        } finally {
            await page.close();
        }
    } catch (err) {
        throw new Error(`Failed to extract cookies: ${err instanceof Error ? err.message : err}`);
    } finally {
        releaseBrowser();
    }
}

// Newton School API credentials (extracted from their web app's network requests)
const NEWTON_CLIENT_ID = '1I4rv6bekM8zAZfjwf4pxC6i4BFgP2M8hqWdvY7M';
const NEWTON_CLIENT_SECRET = 'f3zqwMUUQ5VJOFQAuoAWlDJlfjauOTHNRy8djit9XgjjQcdrQn3WYj6k5qGPvpZDGNuKxacOvaSUddQ6fX9GOjVWWG2GKrUHQQIiXUE1rmveA1NihaWUavL4uqR6xRo9';

/**
 * Fetch a Newton School API endpoint using the browser's auth context.
 *
 * Newton's API requires 3 headers for authentication:
 * 1. Authorization: Bearer <access_token_ns_student_web cookie>
 * 2. client-id: <static client ID>
 * 3. client-secret: <static client secret>
 *
 * This function uses Puppeteer to:
 * - Launch headless Chrome with the persistent profile
 * - Navigate to Newton School to verify login
 * - Extract the access_token_ns_student_web cookie
 * - Make the API call with all required headers
 */
export async function fetchApiViaBrowser(apiPath: string): Promise<unknown> {
    const browser = await acquireBrowser(true);
    const page = await browser.newPage();
    try {

        // Navigate to Newton School to establish auth context
        await page.goto('https://my.newtonschool.co/dashboard', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Check if redirected to login
        if (page.url().includes('/login') || page.url().includes('/register')) {
            throw new Error('NOT_LOGGED_IN');
        }

        // Extract the auth token from cookies
        const cookies = await page.cookies('https://my.newtonschool.co');
        const authCookie = cookies.find(c => c.name === 'access_token_ns_student_web');
        if (!authCookie) {
            throw new Error('NOT_LOGGED_IN');
        }
        const token = authCookie.value;

        // Build full URL
        const fullUrl = apiPath.startsWith('http')
            ? apiPath
            : `https://my.newtonschool.co${apiPath}`;

        // Make the API call with all 3 required headers
        const result = await page.evaluate(
            async (url: string, bearerToken: string, clientId: string, clientSecret: string) => {
                try {
                    const resp = await fetch(url, {
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${bearerToken}`,
                            'client-id': clientId,
                            'client-secret': clientSecret,
                        }
                    });
                    if (!resp.ok) {
                        return { __error: true, status: resp.status, message: await resp.text() };
                    }
                    return await resp.json();
                } catch (err) {
                    return { __error: true, status: 0, message: String(err) };
                }
            },
            fullUrl, token, NEWTON_CLIENT_ID, NEWTON_CLIENT_SECRET
        );

        if (result && typeof result === 'object' && (result as Record<string, unknown>).__error) {
            const errObj = result as Record<string, unknown>;
            throw new Error(`API error (${errObj.status}): ${errObj.message}`);
        }

        return result;
    } catch (err) {
        if (err instanceof Error && err.message === 'NOT_LOGGED_IN') { throw err; }
        throw new Error(`Browser API fetch failed: ${err instanceof Error ? err.message : err}`);
    } finally {
        try { await page.close(); } catch { /* */ }
        releaseBrowser();
    }
}

// Persistent profile directory — stored alongside the extension so cookies survive restarts
let _profileDir: string | undefined;

export function setProfileDir(dir: string): void {
    _profileDir = dir;
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function getProfileDir(): string {
    if (_profileDir) { return _profileDir; }
    // fallback to a temp dir (session won't persist)
    const fallback = path.join(os.tmpdir(), 'newton-chrome-profile');
    if (!fs.existsSync(fallback)) { fs.mkdirSync(fallback, { recursive: true }); }
    return fallback;
}

function findChromePath(): string {
    const platform = os.platform();
    const paths: string[] = platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        ]
        : platform === 'win32'
            ? [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
            ]
            : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

    for (const p of paths) {
        if (fs.existsSync(p)) { return p; }
    }
    throw new Error('Chrome not found. Install Google Chrome.');
}

async function launchBrowser(headless: boolean = true): Promise<puppeteer.Browser> {
    const profileDir = getProfileDir();

    // Chrome leaves lock files behind when it exits uncleanly (e.g. extension reload,
    // Puppeteer crash, VS Code restart). Delete them before launching so we never
    // hit "The browser is already running" errors.
    for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.rmSync(path.join(profileDir, lockFile), { force: true }); } catch { /* ignore */ }
    }

    return puppeteer.launch({
        executablePath: findChromePath(),
        headless: headless ? true : false,
        userDataDir: profileDir,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,900'
        ],
        defaultViewport: headless ? { width: 1280, height: 900 } : null
    });
}

/**
 * Open a visible Chrome window to the Newton School login page.
 * The user logs in manually; cookies are saved to the persistent profile.
 * Returns a promise that resolves when the user closes the browser or after
 * they navigate past the login page.
 */
export async function openLoginBrowser(): Promise<void> {
    const browser = await launchBrowser(false); // visible/headed mode
    try {
        const page = await browser.newPage();
        await page.goto('https://my.newtonschool.co/login', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Wait until the user is logged in (URL no longer contains /login)
        // or the browser is closed manually
        await new Promise<void>((resolve) => {
            const interval = setInterval(async () => {
                try {
                    const url = page.url();
                    // If redirected away from login, they're logged in
                    if (!url.includes('/login') && !url.includes('/signup') && !url.includes('/register')) {
                        clearInterval(interval);
                        // Give cookies a moment to settle
                        await new Promise(r => setTimeout(r, 1500));
                        resolve();
                    }
                } catch {
                    // Page or browser was closed
                    clearInterval(interval);
                    resolve();
                }
            }, 1500);

            // Also resolve if browser is closed manually
            browser.on('disconnected', () => {
                clearInterval(interval);
                resolve();
            });
        });
    } finally {
        try { await browser.close(); } catch { /* already closed */ }
    }
}

/**
 * Check if the stored session is still valid by visiting Newton School.
 */
export async function isLoggedIn(): Promise<boolean> {
    const browser = await acquireBrowser(true);
    const page = await browser.newPage();
    try {
        await page.goto('https://my.newtonschool.co/playground', {
            waitUntil: 'networkidle2',
            timeout: 15000
        });
        const url = page.url();
        // If we got redirected to login, we're not logged in
        return !url.includes('/login') && !url.includes('/signup') && !url.includes('/register');
    } catch {
        return false;
    } finally {
        try { await page.close(); } catch { /* */ }
        releaseBrowser();
    }
}

/**
 * Fetch question by navigating to the arena page and clicking the question.
 */
export async function fetchQuestionByTitle(
    title: string,
    arenaUrl: string,
    metadata: Partial<QuestionData> = {}
): Promise<QuestionData> {
    // Check cache first
    const cacheKey = `title:${title}`;
    const cached = cacheGet(cacheKey);
    if (cached) { return { ...cached, ...metadata } as QuestionData; }

    const browser = await acquireBrowser(true);
    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

        // Navigate to arena
        await page.goto(arenaUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Check if redirected to login
        if (page.url().includes('/login') || page.url().includes('/register')) {
            throw new Error('NOT_LOGGED_IN');
        }

        await page.waitForFunction(() => document.body.innerText.length > 200, { timeout: 10000 }).catch(() => { });

        // Try to find and click the question by title
        const clicked = await page.evaluate((qTitle: string) => {
            const elements = document.querySelectorAll('a, button, div, span, tr, td');
            for (const el of elements) {
                const text = (el.textContent || '').trim();
                if (text === qTitle || text.includes(qTitle)) {
                    const link = el.closest('a') || (el.tagName === 'A' ? el : null);
                    if (link) {
                        (link as HTMLElement).click();
                        return true;
                    }
                    (el as HTMLElement).click();
                    return true;
                }
            }
            return false;
        }, title);

        if (clicked) {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => { });
            await page.waitForFunction(() => document.body.innerText.length > 500, { timeout: 8000 }).catch(() => { });
            await new Promise(r => setTimeout(r, 2000));
        }

        const data = await extractFromPage(page);
        const finalUrl = page.url();
        const playgroundHash = extractPlaygroundHash(finalUrl);

        const result = {
            ...metadata,
            ...data,
            title: data.title || metadata.title || title,
            url: finalUrl,
            playgroundHash,
            difficulty: data.difficulty || metadata.difficulty || '',
            topics: metadata.topics || [],
            companies: metadata.companies || []
        } as QuestionData;

        cacheSet(cacheKey, result);
        cacheSet(`url:${finalUrl}`, result);
        return result;
    } finally {
        try { await page.close(); } catch { /* */ }
        releaseBrowser();
    }
}

/**
 * Fetch question from a direct URL.
 */
export async function fetchQuestion(url: string): Promise<QuestionData> {
    // Check cache first
    const cacheKey = `url:${url}`;
    const cached = cacheGet(cacheKey);
    if (cached) { return cached; }

    const browser = await acquireBrowser(true);
    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Check if redirected to login
        if (page.url().includes('/login') || page.url().includes('/register')) {
            throw new Error('NOT_LOGGED_IN');
        }

        await page.waitForFunction(() => document.body.innerText.length > 500, { timeout: 10000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 2000));

        const data = await extractFromPage(page);
        const playgroundHash = extractPlaygroundHash(page.url());
        const result = { ...data, url, playgroundHash };
        cacheSet(cacheKey, result);
        return result;
    } finally {
        try { await page.close(); } catch { /* */ }
        releaseBrowser();
    }
}

/**
 * Extract question data from the current page using DOM evaluation.
 */
async function extractFromPage(page: puppeteer.Page): Promise<QuestionData> {
    return page.evaluate(() => {
        function getText(sels: string[]): string {
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el && el.textContent && el.textContent.trim().length > 5) {
                    return el.textContent.trim();
                }
            }
            return '';
        }

        // ── Title ──
        let title = getText(['h1', 'h2', '[class*="title"]', '[class*="heading"]', '[class*="problem-name"]']);
        if (!title) {
            const m = document.title.match(/^(.+?)(?:\s*[-|]|$)/);
            title = m ? m[1].trim() : document.title.trim();
        }

        // ── Difficulty ──
        let difficulty = '';
        document.querySelectorAll('[class*="badge"], [class*="difficulty"], [class*="level"], [class*="tag"], span, div').forEach((el: Element) => {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t === 'easy' || t === 'medium' || t === 'hard') {
                difficulty = t.charAt(0).toUpperCase() + t.slice(1);
            }
        });

        // ── Full text — find the main content area ──
        let fullText = '';

        // Strategy 1: specific selectors
        const contentSels = [
            '[class*="question-content"]', '[class*="problem-statement"]',
            '[class*="description"]', '[class*="statement"]',
            '.ql-editor', '.markdown-body', '[class*="content-area"]',
            '[class*="problem-body"]', '[class*="ques"]'
        ];
        for (const sel of contentSels) {
            const el = document.querySelector(sel);
            if (el && el.textContent && el.textContent.length > 100) {
                fullText = el.textContent.trim();
                break;
            }
        }

        // Strategy 2: find largest div with Input/Output keywords
        if (!fullText || fullText.length < 100) {
            let best = '';
            document.querySelectorAll('div, section, main, article').forEach((el: Element) => {
                const text = el.textContent || '';
                if (/\b(Input|Output|Sample|Example)\b/i.test(text) && text.length > 200 && text.length < 15000) {
                    if (text.length > best.length) { best = text.trim(); }
                }
            });
            if (best.length > (fullText?.length || 0)) { fullText = best; }
        }

        // Strategy 3: body text
        if (!fullText || fullText.length < 50) {
            fullText = document.body.innerText.substring(0, 8000);
        }

        // ── Parse sections ──
        let description = '';
        let inputFormat = '';
        let outputFormat = '';
        let constraints = '';

        const inputIdx = fullText.search(/\bInput\s*(Format|:|\n)/i);
        if (inputIdx > 0) { description = fullText.substring(0, inputIdx).trim(); }
        else { description = fullText.substring(0, 800).trim(); }

        const im = fullText.match(/Input\s*(?:Format)?[:\s]*\n?([\s\S]*?)(?=Output\s*(?:Format)?|Example|Sample|Constraint|$)/i);
        if (im) { inputFormat = im[1].trim().substring(0, 500); }

        const om = fullText.match(/Output\s*(?:Format)?[:\s]*\n?([\s\S]*?)(?=Example|Sample|Constraint|$)/i);
        if (om) { outputFormat = om[1].trim().substring(0, 500); }

        const cm = fullText.match(/Constraints?[:\s]*\n?([\s\S]*?)(?=Example|Sample|$)/i);
        if (cm) { constraints = cm[1].trim().substring(0, 500); }

        // ── Examples / Test Cases ──
        const examples: { input: string; output: string }[] = [];

        const pres = document.querySelectorAll('pre, code');
        const codeTexts: string[] = [];
        pres.forEach((el: Element) => {
            const t = (el.textContent || '').trim();
            if (t && t.length > 0 && t.length < 2000) { codeTexts.push(t); }
        });
        for (let i = 0; i < codeTexts.length - 1; i += 2) {
            examples.push({ input: codeTexts[i], output: codeTexts[i + 1] });
        }

        // Fallback: parse from text
        if (examples.length === 0) {
            const si = fullText.match(/(?:Sample|Example)\s*Input\s*(?:#?\d*)?[:\s]*\n?([\s\S]*?)(?=(?:Sample|Example)\s*Output|$)/gi);
            const so = fullText.match(/(?:Sample|Example)\s*Output\s*(?:#?\d*)?[:\s]*\n?([\s\S]*?)(?=(?:Sample|Example)\s*Input|Explanation|Note|$)/gi);
            if (si && so) {
                for (let i = 0; i < Math.min(si.length, so.length); i++) {
                    examples.push({
                        input: si[i].replace(/^.*?[:\s]\n?/, '').trim(),
                        output: so[i].replace(/^.*?[:\s]\n?/, '').trim()
                    });
                }
            }
        }

        // ── Limits ──
        let timeLimit = '';
        let memoryLimit = '';
        const tl = fullText.match(/Time\s*(?:Limit)?[:\s]*(\d+\s*(?:sec|s|ms))/i);
        if (tl) { timeLimit = tl[1]; }
        const ml = fullText.match(/Memory\s*(?:Limit)?[:\s]*(\d+\s*(?:MB|KB|GB))/i);
        if (ml) { memoryLimit = ml[1]; }

        return {
            title, description, inputFormat, outputFormat,
            examples, constraints, fullText,
            url: '', difficulty, timeLimit, memoryLimit,
            topics: [] as string[], companies: [] as string[]
        };
    });
}
