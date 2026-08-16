import path from 'node:path';
import { exists, readText, writeJson } from '../utils/fs.js';
import { CONFIG_FILE, loadConfig } from '../core/config.js';

export async function configCommand(root: string, action?: string, key?: string, value?: string): Promise<void> {
  const file = path.join(root, '.agent', CONFIG_FILE);
  if (action === 'get') {
    const config = await loadConfig(root, (message) => console.warn(`Warning: ${message}`));
    if (!key) {
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    const result = key.split('.').reduce<unknown>((current, segment) => {
      if (typeof current !== 'object' || current === null) return undefined;
      return (current as Record<string, unknown>)[segment];
    }, config);
    if (result === undefined) throw new Error(`Unknown config key: ${key}`);
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
    return;
  }
  if (action === 'set') {
    if (!key || value === undefined) throw new Error('Usage: business-agent config set <key> <value>');
    const current = ((await exists(file)) ? JSON.parse(await readText(file)) : {}) as Record<string, unknown>;
    const parsed = parseValue(value);
    const segments = key.split('.');
    let target = current;
    for (const segment of segments.slice(0, -1)) {
      const next = target[segment];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) target[segment] = {};
      target = target[segment] as Record<string, unknown>;
    }
    target[segments[segments.length - 1]] = parsed;
    await writeJson(file, current);
    await loadConfig(root, (message) => console.warn(`Warning: ${message}`));
    console.log(`Set ${key}`);
    return;
  }
  throw new Error('Usage: business-agent config get [key] | config set <key> <value>');
}

function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
