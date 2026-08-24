import path from 'node:path';
import type { ModuleDescriptor } from './types.js';
import { pascal } from './analyzers/parse.js';

export function fileModuleName(file: string): string {
  const base = path.basename(file).replace(/\.(vue|tsx|jsx|ts|js)$/i, '');
  return pascal(base);
}

export function moduleNodeId(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  return `module:${normalized.toLowerCase()}`;
}

export function buildModuleDescriptor(file: string): ModuleDescriptor {
  return {
    id: moduleNodeId(file),
    name: fileModuleName(file),
    file: file.replaceAll('\\', '/'),
  };
}

export function moduleIdVariants(file: string, modules: ModuleDescriptor[] = []): string[] {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  const direct = moduleNodeId(file);
  const matched = modules.find((item) => item.file.toLowerCase() === normalized);
  return [...new Set([direct, matched?.id].filter(Boolean) as string[])];
}
