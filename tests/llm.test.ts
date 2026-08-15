import { afterEach, describe, expect, it } from 'vitest';
import { buildEntityPrompt, completeLlm } from '../src/core/analyzers/llm.js';
import type { Entity } from '../src/core/types.js';
import type { LlmConfig } from '../src/core/config.js';

const ENTITIES: Entity[] = [
  {
    id: 'entity.product',
    name: 'Product',
    type: 'business_entity',
    description: 'd',
    confidence: 'low',
    evidence: [],
    attributes: [{ name: 'status', type: 'string' }],
  },
];

describe('buildEntityPrompt', () => {
  it('includes entity names and attributes', () => {
    const prompt = buildEntityPrompt(ENTITIES);
    expect(prompt).toContain('Product');
    expect(prompt).toContain('status');
  });
});

describe('completeLlm', () => {
  afterEach(() => {
    delete process.env.TEST_LLM_KEY;
  });

  it('returns undefined when no API key is configured', async () => {
    const config: LlmConfig = { provider: 'openai-compatible', apiKeyEnv: 'TEST_LLM_KEY' };
    const result = await completeLlm('hi', config);
    expect(result).toBeUndefined();
  });

  it('calls the chat completions endpoint with the key', async () => {
    process.env.TEST_LLM_KEY = 'sk-test';
    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
    const fakeFetch = async (
      url: string,
      init: { headers: Record<string, string>; body: string },
    ): Promise<{
      ok: boolean;
      json: () => Promise<{ choices: Array<{ message: { content: string } }> }>;
    }> => {
      captured = { url, headers: init.headers, body: init.body };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
      };
    };
    const config: LlmConfig = {
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'TEST_LLM_KEY',
    };
    const result = await completeLlm('hi', config, fakeFetch as unknown as typeof fetch);
    expect(result).toBe('OK');
    expect(captured?.url).toBe('https://example.com/v1/chat/completions');
    expect(captured?.headers.Authorization).toBe('Bearer sk-test');
  });

  it('treats empty model/baseUrl as unset defaults', async () => {
    process.env.TEST_LLM_KEY = 'sk-test';
    let captured: { url: string; body: string } | undefined;
    const fakeFetch = async (
      url: string,
      init: { body: string },
    ): Promise<{
      ok: boolean;
      json: () => Promise<{ choices: Array<{ message: { content: string } }> }>;
    }> => {
      captured = { url, body: init.body };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
      };
    };
    const config: LlmConfig = { provider: 'openai-compatible', model: '', baseUrl: '', apiKeyEnv: 'TEST_LLM_KEY' };
    const result = await completeLlm('hi', config, fakeFetch as unknown as typeof fetch);
    expect(result).toBe('OK');
    expect(captured?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(captured?.body ?? '{}').model).toBe('gpt-4o-mini');
  });

  it('throws when the endpoint responds with an error status', async () => {
    process.env.TEST_LLM_KEY = 'sk-test';
    const fakeFetch = async (): Promise<{ ok: boolean; status: number; json: () => Promise<object> }> => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    await expect(
      completeLlm(
        'hi',
        { provider: 'openai-compatible', apiKeyEnv: 'TEST_LLM_KEY' },
        fakeFetch as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/status 401/);
  });

  it('retries transient 5xx failures and succeeds on the second attempt', async () => {
    process.env.TEST_LLM_KEY = 'sk-test';
    let calls = 0;
    const fakeFetch = async (): Promise<{ ok: boolean; status: number; json: () => Promise<object> }> => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
    };
    const result = await completeLlm(
      'hi',
      { provider: 'openai-compatible', apiKeyEnv: 'TEST_LLM_KEY' },
      fakeFetch as unknown as typeof fetch,
      30_000,
      2,
    );
    expect(result).toBe('OK');
    expect(calls).toBe(2);
  });

  it('does not retry non-transient 4xx failures', async () => {
    process.env.TEST_LLM_KEY = 'sk-test';
    let calls = 0;
    const fakeFetch = async (): Promise<{ ok: boolean; status: number; json: () => Promise<object> }> => {
      calls++;
      return { ok: false, status: 400, json: async () => ({}) };
    };
    await expect(
      completeLlm(
        'hi',
        { provider: 'openai-compatible', apiKeyEnv: 'TEST_LLM_KEY' },
        fakeFetch as unknown as typeof fetch,
        30_000,
        2,
      ),
    ).rejects.toThrow(/status 400/);
    expect(calls).toBe(1);
  });

  it('converts an aborted request into a timeout error', async () => {
    process.env.TEST_LLM_KEY = 'sk-test';
    const hangingFetch = (_url: string, init: { signal?: AbortSignal }): Promise<never> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    await expect(
      completeLlm(
        'hi',
        { provider: 'openai-compatible', apiKeyEnv: 'TEST_LLM_KEY' },
        hangingFetch as unknown as typeof fetch,
        20,
        0,
      ),
    ).rejects.toThrow(/timed out/);
  });
});
