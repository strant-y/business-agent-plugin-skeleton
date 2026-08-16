import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { Entity, StateMachine } from '../types.js';

const STATUS_NAMES = /\b(?:status|state)\b\s*(?:===?|!==?|==|in|:)?\s*["']([A-Z][A-Z0-9_-]*)["']/gi;
const ENUM_RE = /enum\s+\w+\s*\{([\s\S]*?)\}/gi;
const TRANSITION_RE =
  /(?:from|status|state)\s*[=:>-]+\s*["']?([A-Z][A-Z0-9_-]*)["']?[\s\S]{0,120}?(?:to|=>|then)\s*["']?([A-Z][A-Z0-9_-]*)["']?/gi;

export function extractStateMachines(
  samples: Array<{ file: string; text: string }>,
  entities: Entity[],
): StateMachine[] {
  const byEntity = new Map<string, StateMachine>();
  for (const sample of samples) {
    const states = new Set<string>();
    for (const match of sample.text.matchAll(STATUS_NAMES)) states.add(match[1].toUpperCase());
    for (const match of sample.text.matchAll(ENUM_RE)) {
      for (const value of match[1].matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) states.add(value[1].toUpperCase());
    }
    if (states.size < 2) continue;
    const entity = entities.find((item) => new RegExp(item.name, 'i').test(sample.text))?.name ?? 'Unknown';
    const machine = byEntity.get(entity) ?? { entity, states: [], transitions: [], mermaid: '' };
    machine.states = [...new Set([...machine.states, ...states])];
    for (const match of sample.text.matchAll(TRANSITION_RE)) {
      machine.transitions.push({
        from: match[1].toUpperCase(),
        to: match[2].toUpperCase(),
        evidence: `${sample.file}:${lineOf(sample.text, match.index ?? 0)}`,
      });
    }
    byEntity.set(entity, machine);
  }
  return [...byEntity.values()].map((machine) => ({ ...machine, mermaid: renderMermaid(machine) }));
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function renderMermaid(machine: StateMachine): string {
  const lines = ['stateDiagram-v2'];
  for (const state of machine.states) lines.push(`  state "${state}" as ${state.replace(/[^A-Z0-9_]/g, '_')}`);
  for (const transition of machine.transitions) {
    lines.push(`  ${transition.from.replace(/[^A-Z0-9_]/g, '_')} --> ${transition.to.replace(/[^A-Z0-9_]/g, '_')}`);
  }
  return lines.join('\n');
}

export const statesAnalyzer: Analyzer = {
  name: 'states',
  analyze(scan, ctx): AnalyzeResult {
    const machines = extractStateMachines(scan.samples, ctx.entities);
    const entities: Entity[] = machines.map((machine) => ({
      id: `entity.state-${machine.entity.toLowerCase()}`,
      name: `${machine.entity}State`,
      type: 'business_entity',
      description: `State machine for ${machine.entity}: ${machine.states.join(', ')}.`,
      confidence: 'low',
      evidence: machine.transitions.map((transition) => transition.evidence),
    }));
    return machines.length ? { entities, states: machines } : {};
  },
};
