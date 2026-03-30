// src/api/newtonApi.ts
// Newton School submission API client.
// Ported from utksh1/newton-submit-mcp — adapted for VS Code extension context.
// Uses Node.js built-in https module instead of axios to keep extension lightweight.
// Auth is extracted from the Puppeteer Chrome profile (shared with the scraper).

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { SubmissionResponse, SubmissionStatus, SubmissionStatusValue } from './types';

const DEFAULT_BASE_URL = 'https://my.newtonschool.co';
const DEFAULT_POLL_ATTEMPTS = 8;
const DEFAULT_POLL_INTERVAL_MS = 1200;
const REQUEST_TIMEOUT_MS = 15000;

// ── Cached auth state ──
let _cachedCookieString: string | undefined;
let _cachedBearerToken: string | undefined;

/**
 * Set the session cookie string for API authentication.
 * Typically extracted from the Puppeteer Chrome profile.
 */
export function setSessionCookie(cookie: string): void {
    _cachedCookieString = cookie;
}

/**
 * Set bearer token for API authentication (alternative to cookies).
 */
export function setBearerToken(token: string): void {
    _cachedBearerToken = token;
}

/**
 * Check if any auth credentials are set.
 */
export function hasAuth(): boolean {
    return Boolean(_cachedCookieString || _cachedBearerToken);
}

// ── HTTP helpers ──

interface HttpResponse {
    status: number;
    data: unknown;
}

function makeRequest(
    method: 'GET' | 'PATCH' | 'POST',
    urlPath: string,
    body?: unknown
): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const baseUrl = DEFAULT_BASE_URL;
        const fullUrl = new URL(urlPath, baseUrl);

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': 'Newton-VSCode-Extension/0.1.0',
            'client-id': '1I4rv6bekM8zAZfjwf4pxC6i4BFgP2M8hqWdvY7M',
            'client-secret': 'f3zqwMUUQ5VJOFQAuoAWlDJlfjauOTHNRy8djit9XgjjQcdrQn3WYj6k5qGPvpZDGNuKxacOvaSUddQ6fX9GOjVWWG2GKrUHQQIiXUE1rmveA1NihaWUavL4uqR6xRo9',
        };
        if (_cachedCookieString) {
            headers['Cookie'] = _cachedCookieString;
            // Also extract the bearer token from cookies if not set explicitly
            if (!_cachedBearerToken) {
                const tokenMatch = _cachedCookieString.match(/access_token_ns_student_web=([^;]+)/);
                if (tokenMatch) { headers['Authorization'] = `Bearer ${tokenMatch[1]}`; }
            }
        }
        if (_cachedBearerToken) { headers['Authorization'] = `Bearer ${_cachedBearerToken}`; }

        const options: https.RequestOptions = {
            hostname: fullUrl.hostname,
            port: fullUrl.port || 443,
            path: fullUrl.pathname + fullUrl.search,
            method,
            headers,
            timeout: REQUEST_TIMEOUT_MS,
        };

        const req = https.request(options, (res: http.IncomingMessage) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                let parsed: unknown;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode || 0, data: parsed });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 400): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (retries <= 0) { throw err; }
        await new Promise(r => setTimeout(r, delayMs));
        return withRetry(fn, retries - 1, delayMs * 2);
    }
}

async function apiGet(path: string): Promise<unknown> {
    const res = await withRetry(() => makeRequest('GET', path));
    if (res.status === 401) {
        throw new Error('Unauthorized: Newton session is invalid or expired. Please login again.');
    }
    if (res.status >= 400) {
        throw new Error(`Newton API error (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res.data;
}

async function apiPatch(path: string, body: unknown): Promise<unknown> {
    const res = await withRetry(() => makeRequest('PATCH', path, body));
    if (res.status === 401) {
        throw new Error('Unauthorized: Newton session is invalid or expired. Please login again.');
    }
    if (res.status >= 400) {
        throw new Error(`Newton API error (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res.data;
}

// ── Helper utilities (ported from newton-submit-mcp) ──

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) { return value.trim(); }
    }
    return undefined;
}

function maybeNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) { return value; }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) { return parsed; }
    }
    return undefined;
}

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

// ── Language ID resolution ──

const LANGUAGE_ALIASES: Record<string, string[]> = {
    javascript: ['javascript', 'js', 'node', 'nodejs'],
    typescript: ['typescript', 'ts'],
    python: ['python', 'py'],
    cpp: ['cpp', 'c++'],
    c: ['c'],
    java: ['java'],
    go: ['go', 'golang'],
    csharp: ['csharp', 'c#', 'cs'],
    rust: ['rust'],
    mysql: ['mysql', 'sql'],
};

/**
 * Resolve a language string (e.g. "python", "cpp") to Newton's numeric language_id
 * using the playground's language_mappings.
 */
export function resolveLanguageId(playgroundData: Record<string, unknown>, language: string): number {
    // If already numeric, use directly
    const directNumeric = maybeNumber(language);
    if (directNumeric !== undefined) { return directNumeric; }

    const target = language.trim().toLowerCase();

    // Build set of acceptable slugs
    const acceptable = new Set<string>();
    acceptable.add(target);
    for (const [base, values] of Object.entries(LANGUAGE_ALIASES)) {
        if (values.includes(target)) {
            values.forEach(v => acceptable.add(v));
            acceptable.add(base);
        }
    }

    // Collect language mappings from playground data
    const assignmentQuestion = isObject(playgroundData.assignment_question)
        ? playgroundData.assignment_question : undefined;
    const mappingLists: unknown[] = [
        assignmentQuestion?.assignment_question_language_mappings,
        assignmentQuestion?.language_mappings,
        playgroundData.assignment_question_language_mappings,
        playgroundData.language_mappings,
        playgroundData.languages,
    ];

    for (const list of mappingLists) {
        for (const mapping of asArray<Record<string, unknown>>(list)) {
            const languageId = maybeNumber(mapping.language_id ?? mapping.id);
            if (languageId === undefined) { continue; }

            const candidates = [
                firstString(mapping.slug),
                firstString(mapping.language_slug),
                firstString(mapping.language_text),
                firstString(mapping.language_name),
                firstString(mapping.name),
                isObject(mapping.language)
                    ? firstString(
                        (mapping.language as Record<string, unknown>).slug,
                        (mapping.language as Record<string, unknown>).name,
                        (mapping.language as Record<string, unknown>).language_name
                    )
                    : undefined,
            ]
                .filter((x): x is string => Boolean(x))
                .map(x => x.toLowerCase());

            if (candidates.some(x => acceptable.has(x))) {
                return languageId;
            }
        }
    }

    // Fallback to existing language_id on playground
    const existing = maybeNumber(playgroundData.language_id);
    if (existing !== undefined) { return existing; }

    throw new Error(
        `Unable to map language '${language}' to Newton language_id. Available mappings not found.`
    );
}

// ── Submission status normalization ──

function isPendingBuild(raw: Record<string, unknown>): boolean {
    const buildStatus = firstString(raw.build_status, raw.status, raw.result)?.toUpperCase();
    if (!buildStatus) { return false; }
    return buildStatus === 'PENDING' || buildStatus === 'RUNNING' || buildStatus === 'PROCESSING';
}

function normalizeSubmissionStatus(raw: Record<string, unknown>): SubmissionStatus {
    const statusText = firstString(raw.status, raw.result, raw.build_status, raw.current_status);
    const numeric = maybeNumber(raw.status_id ?? raw.current_status);
    let normalized: SubmissionStatusValue = 'Pending';

    if (numeric === 3) { normalized = 'Accepted'; }
    else if (numeric === 4) { normalized = 'Wrong Answer'; }
    else if (numeric === 5) { normalized = 'TLE'; }
    else if (numeric === 11) { normalized = 'Runtime Error'; }
    else if ([6, 7, 8, 10, 12].includes(numeric ?? -1)) { normalized = 'Runtime Error'; }
    else if (numeric === 13) { normalized = 'Compilation Error'; }
    else if (statusText) {
        const upper = statusText.toUpperCase();
        if (upper.includes('ACCEPT') || upper.includes('SUCCESS')) { normalized = 'Accepted'; }
        else if (upper.includes('WRONG')) { normalized = 'Wrong Answer'; }
        else if (upper.includes('TIME_LIMIT') || upper.includes('TLE')) { normalized = 'TLE'; }
        else if (upper.includes('RUNTIME')) { normalized = 'Runtime Error'; }
        else if (upper.includes('COMPIL')) { normalized = 'Compilation Error'; }
        else { normalized = 'Pending'; }
    }

    return {
        status: normalized,
        runtime: maybeNumber(raw.runtime ?? raw.time ?? raw.execution_time),
        memory: maybeNumber(raw.memory ?? raw.memory_used),
        raw,
    };
}

// ── Core API functions ──

/**
 * Fetch raw playground data by its hash (low-level).
 */
async function fetchPlaygroundRaw(playgroundHash: string): Promise<Record<string, unknown>> {
    const data = await apiGet(`/api/v1/playground/coding/h/${encodeURIComponent(playgroundHash)}/`);
    if (!isObject(data)) {
        throw new Error('Unexpected playground response from Newton API');
    }
    return data;
}

/**
 * Fetch the latest submission for a playground.
 */
async function fetchLatestSubmission(playgroundHash: string): Promise<Record<string, unknown>> {
    const data = await apiGet(
        `/api/v1/playground/coding/h/${encodeURIComponent(playgroundHash)}/latest_submission/`
    );
    if (!isObject(data)) {
        throw new Error('Unexpected latest_submission response from Newton API');
    }
    return data;
}

/**
 * Poll latest submission until build completes or max attempts reached.
 */
async function pollLatestSubmission(playgroundHash: string): Promise<Record<string, unknown>> {
    let latest: Record<string, unknown> = {};
    for (let attempt = 0; attempt < DEFAULT_POLL_ATTEMPTS; attempt++) {
        latest = await fetchLatestSubmission(playgroundHash);
        if (!isPendingBuild(latest)) { return latest; }
        await new Promise(r => setTimeout(r, DEFAULT_POLL_INTERVAL_MS));
    }
    return latest;
}

/**
 * Submit a solution to Newton School's hidden test runner.
 *
 * @param playgroundHash - The playground hash (from the problem URL)
 * @param languageId - Newton's numeric language ID (use resolveLanguageId() first)
 * @param code - The source code to submit
 * @param playgroundData - Optional playground data (for last_saved_at)
 * @returns Submission response with status after polling
 */
export async function submitSolution(
    playgroundHash: string,
    languageId: number,
    code: string,
    playgroundData?: Record<string, unknown>
): Promise<SubmissionResponse> {
    if (!hasAuth()) {
        throw new Error('Not authenticated. Please login first.');
    }

    const payload: Record<string, unknown> = {
        hash: playgroundHash,
        language_id: languageId,
        source_code: code,
        run_hidden_test: true,
        showSubmissionTab: true,
        is_force_save: true,
    };

    // Include last_saved_at if available (prevents conflicts)
    if (playgroundData) {
        const lastSavedAt = firstString(playgroundData.last_saved_at);
        if (lastSavedAt) {
            payload.last_saved_at = lastSavedAt;
        }
    }

    await apiPatch(
        `/api/v1/playground/coding/h/${encodeURIComponent(playgroundHash)}/?run_hidden_test_cases=true`,
        payload
    );

    // Poll for result
    const latest = await pollLatestSubmission(playgroundHash);

    const submissionHash = firstString(
        latest.hash, latest.submission_hash, latest.id, latest.token
    ) ?? 'latest';

    return {
        submissionId: `${playgroundHash}:${submissionHash}`,
        playgroundHash,
        raw: latest,
    };
}

/**
 * Get the current submission status for a playground.
 */
export async function getSubmissionStatus(playgroundHash: string): Promise<SubmissionStatus> {
    if (!hasAuth()) {
        throw new Error('Not authenticated. Please login first.');
    }

    const latest = await fetchLatestSubmission(playgroundHash);
    return normalizeSubmissionStatus(latest);
}

// ── Assignment API ──

export interface AssignmentLanguageMapping {
    languageId: number;
    languageName: string;
    boilerplateCode: string;
    timeLimit: number;
    memoryLimit: number;
}

export interface AssignmentTestCase {
    input: string;
    expectedOutput: string;
    isPublic: boolean;
}

export interface AssignmentQuestion {
    title: string;
    hash: string;
    slug: string;
    difficulty: string;
    descriptionHtml: string;
    maxScore: number;
    earnedScore: number;
    languages: AssignmentLanguageMapping[];
    testCases: AssignmentTestCase[];
    playgroundHash?: string;
}

export interface AssignmentDetails {
    title: string;
    hash: string;
    courseHash: string;
    totalQuestions: number;
    dueDate?: string;
    questions: AssignmentQuestion[];
}

/**
 * Parse course and assignment hashes from a Newton School URL.
 * e.g. /course/dmcdu9kz3y87/assignment/r4xq6g6mawuy
 */
export function parseAssignmentUrl(url: string): { courseHash: string; assignmentHash: string } | null {
    const match = url.match(/\/course\/([a-z0-9]+)\/assignment\/([a-z0-9]+)/i);
    if (!match) { return null; }
    return { courseHash: match[1], assignmentHash: match[2] };
}

/**
 * Parse raw assignment API response into typed AssignmentDetails.
 * Used by both the direct API path and the browser-based fetch path.
 */
export function parseAssignmentResponse(
    data: Record<string, unknown>,
    courseHash: string,
    assignmentHash: string
): AssignmentDetails {
    const assignmentTitle = firstString(data.title, data.name) ?? 'Assignment';
    const rawQuestions = asArray<Record<string, unknown>>(
        data.assignment_questions ?? data.questions
    );

    const questions: AssignmentQuestion[] = rawQuestions.map((q) => {
        // Parse language mappings
        const rawLangs = asArray<Record<string, unknown>>(
            q.assignment_question_language_mappings ?? q.language_mappings
        );
        const languages: AssignmentLanguageMapping[] = rawLangs.map((lm) => {
            const lang = isObject(lm.language) ? lm.language as Record<string, unknown> : {};
            return {
                languageId: maybeNumber(lm.language_id ?? lang.id) ?? 0,
                languageName: firstString(lm.language_text, lang.name, lang.language_name) ?? 'Unknown',
                boilerplateCode: firstString(lm.boilerplate_code, lm.initial_code) ?? '',
                timeLimit: maybeNumber(lm.time_limit) ?? 5,
                memoryLimit: maybeNumber(lm.memory_limit) ?? 256,
            };
        });

        // Parse test cases
        const rawTests = asArray<Record<string, unknown>>(
            q.assignment_question_test_case_mappings ?? q.test_case_mappings ?? q.test_cases
        );
        const testCases: AssignmentTestCase[] = rawTests.map((tc) => ({
            input: firstString(tc.input, tc.stdin) ?? '',
            expectedOutput: firstString(tc.expected_output, tc.output, tc.stdout) ?? '',
            isPublic: tc.is_public === true || tc.is_sample === true,
        }));

        return {
            title: firstString(q.title, q.name) ?? 'Untitled',
            hash: firstString(q.hash) ?? '',
            slug: firstString(q.slug) ?? '',
            difficulty: firstString(q.difficulty)?.toLowerCase() ?? 'medium',
            descriptionHtml: firstString(q.question_text, q.description) ?? '',
            maxScore: maybeNumber(q.max_score) ?? 0,
            earnedScore: maybeNumber(q.earned_score ?? q.score) ?? 0,
            languages,
            testCases: testCases.filter(tc => tc.isPublic),
            playgroundHash: firstString(q.playground_hash, q.playground),
        };
    });

    return {
        title: assignmentTitle,
        hash: assignmentHash,
        courseHash,
        totalQuestions: questions.length,
        dueDate: firstString(data.end_timestamp, data.due_date),
        questions,
    };
}

/**
 * Fetch all questions for an assignment via the Newton API (direct HTTP).
 * One call returns titles, descriptions, test cases, language mappings, and boilerplate code.
 */
export async function fetchAssignmentDetails(
    courseHash: string,
    assignmentHash: string
): Promise<AssignmentDetails> {
    if (!hasAuth()) {
        throw new Error('Not authenticated. Please login first.');
    }

    const data = await apiGet(
        `/api/v1/course/h/${encodeURIComponent(courseHash)}/assignment/h/${encodeURIComponent(assignmentHash)}/details/`
    );

    if (!isObject(data)) {
        throw new Error('Unexpected assignment response from Newton API');
    }

    return parseAssignmentResponse(data, courseHash, assignmentHash);
}

// ══════════════════════════════════════════════════════════════════════════
// Ported from utksh1/newton-submit-mcp — adapted for Node.js https module
// These use the correct endpoints discovered from that source.
// ══════════════════════════════════════════════════════════════════════════

/** Assignment question reference returned by listAssignmentsWithQuestions */
export interface AssignmentQuestionRef {
    assignmentHash: string;
    assignmentTitle?: string;
    questionHash: string;
    questionTitle?: string;
    questionType?: string;
}

/** Full problem content from the playground endpoint */
export interface PlaygroundProblem {
    id: string;
    title: string;
    description: string;
    inputFormat?: string;
    outputFormat?: string;
    constraints?: string;
    examples?: { input: string; output: string; explanation?: string }[];
    languages: { id: number; name: string; slug: string; boilerplate?: string }[];
    playgroundHash: string;
    raw: Record<string, unknown>;
}

/**
 * List ALL assignments for a course with their nested question hashes.
 * Uses the v2 endpoint: GET /api/v2/course/h/{courseHash}/assignment/all/
 * Returns flat list of { assignmentHash, questionHash, questionTitle, ... }.
 */
export async function listAssignmentsWithQuestions(
    courseHash: string
): Promise<AssignmentQuestionRef[]> {
    const data = await apiGet(
        `/api/v2/course/h/${encodeURIComponent(courseHash)}/assignment/all/?pagination=false&completed=false`
    );

    // Normalize response — could be array or { assignments: [], results: [], data: [] }
    let assignments: Record<string, unknown>[] = [];
    if (Array.isArray(data)) {
        assignments = data.filter(isObject);
    } else if (isObject(data)) {
        for (const key of ['assignments', 'results', 'data', 'items'] as const) {
            if (Array.isArray((data as Record<string, unknown>)[key])) {
                assignments = ((data as Record<string, unknown>)[key] as unknown[]).filter(isObject) as Record<string, unknown>[];
                break;
            }
        }
        // Fallback: merge all arrays in the response
        if (assignments.length === 0) {
            for (const val of Object.values(data as Record<string, unknown>)) {
                if (Array.isArray(val)) {
                    for (const item of val) {
                        if (isObject(item)) assignments.push(item as Record<string, unknown>);
                    }
                }
            }
        }
    }

    // Extract question refs from each assignment
    const refs: AssignmentQuestionRef[] = [];
    for (const assignment of assignments) {
        const assignmentHash = firstString(assignment.hash, assignment.assignment_hash);
        if (!assignmentHash) continue;
        const assignmentTitle = firstString(assignment.title, assignment.name, assignment.assignment_title);

        const questions = asArray<Record<string, unknown>>(assignment.assignment_questions);
        for (const q of questions) {
            const questionHash = firstString(q.hash, q.assignment_question_hash);
            if (!questionHash) continue;
            refs.push({
                assignmentHash,
                assignmentTitle,
                questionHash,
                questionTitle: firstString(q.title, q.name),
                questionType: firstString(q.question_type, q.type),
            });
        }
    }
    return refs;
}

/**
 * Fetch details for a specific assignment question.
 * Returns the playground hash needed to fetch full problem content.
 * Endpoint: GET /api/v1/course/h/{course}/assignment/h/{assignment}/question/h/{question}/details/
 */
export async function fetchAssignmentQuestionDetail(
    courseHash: string,
    assignmentHash: string,
    questionHash: string
): Promise<Record<string, unknown>> {
    const data = await apiGet(
        `/api/v1/course/h/${encodeURIComponent(courseHash)}/assignment/h/${encodeURIComponent(assignmentHash)}/question/h/${encodeURIComponent(questionHash)}/details/`
    );
    if (!isObject(data)) {
        throw new Error('Unexpected question details response from Newton API');
    }
    return data as Record<string, unknown>;
}

/**
 * Fetch full playground content (problem description, test cases, boilerplate, languages).
 * Endpoint: GET /api/v1/playground/coding/h/{playgroundHash}/
 *
 * Actual API response structure (discovered via raw dump):
 *   data.assignment_question.question_text → description (HTML)
 *   data.assignment_question.input → input format (HTML)
 *   data.assignment_question.output → output format (HTML)
 *   data.assignment_question.example → example (single HTML string with Input/Output/Note)
 *   data.assignment_question.constraints → constraints (uses <inlineMath> tags)
 *   data.assignment_question.assignment_question_language_mappings[] → languages
 *     .language_id, .language_text, .function_code (boilerplate)
 */
export async function fetchPlayground(playgroundHash: string): Promise<PlaygroundProblem> {
    const raw = await apiGet(
        `/api/v1/playground/coding/h/${encodeURIComponent(playgroundHash)}/`
    );
    if (!isObject(raw)) {
        throw new Error('Unexpected playground response from Newton API');
    }
    const data = raw as Record<string, unknown>;

    // Navigate to the assignment_question object
    const aq = isObject(data.assignment_question)
        ? data.assignment_question as Record<string, unknown>
        : {} as Record<string, unknown>;

    // Title
    const title = firstString(
        aq.question_title as string, aq.title as string, data.title as string
    ) ?? 'Untitled';

    // Description — from question_text field (HTML content)
    const description = firstString(
        aq.question_text as string,
        aq.description as string,
        aq.statement as string,
        data.description as string
    ) ?? '';

    // Input/Output format
    const inputFormat = firstString(aq.input as string) ?? '';
    const outputFormat = firstString(aq.output as string) ?? '';

    // Constraints — may contain <inlineMath> tags
    const constraints = firstString(
        aq.constraints as string, data.constraints as string
    );

    // Parse examples from the single "example" HTML string
    const exampleRaw = firstString(aq.example as string, data.example as string) ?? '';
    const examples = parseExampleString(exampleRaw);

    // Parse language mappings from assignment_question_language_mappings
    const langMappings = asArray<Record<string, unknown>>(
        aq.assignment_question_language_mappings ??
        data.assignment_question_language_mappings
    );
    const languages: PlaygroundProblem['languages'] = langMappings.map(item => {
        const langId = maybeNumber(item.language_id ?? item.id) ?? 0;
        const name = firstString(
            item.language_text as string, item.language_name as string, item.name as string
        ) ?? `Lang ${langId}`;
        // Slug: derive from language_text (e.g. "Python (3.11.4)" → "python")
        const slug = name.toLowerCase().split(/[\s(]/)[0] || name.toLowerCase();
        // Boilerplate: function_code is the actual editable code
        const boilerplate = firstString(
            item.function_code as string,
            item.boilerplate_code as string,
            item.initial_code as string
        );
        return { id: langId, name, slug, boilerplate };
    });

    return {
        id: firstString(data.hash as string, aq.hash as string) ?? playgroundHash,
        title,
        description,
        inputFormat,
        outputFormat,
        constraints,
        examples: examples.length ? examples : undefined,
        languages,
        playgroundHash,
        raw: data,
    };
}

/**
 * Parse Newton's "example" HTML string into structured examples.
 * Format: "<b>Sample Input</b>\n...\n<b>Sample Output</b>\n...\n<b>Note</b>\n..."
 */
function parseExampleString(html: string): { input: string; output: string; explanation?: string }[] {
    if (!html.trim()) return [];

    // Clean up HTML tags but keep structure markers
    const clean = html
        .replace(/<b>(.*?)<\/b>/gi, '###$1###')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

    // Split on markers
    const inputMatch = clean.match(/###Sample Input###\s*([\s\S]*?)(?=###Sample Output###|$)/i);
    const outputMatch = clean.match(/###Sample Output###\s*([\s\S]*?)(?=###Note###|###Explanation###|$)/i);
    const noteMatch = clean.match(/###(?:Note|Explanation)###\s*([\s\S]*?)$/i);

    if (!inputMatch && !outputMatch) return [];

    return [{
        input: (inputMatch?.[1] || '').trim(),
        output: (outputMatch?.[1] || '').trim(),
        explanation: noteMatch?.[1]?.trim() || undefined,
    }];
}

/**
 * Submit a solution to Newton School for grading.
 * PATCHes the playground and polls for the latest submission result.
 */
export async function submitSolutionToNewton(
    playgroundHash: string,
    languageId: number,
    code: string
): Promise<SubmissionResponse> {
    const payload = {
        hash: playgroundHash,
        language_id: languageId,
        source_code: code,
        run_hidden_test: true,
        showSubmissionTab: true,
        is_force_save: true,
    };

    // Submit via PATCH
    await withRetry<HttpResponse>(() =>
        makeRequest('PATCH', `/api/v1/playground/coding/h/${encodeURIComponent(playgroundHash)}/?run_hidden_test_cases=true`, payload)
    );

    // Poll for result
    let latest: Record<string, unknown> = {};
    for (let attempt = 0; attempt < DEFAULT_POLL_ATTEMPTS; attempt++) {
        const resp = await apiGet(`/api/v1/playground/coding/h/${encodeURIComponent(playgroundHash)}/latest_submission/`);
        if (isObject(resp)) {
            latest = resp as Record<string, unknown>;
            const buildStatus = firstString(latest.build_status as string, latest.status as string)?.toUpperCase();
            if (buildStatus && buildStatus !== 'PENDING' && buildStatus !== 'RUNNING' && buildStatus !== 'PROCESSING') {
                break;
            }
        }
        await new Promise(resolve => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
    }

    const submissionHash = firstString(latest.hash as string, latest.submission_hash as string, latest.token as string) ?? 'latest';

    return {
        submissionId: `${playgroundHash}:${submissionHash}`,
        playgroundHash,
        raw: latest,
    };
}

/**
 * Extract the Bearer token from the cached cookie string.
 * Looks for the `access_token_ns_student_web` cookie.
 */
export function extractBearerTokenFromCookies(): string | undefined {
    if (_cachedBearerToken) return _cachedBearerToken;
    if (_cachedCookieString) {
        const match = _cachedCookieString.match(/access_token_ns_student_web=([^;]+)/);
        if (match) return match[1];
    }
    return undefined;
}

