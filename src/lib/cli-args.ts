export type CliInvocation = {
  argv: string[] | null;
  showHelp: boolean;
};

const TWEET_URL_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[^/]+\/status\/\d+/i;
const TWEET_ID_REGEX = /^\d{8,}$/;

export function looksLikeTweetInput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return TWEET_URL_REGEX.test(trimmed) || TWEET_ID_REGEX.test(trimmed);
}

export function resolveCliInvocation(
  rawArgs: string[],
  knownCommands: Set<string>,
  optionsWithValues: ReadonlySet<string> = new Set(),
): CliInvocation {
  if (rawArgs.length === 0) {
    return { argv: null, showHelp: true };
  }

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg.startsWith('-') && arg !== '--') {
      if (optionsWithValues.has(arg)) {
        index += 1;
      }
      continue;
    }
    const operand = arg === '--' ? rawArgs[index + 1] : arg;
    if (operand && !knownCommands.has(operand) && looksLikeTweetInput(operand)) {
      const rewrittenArgs = [...rawArgs];
      rewrittenArgs.splice(index, 0, 'read');
      return { argv: ['node', 'bird', ...rewrittenArgs], showHelp: false };
    }
    break;
  }

  return { argv: null, showHelp: false };
}
