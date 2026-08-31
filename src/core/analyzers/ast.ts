import path from 'node:path';
import { createRequire } from 'node:module';
import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { Entity, Relation } from '../types.js';
import { pascal, entityId } from './parse.js';
import type ts from 'typescript';

// Cache the load per project root: concurrent callers (ast + vue analyzers run
// in parallel) must await the same in-flight import instead of reading a not-yet
// assigned tsModule. When the plugin is installed globally (npm -g / tgz), the
// project's own `typescript` devDependency is resolved from the scanned project
// root before falling back to the plugin's own resolution.
const tsByRoot = new Map<string, Promise<typeof ts | undefined>>();

export function loadTs(root?: string): Promise<typeof ts | undefined> {
  const key = root ?? '';
  const cached = tsByRoot.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<typeof ts | undefined> => {
    if (root) {
      try {
        const requireFromProject = createRequire(path.join(root, 'package.json'));
        return requireFromProject('typescript') as typeof ts;
      } catch {
        // Project has no typescript; fall through to the plugin's own resolution.
      }
    }
    try {
      return await import('typescript');
    } catch {
      return undefined;
    }
  })();
  tsByRoot.set(key, promise);
  return promise;
}

export const TS_MISSING_WARNING = 'ast/vue analysis skipped: install "typescript" to enable TypeScript AST analysis';

export interface TypeScriptAnalysis {
  entities: Entity[];
  relations: Relation[];
}

const PRIMITIVE_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'Date',
  'Array',
  'Promise',
  'Record',
  'Partial',
  'Pick',
  'Omit',
  'unknown',
  'any',
  'void',
  'null',
  'undefined',
]);

function typeCardinality(typeText: string): Relation['cardinality'] {
  const normalized = typeText.replace(/\s+/g, '');
  if (/^(?:ReadonlyArray|Array|Promise<.*\[\])/.test(normalized) || /\[\]$/.test(normalized)) return '1:N';
  if (/^Promise<.*>$/.test(normalized)) return '1:1';
  return 'N:1';
}

function captureTypeReference(typeText: string, source: string, relations: Relation[], file: string): void {
  const cleaned = typeText.replace(/['"][^'"]*['"]/g, ' ');
  const re = /\b[A-Z][A-Za-z0-9_]*\b/g;
  for (const m of cleaned.matchAll(re)) {
    const target = m[0];
    if (target === source) continue;
    if (PRIMITIVE_TYPES.has(target)) continue;
    if (relations.some((r) => r.source === source && r.target === target)) continue;
    relations.push({
      id: `relation.${source.toLowerCase()}-${target.toLowerCase()}-type`,
      source,
      target,
      relationship: 'references',
      cardinality: typeCardinality(typeText),
      description: `Type reference in ${source} → ${target}.`,
      confidence: 'medium',
      evidence: [file],
    });
  }
}

export async function analyzeTypeScript(
  text: string,
  file: string,
  knownNames: ReadonlySet<string> = new Set(),
): Promise<TypeScriptAnalysis> {
  const ts = await loadTs();
  if (ts === undefined) return { entities: [], relations: [] };

  const entities: Entity[] = [];
  const relations: Relation[] = [];

  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  } catch {
    return { entities: [], relations: [] };
  }

  source.statements.forEach((statement) => {
    if (!(ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement))) return;
    const declName = statement.name?.getText(source);
    if (!declName) return;
    const entityName = pascal(declName);
    const attributes: Entity['attributes'] = [];

    if (ts.isInterfaceDeclaration(statement)) {
      for (const member of statement.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        const attrName = member.name.getText(source);
        const type = member.type?.getText(source) ?? 'unknown';
        attributes.push({ name: attrName, type });
        captureTypeReference(type, entityName, relations, file);
      }
    } else if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (!(ts.isPropertyDeclaration(member) || ts.isGetAccessor(member))) continue;
        if (!member.name) continue;
        const attrName = member.name.getText(source);
        const type = member.type?.getText(source) ?? 'unknown';
        if (!attributes.some((a) => a.name === attrName)) {
          attributes.push({ name: attrName, type });
        }
        captureTypeReference(type, entityName, relations, file);
      }
    }

    const isEntity = attributes.length > 0 || knownNames.has(entityName);
    if (isEntity) {
      entities.push({
        id: entityId(entityName),
        name: entityName,
        type: 'business_entity',
        description: `Discovered from AST in ${file}.`,
        confidence: 'high',
        attributes,
        evidence: [file],
      });
    }
  });

  return { entities, relations };
}

export const astAnalyzer: Analyzer = {
  name: 'ast',
  async analyze(scan, ctx) {
    if (!(await loadTs(scan.root))) {
      ctx.warn?.(TS_MISSING_WARNING);
      return {};
    }
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const knownNames = new Set(ctx.entities.map((e) => e.name));

    for (const sample of scan.samples) {
      if (!/\.(ts|tsx|js|jsx)$/i.test(sample.file)) continue;
      const r = await analyzeTypeScript(sample.text, sample.file, knownNames);
      entities.push(...r.entities);
      relations.push(...r.relations);
    }

    const result: AnalyzeResult = {};
    if (entities.length) result.entities = entities;
    if (relations.length) result.relations = relations;
    return result;
  },
};
