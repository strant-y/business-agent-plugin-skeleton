import path from 'node:path';
import { exists, readText } from '../utils/fs.js';

export interface LlmConfig {
  provider: 'openai' | 'openai-compatible' | 'ollama';
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  allowSourceUpload?: boolean;
}

export interface AgentConfig {
  ignoreDirs: string[];
  allowedExt: string[];
  preferredEntities: string[];
  maxFileBytes: number;
  maxEntities: number;
  maxSampleFiles: number;
  maxSamplesPerExt: number;
  maxSampleChars: number;
  relationWindow: number;
  analyzers: string[];
  autoPromote: 'never' | 'high' | 'medium';
  llm?: LlmConfig;
}

export const DEFAULT_CONFIG: AgentConfig = {
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', '.idea', '.vscode', '.agent', 'coverage'],
  allowedExt: ['.ts', '.tsx', '.vue', '.java', '.sql', '.xml', '.js', '.jsx'],
  preferredEntities: [],
  maxFileBytes: 1024 * 1024,
  maxEntities: 100,
  maxSampleFiles: 40,
  maxSamplesPerExt: 20,
  maxSampleChars: 8000,
  relationWindow: 150,
  analyzers: [],
  autoPromote: 'never',
  // A default llm block keeps the key mergeable in mergeConfig: user-provided
  // llm settings are merged over these defaults instead of being dropped.
  llm: { provider: 'openai-compatible', apiKeyEnv: 'OPENAI_API_KEY', allowSourceUpload: false },
};

export const CONFIG_FILE = 'business-agent.json';

export const AVAILABLE_ANALYZERS = [
  'sql',
  'api',
  'ast',
  'vue',
  'java',
  'xml',
  'stores',
  'linkage',
  'llm',
  'llm-rules',
  'states',
  'frontend',
] as const;
export type AnalyzerName = (typeof AVAILABLE_ANALYZERS)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeConfig(base: AgentConfig, partial: unknown, onWarning?: (message: string) => void): AgentConfig {
  if (!isPlainObject(partial)) return base;
  const out: AgentConfig = { ...base };
  const record = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof AgentConfig>) {
    const value = partial[key];
    if (value === undefined) continue;
    if (key === 'llm') {
      if (!isPlainObject(value)) {
        onWarning?.('Ignoring invalid llm configuration: expected an object.');
        continue;
      }
      const llm = { ...base.llm };
      if (value.provider !== undefined) {
        if (value.provider === 'openai' || value.provider === 'openai-compatible' || value.provider === 'ollama') {
          llm.provider = value.provider;
        } else onWarning?.('Ignoring invalid llm.provider; expected openai, openai-compatible, or ollama.');
      }
      for (const field of ['model', 'baseUrl', 'apiKeyEnv'] as const) {
        if (value[field] === undefined) continue;
        if (typeof value[field] === 'string') llm[field] = value[field];
        else onWarning?.(`Ignoring invalid llm.${field}; expected a string.`);
      }
      if (value.allowSourceUpload !== undefined) {
        if (typeof value.allowSourceUpload === 'boolean') llm.allowSourceUpload = value.allowSourceUpload;
        else onWarning?.('Ignoring invalid llm.allowSourceUpload; expected a boolean.');
      }
      record.llm = llm;
      continue;
    }
    if (Array.isArray(base[key]) && Array.isArray(value)) {
      record[key] = value;
    } else if (typeof base[key] === 'number' && typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0 || (key === 'maxEntities' && value < 1)) {
        onWarning?.(`Ignoring invalid config.${key}; expected a positive finite number.`);
        continue;
      }
      record[key] = value;
    } else if (typeof base[key] === 'string' && typeof value === 'string') {
      if (key === 'autoPromote' && !['never', 'high', 'medium'].includes(value)) continue;
      record[key] = value;
    }
  }
  if (out.llm?.provider === 'ollama' && !out.llm.apiKeyEnv) out.llm.apiKeyEnv = 'none';
  return out;
}

export async function loadConfig(root: string, onWarning?: (message: string) => void): Promise<AgentConfig> {
  const file = path.join(root, '.agent', CONFIG_FILE);
  if (!(await exists(file))) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(await readText(file));
    if (!isPlainObject(raw)) {
      onWarning?.(`Ignoring invalid configuration at ${file}: expected a JSON object.`);
      return { ...DEFAULT_CONFIG };
    }
    return mergeConfig(DEFAULT_CONFIG, raw, onWarning);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onWarning?.(`Ignoring invalid configuration at ${file}: ${detail}`);
    return { ...DEFAULT_CONFIG };
  }
}
