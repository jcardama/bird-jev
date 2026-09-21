import { createHash } from 'node:crypto';
import type { JevOutput, JevScope, JevSpec, JevTask } from './jev-types.js';
import type { TweetData } from './twitter-client-types.js';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_JEV_MAX_POSTS = 100;
export const JEV_SPEC_MAX_BYTES = 64 * 1024;
export const JEV_MAX_TASKS = 16;
export const JEV_SINGLE_QUESTION_MAX_BYTES = 32 * 1024;
export const JEV_ALL_QUESTIONS_MAX_BYTES = 64 * 1024;

const SAFE_ID_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_POSTS_STRING_REGEX = /^[1-9][0-9]{0,15}$/;
const FORBIDDEN_IDS = new Set(['constructor', 'prototype', '__proto__']);
const RELEVANCE_LABELS = ['relevant', 'irrelevant', 'unclear'];
const SENTIMENT_LABELS = ['positive', 'negative', 'mixed', 'neutral', 'unclear'];

export type CompiledJevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, null> }
  | { type: 'noul'; instructions: string }
  | { type: 'score'; instructions: string; criteria: Extract<JevOutput, { type: 'score' }>['criteria'] };

export type ProjectedJevPost = {
  id: string;
  text: string;
  authorId?: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToStatusId?: string;
  quotedTweet?: ProjectedJevPost;
};

export interface PlannedJevRequest {
  id: string;
  scope: JevScope;
  postIds: string[];
  state: ProjectedJevPost | ProjectedJevPost[];
  questions: Record<string, CompiledJevQuestion>;
  tasks: JevTask[];
  inputHash: string;
}

export type JevPlan =
  | { ok: true; requests: PlannedJevRequest[] }
  | { ok: false; code: 'post_limit' | 'payload_limit'; message: string };

export function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function defineEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function parseJevMaxPosts(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_JEV_MAX_POSTS;
  }
  if (typeof value === 'string' && MAX_POSTS_STRING_REGEX.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  failValidation('Maximum post count is invalid.');
}

export function validateJevSpec(input: unknown): JevSpec {
  if (!isPlainObject(input)) {
    failValidation('JEV specification must be an object.');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    failValidation('JEV specification is invalid.');
  }
  if (utf8Bytes(serialized) > JEV_SPEC_MAX_BYTES) {
    failValidation('JEV specification is too large.');
  }
  if (hasUnknownKeys(input, ['tasks'])) {
    failValidation('JEV specification has unknown fields.');
  }
  if (!Array.isArray(input.tasks)) {
    failValidation('JEV specification tasks must be a list.');
  }
  if (input.tasks.length === 0) {
    failValidation('JEV specification requires at least one task.');
  }
  if (input.tasks.length > JEV_MAX_TASKS) {
    failValidation('JEV specification has too many tasks.');
  }

  const tasks: JevTask[] = [];
  const seenIds = new Set<string>();
  for (const item of input.tasks) {
    const task = validateTask(item);
    if (seenIds.has(task.id)) {
      failValidation('Task ids must be unique.');
    }
    seenIds.add(task.id);
    tasks.push(task);
  }
  return { tasks };
}

export function createJevPresets(options: {
  relevance?: string;
  sentiment?: string;
  scope?: 'post' | 'collection' | 'both';
}): JevSpec {
  const hasRelevance = options.relevance !== undefined;
  const hasSentiment = options.sentiment !== undefined;
  if (!hasRelevance && !hasSentiment) {
    failValidation('A relevance or sentiment preset is required.');
  }
  if (hasRelevance && (typeof options.relevance !== 'string' || options.relevance.trim() === '')) {
    failValidation('Preset criterion is invalid.');
  }
  if (hasSentiment && (typeof options.sentiment !== 'string' || options.sentiment.trim() === '')) {
    failValidation('Preset subject is invalid.');
  }

  const scopes = resolvePresetScopes(options.scope);
  const tasks: JevTask[] = [];
  if (hasRelevance && options.relevance !== undefined) {
    const criterion = options.relevance;
    for (const scope of scopes) {
      tasks.push({
        id: `relevance_${scope}`,
        scope,
        instructions: relevanceInstructions(scope, criterion),
        output: { type: 'category', labels: [...RELEVANCE_LABELS] },
      });
    }
  }
  if (hasSentiment && options.sentiment !== undefined) {
    const subject = options.sentiment;
    for (const scope of scopes) {
      tasks.push({
        id: `sentiment_${scope}`,
        scope,
        instructions: sentimentInstructions(scope, subject),
        output: { type: 'category', labels: [...SENTIMENT_LABELS] },
      });
    }
  }
  return validateJevSpec({ tasks });
}

export function selectUniquePosts(posts: readonly TweetData[]): {
  occurrenceCount: number;
  posts: TweetData[];
} {
  const unique: TweetData[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    if (seen.has(post.id)) {
      continue;
    }
    seen.add(post.id);
    unique.push(post);
  }
  return { occurrenceCount: posts.length, posts: unique };
}

export function projectPost(post: TweetData, seen: WeakSet<TweetData> = new WeakSet()): ProjectedJevPost {
  seen.add(post);
  const projected: ProjectedJevPost = {
    id: post.id,
    text: post.text,
  };
  if (typeof post.authorId === 'string') {
    projected.authorId = post.authorId;
  }
  if (typeof post.createdAt === 'string') {
    projected.createdAt = post.createdAt;
  }
  if (typeof post.conversationId === 'string') {
    projected.conversationId = post.conversationId;
  }
  if (typeof post.inReplyToStatusId === 'string') {
    projected.inReplyToStatusId = post.inReplyToStatusId;
  }
  if (post.quotedTweet && !seen.has(post.quotedTweet)) {
    projected.quotedTweet = projectPost(post.quotedTweet, seen);
  }
  return projected;
}

export function hashJevRequest(state: unknown, questions: Record<string, CompiledJevQuestion>): string {
  return createHash('sha256')
    .update(canonicalJson({ model: JEV_MODEL, state, questions }), 'utf8')
    .digest('hex');
}

export function planJevAnalysis(uniquePosts: readonly TweetData[], spec: JevSpec, maxPosts: number): JevPlan {
  if (uniquePosts.length > maxPosts) {
    return { ok: false, code: 'post_limit', message: 'Selected unique posts exceed the configured maximum.' };
  }
  if (uniquePosts.length === 0) {
    return { ok: true, requests: [] };
  }

  const projected = uniquePosts.map((post) => projectPost(post));
  const collectionTasks = spec.tasks.filter((task) => task.scope === 'collection');
  const postTasks = spec.tasks.filter((task) => task.scope === 'post');
  const requests: PlannedJevRequest[] = [];

  if (collectionTasks.length > 0) {
    requests.push(
      buildRequest(
        'collection',
        'collection',
        uniquePosts.map((post) => post.id),
        projected,
        collectionTasks,
      ),
    );
  }
  if (postTasks.length > 0) {
    for (const [index, post] of uniquePosts.entries()) {
      requests.push(buildRequest(`post:${post.id}`, 'post', [post.id], projected[index], postTasks));
    }
  }

  for (const request of requests) {
    if (exceedsPayloadLimit(request.state, request.questions)) {
      return {
        ok: false,
        code: 'payload_limit',
        message: 'The analysis request exceeds the local payload size limit.',
      };
    }
  }
  return { ok: true, requests };
}

function failValidation(message: string): never {
  throw new Error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return true;
    }
  }
  return false;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function utf8JsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function isSafeId(value: string): boolean {
  return SAFE_ID_REGEX.test(value) && !FORBIDDEN_IDS.has(value);
}

function validateTask(input: unknown): JevTask {
  if (!isPlainObject(input)) {
    failValidation('Task is missing required fields.');
  }
  if (hasUnknownKeys(input, ['id', 'scope', 'instructions', 'output'])) {
    failValidation('Task has unknown fields.');
  }
  if (typeof input.id !== 'string' || !isSafeId(input.id)) {
    failValidation('Task id is invalid.');
  }
  if (input.scope !== 'post' && input.scope !== 'collection') {
    failValidation('Task scope is invalid.');
  }
  if (typeof input.instructions !== 'string' || input.instructions.trim() === '') {
    failValidation('Task instructions are invalid.');
  }
  return {
    id: input.id,
    scope: input.scope,
    instructions: input.instructions,
    output: validateOutput(input.output),
  };
}

function validateOutput(output: unknown): JevOutput {
  if (!isPlainObject(output) || typeof output.type !== 'string') {
    failValidation('Task output is invalid.');
  }
  if (output.type === 'category') {
    if (hasUnknownKeys(output, ['type', 'labels'])) {
      failValidation('Task output is invalid.');
    }
    return { type: 'category', labels: validateLabels(output.labels) };
  }
  if (output.type === 'boolean') {
    if (hasUnknownKeys(output, ['type', 'threshold'])) {
      failValidation('Task output is invalid.');
    }
    return { type: 'boolean', threshold: validateThreshold(output.threshold) };
  }
  if (output.type === 'score') {
    if (hasUnknownKeys(output, ['type', 'criteria'])) {
      failValidation('Task output is invalid.');
    }
    return { type: 'score', criteria: validateScoreCriteria(output.criteria) };
  }
  failValidation('Task output is invalid.');
}

function validateLabels(labels: unknown): string[] {
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 255) {
    failValidation('Category labels are invalid.');
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (typeof label !== 'string' || label.trim() === '') {
      failValidation('Category labels are invalid.');
    }
    if (seen.has(label)) {
      failValidation('Category labels are invalid.');
    }
    seen.add(label);
    normalized.push(label);
  }
  return normalized;
}

function validateThreshold(threshold: unknown): number {
  if (threshold === undefined) {
    return 0.5;
  }
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    failValidation('Boolean threshold is invalid.');
  }
  return threshold;
}

function validateScoreCriteria(criteria: unknown): Extract<JevOutput, { type: 'score' }>['criteria'] {
  if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
    failValidation('Score criteria are invalid.');
  }
  const normalized: string[] = [];
  for (const item of criteria) {
    if (typeof item !== 'string' || item.trim() === '') {
      failValidation('Score criteria are invalid.');
    }
    normalized.push(item);
  }
  return [normalized[0], normalized[1], ...normalized.slice(2)];
}

function resolvePresetScopes(scope: 'post' | 'collection' | 'both' | undefined): JevScope[] {
  if (scope === undefined || scope === 'post') {
    return ['post'];
  }
  if (scope === 'collection') {
    return ['collection'];
  }
  if (scope === 'both') {
    return ['post', 'collection'];
  }
  failValidation('Preset scope is invalid.');
}

function relevanceInstructions(scope: JevScope, criterion: string): string {
  if (scope === 'post') {
    return `Judge whether this post is relevant to the following criterion. Criterion: ${criterion}`;
  }
  return `Judge whether the supplied posts together are relevant to the following criterion. The judgment applies to the selected posts only. Criterion: ${criterion}`;
}

function sentimentInstructions(scope: JevScope, subject: string): string {
  if (scope === 'post') {
    return `Assess the author's sentiment toward the following subject. Subject: ${subject}`;
  }
  return `Assess the overall sentiment toward the following subject across the supplied posts together. Use mixed when opposing stances are present. Subject: ${subject}`;
}

function compileQuestion(task: JevTask): CompiledJevQuestion {
  if (task.output.type === 'category') {
    const criteria = emptyMap<null>();
    for (const label of task.output.labels) {
      defineEntry(criteria, label, null);
    }
    return { type: 'choice', instructions: task.instructions, criteria };
  }
  if (task.output.type === 'boolean') {
    return { type: 'noul', instructions: task.instructions };
  }
  return { type: 'score', instructions: task.instructions, criteria: [...task.output.criteria] };
}

function compileQuestions(tasks: JevTask[]): Record<string, CompiledJevQuestion> {
  const questions = emptyMap<CompiledJevQuestion>();
  for (const task of tasks) {
    defineEntry(questions, task.id, compileQuestion(task));
  }
  return questions;
}

function buildRequest(
  id: string,
  scope: JevScope,
  postIds: string[],
  state: ProjectedJevPost | ProjectedJevPost[],
  tasks: JevTask[],
): PlannedJevRequest {
  const questions = compileQuestions(tasks);
  return {
    id,
    scope,
    postIds: [...postIds],
    state,
    questions,
    tasks,
    inputHash: hashJevRequest(state, questions),
  };
}

function exceedsPayloadLimit(
  state: ProjectedJevPost | ProjectedJevPost[],
  questions: Record<string, CompiledJevQuestion>,
): boolean {
  if (utf8JsonBytes({ model: JEV_MODEL, state, questions }) > JEV_ALL_QUESTIONS_MAX_BYTES) {
    return true;
  }
  for (const [id, question] of Object.entries(questions)) {
    const single = emptyMap<CompiledJevQuestion>();
    defineEntry(single, id, question);
    if (utf8JsonBytes({ model: JEV_MODEL, state, questions: single }) > JEV_SINGLE_QUESTION_MAX_BYTES) {
      return true;
    }
  }
  return false;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isPlainObject(value)) {
    const sorted = emptyMap<unknown>();
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const entry = value[key];
      if (entry === undefined) {
        continue;
      }
      sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return null;
}
