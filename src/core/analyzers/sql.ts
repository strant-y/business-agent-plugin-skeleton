import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { BusinessRule, Entity, Relation } from '../types.js';
import { parseSqlRelations } from './parse.js';

export const sqlAnalyzer: Analyzer = {
  name: 'sql',
  analyze(scan) {
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const rules: BusinessRule[] = [];

    for (const file of scan.files) {
      if (!/\.sql$/i.test(file)) continue;
      const text = scan.fileText[file];
      if (!text) continue;
      const parsed = parseSqlRelations(text, file, scan.files);
      entities.push(...parsed.entities);
      relations.push(...parsed.relations);
      rules.push(...parsed.rules);
    }

    const result: AnalyzeResult = {};
    if (entities.length) result.entities = entities;
    if (relations.length) result.relations = relations;
    if (rules.length) result.rules = rules;
    return result;
  },
};
