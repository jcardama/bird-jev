import type { JevOutcome, JevReport } from '../lib/jev-types.js';
import type { TweetData } from '../lib/twitter-client-types.js';
import type { CliContext } from './shared.js';

export function ordinaryTweetsJsonData(
  tweets: readonly TweetData[],
  nextCursor: string | undefined,
  usePagination: boolean,
): unknown {
  if (usePagination) {
    return { tweets, nextCursor: nextCursor ?? null };
  }
  return tweets;
}

export function printJevJson(data: unknown, report: JevReport): void {
  console.log(JSON.stringify({ data, jev: report }, null, 2));
}

export function printJevAnalysis(ctx: CliContext, report: JevReport): void {
  console.log('');
  console.log(ctx.colors.section('Analysis'));
  console.log(ctx.colors.muted(`  ${report.selection.postCount} posts (${report.selection.occurrenceCount} selected)`));

  const collectionEntries = Object.entries(report.collection);
  if (collectionEntries.length > 0) {
    console.log(`  ${ctx.colors.command('collection')}`);
    for (const [id, outcome] of collectionEntries) {
      console.log(`    ${formatOutcomeLine(id, outcome)}`);
    }
  }

  for (const post of report.posts) {
    console.log(`  ${ctx.colors.accent(post.postId)}`);
    for (const [id, outcome] of Object.entries(post.results)) {
      console.log(`    ${formatOutcomeLine(id, outcome)}`);
    }
  }
}

export function jevShouldExit(report: JevReport): boolean {
  if (report.error) {
    return true;
  }
  for (const outcome of Object.values(report.collection)) {
    if (isBlockingOutcome(outcome)) {
      return true;
    }
  }
  for (const post of report.posts) {
    for (const outcome of Object.values(post.results)) {
      if (isBlockingOutcome(outcome)) {
        return true;
      }
    }
  }
  return false;
}

function isBlockingOutcome(outcome: JevOutcome): boolean {
  if (outcome.status === 'failed') {
    return true;
  }
  if (outcome.status === 'skipped') {
    return outcome.reason !== 'empty_selection';
  }
  return false;
}

function formatOutcomeLine(id: string, outcome: JevOutcome): string {
  if (outcome.status === 'skipped') {
    return `${id}: skipped (${outcome.reason})`;
  }
  if (outcome.status === 'failed') {
    return `${id}: failed (${outcome.error.code})`;
  }
  if (outcome.type === 'category') {
    return `${id}: ${outcome.value}  conf=${formatNumber(outcome.confidence)}  ${formatProbabilities(outcome.probabilities)}`;
  }
  if (outcome.type === 'boolean') {
    const answer = outcome.value ? 'yes' : 'no';
    return `${id}: ${answer}  p=${formatNumber(outcome.probability)}  threshold=${formatNumber(outcome.threshold)}`;
  }
  return `${id}: ${formatNumber(outcome.value)}/${Object.keys(outcome.probabilities).length - 1}  conf=${formatNumber(outcome.confidence)}  ${formatProbabilities(outcome.probabilities)}`;
}

function formatProbabilities(probabilities: Record<string, number>): string {
  const parts: string[] = [];
  for (const [label, value] of Object.entries(probabilities)) {
    parts.push(`${label} ${formatNumber(value)}`);
  }
  return parts.join(', ');
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'invalid';
}
