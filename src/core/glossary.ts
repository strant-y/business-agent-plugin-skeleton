import path from 'node:path';
import { exists, readText } from '../utils/fs.js';

import type { Entity } from './types.js';

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  entity: string;
}

export interface AliasArtifacts {
  aliasesByEntity: Record<string, string[]>;
  aliasToEntity: Record<string, string>;
}

function normalizeCell(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ',')
    .replace(/[，、/]/g, ',')
    .trim();
}

function splitAliases(value: string): string[] {
  return normalizeCell(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeName(value: string): string {
  return value.trim();
}

export async function loadGlossary(root: string): Promise<GlossaryEntry[]> {
  const file = path.join(root, '.agent', 'business', 'glossary.md');
  if (!(await exists(file))) return [];
  const text = await readText(file);
  const entries: GlossaryEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[0]) || /术语|term|entity/i.test(cells[0])) continue;
    const term = normalizeName(cells[0]);
    const entity = normalizeName(cells[2]);
    if (!term || !entity) continue;
    const aliases = [...new Set(splitAliases(cells[1]).filter((alias) => alias && alias !== entity && alias !== term))];
    entries.push({ term, aliases, entity });
  }
  return entries;
}

function singularize(value: string): string[] {
  const lower = value.toLowerCase();
  const forms = new Set<string>([lower]);
  forms.add(`${lower}s`);
  if (lower.endsWith('y')) forms.add(`${lower.slice(0, -1)}ies`);
  if (lower.endsWith('s')) forms.add(lower.slice(0, -1));
  if (lower.endsWith('ies')) forms.add(`${lower.slice(0, -3)}y`);
  return [...forms];
}

function stripEntitySuffix(value: string): string[] {
  const trimmed = value.trim();
  const forms = new Set<string>([trimmed]);
  const stripped = trimmed.replace(/(dto|vo|bo|po)$/i, '');
  if (stripped && stripped !== trimmed) forms.add(stripped);
  return [...forms];
}

function singularPascal(value: string): string {
  return value.endsWith('s') ? value.slice(0, -1) : value;
}

function isSqlDerivedEntity(entity: Entity): boolean {
  return entity.description.startsWith('Discovered from SQL table ');
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function buildAliasVariants(value: string): string[] {
  const variants = new Set<string>();
  for (const suffixless of stripEntitySuffix(value)) {
    variants.add(suffixless);
    variants.add(toSnakeCase(suffixless));
    for (const plural of singularize(suffixless)) variants.add(plural);
    for (const plural of singularize(toSnakeCase(suffixless))) variants.add(plural);
  }
  return [...variants].filter(Boolean);
}

export function normalizeTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, '');
}

export function buildAliasArtifacts(entities: Entity[], entries: GlossaryEntry[]): AliasArtifacts {
  const buckets = new Map<string, Set<string>>();
  const aliasToEntity = new Map<string, string>();

  const ensure = (canonical: string): Set<string> => {
    const existing = buckets.get(canonical);
    if (existing) return existing;
    const created = new Set<string>();
    buckets.set(canonical, created);
    return created;
  };

  const registerAlias = (canonical: string, alias: string): void => {
    const normalized = normalizeTerm(alias);
    if (!normalized || normalized === normalizeTerm(canonical)) return;
    ensure(canonical).add(alias);
    aliasToEntity.set(normalized, canonical);
  };

  const directNames = new Set(entities.map((entity) => normalizeTerm(entity.name)));
  const singularEntityNames = new Set(entities.map((entity) => normalizeTerm(singularPascal(entity.name))));

  for (const entity of entities) {
    aliasToEntity.set(normalizeTerm(entity.name), entity.name);
    const bucket = ensure(entity.name);
    for (const variant of buildAliasVariants(entity.name)) {
      const normalizedVariant = normalizeTerm(variant);
      if (directNames.has(normalizedVariant) && normalizedVariant !== normalizeTerm(entity.name)) continue;
      if (isSqlDerivedEntity(entity) && singularEntityNames.has(normalizedVariant) && normalizedVariant !== normalizeTerm(entity.name)) {
        continue;
      }
      registerAlias(entity.name, variant);
    }
    for (const tag of entity.tags ?? []) {
      bucket.add(tag);
      registerAlias(entity.name, tag);
      for (const variant of buildAliasVariants(tag)) {
        const normalizedVariant = normalizeTerm(variant);
        if (directNames.has(normalizedVariant) && normalizedVariant !== normalizeTerm(entity.name)) continue;
        if (isSqlDerivedEntity(entity) && singularEntityNames.has(normalizedVariant) && normalizedVariant !== normalizeTerm(entity.name)) {
          continue;
        }
        registerAlias(entity.name, variant);
      }
    }
  }

  for (const entry of entries) {
    aliasToEntity.set(normalizeTerm(entry.entity), entry.entity);
    registerAlias(entry.entity, entry.term);
    for (const variant of buildAliasVariants(entry.term)) registerAlias(entry.entity, variant);
    for (const alias of entry.aliases) {
      registerAlias(entry.entity, alias);
      for (const variant of buildAliasVariants(alias)) registerAlias(entry.entity, variant);
    }
  }

  const aliasesByEntity: Record<string, string[]> = {};
  for (const [canonical, items] of buckets) {
    aliasesByEntity[canonical] = [...new Set([...items].filter((item) => normalizeTerm(item) !== normalizeTerm(canonical)))];
  }

  return {
    aliasesByEntity,
    aliasToEntity: Object.fromEntries(aliasToEntity),
  };
}

export function buildAliasMap(entities: Entity[], entries: GlossaryEntry[]): Record<string, string[]> {
  return buildAliasArtifacts(entities, entries).aliasesByEntity;
}

export function resolveCanonicalName(value: string, aliases: Record<string, string[]>): string {
  const target = normalizeTerm(value);
  for (const [canonical, items] of Object.entries(aliases)) {
    if ([canonical, ...items].some((item) => normalizeTerm(item) === target)) return canonical;
  }
  return value;
}

export function resolveCanonicalNameFromIndex(value: string, aliasToEntity: Record<string, string>): string {
  return aliasToEntity[normalizeTerm(value)] ?? value;
}

export function invertAliasMap(aliasesByEntity: Record<string, string[]>): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [entity, aliases] of Object.entries(aliasesByEntity)) {
    index[normalizeTerm(entity)] = entity;
    for (const alias of aliases) {
      index[normalizeTerm(alias)] = entity;
    }
  }
  return index;
}

export function getEntityAliases(entity: string, aliasesByEntity: Record<string, string[]>): string[] {
  return aliasesByEntity[entity] ?? [];
}
