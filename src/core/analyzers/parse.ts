import type { Entity, Relation } from '../types.js';

export function pascal(name: string): string {
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function entityId(name: string): string {
  return `entity.${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

export function relationId(source: string, target: string, kind: string): string {
  return `relation.${source.toLowerCase()}-${target.toLowerCase()}-${kind}`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SqlParseResult {
  entities: Entity[];
  relations: Relation[];
}

function refRelationId(source: string, target: string, kind: string): string {
  return relationId(source, target, kind);
}

export function parseSqlRelations(text: string, file: string, evidenceFiles: string[] = []): SqlParseResult {
  const entities: Entity[] = [];
  const relations: Relation[] = [];
  const knownTables = new Set<string>();

  const addEntity = (table: string): string => {
    const name = pascal(table);
    if (knownTables.has(name)) return name;
    knownTables.add(name);
    const re = new RegExp(`\\b${escapeRegExp(table)}\\b`, 'i');
    entities.push({
      id: entityId(name),
      name,
      type: 'business_entity',
      description: `Discovered from SQL table ${table}.`,
      confidence: 'medium',
      evidence: evidenceFiles.filter((f) => re.test(f)).slice(0, 8),
    });
    return name;
  };

  const addRelation = (source: string, target: string, kind: string, opts: Partial<Relation> = {}): void => {
    if (source === target) return;
    relations.push({
      id: refRelationId(source, target, kind),
      source,
      target,
      relationship: 'references',
      cardinality: 'unknown',
      confidence: 'low',
      evidence: [file],
      ...opts,
    });
  };

  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)/gi;
  for (const m of text.matchAll(createRe)) {
    const table = m[1].toLowerCase();
    addEntity(table);
    const refRe = /\breferences\s+([a-z_][a-z0-9_]*)/gi;
    for (const r of m[2].matchAll(refRe)) {
      addEntity(r[1].toLowerCase());
      addRelation(pascal(table), pascal(r[1]), 'fk', {
        cardinality: 'N:1',
        description: `Foreign key: ${table} references ${r[1].toLowerCase()}.`,
        confidence: 'medium',
      });
    }
  }

  const joinRe = /\bfrom\s+([a-z_][a-z0-9_]*)[\s\S]{0,200}?\bjoin\s+([a-z_][a-z0-9_]*)\b/gi;
  for (const m of text.matchAll(joinRe)) {
    addEntity(m[1].toLowerCase());
    addEntity(m[2].toLowerCase());
    addRelation(pascal(m[1]), pascal(m[2]), 'join', {
      description: `SQL join between ${m[1].toLowerCase()} and ${m[2].toLowerCase()}.`,
      confidence: 'low',
    });
  }

  return { entities, relations };
}
