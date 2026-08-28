import type { Analyzer } from '../analyzer.js';
import type { Entity } from '../types.js';
import { entityId, pascal } from './parse.js';

const STRUCT_RE = /type\s+([A-Za-z_]\w*)\s+struct\s*\{([\s\S]*?)\}/g;
const FIELD_RE = /^\s*([A-Za-z_]\w*)\s+([\w.*[\]]+)(?:\s+`([^`]*)`)?/gm;

function tableName(tag?: string): string | undefined {
  const match = tag?.match(/gorm:["'](?:[^"']*;)?tableName:([^;"']+)/i);
  return match?.[1];
}

export const goAnalyzer: Analyzer = {
  name: 'go',
  analyze(scan) {
    const entities: Entity[] = [];
    for (const sample of scan.samples) {
      if (!/\.go$/i.test(sample.file)) continue;
      for (const match of sample.text.matchAll(STRUCT_RE)) {
        const name = pascal(match[1]);
        const attributes = [...match[2].matchAll(FIELD_RE)]
          .filter((field) => field[1] !== '_')
          .map((field) => ({ name: field[1], type: field[2].replace(/^\*/, '') }));
        if (!attributes.length) continue;
        const table = tableName(attributes.length ? match[2].match(/`([^`]*)`/)?.[1] : undefined);
        entities.push({
          id: entityId(name),
          name,
          type: 'business_entity',
          description: table ? `Go struct ${name} mapped to table ${table}.` : `Go struct ${name}.`,
          confidence: 'medium',
          attributes,
          evidence: [sample.file],
        });
      }
    }
    return { entities };
  },
};
