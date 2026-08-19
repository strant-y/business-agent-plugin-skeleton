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
  status?: 'candidate' | 'confirmed' | 'deprecated';
}

export interface Relation {
  id: string;
  source: string;
  target: string;
  relationship: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M' | 'unknown';
  description?: string;
  confidence: Confidence;
  evidence: string[];
}

export interface ApiRoute {
  id: string;
  method: string;
  path: string;
  handler?: string;
  entity?: string;
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
}
