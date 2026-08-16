import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/sample');

describe('scanProject', () => {
  it('scans allowed extensions and ignores node_modules', async () => {
    const scan = await scanProject(FIXTURE);
    const rel = scan.files.map((f) => f.replaceAll('\\', '/')).sort();
    expect(rel).toEqual(['db/schema.sql', 'src/Order.ts', 'src/Product.ts']);
    expect(scan.files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('collects samples with file attribution', async () => {
    const scan = await scanProject(FIXTURE);
    const product = scan.samples.find((s) => s.file.endsWith('Product.ts'));
    expect(product).toBeDefined();
    expect(product?.text).toContain('interface Product');
  });

  it('respects maxFileBytes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-scan-big-'));
    await fs.writeFile(path.join(dir, 'big.ts'), 'x'.repeat(1000), 'utf8');
    const config = { ...DEFAULT_CONFIG, maxFileBytes: 100 };
    const scan = await scanProject(dir, config);
    expect(scan.files).toEqual([]);
    expect(scan.samples).toEqual([]);
  });

  it('skips binary files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-scan-bin-'));
    await fs.writeFile(path.join(dir, 'bin.ts'), Buffer.from([0, 1, 2, 3, 4]));
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    expect(scan.files).toEqual([]);
    expect(scan.samples).toEqual([]);
  });

  it('truncates sample text to maxSampleChars', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-scan-trunc-'));
    await fs.writeFile(path.join(dir, 'a.ts'), 'y'.repeat(500), 'utf8');
    const config = { ...DEFAULT_CONFIG, maxSampleChars: 100 };
    const scan = await scanProject(dir, config);
    expect(scan.samples[0].text.length).toBe(100);
  });

  it('caps samples per file extension instead of a single global pool', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-scan-perext-'));
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(dir, `a${i}.ts`), 'x', 'utf8');
      await fs.writeFile(path.join(dir, `b${i}.vue`), 'y', 'utf8');
    }
    const config = { ...DEFAULT_CONFIG, maxSamplesPerExt: 2 };
    const scan = await scanProject(dir, config);
    expect(scan.samples.filter((s) => s.file.endsWith('.ts')).length).toBe(2);
    expect(scan.samples.filter((s) => s.file.endsWith('.vue')).length).toBe(2);
  });

  it('continues when a nested directory disappears during traversal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-scan-missing-'));
    const nested = path.join(dir, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(dir, 'ok.ts'), 'content', 'utf8');
    await fs.rm(nested, { recursive: true });
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    expect(scan.files).toEqual(['ok.ts']);
  });

  it('produces deterministic file and sample order across repeated scans', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-scan-determ-'));
    for (const name of ['z.ts', 'a.ts', 'm.ts', 'c.vue', 'b.vue', 'k.sql']) {
      await fs.writeFile(path.join(dir, name), `content of ${name}`, 'utf8');
    }
    const first = await scanProject(dir, DEFAULT_CONFIG);
    const second = await scanProject(dir, DEFAULT_CONFIG);
    expect(first.files).toEqual(second.files);
    expect(first.samples.map((s) => s.file)).toEqual(second.samples.map((s) => s.file));
    expect(first.sampleText).toEqual(second.sampleText);
  });
});
