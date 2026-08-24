import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../src/core/config.js';

async function tempProject(agent: Record<string, unknown> | string | null): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-config-'));
  if (agent !== null) {
    const content = typeof agent === 'string' ? agent : JSON.stringify(agent);
    await fs.mkdir(path.join(dir, '.agent'), { recursive: true });
    await fs.writeFile(path.join(dir, '.agent', 'business-agent.json'), content, 'utf8');
  }
  return dir;
}

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const dir = await tempProject(null);
    const config = await loadConfig(dir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('merges partial config with defaults', async () => {
    const dir = await tempProject({ preferredEntities: ['Plan', 'Product'] });
    const config = await loadConfig(dir);
    expect(config.preferredEntities).toEqual(['Plan', 'Product']);
    expect(config.maxEntities).toBe(DEFAULT_CONFIG.maxEntities);
    expect(config.allowedExt).toEqual(DEFAULT_CONFIG.allowedExt);
    expect(config.analyzers).toEqual(['sql', 'api', 'ast']);
  });

  it('defaults discover analyzers to sql, api and ast', () => {
    expect(DEFAULT_CONFIG.analyzers).toEqual(['sql', 'api', 'ast']);
  });

  it('allows explicitly disabling all analyzers', async () => {
    const dir = await tempProject({ analyzers: [] });
    const config = await loadConfig(dir);
    expect(config.analyzers).toEqual([]);
  });

  it('falls back to defaults and warns on invalid JSON', async () => {
    const dir = await tempProject('{ not valid json');
    const warnings: string[] = [];
    const config = await loadConfig(dir, (message) => warnings.push(message));
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings[0]).toContain('Ignoring invalid configuration');
  });

  it('warns when the config root is not a JSON object', async () => {
    const dir = await tempProject('[]');
    const warnings: string[] = [];
    await loadConfig(dir, (message) => warnings.push(message));
    expect(warnings[0]).toContain('expected a JSON object');
  });

  it('ignores wrong-typed overrides', async () => {
    const dir = await tempProject({ maxEntities: 'many' as unknown as number, allowedExt: 'x' as unknown as string[] });
    const config = await loadConfig(dir);
    expect(config.maxEntities).toBe(DEFAULT_CONFIG.maxEntities);
    expect(config.allowedExt).toEqual(DEFAULT_CONFIG.allowedExt);
  });

  it('validates LLM provider and privacy option types', async () => {
    const dir = await tempProject({ llm: { provider: 'invalid', allowSourceUpload: 'yes' } });
    const warnings: string[] = [];
    const config = await loadConfig(dir, (message) => warnings.push(message));
    expect(config.llm?.provider).toBe(DEFAULT_CONFIG.llm?.provider);
    expect(config.llm?.allowSourceUpload).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it('merges llm config over defaults instead of dropping it', async () => {
    const dir = await tempProject({
      llm: { model: 'my-model', baseUrl: 'https://llm.example.com/v1', apiKeyEnv: 'MY_KEY' },
    });
    const config = await loadConfig(dir);
    expect(config.llm?.model).toBe('my-model');
    expect(config.llm?.baseUrl).toBe('https://llm.example.com/v1');
    expect(config.llm?.apiKeyEnv).toBe('MY_KEY');
    expect(config.llm?.provider).toBe('openai-compatible');
  });
});
