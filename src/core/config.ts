import path from 'node:path';
import { exists, readText } from '../utils/fs.js';

export interface LlmConfig {
  provider: 'openai' | 'openai-compatible';
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
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
  // A default llm block keeps the key mergeable in mergeConfig: user-provided
  // llm settings are merged over these defaults instead of being dropped.
  llm: { provider: 'openai-compatible', apiKeyEnv: 'OPENAI_API_KEY' },
};

export const CONFIG_FILE = 'business-agent.json';

export const AVAILABLE_ANALYZERS = ['sql', 'api', 'ast', 'vue', 'java', 'xml', 'linkage', 'llm', 'llm-rules'] as const;
export type AnalyzerName = (typeof AVAILABLE_ANALYZERS)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeConfig(base: AgentConfig, partial: unknown): AgentConfig {
  if (!isPlainObject(partial)) return base;
  const out: AgentConfig = { ...base };
  const record = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof AgentConfig>) {
    const value = partial[key];
    if (value === undefined) continue;
    if (Array.isArray(base[key]) && Array.isArray(value)) {
      record[key] = value;
    } else if (typeof base[key] === 'number' && typeof value === 'number') {
      record[key] = value;
    } else if (typeof base[key] === 'string' && typeof value === 'string') {
      record[key] = value;
    } else if (isPlainObject(base[key] as unknown) && isPlainObject(value)) {
      record[key] = { ...(base[key] as object), ...value };
    }
  }
  return out;
}

export async function loadConfig(root: string): Promise<AgentConfig> {
  const file = path.join(root, '.agent', CONFIG_FILE);
  if (!(await exists(file))) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(await readText(file));
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
