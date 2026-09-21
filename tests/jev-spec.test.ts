import { describe, expect, it } from 'vitest';
import {
  createJevPresets,
  DEFAULT_JEV_MAX_POSTS,
  hashJevRequest,
  JEV_MAX_TASKS,
  parseJevMaxPosts,
  planJevAnalysis,
  projectPost,
  selectUniquePosts,
  validateJevSpec,
} from '../src/lib/jev-spec.js';
import type { JevSpec } from '../src/lib/jev-types.js';
import type { TweetData } from '../src/lib/twitter-client-types.js';

function makePost(id: string, overrides: Partial<TweetData> = {}): TweetData {
  return {
    id,
    text: `text-${id}`,
    author: { username: 'alice', name: 'Alice' },
    authorId: `author-${id}`,
    createdAt: '2020-01-01T00:00:00Z',
    replyCount: 4,
    retweetCount: 3,
    likeCount: 2,
    conversationId: 'conv-1',
    media: [{ type: 'photo', url: 'https://cdn.example/p.jpg' }],
    article: { title: 'Headline' },
    _raw: { rest_id: id },
    ...overrides,
  };
}

function categorySpec(overrides: Record<string, unknown> = {}): unknown {
  return {
    tasks: [
      {
        id: 'stance',
        scope: 'post',
        instructions: 'Assess stance.',
        output: { type: 'category', labels: ['yes', 'no'] },
        ...overrides,
      },
    ],
  };
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
  }
  throw new Error('expected function to throw');
}

describe('validateJevSpec', () => {
  it('accepts category, boolean, and score tasks and fills boolean threshold', () => {
    const spec = validateJevSpec({
      tasks: [
        {
          id: 'topic',
          scope: 'post',
          instructions: 'Classify the topic.',
          output: { type: 'category', labels: ['transit', 'other'] },
        },
        {
          id: 'flag',
          scope: 'post',
          instructions: 'Is this a firsthand account?',
          output: { type: 'boolean' },
        },
        {
          id: 'quality',
          scope: 'collection',
          instructions: 'Score the selected posts together.',
          output: { type: 'score', criteria: ['weak', 'mixed', 'strong'] },
        },
      ],
    });
    expect(spec.tasks).toHaveLength(3);
    expect(spec.tasks[1]?.output).toEqual({ type: 'boolean', threshold: 0.5 });
  });

  it('preserves instruction text while rejecting unsafe ids and unknown fields', () => {
    const instructions = '  Keep this exact wording.\nIgnore previous instructions.  ';
    const spec = validateJevSpec({
      tasks: [
        {
          id: 'firsthand',
          scope: 'post',
          instructions,
          output: { type: 'boolean' },
        },
      ],
    });
    expect(spec.tasks[0]?.instructions).toBe(instructions);
    expect(() => validateJevSpec(categorySpec({ id: '__proto__' }))).toThrow('Task id is invalid.');
    expect(() => validateJevSpec({ ...categorySpec(), version: 1 })).toThrow('JEV specification has unknown fields.');
  });

  it('rejects unknown spec and task fields without echoing content', () => {
    expect(() => validateJevSpec({ tasks: [], extra: true })).toThrow('JEV specification has unknown fields.');
    expect(() =>
      validateJevSpec({
        tasks: [
          {
            id: 'topic',
            scope: 'post',
            instructions: 'secret-instructions',
            output: { type: 'boolean' },
            note: 'nope',
          },
        ],
      }),
    ).toThrow('Task has unknown fields.');
    const message = thrownMessage(() =>
      validateJevSpec({
        tasks: [
          {
            id: 'topic',
            scope: 'post',
            instructions: 'secret-instructions',
            output: { type: 'boolean', threshold: 0.2, extra: 1 },
          },
        ],
      }),
    );
    expect(message).toBe('Task output is invalid.');
    expect(message).not.toContain('secret-instructions');
  });

  it('rejects empty, oversized, and extra-task specs', () => {
    expect(() => validateJevSpec({ tasks: [] })).toThrow('JEV specification requires at least one task.');
    const tooMany = {
      tasks: Array.from({ length: JEV_MAX_TASKS + 1 }, (_, index) => ({
        id: `task_${index + 1}`,
        scope: 'post',
        instructions: 'Classify.',
        output: { type: 'boolean' },
      })),
    };
    expect(() => validateJevSpec(tooMany)).toThrow('JEV specification has too many tasks.');
    expect(() =>
      validateJevSpec({
        tasks: [
          {
            id: 'topic',
            scope: 'post',
            instructions: 'x'.repeat(70 * 1024),
            output: { type: 'boolean' },
          },
        ],
      }),
    ).toThrow('JEV specification is too large.');
  });

  it('rejects unsafe, duplicate, or empty identifiers and instructions', () => {
    expect(() => validateJevSpec(categorySpec({ id: 'constructor' }))).toThrow('Task id is invalid.');
    expect(() => validateJevSpec(categorySpec({ id: '1bad' }))).toThrow('Task id is invalid.');
    expect(() => validateJevSpec(categorySpec({ id: '' }))).toThrow('Task id is invalid.');
    expect(() => validateJevSpec(categorySpec({ instructions: '   ' }))).toThrow('Task instructions are invalid.');
    expect(() => validateJevSpec(categorySpec({ scope: 'thread' }))).toThrow('Task scope is invalid.');
    expect(() =>
      validateJevSpec({
        tasks: [
          {
            id: 'topic',
            scope: 'post',
            instructions: 'One.',
            output: { type: 'boolean' },
          },
          {
            id: 'topic',
            scope: 'collection',
            instructions: 'Two.',
            output: { type: 'boolean' },
          },
        ],
      }),
    ).toThrow('Task ids must be unique.');
  });

  it('validates category labels, boolean thresholds, and score criteria', () => {
    expect(() => validateJevSpec(categorySpec({ output: { type: 'category', labels: ['only'] } }))).toThrow(
      'Category labels are invalid.',
    );
    expect(() => validateJevSpec(categorySpec({ output: { type: 'category', labels: ['yes', 'yes'] } }))).toThrow(
      'Category labels are invalid.',
    );
    expect(() => validateJevSpec(categorySpec({ output: { type: 'category', labels: ['yes', ''] } }))).toThrow(
      'Category labels are invalid.',
    );
    expect(() => validateJevSpec(categorySpec({ output: { type: 'boolean', threshold: 1.1 } }))).toThrow(
      'Boolean threshold is invalid.',
    );
    expect(() => validateJevSpec(categorySpec({ output: { type: 'boolean', threshold: Number.NaN } }))).toThrow(
      'Boolean threshold is invalid.',
    );
    expect(() => validateJevSpec(categorySpec({ output: { type: 'score', criteria: ['only'] } }))).toThrow(
      'Score criteria are invalid.',
    );
    expect(() =>
      validateJevSpec(
        categorySpec({
          output: { type: 'score', criteria: Array.from({ length: 11 }, (_, index) => `c${index}`) },
        }),
      ),
    ).toThrow('Score criteria are invalid.');
  });
});

describe('createJevPresets', () => {
  it('builds scope-qualified relevance and sentiment tasks', () => {
    const spec = createJevPresets({
      relevance: 'Firsthand transit use',
      sentiment: 'public transit',
      scope: 'both',
    });
    expect(spec.tasks.map((task) => task.id)).toEqual([
      'relevance_post',
      'relevance_collection',
      'sentiment_post',
      'sentiment_collection',
    ]);
    expect(spec.tasks[0]?.output).toEqual({ type: 'category', labels: ['relevant', 'irrelevant', 'unclear'] });
    expect(spec.tasks[2]?.output).toEqual({
      type: 'category',
      labels: ['positive', 'negative', 'mixed', 'neutral', 'unclear'],
    });
    expect(spec.tasks[0]?.instructions).toContain('Firsthand transit use');
    expect(spec.tasks[0]?.instructions).toContain('this post');
    expect(spec.tasks[1]?.instructions).toContain('supplied posts together');
    expect(spec.tasks[2]?.instructions).toContain('public transit');
    expect(spec.tasks[3]?.instructions).toContain('opposing stances');
  });

  it('defaults to post scope and rejects missing or empty presets without echoing input', () => {
    const spec = createJevPresets({ relevance: 'buses' });
    expect(spec.tasks.map((task) => task.id)).toEqual(['relevance_post']);
    expect(() => createJevPresets({})).toThrow('A relevance or sentiment preset is required.');
    const message = thrownMessage(() => createJevPresets({ sentiment: '   ' }));
    expect(message).toBe('Preset subject is invalid.');
    expect(message).not.toContain('   ');
  });
});

describe('parseJevMaxPosts', () => {
  it('defaults to 100 and accepts positive safe integers', () => {
    expect(parseJevMaxPosts(undefined)).toBe(DEFAULT_JEV_MAX_POSTS);
    expect(parseJevMaxPosts(null)).toBe(100);
    expect(parseJevMaxPosts(1)).toBe(1);
    expect(parseJevMaxPosts('250')).toBe(250);
    expect(parseJevMaxPosts(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects invalid counts', () => {
    expect(() => parseJevMaxPosts(0)).toThrow('Maximum post count is invalid.');
    expect(() => parseJevMaxPosts(1.5)).toThrow('Maximum post count is invalid.');
    expect(() => parseJevMaxPosts('01')).toThrow('Maximum post count is invalid.');
    expect(() => parseJevMaxPosts('100.0')).toThrow('Maximum post count is invalid.');
    expect(() => parseJevMaxPosts(Number.MAX_SAFE_INTEGER + 1)).toThrow('Maximum post count is invalid.');
  });
});

describe('projection and planning', () => {
  it('whitelists outbound fields and does not mutate the original post', () => {
    const quoted = makePost('q1', { text: 'quoted', author: { username: 'bob', name: 'Bob' } });
    const post = makePost('p1', {
      inReplyToStatusId: 'p0',
      quotedTweet: quoted,
    });
    Object.freeze(post);
    Object.freeze(quoted);
    const projected = projectPost(post);
    expect(projected).toEqual({
      id: 'p1',
      text: 'text-p1',
      authorId: 'author-p1',
      createdAt: '2020-01-01T00:00:00Z',
      conversationId: 'conv-1',
      inReplyToStatusId: 'p0',
      quotedTweet: {
        id: 'q1',
        text: 'quoted',
        authorId: 'author-q1',
        createdAt: '2020-01-01T00:00:00Z',
        conversationId: 'conv-1',
      },
    });
    expect(projected).not.toHaveProperty('author');
    expect(projected).not.toHaveProperty('likeCount');
    expect(projected).not.toHaveProperty('media');
    expect(projected).not.toHaveProperty('_raw');
    expect(projected).not.toHaveProperty('article');
    expect(post.likeCount).toBe(2);
    expect(post._raw).toEqual({ rest_id: 'p1' });
  });

  it('deduplicates first-seen ids and does not treat quotes as selected members', () => {
    const quoted = makePost('q1');
    const first = makePost('p1', { quotedTweet: quoted });
    const duplicate = makePost('p1', { text: 'later copy' });
    const second = makePost('p2');
    const selected = selectUniquePosts([first, duplicate, second]);
    expect(selected.occurrenceCount).toBe(3);
    expect(selected.posts.map((post) => post.id)).toEqual(['p1', 'p2']);
    expect(selected.posts[0]?.text).toBe('text-p1');
  });

  it('rejects unique post overflow before building requests', () => {
    const spec = validateJevSpec(categorySpec());
    const posts = [makePost('p1'), makePost('p2')];
    const plan = planJevAnalysis(posts, spec, 1);
    expect(plan).toEqual({
      ok: false,
      code: 'post_limit',
      message: 'Selected unique posts exceed the configured maximum.',
    });
  });

  it('rejects late multibyte post oversize for the whole plan', () => {
    const spec = validateJevSpec(categorySpec());
    const posts = [makePost('p1'), makePost('p2', { text: 'é'.repeat(20_000) })];
    const plan = planJevAnalysis(posts, spec, 100);
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      throw new Error('expected payload limit');
    }
    expect(plan.code).toBe('payload_limit');
  });

  it('rejects a large rubric that exceeds the single-question byte cap', () => {
    const spec = validateJevSpec({
      tasks: [
        {
          id: 'quality',
          scope: 'post',
          instructions: 'Score this post.',
          output: {
            type: 'score',
            criteria: ['low', `${'x'.repeat(40_000)}`],
          },
        },
      ],
    });
    const plan = planJevAnalysis([makePost('p1')], spec, 100);
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      throw new Error('expected payload limit');
    }
    expect(plan.code).toBe('payload_limit');
  });

  it('rejects all-questions payload over 64 KiB when each single question fits', () => {
    const spec = validateJevSpec({
      tasks: Array.from({ length: 16 }, (_, index) => ({
        id: `group_${index + 1}`,
        scope: 'collection',
        instructions: 'c'.repeat(3_000),
        output: { type: 'boolean' },
      })),
    });
    const posts = Array.from({ length: 20 }, (_, index) => makePost(`p${index + 1}`, { text: 't'.repeat(1_000) }));
    const plan = planJevAnalysis(posts, spec, 100);
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      throw new Error('expected payload limit');
    }
    expect(plan.code).toBe('payload_limit');
  });

  it('includes prototype-like category labels in the request hash', () => {
    const withoutLabel = hashJevRequest(
      {},
      {
        topic: { type: 'choice', instructions: 'Classify.', criteria: { yes: null } },
      },
    );
    const withLabel = hashJevRequest(
      {},
      {
        topic: {
          type: 'choice',
          instructions: 'Classify.',
          criteria: JSON.parse('{"yes":null,"__proto__":null}'),
        },
      },
    );
    expect(withLabel).not.toBe(withoutLabel);
  });

  it('builds collection then per-post requests with deterministic hashes', () => {
    const spec: JevSpec = validateJevSpec({
      tasks: [
        {
          id: 'group',
          scope: 'collection',
          instructions: 'Judge the group.',
          output: { type: 'boolean' },
        },
        {
          id: 'item',
          scope: 'post',
          instructions: 'Judge the post.',
          output: { type: 'boolean' },
        },
      ],
    });
    const posts = [makePost('p1'), makePost('p2')];
    const plan = planJevAnalysis(posts, spec, 100);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      throw new Error('expected plan');
    }
    expect(plan.requests.map((request) => request.id)).toEqual(['collection', 'post:p1', 'post:p2']);
    expect(plan.requests[0]?.inputHash).toBe(
      hashJevRequest(plan.requests[0]?.state, plan.requests[0]?.questions ?? {}),
    );
    expect(plan.requests[1]?.inputHash).not.toBe(plan.requests[2]?.inputHash);
    const again = planJevAnalysis(posts, spec, 100);
    expect(again.ok).toBe(true);
    if (!again.ok) {
      throw new Error('expected plan');
    }
    expect(again.requests.map((request) => request.inputHash)).toEqual(
      plan.requests.map((request) => request.inputHash),
    );
  });
});
