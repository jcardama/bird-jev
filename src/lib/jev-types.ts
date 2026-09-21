import type { TweetData } from './twitter-client-types.js';

export type JevScope = 'post' | 'collection';

export type JevOutput =
  | { type: 'category'; labels: string[] }
  | { type: 'boolean'; threshold?: number }
  | { type: 'score'; criteria: [string, string, ...string[]] };

export interface JevTask {
  id: string;
  scope: JevScope;
  instructions: string;
  output: JevOutput;
}

export interface JevSpec {
  tasks: JevTask[];
}

export type JevErrorCode =
  | 'collection_failed'
  | 'post_limit'
  | 'payload_limit'
  | 'invalid_response'
  | 'authentication'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'provider_error'
  | 'network_error';

export interface JevFailure {
  code: JevErrorCode;
  message: string;
}

export type JevOutcome =
  | {
      status: 'ok';
      requestId: string;
      type: 'category';
      value: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      status: 'ok';
      requestId: string;
      type: 'boolean';
      value: boolean;
      probability: number;
      threshold: number;
    }
  | {
      status: 'ok';
      requestId: string;
      type: 'score';
      value: number;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | { status: 'failed'; requestId?: string; error: JevFailure }
  | {
      status: 'skipped';
      reason: 'empty_selection' | 'collection_failed' | 'preflight_failed' | 'previous_request_failed';
    };

export interface JevCollectionContext {
  source: string;
  status: 'ok' | 'failed';
  nextCursor?: string;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JevReceipt {
  id: string;
  scope: JevScope;
  postIds: string[];
  inputHash: string;
  status: 'ok' | 'invalid_answers' | 'failed';
  model?: string;
  usage?: JevUsage;
  error?: JevFailure;
}

export interface JevReport {
  schemaVersion: 1;
  requestedModel: string;
  tasks: JevTask[];
  selection: JevCollectionContext & {
    occurrenceCount: number;
    postCount: number;
    postIds: string[];
    coverage: 'selected_posts_only';
  };
  posts: Array<{ postId: string; results: Record<string, JevOutcome> }>;
  collection: Record<string, JevOutcome>;
  requests: JevReceipt[];
  usage: JevUsage & { complete: boolean };
  error?: JevFailure;
}

export interface JevAnalysisOptions {
  apiKey: string;
  maxPosts?: number;
  collection?: JevCollectionContext;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export type AnalyzePosts = (
  posts: readonly TweetData[],
  spec: JevSpec,
  options: JevAnalysisOptions,
) => Promise<JevReport>;
