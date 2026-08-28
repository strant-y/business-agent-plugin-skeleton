import { describe, expect, it } from 'vitest';
import { isSkeletonDescription, isSqlTableDescription, skeletonDescription } from '../src/core/entity-description.js';

describe('skeletonDescription', () => {
  it('carries the evidence that produced the candidate', () => {
    const description = skeletonDescription('Order', ['src/models/Order.ts', 'src/api/order.ts']);
    expect(description).toContain('Order');
    expect(description).toContain('src/models/Order.ts');
    expect(description).toContain('src/api/order.ts');
  });

  it('says so when only a name matched', () => {
    const description = skeletonDescription('Order', []);
    expect(description).toContain('no file-level evidence');
  });

  it('caps the evidence list so descriptions stay short', () => {
    const description = skeletonDescription('Order', ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    expect(description).toContain('a.ts');
    expect(description).toContain('c.ts');
    expect(description).not.toContain('d.ts');
  });
});

describe('isSkeletonDescription', () => {
  it('recognises generated descriptions', () => {
    expect(isSkeletonDescription(skeletonDescription('Order', ['src/Order.ts']))).toBe(true);
  });

  it('still recognises descriptions written before evidence was included', () => {
    expect(isSkeletonDescription('Discovered business candidate: Order')).toBe(true);
  });

  it('keeps human or LLM authored descriptions', () => {
    expect(isSkeletonDescription('缴费单据，审核中不可修改')).toBe(false);
    expect(isSkeletonDescription('Discovered from SQL table orders.')).toBe(false);
    expect(isSkeletonDescription(undefined)).toBe(false);
  });
});

describe('isSqlTableDescription', () => {
  it('detects SQL-derived entities', () => {
    expect(isSqlTableDescription('Discovered from SQL table orders.')).toBe(true);
    expect(isSqlTableDescription(skeletonDescription('Order', ['a.ts']))).toBe(false);
    expect(isSqlTableDescription(undefined)).toBe(false);
  });
});
