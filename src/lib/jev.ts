import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  choice,
  type Fetch,
  noul,
  PermissionDeniedError,
  type Questions,
  RateLimitError,
  score,
  TypeSafeClient,
  TypeSafeError,
} from '@typesafe-ai/sdk';
import {
  type CompiledJevQuestion,
  defineEntry,
  emptyMap,
  JEV_BASE_URL,
  JEV_MODEL,
  type PlannedJevRequest,
  parseJevMaxPosts,
  planJevAnalysis,
  selectUniquePosts,
  validateJevSpec,
} from './jev-spec.js';
import type {
  AnalyzePosts,
  JevAnalysisOptions,
  JevCollectionContext,
  JevFailure,
  JevOutcome,
  JevReceipt,
  JevReport,
  JevSpec,
  JevTask,
  JevUsage,
} from './jev-types.js';
import type { TweetData } from './twitter-client-types.js';

const REQUEST_TIMEOUT_MS = 30_000;
const PROBABILITY_ROUNDING_TOLERANCE = 0.00005;
const SAFE_MODEL_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const CANCELLED_FAILURE: JevFailure = {
  code: 'cancelled',
  message: 'The analysis request was cancelled.',
};
function invalidResponse(message: string): { ok: false; error: JevFailure } {
  return { ok: false, error: { code: 'invalid_response', message } };
}
const COLLECTION_FAILED: JevFailure = {
  code: 'collection_failed',
  message: 'Collection failed; analysis was not attempted.',
};

export const analyzePosts: AnalyzePosts = async (posts, inputSpec, options) => {
  const spec = validateJevSpec(inputSpec);
  const apiKey = requireApiKey(options.apiKey);
  const maxPosts = parseJevMaxPosts(options.maxPosts);
  const selected = selectUniquePosts(posts);
  const selection = buildSelection(options.collection, selected.occurrenceCount, selected.posts);
  const postTasks = spec.tasks.filter((task) => task.scope === 'post');
  const collectionTasks = spec.tasks.filter((task) => task.scope === 'collection');

  if (selection.status === 'failed') {
    return makeReport({
      spec,
      selection,
      posts: skippedPosts(selected.posts, postTasks, 'collection_failed'),
      collection: skippedRecord(collectionTasks, 'collection_failed'),
      requests: [],
      error: COLLECTION_FAILED,
    });
  }

  if (selected.posts.length === 0) {
    return makeReport({
      spec,
      selection,
      posts: [],
      collection: skippedRecord(collectionTasks, 'empty_selection'),
      requests: [],
    });
  }

  const plan = planJevAnalysis(selected.posts, spec, maxPosts);
  if (!plan.ok) {
    return makeReport({
      spec,
      selection,
      posts: skippedPosts(selected.posts, postTasks, 'preflight_failed'),
      collection: skippedRecord(collectionTasks, 'preflight_failed'),
      requests: [],
      error: { code: plan.code, message: plan.message },
    });
  }

  if (options.signal?.aborted) {
    return makeReport({
      spec,
      selection,
      posts: failedPosts(selected.posts, postTasks, CANCELLED_FAILURE),
      collection: failedRecord(collectionTasks, CANCELLED_FAILURE),
      requests: [],
      error: CANCELLED_FAILURE,
    });
  }

  const client = new TypeSafeClient({
    apiKey,
    baseURL: JEV_BASE_URL,
    defaultModel: JEV_MODEL,
    logLevel: 'off',
    retry: { maxRetries: 0 },
    timeout: REQUEST_TIMEOUT_MS,
    fetch: wrapFetch(options.fetch),
  });

  const postResults = new Map<string, Record<string, JevOutcome>>();
  for (const post of selected.posts) {
    postResults.set(post.id, emptyMap());
  }
  const collectionResults = emptyMap<JevOutcome>();
  const receipts: JevReceipt[] = [];
  let halt: JevFailure | undefined;

  for (const request of plan.requests) {
    if (halt) {
      applySkip(request, postResults, collectionResults, 'previous_request_failed');
      continue;
    }
    if (options.signal?.aborted) {
      halt = CANCELLED_FAILURE;
      applyFailure(request, postResults, collectionResults, CANCELLED_FAILURE);
      continue;
    }

    let raw: unknown;
    try {
      raw = await client.systemOne(
        {
          model: JEV_MODEL,
          state: request.state,
          questions: toSdkQuestions(request.questions),
        },
        { signal: options.signal },
      );
    } catch (error) {
      const failure = classifyProviderError(error);
      receipts.push(
        buildReceipt({
          id: request.id,
          scope: request.scope,
          postIds: request.postIds,
          inputHash: request.inputHash,
          status: 'failed',
          error: failure,
        }),
      );
      applyFailure(request, postResults, collectionResults, failure, request.id);
      halt = failure;
      continue;
    }

    const checked = checkResponse(raw, request);
    receipts.push(checked.receipt);
    applyOutcomes(request, postResults, collectionResults, checked.outcomes);
    if (checked.receipt.status === 'failed' && checked.receipt.error) {
      halt = checked.receipt.error;
    }
  }

  const postRows =
    postTasks.length === 0
      ? []
      : selected.posts.map((post) => ({
          postId: post.id,
          results: postResults.get(post.id) ?? emptyMap<JevOutcome>(),
        }));

  return makeReport({
    spec,
    selection,
    posts: postRows,
    collection: collectionResults,
    requests: receipts,
    error: halt,
  });
};

function requireApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Analysis API key is missing.');
  }
  return value;
}

function wrapFetch(fetchImpl: JevAnalysisOptions['fetch']): Fetch {
  const inner = fetchImpl ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => inner(input, { ...init, redirect: 'error' });
}

function toSdkQuestions(compiled: Record<string, CompiledJevQuestion>): Questions {
  const questions: Questions = emptyMap();
  for (const [id, question] of Object.entries(compiled)) {
    if (question.type === 'choice') {
      defineEntry(questions, id, choice(question.instructions, question.criteria));
      continue;
    }
    if (question.type === 'noul') {
      defineEntry(questions, id, noul(question.instructions));
      continue;
    }
    defineEntry(questions, id, score(question.instructions, question.criteria));
  }
  return questions;
}

function buildSelection(
  collection: JevCollectionContext | undefined,
  occurrenceCount: number,
  unique: readonly TweetData[],
): JevReport['selection'] {
  const context = collection ?? { source: 'library', status: 'ok' };
  const selection: JevReport['selection'] = {
    source: context.source,
    status: context.status,
    occurrenceCount,
    postCount: unique.length,
    postIds: unique.map((post) => post.id),
    coverage: 'selected_posts_only',
  };
  if (context.nextCursor !== undefined) {
    selection.nextCursor = context.nextCursor;
  }
  return selection;
}

function makeReport(args: {
  spec: JevSpec;
  selection: JevReport['selection'];
  posts: JevReport['posts'];
  collection: Record<string, JevOutcome>;
  requests: JevReceipt[];
  error?: JevFailure;
}): JevReport {
  let inputTokens = 0;
  let outputTokens = 0;
  let complete = true;
  for (const receipt of args.requests) {
    if (!receipt.usage) {
      complete = false;
      continue;
    }
    inputTokens += receipt.usage.inputTokens;
    outputTokens += receipt.usage.outputTokens;
  }
  const report: JevReport = {
    schemaVersion: 1,
    requestedModel: JEV_MODEL,
    tasks: args.spec.tasks,
    selection: args.selection,
    posts: args.posts,
    collection: args.collection,
    requests: args.requests,
    usage: { inputTokens, outputTokens, complete },
  };
  if (args.error) {
    report.error = args.error;
  }
  return report;
}

function skippedRecord(
  tasks: JevTask[],
  reason: Extract<JevOutcome, { status: 'skipped' }>['reason'],
): Record<string, JevOutcome> {
  const results = emptyMap<JevOutcome>();
  for (const task of tasks) {
    defineEntry(results, task.id, { status: 'skipped', reason });
  }
  return results;
}

function failedRecord(tasks: JevTask[], error: JevFailure, requestId?: string): Record<string, JevOutcome> {
  const results = emptyMap<JevOutcome>();
  for (const task of tasks) {
    const outcome: JevOutcome = requestId ? { status: 'failed', requestId, error } : { status: 'failed', error };
    defineEntry(results, task.id, outcome);
  }
  return results;
}

function skippedPosts(
  unique: readonly TweetData[],
  postTasks: JevTask[],
  reason: Extract<JevOutcome, { status: 'skipped' }>['reason'],
): JevReport['posts'] {
  if (postTasks.length === 0) {
    return [];
  }
  return unique.map((post) => ({
    postId: post.id,
    results: skippedRecord(postTasks, reason),
  }));
}

function failedPosts(unique: readonly TweetData[], postTasks: JevTask[], error: JevFailure): JevReport['posts'] {
  if (postTasks.length === 0) {
    return [];
  }
  return unique.map((post) => ({
    postId: post.id,
    results: failedRecord(postTasks, error),
  }));
}

function applySkip(
  request: PlannedJevRequest,
  postResults: Map<string, Record<string, JevOutcome>>,
  collectionResults: Record<string, JevOutcome>,
  reason: Extract<JevOutcome, { status: 'skipped' }>['reason'],
): void {
  const outcomes = skippedRecord(request.tasks, reason);
  applyOutcomes(request, postResults, collectionResults, outcomes);
}

function applyFailure(
  request: PlannedJevRequest,
  postResults: Map<string, Record<string, JevOutcome>>,
  collectionResults: Record<string, JevOutcome>,
  error: JevFailure,
  requestId?: string,
): void {
  applyOutcomes(request, postResults, collectionResults, failedRecord(request.tasks, error, requestId));
}

function applyOutcomes(
  request: PlannedJevRequest,
  postResults: Map<string, Record<string, JevOutcome>>,
  collectionResults: Record<string, JevOutcome>,
  outcomes: Record<string, JevOutcome>,
): void {
  if (request.scope === 'collection') {
    for (const [taskId, outcome] of Object.entries(outcomes)) {
      defineEntry(collectionResults, taskId, outcome);
    }
    return;
  }
  const postId = request.postIds[0];
  if (postId === undefined) {
    return;
  }
  const bucket = postResults.get(postId) ?? emptyMap<JevOutcome>();
  if (!postResults.has(postId)) {
    postResults.set(postId, bucket);
  }
  for (const [taskId, outcome] of Object.entries(outcomes)) {
    defineEntry(bucket, taskId, outcome);
  }
}

function buildReceipt(args: {
  id: string;
  scope: PlannedJevRequest['scope'];
  postIds: string[];
  inputHash: string;
  status: JevReceipt['status'];
  model?: string;
  usage?: JevUsage;
  error?: JevFailure;
}): JevReceipt {
  const receipt: JevReceipt = {
    id: args.id,
    scope: args.scope,
    postIds: [...args.postIds],
    inputHash: args.inputHash,
    status: args.status,
  };
  if (args.model !== undefined) {
    receipt.model = args.model;
  }
  if (args.usage !== undefined) {
    receipt.usage = args.usage;
  }
  if (args.error !== undefined) {
    receipt.error = args.error;
  }
  return receipt;
}

function classifyProviderError(error: unknown): JevFailure {
  if (error instanceof APIUserAbortError) {
    return CANCELLED_FAILURE;
  }
  if (error instanceof APITimeoutError) {
    return { code: 'timeout', message: 'The analysis request timed out.' };
  }
  if (error instanceof APIConnectionError) {
    return { code: 'network_error', message: 'The analysis request failed to connect.' };
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return { code: 'authentication', message: 'Analysis authentication failed.' };
  }
  if (error instanceof RateLimitError) {
    return { code: 'rate_limited', message: 'Analysis is rate limited.' };
  }
  if (error instanceof APIError || error instanceof TypeSafeError) {
    return { code: 'provider_error', message: 'The analysis provider rejected the request.' };
  }
  return { code: 'network_error', message: 'The analysis request failed.' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readModel(raw: unknown): string | undefined {
  if (!isPlainObject(raw) || typeof raw.model !== 'string' || !SAFE_MODEL_REGEX.test(raw.model)) {
    return undefined;
  }
  return raw.model;
}

function readUsage(raw: unknown): JevUsage | undefined {
  if (!isPlainObject(raw) || !isPlainObject(raw.usage)) {
    return undefined;
  }
  const inputTokens = raw.usage.input_tokens;
  const outputTokens = raw.usage.output_tokens;
  if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens)) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

function checkResponse(
  raw: unknown,
  request: PlannedJevRequest,
): { receipt: JevReceipt; outcomes: Record<string, JevOutcome> } {
  const model = readModel(raw);
  const usage = readUsage(raw);
  if (!isPlainObject(raw) || model !== JEV_MODEL || !isPlainObject(raw.answers)) {
    const failure = invalidResponse('Invalid response envelope, model, or answers.').error;
    return {
      receipt: buildReceipt({
        id: request.id,
        scope: request.scope,
        postIds: request.postIds,
        inputHash: request.inputHash,
        status: 'failed',
        model,
        usage,
        error: failure,
      }),
      outcomes: failedRecord(request.tasks, failure, request.id),
    };
  }

  const expected = new Set(request.tasks.map((task) => task.id));
  for (const key of Object.keys(raw.answers)) {
    if (!expected.has(key)) {
      const failure = invalidResponse('Unexpected answer key.').error;
      return {
        receipt: buildReceipt({
          id: request.id,
          scope: request.scope,
          postIds: request.postIds,
          inputHash: request.inputHash,
          status: 'failed',
          model,
          usage,
          error: failure,
        }),
        outcomes: failedRecord(request.tasks, failure, request.id),
      };
    }
  }

  const outcomes = emptyMap<JevOutcome>();
  for (const task of request.tasks) {
    const parsed = Object.hasOwn(raw.answers, task.id)
      ? parseAnswer(task, raw.answers[task.id])
      : invalidResponse('Answer missing.');
    if (!parsed.ok) {
      defineEntry(outcomes, task.id, { status: 'failed', requestId: request.id, error: parsed.error });
      continue;
    }
    defineEntry(outcomes, task.id, { status: 'ok', requestId: request.id, ...parsed.value });
  }

  return {
    receipt: buildReceipt({
      id: request.id,
      scope: request.scope,
      postIds: request.postIds,
      inputHash: request.inputHash,
      status: Object.values(outcomes).some((outcome) => outcome.status === 'failed') ? 'invalid_answers' : 'ok',
      model,
      usage,
    }),
    outcomes,
  };
}

type ParsedAnswer =
  | { type: 'category'; value: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'boolean'; value: boolean; probability: number; threshold: number }
  | { type: 'score'; value: number; probabilities: Record<string, number>; confidence: number };

type Validation<T> = { ok: true; value: T } | { ok: false; error: JevFailure };

function parseAnswer(task: JevTask, answer: unknown): Validation<ParsedAnswer> {
  const expectedType = task.output.type === 'boolean' ? 'noul' : task.output.type === 'category' ? 'choice' : 'score';
  if (!isPlainObject(answer) || answer.type !== expectedType) {
    return invalidResponse('Invalid answer type.');
  }
  if (task.output.type === 'boolean') {
    if (!isProbability(answer.noul)) {
      return invalidResponse('Boolean probability is outside [0, 1].');
    }
    const threshold = task.output.threshold ?? 0.5;
    return {
      ok: true,
      value: { type: 'boolean', value: answer.noul >= threshold, probability: answer.noul, threshold },
    };
  }
  if (!isProbability(answer.confidence)) {
    return invalidResponse('Confidence is outside [0, 1].');
  }
  if (task.output.type === 'category') {
    if (typeof answer.choice !== 'string') {
      return invalidResponse('Category choice is not a string.');
    }
    if (!task.output.labels.includes(answer.choice)) {
      return invalidResponse('Category choice is not a declared label.');
    }
    const probabilities = readExactProbabilities(answer.probabilities, task.output.labels);
    if (!probabilities.ok) {
      return probabilities;
    }
    return {
      ok: true,
      value: {
        type: 'category',
        value: answer.choice,
        probabilities: probabilities.value,
        confidence: answer.confidence,
      },
    };
  }
  const size = task.output.criteria.length;
  if (
    typeof answer.score !== 'number' ||
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > size - 1
  ) {
    return invalidResponse('Score is outside the declared range.');
  }
  const keys = Array.from({ length: size }, (_, index) => String(index));
  const probabilities = readExactProbabilities(answer.probabilities, keys);
  if (!probabilities.ok) {
    return probabilities;
  }
  return {
    ok: true,
    value: { type: 'score', value: answer.score, probabilities: probabilities.value, confidence: answer.confidence },
  };
}

function readExactProbabilities(raw: unknown, keys: readonly string[]): Validation<Record<string, number>> {
  if (!isPlainObject(raw)) {
    return invalidResponse('Probabilities are not an object.');
  }
  const rawKeys = Object.keys(raw);
  if (rawKeys.length !== keys.length) {
    return invalidResponse('Probability key count differs from the declared categories.');
  }
  const expected = new Set(keys);
  const probabilities = emptyMap<number>();
  let sum = 0;
  for (const key of rawKeys) {
    if (!expected.has(key)) {
      return invalidResponse('Unexpected probability key.');
    }
    const value = raw[key];
    if (!isProbability(value)) {
      return invalidResponse('Probability value is outside [0, 1].');
    }
    defineEntry(probabilities, key, value);
    sum += value;
  }
  if (Math.abs(sum - 1) > keys.length * PROBABILITY_ROUNDING_TOLERANCE + Number.EPSILON) {
    return invalidResponse('Probabilities do not sum to one within rounding tolerance.');
  }
  return { ok: true, value: probabilities };
}
