import type { Analyzer } from '../analyzer.js';
import type { ApiRoute, Entity } from '../types.js';

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'express', re: /(?:router|app)\.(get|post|put|delete|patch|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi },
  { name: 'nest', re: /@(Get|Post|Put|Delete|Patch|All)\(\s*["'`]([^"'`]+)["'`]/gi },
  { name: 'vue-router', re: /\bpath\s*:\s*["'`](\/[^"'`]+)["'`]/gi },
  {
    name: 'spring',
    re: /@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  },
];

function methodFrom(verb: string, style: string): string {
  if (style === 'vue-router') return 'ANY';
  if (style === 'spring') return 'ANY';
  return verb.toUpperCase();
}

function kindFrom(style: string): 'backend' | 'frontend' {
  return style === 'vue-router' ? 'frontend' : 'backend';
}

function matchEntity(path: string, entities: Entity[]): string | undefined {
  const segments = path.split('/').filter(Boolean);
  for (const seg of segments) {
    const normalized = seg.replace(/[^a-zA-Z]/g, '');
    for (const entity of entities) {
      if (normalized.toLowerCase() === entity.name.toLowerCase()) return entity.name;
      if (normalized.toLowerCase() === entity.name.toLowerCase() + 's') return entity.name;
    }
  }
  return undefined;
}

export const apiAnalyzer: Analyzer = {
  name: 'api',
  analyze(scan, ctx) {
    const apis: ApiRoute[] = [];
    for (const sample of scan.samples) {
      for (const { name: style, re } of PATTERNS) {
        for (const m of sample.text.matchAll(re)) {
          const verb = m[1] ?? 'ANY';
          const path = m[2] ?? m[1] ?? '';
          apis.push({
            id: `api.${methodFrom(verb, style).toLowerCase()}-${path
              .replace(/[^a-zA-Z0-9]/g, '-')
              .replace(/^-|-$/g, '')
              .toLowerCase()}`,
            method: methodFrom(verb, style),
            path,
            entity: matchEntity(path, ctx.entities),
            kind: kindFrom(style),
            confidence: 'low',
            evidence: [sample.file],
          });
        }
      }
    }
    return apis.length ? { apis } : {};
  },
};
