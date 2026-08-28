export type Confidence = 'high' | 'medium' | 'low';

export type { EvidenceKind, EvidenceStrength, EvidenceRef } from './evidence.js';
export type { KnowledgeStatus, KnowledgeRecord, KnowledgeStateEvent } from './knowledge-state.js';

export type EntityType =
  | 'business_entity'
  | 'frontend_store'
  | 'composable'
  | 'page'
  | 'component'
  | 'api_client'
  | 'backend_api'
  | 'database_table';

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description: string;
  attributes?: Array<{ name: string; type?: string; required?: boolean; description?: string }>;
  confidence: Confidence;
  evidence: string[];
  tags?: string[];
  /** Lifecycle states discovered for this object; back-link into the manifest state machines. */
  states?: string[];
}

export interface BusinessRule {
  id: string;
  name: string;
  entity: string;
  preconditions?: string[];
  rule: string[];
  exceptions?: string[];
  impact?: string[];
  context?: string[];
  confidence: Confidence;
  evidence: string[];
  coveringTests?: string[];
  status?: 'candidate' | 'confirmed' | 'deprecated';
}

export interface RuleViolation {
  ruleId: string;
  ruleName: string;
  evidence: string;
  reason: string;
  severity: 'confirmed-missing' | 'likely-modified';
}

export type RelationshipKind = 'owns' | 'aggregates' | 'references' | 'calls' | 'renders' | 'maps-to';
export type LegacyRelationshipKind =
  | 'references_or_contains'
  | 'join'
  | 'uses'
  | 'uses_entity'
  | 'uses_store'
  | 'uses_composable'
  | 'calls_api'
  | 'calls_api_route'
  | 'action_calls_api'
  | 'imports_component'
  | 'renders_component'
  | 'contains'
  | 'triggers_action'
  | 'action_updates_store';

const RELATIONSHIP_MIGRATIONS: Record<LegacyRelationshipKind, RelationshipKind> = {
  references_or_contains: 'references',
  join: 'references',
  uses: 'references',
  uses_entity: 'references',
  uses_store: 'references',
  uses_composable: 'calls',
  calls_api: 'calls',
  calls_api_route: 'calls',
  action_calls_api: 'calls',
  imports_component: 'renders',
  renders_component: 'renders',
  contains: 'aggregates',
  triggers_action: 'calls',
  action_updates_store: 'calls',
};

const RELATIONSHIP_KINDS = new Set<RelationshipKind>([
  'owns',
  'aggregates',
  'references',
  'calls',
  'renders',
  'maps-to',
]);

export function normalizeRelationship(value: string): RelationshipKind {
  if (RELATIONSHIP_KINDS.has(value as RelationshipKind)) return value as RelationshipKind;
  return RELATIONSHIP_MIGRATIONS[value as LegacyRelationshipKind] ?? 'references';
}

export function isRelationshipValue(value: string): value is RelationshipKind | LegacyRelationshipKind {
  return RELATIONSHIP_KINDS.has(value as RelationshipKind) || value in RELATIONSHIP_MIGRATIONS;
}

export type RelationSubtype =
  | 'store_usage'
  | 'store_entity_usage'
  | 'composable_usage'
  | 'api_route_call'
  | 'page_action_trigger'
  | 'action_store_update'
  | 'action_api_call';

export type RelationProvenance =
  | 'discovery_text'
  | 'ast_type'
  | 'sql_schema'
  | 'frontend_page'
  | 'frontend_action'
  | 'store_module'
  | 'composable_module'
  | 'api_client_module'
  | 'frontend_linkage'
  | 'backend_code'
  | 'xml_mapping'
  | 'llm_inference';

export interface Relation {
  id: string;
  source: string;
  target: string;
  relationship: RelationshipKind;
  subtype?: RelationSubtype;
  provenance?: RelationProvenance;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M' | 'unknown';
  description?: string;
  confidence: Confidence;
  evidence: string[];
}

export interface FieldRef {
  entity: string;
  field: string;
  via?: string;
}

export interface ApiRoute {
  id: string;
  method: string;
  path: string;
  handler?: string;
  entity?: string;
  fields?: FieldRef[];
  /** backend = real API route; frontend = client-side router path (not linkable to entities). */
  kind?: 'backend' | 'frontend';
  confidence: Confidence;
  evidence: string[];
}

export interface RuleConflict {
  id: string;
  ruleA: string;
  ruleB: string;
  entity: string;
  description: string;
  confidence: Confidence;
  evidence: string[];
  suggestions?: string[];
}

export interface StateTransition {
  from?: string;
  to: string;
  trigger?: string;
  guard?: string;
  effects?: string[];
  evidence: string;
}

export interface StateMachine {
  entity: string;
  states: string[];
  transitions: StateTransition[];
  mermaid: string;
}

export type UserActionTrigger = 'click' | 'submit' | 'route' | 'watch' | 'startup' | 'event';

export interface FrontendPage {
  id: string;
  route?: string;
  component: string;
  permissions: string[];
  stores: string[];
  apiCalls: string[];
  fields?: FieldRef[];
  actions: string[];
  evidence: string[];
}

export interface UserAction {
  id: string;
  name: string;
  source: string;
  trigger: UserActionTrigger;
  preconditions: string[];
  stateReads: string[];
  stateWrites: string[];
  apiCalls: string[];
  stores?: string[];
  fields?: FieldRef[];
  successEffects: string[];
  failureEffects: string[];
  evidence: string[];
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  steps: string[];
  status: 'draft';
}

export interface ModuleDescriptor {
  id: string;
  name: string;
  file: string;
}

export interface FieldIndexEntry {
  entity: string;
  field: string;
  apis: string[];
  stores: string[];
  storeActions?: string[];
  pages: string[];
  tests: string[];
  evidence?: string[];
}

export interface DiscoverManifest {
  generatedAt: string;
  projectRoot: string;
  filesScanned: number;
  entities: Entity[];
  rules: BusinessRule[];
  relations: Relation[];
  apis: ApiRoute[];
  conflicts: RuleConflict[];
  tests?: string[];
  states?: StateMachine[];
  workflows?: WorkflowTemplate[];
  pages?: FrontendPage[];
  actions?: UserAction[];
  modules?: ModuleDescriptor[];
  aliases?: Record<string, string[]>;
  aliasIndex?: Record<string, string>;
  fieldIndex?: Record<string, FieldIndexEntry>;
}
