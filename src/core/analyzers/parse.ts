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

function tableName(value: string): string | undefined {
  const normalized = value
    .replace(/["`[\]]/g, '')
    .split('.')
    .pop()
    ?.trim()
    .toLowerCase();
  if (!normalized || !/^[a-z_][a-z0-9_$]*$/i.test(normalized)) return undefined;
  if (/^(select|where|on|and|or|group|order|limit|union|values|set|with)$/i.test(normalized)) return undefined;
  return normalized;
}

function addTableNames(text: string, names: Set<string>): void {
  const tableRe = /\b(?:from|join|update|into|using)\s+([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)/gi;
  for (const match of text.matchAll(tableRe)) {
    const table = tableName(match[1]);
    if (table) names.add(table);
  }
}

function addJoinRelations(
  text: string,
  addRelation: (source: string, target: string, kind: string, opts?: Partial<Relation>) => void,
  addEntity: (table: string) => string,
): void {
  const fromRe = /\bfrom\s+([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)([\s\S]*?)(?=;|\bunion\b|$)/gi;
  for (const match of text.matchAll(fromRe)) {
    const source = tableName(match[1]);
    if (!source) continue;
    const body = match[2];
    for (const join of body.matchAll(/\bjoin\s+([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)/gi)) {
      const target = tableName(join[1]);
      if (!target) continue;
      addRelation(addEntity(source), addEntity(target), 'join', {
        description: `SQL join between ${source} and ${target}.`,
        confidence: 'low',
      });
    }
  }
}

export function parseSqlRelations(text: string, file: string, evidenceFiles: string[] = []): SqlParseResult {
  const entities: Entity[] = [];
  const relations: Relation[] = [];
  const knownTables = new Set<string>();
  const relationKeys = new Set<string>();

  const addEntity = (table: string): string => {
    const name = pascal(table);
    if (!knownTables.has(table)) {
      knownTables.add(table);
      const re = new RegExp(`\\b${escapeRegExp(table)}\\b`, 'i');
      entities.push({
        id: entityId(name),
        name,
        type: 'business_entity',
        description: `Discovered from SQL table ${table}.`,
        confidence: 'medium',
        evidence: evidenceFiles.filter((f) => re.test(f)).slice(0, 8).length
          ? evidenceFiles.filter((f) => re.test(f)).slice(0, 8)
          : [file],
      });
    }
    return name;
  };

  const addRelation = (source: string, target: string, kind: string, opts: Partial<Relation> = {}): void => {
    if (source === target) return;
    const key = `${source}|${target}|${kind}|${opts.relationship ?? 'references'}`;
    if (relationKeys.has(key)) return;
    relationKeys.add(key);
    relations.push({
      id: relationId(source, target, kind),
      source,
      target,
      relationship: 'references',
      cardinality: 'unknown',
      confidence: 'low',
      evidence: [file],
      ...opts,
    });
  };

  const names = new Set<string>();
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_$]*)/gi;
  for (const match of text.matchAll(createRe)) {
    const table = tableName(match[1]);
    if (table) names.add(table);
  }
  addTableNames(text, names);
  for (const table of names) addEntity(table);

  const createBodies = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_$]*)\s*\(([\s\S]*?)\)/gi;
  for (const match of text.matchAll(createBodies)) {
    const source = tableName(match[1]);
    if (!source) continue;
    for (const reference of match[2].matchAll(/\breferences\s+([a-z_][a-z0-9_$]*)/gi)) {
      const target = tableName(reference[1]);
      if (target)
        addRelation(addEntity(source), addEntity(target), 'fk', {
          cardinality: 'N:1',
          description: `Foreign key: ${source} references ${target}.`,
          confidence: 'medium',
        });
    }
  }

  addJoinRelations(text, addRelation, addEntity);
  const subqueryRe = /\b(?:in|exists)\s*\(([\s\S]*?)\)/gi;
  for (const match of text.matchAll(subqueryRe)) addTableNames(match[1], names);
  for (const table of names) addEntity(table);

  return { entities, relations };
}
