import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export function getVersion(): string {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const pkg = require(path.resolve(here, '../package.json')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
