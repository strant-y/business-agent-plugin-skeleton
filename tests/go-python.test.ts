import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { goAnalyzer } from '../src/core/analyzers/go.js';
import { pythonAnalyzer } from '../src/core/analyzers/python.js';
import { discover } from '../src/core/discovery.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('Go and Python analyzers', () => {
  it('extracts Go structs and fields', () => {
    const result = goAnalyzer.analyze(
      {
        files: ['internal/order.go'],
        samples: [
          {
            file: 'internal/order.go',
            text: 'type Order struct {\n ID uint `gorm:"primaryKey"`\n Status string\n Total int64\n}',
          },
        ],
        sampleText: '',
        fileText: {},
      },
      { config: DEFAULT_CONFIG, entities: [], rules: [], relations: [] },
    );
    expect(result.entities?.[0]).toMatchObject({
      name: 'Order',
      type: 'business_entity',
      attributes: expect.arrayContaining([
        { name: 'ID', type: 'uint' },
        { name: 'Status', type: 'string' },
      ]),
    });
  });

  it('extracts dataclass and pydantic fields', () => {
    const result = pythonAnalyzer.analyze(
      {
        files: ['models/order.py'],
        samples: [
          {
            file: 'models/order.py',
            text: '@dataclass\nclass Order:\n    status: str\n    total: int\n\nclass Customer(BaseModel):\n    name: str\n',
          },
        ],
        sampleText: '',
        fileText: {},
      },
      { config: DEFAULT_CONFIG, entities: [], rules: [], relations: [] },
    );
    expect(result.entities?.map((entity) => entity.name)).toEqual(['Order', 'Customer']);
    expect(result.entities?.find((entity) => entity.name === 'Customer')?.attributes).toEqual([
      { name: 'name', type: 'str' },
    ]);
  });

  it('discovers Go and Python entities when explicitly enabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-languages-'));
    await fs.writeFile(path.join(dir, 'order.go'), 'type Order struct {\n ID uint\n Status string\n}\n', 'utf8');
    await fs.writeFile(path.join(dir, 'customer.py'), '@dataclass\nclass Customer:\n    name: str\n', 'utf8');
    const manifest = await discover(dir, {
      dryRun: true,
      config: { ...DEFAULT_CONFIG, analyzers: ['go', 'python'], allowedExt: ['.go', '.py'] },
    });
    expect(manifest.entities.map((entity) => entity.name)).toEqual(expect.arrayContaining(['Order', 'Customer']));
  });

  it('keeps Go and Python disabled by default', () => {
    expect(DEFAULT_CONFIG.allowedExt).not.toEqual(expect.arrayContaining(['.go', '.py']));
    expect(DEFAULT_CONFIG.analyzers).not.toEqual(expect.arrayContaining(['go', 'python']));
  });
});
