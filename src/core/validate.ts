import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { exists, readText } from '../utils/fs.js';
import type { DiscoverManifest } from './types.js';

const ajv = new Ajv2020({ allErrors: true });

interface Schema {
  $id?: string;
  [key: string]: unknown;
}

async function loadSchema(name: string): Promise<Schema> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '../../schemas', `${name}.schema.json`);
  return JSON.parse(await readText(file)) as Schema;
}

const validatorCache = new Map<string, ValidateFunction>();

async function loadValidator(name: string): Promise<ValidateFunction> {
  const cached = validatorCache.get(name);
  if (cached) return cached;
  const validator = ajv.compile(await loadSchema(name));
  validatorCache.set(name, validator);
  return validator;
}

function formatProblems(validator: ValidateFunction, value: unknown, basePath: string): string[] {
  if (validator(value)) return [];
  return (validator.errors ?? []).map((e) => `${basePath}${e.instancePath ?? ''} ${e.message ?? 'invalid'}`.trim());
}

/** Validate an arbitrary value against an inline JSON Schema (draft 2020-12). */
export function validateAgainstSchema(value: unknown, schema: Schema, basePath: string): string[] {
  return formatProblems(ajv.compile(schema as object), value, basePath);
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

async function validateWith(name: string, value: unknown): Promise<ValidationResult> {
  const problems = formatProblems(await loadValidator(name), value, name);
  return { valid: problems.length === 0, problems };
}

export async function validateEntity(value: unknown): Promise<ValidationResult> {
  return validateWith('entity', value);
}

export async function validateRule(value: unknown): Promise<ValidationResult> {
  return validateWith('rule', value);
}

export async function validateRelation(value: unknown): Promise<ValidationResult> {
  return validateWith('relation', value);
}

export async function validateApi(value: unknown): Promise<ValidationResult> {
  return validateWith('api', value);
}

export async function validateConflict(value: unknown): Promise<ValidationResult> {
  return validateWith('conflict', value);
}

export async function validateManifest(manifest: DiscoverManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const entity of manifest.entities) {
    problems.push(...(await validateEntity(entity)).problems);
  }
  for (const rule of manifest.rules) {
    problems.push(...(await validateRule(rule)).problems);
  }
  for (const relation of manifest.relations) {
    problems.push(...(await validateRelation(relation)).problems);
  }
  for (const api of manifest.apis ?? []) {
    problems.push(...(await validateApi(api)).problems);
  }
  for (const conflict of manifest.conflicts ?? []) {
    problems.push(...(await validateConflict(conflict)).problems);
  }
  return problems;
}

export interface KnowledgeProblem {
  file: string;
  kind: 'rule' | 'relation';
  problems: string[];
}

/** Validate the confirmed knowledge files under .agent/business/ against the schemas. */
export async function validateKnowledgeDir(agentRoot: string): Promise<KnowledgeProblem[]> {
  const out: KnowledgeProblem[] = [];
  const sections = [
    { kind: 'rule' as const, dir: 'business/rules', validate: validateRule },
    { kind: 'relation' as const, dir: 'business/relationships', validate: validateRelation },
  ];
  for (const section of sections) {
    const full = path.join(agentRoot, section.dir);
    if (!(await exists(full))) continue;
    const entries = await fs.readdir(full, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(full, entry.name);
      try {
        const value = JSON.parse(await readText(file)) as unknown;
        const result = await section.validate(value);
        if (!result.valid) out.push({ file, kind: section.kind, problems: result.problems });
      } catch {
        out.push({ file, kind: section.kind, problems: ['not valid JSON'] });
      }
    }
  }
  return out;
}
