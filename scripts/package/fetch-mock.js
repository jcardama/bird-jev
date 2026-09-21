import { appendFileSync, readFileSync } from 'node:fs';

export const JEV_PROVIDER_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.13.0';

export function createProviderFetch({ logPath = process.env.BIRD_PACKAGE_FETCH_LOG } = {}) {
  const fetchImpl = async (input, init = {}) => {
    const url = requestUrl(input);
    if (url !== JEV_PROVIDER_URL) {
      record(logPath, { url, denied: true });
      throw new Error(`Unexpected network request: ${url}`);
    }
    const bodyText = typeof init.body === 'string' ? init.body : '';
    if (bodyText.includes('not-sent')) {
      record(logPath, { url, denied: true, leaked: true });
      throw new Error('Private input leaked to the provider');
    }
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      record(logPath, { url, denied: true, malformed: true });
      throw new Error('Provider request body is not JSON');
    }
    const questions = body.questions && typeof body.questions === 'object' ? body.questions : {};
    const scope = Array.isArray(body.state) ? 'collection' : 'post';
    record(logPath, { url, scope, model: body.model, questionIds: Object.keys(questions) });
    return new Response(
      JSON.stringify({
        model: typeof body.model === 'string' ? body.model : JEV_MODEL,
        answers: answersFor(questions),
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return fetchImpl;
}

export function readFetchLog(logPath) {
  try {
    const raw = readFileSync(logPath, 'utf8').trim();
    if (raw === '') {
      return [];
    }
    return raw.split('\n').map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function answersFor(questions) {
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const type = question && typeof question === 'object' ? question.type : undefined;
    if (type === 'noul') {
      answers[id] = { type: 'noul', noul: 0.8 };
      continue;
    }
    if (type === 'score') {
      answers[id] = { type: 'score', score: 1, confidence: 1, probabilities: { 0: 0, 1: 1 } };
      continue;
    }
    const criteria = question && typeof question === 'object' ? question.criteria : undefined;
    const labels =
      criteria && typeof criteria === 'object' && !Array.isArray(criteria) ? Object.keys(criteria) : ['yes', 'no'];
    const choice = labels[0] ?? 'yes';
    const probabilities = {};
    for (const label of labels) {
      probabilities[label] = label === choice ? 1 : 0;
    }
    answers[id] = { type: 'choice', choice, confidence: 1, probabilities };
  }
  return answers;
}

function requestUrl(input) {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (input && typeof input === 'object' && typeof input.url === 'string') {
    return input.url;
  }
  return String(input);
}

function record(logPath, event) {
  if (!logPath) {
    return;
  }
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

if (process.env.BIRD_PACKAGE_FETCH_GUARD === '1') {
  globalThis.fetch = createProviderFetch();
} else if (process.env.BIRD_PACKAGE_FETCH_GUARD === 'deny') {
  globalThis.fetch = async (input) => {
    record(process.env.BIRD_PACKAGE_FETCH_LOG, { url: requestUrl(input), denied: true });
    throw new Error('Library smoke must use its injected provider transport');
  };
}
