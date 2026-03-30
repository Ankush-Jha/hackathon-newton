// src/api/types.ts
// Submission-related types ported from newton-submit-mcp

export type SubmissionStatusValue =
    | 'Accepted'
    | 'Wrong Answer'
    | 'TLE'
    | 'Runtime Error'
    | 'Compilation Error'
    | 'Pending';

export interface SubmissionResponse {
    submissionId: string;
    playgroundHash?: string;
    raw?: unknown;
}

export interface SubmissionStatus {
    status: SubmissionStatusValue;
    runtime?: number;
    memory?: number;
    raw?: unknown;
}
