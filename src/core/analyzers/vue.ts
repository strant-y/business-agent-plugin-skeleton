import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { BusinessRule, Entity, Relation } from '../types.js';
import { pascal, entityId } from './parse.js';
import { analyzeTypeScript, loadTs, TS_MISSING_WARNING } from './ast.js';

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const IMPORT_RE = /\bfrom\s*["']([^"']+\.vue)["']/gi;
const PROPS_TS_RE = /defineProps\s*<\{([\s\S]*?)\}>/g;
const PROPS_RUNTIME_RE = /defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const EMITS_TS_RE = /defineEmits\s*<\{([\s\S]*?)\}>/g;
const EMITS_RUNTIME_RE = /defineEmits\s*\(\s*\[\s*([^\]]*)\s*\]\s*\)/g;
const NAME_RE = /(?:defineComponent|export\s+default)\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/i;

function extractScript(text: string): string | undefined {
  for (const m of text.matchAll(SCRIPT_RE)) return m[1];
  return undefined;
}

function extractTemplate(text: string): string | undefined {
  const m = /<template\b[^>]*>([\s\S]*?)<\/template>/i.exec(text);
  return m?.[1];
}

function componentName(text: string, file: string): string {
  const m = NAME_RE.exec(text);
  if (m?.[1]) return pascal(m[1]);
  const base =
    file
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.vue$/i, '') ?? '';
  return pascal(base);
}

function parseProps(text: string): NonNullable<Entity['attributes']> {
  const attrs: NonNullable<Entity['attributes']> = [];
  for (const m of text.matchAll(PROPS_TS_RE)) {
    for (const member of m[1].split(/[;,\n]/)) {
      const pm = member.match(/([a-zA-Z_$][\w$]*)\s*(\?)?\s*:\s*([^;]+)/);
      if (!pm) continue;
      attrs.push({ name: pm[1], type: pm[3].trim(), required: !pm[2] });
    }
  }
  for (const m of text.matchAll(PROPS_RUNTIME_RE)) {
    for (const member of m[1].split(/[;,\n]/)) {
      const pm = member.match(/([a-zA-Z_$][\w$]*)\s*:\s*\{([^}]*)\}/);
      if (!pm) continue;
      const typeMatch = pm[2].match(/\btype\s*:\s*(\w+)/);
      attrs.push({
        name: pm[1],
        type: typeMatch?.[1] ?? undefined,
        required: /\brequired\s*:\s*true/.test(pm[2]),
      });
    }
  }
  for (const m of text.matchAll(EMITS_TS_RE)) {
    for (const member of m[1].split(/[;,\n]/)) {
      const pm = member.match(/([a-zA-Z_$][\w$]*)\s*[?]?\s*:/);
      if (!pm) continue;
      attrs.push({ name: pm[1], type: 'emit', required: false });
    }
  }
  for (const m of text.matchAll(EMITS_RUNTIME_RE)) {
    for (const name of m[1].matchAll(/["']([^"']+)["']/g)) {
      attrs.push({ name: name[1], type: 'emit', required: false });
    }
  }
  const seen = new Set<string>();
  return attrs.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
}

function importRelations(text: string, file: string, selfName: string): Relation[] {
  const rels: Relation[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const base =
      m[1]
        .split('/')
        .pop()
        ?.replace(/\.vue$/i, '') ?? '';
    const target = pascal(base);
    if (!target || target === selfName) continue;
    rels.push({
      id: `relation.${selfName.toLowerCase()}-${target.toLowerCase()}-import`,
      source: selfName,
      target,
      relationship: 'imports_component',
      cardinality: 'unknown',
      description: `${selfName} imports component ${target}.`,
      confidence: 'medium',
      evidence: [file],
    });
  }
  return rels;
}

function templateRules(text: string, file: string, entityName: string): BusinessRule[] {
  const rules: BusinessRule[] = [];
  const template = extractTemplate(text);
  if (!template) return rules;
  // Include a per-file slug so rule ids never collide across components.
  const fileSlug =
    file
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(-16) || 'file';
  let n = 0;

  const ifRe = /v-if\s*=\s*["']([^"']+)["']/g;
  for (const m of template.matchAll(ifRe)) {
    rules.push({
      id: `rule.vue.if-${fileSlug}-${n++}`,
      name: 'Conditional rendering constraint (v-if)',
      entity: entityName,
      rule: [`Element is rendered only when: ${m[1].trim()}.`],
      confidence: 'low',
      evidence: [file],
      status: 'candidate',
    });
  }

  const disabledRe = /(?::disabled|v-bind:disabled)\s*=\s*["']([^"']+)["']/g;
  for (const m of template.matchAll(disabledRe)) {
    rules.push({
      id: `rule.vue.disabled-${fileSlug}-${n++}`,
      name: 'Disabled control constraint (:disabled)',
      entity: entityName,
      rule: [`Control is disabled when: ${m[1].trim()}.`],
      confidence: 'low',
      evidence: [file],
      status: 'candidate',
    });
  }

  return rules;
}

export const vueAnalyzer: Analyzer = {
  name: 'vue',
  async analyze(scan, ctx) {
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const rules: BusinessRule[] = [];
    const knownNames = new Set(ctx.entities.map((e) => e.name));
    if (!(await loadTs())) ctx.warn?.(TS_MISSING_WARNING);

    for (const sample of scan.samples) {
      if (!/\.vue$/i.test(sample.file)) continue;
      const selfName = componentName(sample.text, sample.file);

      const script = extractScript(sample.text);
      if (script) {
        const r = await analyzeTypeScript(script, sample.file, knownNames);
        entities.push(...r.entities);
        relations.push(...r.relations);
      }
      relations.push(...importRelations(sample.text, sample.file, selfName));

      const props = parseProps(sample.text);
      if (props.length) {
        let comp = entities.find((e) => e.name === selfName);
        if (!comp) {
          comp = {
            id: entityId(selfName),
            name: selfName,
            type: 'business_entity',
            description: `Vue component discovered in ${sample.file}.`,
            confidence: 'medium',
            attributes: [],
            evidence: [sample.file],
          };
          entities.push(comp);
        }
        comp.attributes = uniqAttributes([...(comp.attributes ?? []), ...props]);
        knownNames.add(selfName);
      }
      rules.push(...templateRules(sample.text, sample.file, selfName));
    }

    const result: AnalyzeResult = {};
    if (entities.length) result.entities = entities;
    if (relations.length) result.relations = relations;
    if (rules.length) result.rules = rules;
    return result;
  },
};

function uniqAttributes(attrs: NonNullable<Entity['attributes']>): NonNullable<Entity['attributes']> {
  const seen = new Set<string>();
  return attrs.filter((a) => {
    if (seen.has(a.name)) return false;
    seen.add(a.name);
    return true;
  });
}
