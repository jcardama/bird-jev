#!/usr/bin/env node

/**
 * bird - CLI tool for posting tweets and replies
 *
 * Usage:
 *   bird tweet "Hello world!"
 *   bird reply <tweet-id> "This is a reply"
 *   bird reply <tweet-url> "This is a reply"
 *   bird read <tweet-id-or-url>
 */

import { createProgram, KNOWN_COMMANDS } from './cli/program.js';
import { createCliContext } from './cli/shared.js';
import { resolveCliInvocation } from './lib/cli-args.js';

const rawArgs: string[] = process.argv.slice(2);
const normalizedArgs: string[] = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

const ctx = createCliContext(normalizedArgs);

const program = createProgram(ctx);

const optionsWithValues = new Set(
  [program, ...program.commands]
    .flatMap((command) => command.options)
    .filter((option) => option.required || option.optional)
    .flatMap((option) => [option.short, option.long].filter((flag) => flag !== undefined)),
);
const { argv, showHelp } = resolveCliInvocation(normalizedArgs, KNOWN_COMMANDS, optionsWithValues);

if (showHelp) {
  program.outputHelp();
  process.exit(0);
}

if (argv) {
  program.parse(argv);
} else {
  program.parse(['node', 'bird', ...normalizedArgs]);
}
