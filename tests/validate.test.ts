import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateEntity,
  validateRule,
  validateRelation,
  validateAgainstSchema,
  validateKnowledgeDir,
} from '../src/core/validate.js';
import type { Entity, BusinessRule, Relation } from '../src/core/types.js';

describe('validateAgainstSchema', () => {
  it('reports missing required properties', () => {
    const schema = { type: 'object', required: ['id', 'name'] };
    const problems = validateAgainstSchema({ id: 'x' }, schema, 'item');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('name');
    expect(problems.join('\n')).toContain('item');
  });

  it('enforces enum and const constraints', () => {
    const schema = { type: 'object', properties: { status: { enum: ['a', 'b'] } } };
    expect(validateAgainstSchema({ status: 'c' }, schema, 'item').length).toBeGreaterThan(0);
    expect(validateAgainstSchema({ status: 'a' }, schema, 'item')).toEqual([]);
  });

  it('validates arrays of items', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    const problems = validateAgainstSchema(['ok', 5], schema, 'list');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('list');
  });

  it('enforces minLength constraints', () => {
    const schema = { type: 'object', properties: { name: { type: 'string', minLength: 1 } } };
    expect(validateAgainstSchema({ name: '' }, schema, 'item').length).toBeGreaterThan(0);
    expect(validateAgainstSchema({ name: 'x' }, schema, 'item')).toEqual([]);
  });
});

describe('schema validators', () => {
  it('accepts a valid entity', async () => {
    const entity: Entity = {
      id: 'entity.product',
      name: 'Product',
      type: 'business_entity',
      description: 'A product',
      confidence: 'medium',
      evidence: ['src/Product.ts'],
    };
    expect((await validateEntity(entity)).valid).toBe(true);
  });

  it('rejects an entity with a bad id and bad confidence', async () => {
    const entity = {
      id: 'PRODUCT',
      name: 'Product',
      type: 'business_entity',
      description: 'A product',
      confidence: 'certain',
      evidence: [],
    };
    const result = await validateEntity(entity);
    expect(result.valid).toBe(false);
    expect(result.problems.join('\n')).toContain('id');
    expect(result.problems.join('\n')).toContain('confidence');
  });

  it('rejects an entity with an empty name (minLength)', async () => {
    const entity = {
      id: 'entity.x',
      name: '',
      type: 'business_entity',
      description: '',
      confidence: 'low',
      evidence: [],
    };
    const result = await validateEntity(entity);
    expect(result.valid).toBe(false);
    expect(result.problems.join('\n')).toContain('name');
  });

  it('accepts a valid rule', async () => {
    const rule: BusinessRule = {
      id: 'rule.discovery.validation-state',
      name: 'State-dependent validation',
      entity: 'Product',
      rule: ['check status'],
      confidence: 'low',
      evidence: ['src/Product.ts'],
      status: 'candidate',
    };
    expect((await validateRule(rule)).valid).toBe(true);
  });

  it('accepts a valid relation', async () => {
    const relation: Relation = {
      id: 'relation.product-order',
      source: 'Product',
      target: 'Order',
      relationship: 'references_or_contains',
      cardinality: '1:N',
      confidence: 'low',
      evidence: [],
    };
    expect((await validateRelation(relation)).valid).toBe(true);
  });
});

describe('validateKnowledgeDir', () => {
  it('checks confirmed rules and relationships under .agent/business/', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-know-'));
    const rulesDir = path.join(dir, '.agent/business/rules');
    const relsDir = path.join(dir, '.agent/business/relationships');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.mkdir(relsDir, { recursive: true });

    await fs.writeFile(
      path.join(rulesDir, 'good.json'),
      JSON.stringify({
        id: 'rule.good',
        name: 'Good',
        entity: 'Plan',
        rule: ['x'],
        confidence: 'low',
        evidence: [],
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(rulesDir, 'bad.json'),
      JSON.stringify({
        id: 'rule.bad',
        name: 'Bad',
        entity: 'Plan',
        rule: ['x'],
        confidence: 'certain',
        evidence: [],
      }),
      'utf8',
    );
    await fs.writeFile(path.join(relsDir, 'broken.json'), '{ not json', 'utf8');

    const problems = await validateKnowledgeDir(path.join(dir, '.agent'));
    expect(problems.length).toBe(2);
    const bad = problems.find((p) => p.file.endsWith('bad.json'));
    expect(bad?.problems.join('\n')).toContain('confidence');
    const broken = problems.find((p) => p.file.endsWith('broken.json'));
    expect(broken?.problems).toEqual(['not valid JSON']);
  });

  it('reports no problems for an empty or missing business dir', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-know-empty-'));
    expect(await validateKnowledgeDir(path.join(dir, '.agent'))).toEqual([]);
  });
});
