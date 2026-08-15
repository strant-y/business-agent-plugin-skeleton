export type Confidence = 'high' | 'medium' | 'low';

export interface Entity {
  id: string;
  name: string;
  type: 'business_entity';
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
}
