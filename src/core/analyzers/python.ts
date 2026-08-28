import type { Analyzer } from '../analyzer.js';
import type { Entity } from '../types.js';
import { entityId, pascal } from './parse.js';

const FIELD_RE = /^\s{4}([A-Za-z_]\w*)\s*:\s*([^=\n]+?)(?:\s*=.*)?$/gm;

export const pythonAnalyzer: Analyzer = {
  name: 'python',
  analyze(scan) {
    const entities: Entity[] = [];
    for (const sample of scan.samples) {
      if (!/\.py$/i.test(sample.file)) continue;
      const classMatches = [...sample.text.matchAll(/^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/gm)];
      for (const [index, match] of classMatches.entries()) {
        const bases = match[2] ?? '';
        const bodyStart = (match.index ?? 0) + match[0].length;
        const bodyEnd = classMatches[index + 1]?.index ?? sample.text.length;
        const body = sample.text.slice(bodyStart, bodyEnd);
        if (!/@dataclass/.test(sample.text.slice(Math.max(0, match.index! - 120), match.index!)) && !/BaseModel/.test(bases)) continue;
        const name = pascal(match[1]);
        const attributes = [...body.matchAll(FIELD_RE)].map((field) => ({
          name: field[1],
          type: field[2].trim(),
        }));
        if (!attributes.length) continue;
        entities.push({
          id: entityId(name),
          name,
          type: 'business_entity',
          description: `Python model ${name}.`,
          confidence: 'medium',
          attributes,
          evidence: [sample.file],
        });
      }
    }
    return { entities };
  },
};
