import type { Analyzer } from '../analyzer.js';
import type { Entity } from '../types.js';
import type { LlmConfig } from '../config.js';

export function buildEntityPrompt(entities: Entity[]): string {
  const lines = entities.map(
    (e) =>
      `- ${e.name}: ${e.description}${e.attributes?.length ? ` (${e.attributes.map((a) => a.name).join(', ')})` : ''}`,
  );
  return [
    'You are a business analyst for a codebase. For each entity below, return JSON with a concise business description and a suggested attribute description for each listed attribute.',
    'Respond with a single JSON array, no markdown.',
    'Entities:',
    ...lines,
  ].join('\n');
}

/** Retry only transient failures: rate limits, server errors, timeouts and network errors. */
function isRetryable(message: string): boolean {
  return /status (429|5\d\d)|timed out|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(message);
}

async function requestOnce(
  prompt: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`LLM request failed with status ${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('LLM request timed out', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function completeLlm(
  prompt: string,
  config: LlmConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
  retries = 2,
): Promise<string | undefined> {
  const apiKeyEnv = config.apiKeyEnv ?? 'OPENAI_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) return undefined;
  const baseUrl = config.baseUrl?.trim() || 'https://api.openai.com/v1';
  const model = config.model?.trim() || 'gpt-4o-mini';

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
    try {
      return await requestOnce(prompt, baseUrl, model, apiKey, fetchImpl, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryable(message) || attempt === retries) throw error;
      lastError = error instanceof Error ? error : new Error(message);
    }
  }
  throw lastError ?? new Error('LLM request failed');
}

interface LlmEntity {
  name?: string;
  description?: string;
  attributes?: Array<{ name?: string; description?: string }>;
}

export const llmAnalyzer: Analyzer = {
  name: 'llm',
  async analyze(scan, ctx) {
    const config = ctx.config.llm;
    if (!config) return {};
    const prompt = buildEntityPrompt(ctx.entities);
    const content = await completeLlm(prompt, config);
    if (!content) return {};

    let parsed: LlmEntity[];
    try {
      parsed = JSON.parse(content.trim().replace(/^```json?|```$/g, '')) as LlmEntity[];
    } catch {
      return {};
    }

    const byName = new Map<string, LlmEntity>();
    for (const item of parsed) if (item.name) byName.set(item.name, item);

    const entities: Entity[] = ctx.entities
      .filter((e) => byName.has(e.name))
      .map((e) => {
        const llm = byName.get(e.name)!;
        return {
          ...e,
          description: llm.description ?? e.description,
          attributes: e.attributes?.map((a) => ({
            ...a,
            description: llm.attributes?.find((x) => x.name === a.name)?.description,
          })),
        };
      });
    return entities.length ? { entities } : {};
  },
};
