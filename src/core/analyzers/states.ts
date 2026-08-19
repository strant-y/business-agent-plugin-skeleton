import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { Entity, StateMachine, StateTransition } from '../types.js';
import { fileModuleName } from './linkage.js';

const STATUS_NAMES = /\b(?:status|state)\b\s*(?:===?|!==?|==|in|:)?\s*["']([A-Z][A-Z0-9_-]*)["']/gi;
const ENUM_RE = /enum\s+\w+\s*\{([\s\S]*?)\}/gi;
const TRANSITION_RE =
  /(?:from|status|state)\s*[=:>-]+\s*["']?([A-Z][A-Z0-9_-]*)["']?[\s\S]{0,120}?(?:to|=>|then)\s*["']?([A-Z][A-Z0-9_-]*)["']?/gi;
const TRIGGER_RE =
  /\b(submit|save|approve|reject|create|update|delete|load|fetch|sync|route|watch|handle[A-Z][A-Za-z0-9_$]*)\b/i;
const GUARD_RE = /\bif\s*\(([^)]+)\)/i;
const EFFECT_RE = /\b(?:status|state)(?:\.value)?\s*=\s*["'`]([A-Z][A-Z0-9_-]*)["'`]/g;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function linesAround(text: string, index: number): string {
  const line = lineOf(text, index);
  const all = text.split(/\r?\n/);
  return all
    .slice(Math.max(0, line - 2), Math.min(all.length, line + 1))
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' | ');
}

function inferEntity(sample: { file: string; text: string }, entities: Entity[]): string {
  const moduleName = fileModuleName(sample.file);
  const entityByFile = entities.find((item) => item.name.toLowerCase() === moduleName.toLowerCase())?.name;
  const entityByText = entities.find(
    (item) => item.type === 'business_entity' && new RegExp(`\\b${item.name}\\b`, 'i').test(sample.text),
  )?.name;
  return entityByFile ?? entityByText ?? moduleName;
}

function transitionEffects(snippet: string): string[] {
  return [...snippet.matchAll(EFFECT_RE)].map((match) => `State becomes ${match[1].toUpperCase()}.`);
}

function transitionFromMatch(sample: { file: string; text: string }, match: RegExpMatchArray): StateTransition {
  const index = match.index ?? 0;
  const snippet = linesAround(sample.text, index);
  return {
    from: match[1].toUpperCase(),
    to: match[2].toUpperCase(),
    trigger: snippet.match(TRIGGER_RE)?.[1],
    guard: snippet.match(GUARD_RE)?.[1]?.trim(),
    effects: transitionEffects(snippet),
    evidence: `${sample.file}:${lineOf(sample.text, index)}: ${snippet}`,
  };
}

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
    const entity = inferEntity(sample, entities);
    const machine = byEntity.get(entity) ?? { entity, states: [], transitions: [], mermaid: '' };
    machine.states = [...new Set([...machine.states, ...states])];
    for (const match of sample.text.matchAll(TRANSITION_RE))
      machine.transitions.push(transitionFromMatch(sample, match));
    byEntity.set(entity, machine);
  }
  return [...byEntity.values()].map((machine) => ({ ...machine, mermaid: renderMermaid(machine) }));
}

function renderMermaid(machine: StateMachine): string {
  const lines = ['stateDiagram-v2'];
  for (const state of machine.states) lines.push(`  state "${state}" as ${state.replace(/[^A-Z0-9_]/g, '_')}`);
  for (const transition of machine.transitions) {
    lines.push(
      `  ${(transition.from ?? '[*]').replace(/[^A-Z0-9_*]/g, '_')} --> ${transition.to.replace(/[^A-Z0-9_]/g, '_')}`,
    );
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
