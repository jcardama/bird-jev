# JEV analysis

Version 0.9.0 adds optional analysis of individual posts and collected groups. JEV does not change which posts Bird collects, filter results, predict engagement, or verify factual claims. Ordinary commands and JSON output stay unchanged without `--jev`.

## Consent and credentials

`--jev` explicitly authorizes sending the selected post content and the context described below to **TypeSafe**, at `https://api.typesafe.ai`. This includes protected posts and account-specific selections you can read, such as bookmarks or the home feed. Bird does not assert that selected content is public.

Supply `TYPESAFE_API_KEY` through your process environment or secret manager. Do not put the key in command arguments, task files, shell history, or Bird's JSON5 configuration. There is no interactive key setup or credential-file fallback. Missing keys and invalid task options fail before X credential resolution or collection.

The provider receives only:

- Selected post text and IDs.
- Author IDs and timestamps, when available.
- Conversation and reply IDs.
- The same projected fields from quoted posts already collected.
- Your task instructions and criteria.

It does **not** receive X cookies, raw GraphQL objects, usernames/display names, engagement counts, media URLs or binaries, or news headlines/metadata. Links that are part of the post text remain part of that text. JEV does not fetch linked content, missing parent posts, or media descriptions. Quoted posts supply context; they do not become additional selected members.

The provider's [privacy notice](https://typesafe.ai/legal/privacy-policy) states that input is not used to train or fine-tune models and describes US processing. It does not state a fixed retention period. Do not assume zero retention. You remain responsible for whether you may send the selected content and your task instructions.

## Presets

```sh
bird search "public transit" --count 20 --jev \
  --relevance "Firsthand experiences using public transit" \
  --sentiment "public transit" --jev-scope both --json

bird read 1234567890123456789 --jev --sentiment "public transit"

bird replies 1234567890123456789 --max-pages 2 --jev \
  --sentiment "public transit" --jev-scope collection --json
```

- `--relevance <criterion>` asks whether the content addresses your criterion. Labels: `relevant`, `irrelevant`, `unclear`.
- `--sentiment <subject>` evaluates sentiment toward that subject, not an unspecified general mood. Labels: `positive`, `negative`, `mixed`, `neutral`, `unclear`.
- `--jev-scope post` is the preset default. `collection` evaluates the selected group together. `both` requests both kinds of result.
- Presets compile to the same tasks available in custom JSON. Their IDs include scope, for example `sentiment_post` and `sentiment_collection`.

All JEV options require `--jev`. A bare `--jev` requires either a preset or a task file; it does not silently choose an analysis.

## Custom tasks

```sh
bird thread 1234567890123456789 --jev --jev-spec ./analysis.json --json
```

See [`examples/jev-analysis.json`](../examples/jev-analysis.json) for a neutral example. Task files use strict JSON, not JSON5, and must contain only a `tasks` array. Each task requires a unique identifier, an explicit `post` or `collection` scope, instructions, and one output definition:

```json
{
  "tasks": [
    {
      "id": "firsthand",
      "scope": "post",
      "instructions": "Does the author explicitly describe personally using public transit?",
      "output": { "type": "boolean", "threshold": 0.5 }
    },
    {
      "id": "discussion_stance",
      "scope": "collection",
      "instructions": "Assess the overall stance toward public transit across the supplied posts together. Use mixed when opposing stances are present.",
      "output": {
        "type": "category",
        "labels": ["positive", "negative", "mixed", "neutral", "unclear"]
      }
    }
  ]
}
```

### Output kinds

| Type | Definition | Result |
| --- | --- | --- |
| `category` | `labels`: 2–255 unique, nonempty strings | Selected label, probability distribution, confidence |
| `boolean` | Optional finite `threshold` in [0,1], default 0.5 | Yes-probability, effective threshold, and `value = probability >= threshold` |
| `score` | `criteria`: 2–10 ordered, nonempty level descriptions | Fractional expected level index, distribution, confidence |

For a score, define one dimension and give each level a self-contained description:

```json
{
  "id": "specificity",
  "scope": "post",
  "instructions": "Assess how concretely the post describes a transit experience.",
  "output": {
    "type": "score",
    "criteria": [
      "The post offers only generic claims without a concrete experience.",
      "The post identifies a concrete experience but gives limited detail.",
      "The post describes a concrete experience with relevant, specific details."
    ]
  }
}
```

With three levels the score ranges from 0 to 2 and can be fractional. It is not a percentage. Confidence reflects the provider's probability distribution, not independently verified correctness. A boolean probability near 0.5 remains uncertain even though the threshold produces a boolean. Failed or unavailable analysis is a separate outcome, never automatically `false`, neutral, or irrelevant.

Task identifiers start with an ASCII letter and contain only letters, digits, underscores, or hyphens, up to 64 characters. The names `constructor`, `prototype`, and `__proto__` are reserved. Unknown fields are rejected. A specification supports at most 16 normalized tasks and 64 KiB of UTF-8 JSON. Do not combine `--jev-spec` with preset flags or `--jev-scope`; each custom task already declares its scope.

## Analyze supplied posts

```sh
bird analyze --input posts.json --jev --jev-spec analysis.json --json
```

`analyze` reuses the same analysis engine without resolving X credentials, collecting posts, or following links. It requires explicit `--jev` consent and either a task file or presets. `posts.json` must be a strict JSON array, at most 4 MiB. Each post requires a nonblank string `id` and string `text`. Optional `authorId`, `createdAt`, `conversationId`, and `inReplyToStatusId` must be strings. Optional `author` requires a string `username` and may contain a string `name`. Optional `quotedTweet` follows the same shape (maximum 16 nested quotes). Other original fields remain in `data`; only the existing allowlisted projection is sent to TypeSafe.

The report records `selection.source: "input"`, not a fresh X collection. Supplied dates and content are caller assertions, not verified by Bird. Duplicate IDs follow the same first-occurrence rule and unique-post limits below. Empty input makes no provider calls. Input errors exit 2; analysis limits and partial failures preserve the input/report and exit 1. This command does not retry or replace missing context.

## Supported reads and group boundaries

| Command | Selected content |
| --- | --- |
| `read`, bare post-ID shorthand | The returned post |
| `replies` | Collected direct replies, not every descendant |
| `thread` | Final posts after existing thread filters |
| `search`, `mentions`, `user-tweets`, `home` | Returned posts |
| `bookmarks`, `likes`, `list-timeline` | Final selected posts, including explicitly requested bookmark expansion |
| `news`, alias `trending` | Related posts with explicit `--with-tweets` |

For news, Bird analyzes one collection of related posts across returned items. It preserves the nested news records in local output; it does not classify headlines, infer topic clusters, or create a separate group per headline.

Collection analysis covers the selected set for one invocation. It does not establish complete coverage of X, a topic, an account, or a conversation. A missing continuation cursor does not establish completeness. The report records actual member IDs, counts, and a cursor when the collector supplies one.

Duplicate post IDs use the first selected occurrence for inference, in encounter order. Original data remains intact. Thread metadata can depend on additional collected posts, but JEV receives only the final selected members and their existing quote context.

Metadata commands such as `following`, `followers`, `lists`, and `about`, and all write commands, have no JEV flags. Library callers can analyze their own selected subsets through the same API.

## Limits, requests, and failures

- `--jev-max-posts <n>` defaults to 100 unique selected posts. It must be a finite positive safe integer. Exceeding it rejects analysis; it never takes the first N posts. This is an analysis limit, not a replacement for the command's collection flags.
- Raise the post cap explicitly when a larger number of per-post requests is intended. Payload limits still apply.
- Requests run sequentially: at most one collection request first, then one request per unique post. All tasks for the same scope/input share a request. No automatic retries or model fallback.
- Bird uses the fixed `jev-1.13.0` model, a 30-second per-request timeout, and disabled SDK logging. A missing or different returned model fails the request. Provider base-URL, default-model, and logging environment overrides are not inherited.
- The complete local request plan is checked before any JEV request. Local guards limit the serialized payload to 32 KiB for state plus the largest question and 64 KiB for state plus all questions, including instructions, criteria, and JSON overhead.
- These are conservative **byte limits**, not tokenizer counts. The provider separately documents 32k/64k token limits. A provider-side rejection can still happen after earlier requests incurred usage.
- Oversized groups are rejected without truncation, partitioning, or summary merging. Reduce the selection or task payload and rerun.

A request failure stops subsequent requests. Completed results remain available; pending tasks are explicitly skipped. An invalid individual answer fails that task without discarding valid siblings. Empty successful selections make no provider requests.

If X collection fails, JEV does not run. Available partial data remains in local output. With JEV enabled, failed news sub-fetches or requested bookmark expansions also fail collection rather than silently analyzing a fallback set. Ordinary non-JEV best-effort behavior is unchanged.

JEV argument/configuration errors exit 2 before collection. Failed collection, analysis, or unrun requested work on a nonempty selection exits 1. Completed work and successful empty selections exit 0. Provider errors are sanitized; no raw request/error bodies or keys are printed. Invalid-answer messages identify the failed structural check (such as a missing answer, undeclared category, invalid confidence, or distribution keys/total) using static text, never rejected values. These messages diagnose validation failures without weakening acceptance or claiming factual correctness.

## Output

With `--jev --json` or `--jev --json-full`, stdout contains one document:

```text
{
  "data": <the command's ordinary JSON value>,
  "jev": <analysis report>
}
```

`data` preserves the ordinary single-post object, post array, `{tweets,nextCursor}` pagination object, or nested news array. `--json-full` preserves `_raw` here only; it never sends `_raw` to TypeSafe. An absent single post is represented by `null` on collection failure.

The version-1 report contains:

- `requestedModel`, normalized `tasks`, and `selection` metadata.
- `posts`: per-post result maps keyed by task ID; `collection`: collection result map.
- Outcomes with `status: ok`, `failed`, or `skipped`. Successful results carry a request-receipt ID.
- `requests`: one receipt per attempted request, with member IDs, scope, input hash, and actual model/usage when available. Status is `ok` when every answer validates, `invalid_answers` when individual answers fail, or `failed` for request/envelope failures. Individual answer failures do not discard valid siblings or stop later requests.
- `usage.inputTokens`, `usage.outputTokens`, and `usage.complete`. Totals include only known usage, counted once per request.

Unknown usage is not zero billed cost. The API reports token usage, not a monetary billing receipt, so Bird does not invent dollar amounts. Input hashes identify canonical model/state/questions; they are not anonymization or proof that the provider executed a request.

Without a JSON flag, Bird prints the ordinary content and then an analysis section. Model judgments are separate from original posts and from measured X statistics.

## Library

```ts
import { analyzePosts, createJevPresets } from 'bird-jev';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error('TYPESAFE_API_KEY is required');

const spec = createJevPresets({ sentiment: 'public transit', scope: 'both' });
const posts = [
  { id: '1', text: 'The new bus route shortened my commute.', author: { username: 'reader', name: 'Reader' } }
];
const report = await analyzePosts(posts, spec, { apiKey });
```

The key is explicit in library options. Importing the library does not resolve credentials or make requests. Existing `TwitterClient` methods remain collectors; call `analyzePosts` after selecting posts. `validateJevSpec` validates custom definitions. Library options also support a post limit, collection provenance, cancellation signal, and an injected fetch implementation for offline testing.

## Verification boundary

The normal check uses synthetic fixtures and mocked network responses. It validates behavior and contracts, not live prediction quality or provider availability. A bounded paid JEV pilot and any live X probe each require separate authorization. Exact counts and ratios should be calculated from validated per-post outcomes in code rather than inferred from collection scores.

References: [API](https://docs.typesafe.ai/api.md), [models and limits](https://docs.typesafe.ai/models.md), [model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md), [Score](https://docs.typesafe.ai/primitives/score.md), [Noul](https://docs.typesafe.ai/primitives/noul.md).
