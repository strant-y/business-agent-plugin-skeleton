import type { Analyzer } from '../analyzer.js';
import type { ApiRoute, Entity, FieldRef } from '../types.js';
import { skeletonDescription } from '../entity-description.js';

interface OpenApiSchema {
  type?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  $ref?: string;
  required?: string[];
}

interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
}

function readOpenApiDocuments(
  scan: Parameters<Analyzer['analyze']>[0],
  warn?: (message: string) => void,
): Array<{ file: string; doc: OpenApiDocument }> {
  const docs: Array<{ file: string; doc: OpenApiDocument }> = [];
  for (const sample of scan.samples) {
    if (
      !/openapi[^/\\]*\.(?:json|ya?ml)$/i.test(sample.file) &&
      !/(?:^|[/\\])swagger[^/\\]*\.(?:json|ya?ml)$/i.test(sample.file)
    )
      continue;
    try {
      const raw = scan.fileText[sample.file] ?? sample.text;
      const doc = JSON.parse(raw) as OpenApiDocument;
      if (!doc.paths && !doc.components?.schemas) continue;
      docs.push({ file: sample.file, doc });
    } catch {
      if (/\.(?:ya?ml)$/i.test(sample.file)) {
        warn?.(`OpenAPI YAML contract skipped because YAML parsing is unavailable: ${sample.file}`);
      } else {
        warn?.(`OpenAPI contract could not be parsed: ${sample.file}`);
      }
    }
  }
  return docs;
}

function derefSchema(
  schema: OpenApiSchema | undefined,
  schemas: Record<string, OpenApiSchema>,
): OpenApiSchema | undefined {
  if (!schema) return undefined;
  if (!schema.$ref) return schema;
  const match = schema.$ref.match(/^#\/components\/schemas\/([^/]+)$/);
  if (!match) return undefined;
  return schemas[match[1]];
}

function schemaFieldRefs(
  entity: string,
  schema: OpenApiSchema | undefined,
  schemas: Record<string, OpenApiSchema>,
): FieldRef[] {
  const resolved = derefSchema(schema, schemas);
  if (!resolved) return [];
  if (resolved.type === 'array') return schemaFieldRefs(entity, resolved.items, schemas);
  return Object.entries(resolved.properties ?? {}).map(([field]) => ({ entity, field, via: 'openapi' }));
}

function schemaToEntity(name: string): Entity {
  return {
    id: `entity.${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    name,
    type: 'business_entity',
    description: skeletonDescription(name),
    confidence: 'low',
    evidence: [],
  };
}

function collectSchemaEntities(file: string, schemas: Record<string, OpenApiSchema>): Entity[] {
  return Object.entries(schemas).map(([name, schema]) => ({
    ...schemaToEntity(name),
    attributes: Object.entries(derefSchema(schema, schemas)?.properties ?? {}).map(([field, value]) => ({
      name: field,
      type: derefSchema(value, schemas)?.type,
      required: (schema.required ?? []).includes(field),
    })),
    evidence: [file],
  }));
}

function extractEntityFromSchema(
  schema: OpenApiSchema | undefined,
  schemas: Record<string, OpenApiSchema>,
): string | undefined {
  const resolved = derefSchema(schema, schemas);
  if (!resolved) return undefined;
  const ref = schema?.$ref?.match(/^#\/components\/schemas\/([^/]+)$/)?.[1];
  if (ref) return ref;
  if (resolved.type === 'array') return extractEntityFromSchema(resolved.items, schemas);
  return undefined;
}

function responseSchema(operation: Record<string, unknown>): OpenApiSchema | undefined {
  const responses = operation.responses as Record<string, unknown> | undefined;
  for (const status of ['200', '201', '202', 'default']) {
    const response = responses?.[status] as Record<string, unknown> | undefined;
    const json = response?.content as Record<string, unknown> | undefined;
    const body = json?.['application/json'] as Record<string, unknown> | undefined;
    if (body?.schema) return body.schema as OpenApiSchema;
  }
  return undefined;
}

function requestSchema(operation: Record<string, unknown>): OpenApiSchema | undefined {
  const body = operation.requestBody as Record<string, unknown> | undefined;
  const content = body?.content as Record<string, unknown> | undefined;
  const json = content?.['application/json'] as Record<string, unknown> | undefined;
  return json?.schema as OpenApiSchema | undefined;
}

function collectContractRoutes(file: string, doc: OpenApiDocument): ApiRoute[] {
  const schemas = doc.components?.schemas ?? {};
  const apis: ApiRoute[] = [];
  for (const [routePath, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, operationValue] of Object.entries(methods ?? {})) {
      const upperMethod = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(upperMethod)) continue;
      const operation = operationValue as Record<string, unknown>;
      const response = responseSchema(operation);
      const request = requestSchema(operation);
      const entity = extractEntityFromSchema(response, schemas) ?? extractEntityFromSchema(request, schemas);
      const fields = [
        ...schemaFieldRefs(entity ?? 'Unknown', response, schemas),
        ...schemaFieldRefs(entity ?? 'Unknown', request, schemas),
      ].filter(
        (field, index, list) =>
          list.findIndex((item) => `${item.entity}.${item.field}` === `${field.entity}.${field.field}`) === index,
      );
      apis.push({
        id: `api.openapi.${upperMethod.toLowerCase()}-${routePath
          .replace(/[^a-zA-Z0-9]/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase()}`,
        method: upperMethod,
        path: routePath,
        entity,
        fields: entity ? fields.filter((field) => field.entity === entity) : fields,
        kind: 'backend',
        confidence: 'medium',
        evidence: [file],
      });
    }
  }
  return apis;
}

export const openapiAnalyzer: Analyzer = {
  name: 'openapi',
  analyze(scan, ctx) {
    const docs = readOpenApiDocuments(scan, ctx.warn);
    if (!docs.length) return {};
    const entities: Entity[] = [];
    const apis: ApiRoute[] = [];
    for (const { file, doc } of docs) {
      const schemas = doc.components?.schemas ?? {};
      entities.push(...collectSchemaEntities(file, schemas));
      apis.push(...collectContractRoutes(file, doc));
    }
    const knownRoutes = new Set((ctx.apis ?? []).map((api) => `${api.method.toUpperCase()} ${api.path}`));
    for (const api of apis) {
      const key = `${api.method.toUpperCase()} ${api.path}`;
      if (!knownRoutes.has(key)) ctx.warn?.(`OpenAPI contract route missing from code: ${key} (${api.evidence[0]})`);
    }
    const contractFields = new Map<string, Set<string>>();
    for (const entity of entities) {
      contractFields.set(entity.name, new Set((entity.attributes ?? []).map((attribute) => attribute.name)));
    }
    for (const entity of ctx.entities) {
      const expected = contractFields.get(entity.name);
      if (!expected) continue;
      const actual = new Set((entity.attributes ?? []).map((attribute) => attribute.name));
      const missing = [...expected].filter((field) => !actual.has(field));
      const extra = [...actual].filter((field) => !expected.has(field));
      if (missing.length || extra.length) {
        ctx.warn?.(
          `OpenAPI schema mismatch for entity ${entity.name}: missing=${missing.join(', ') || 'none'}; extra=${extra.join(', ') || 'none'}`,
        );
      }
    }
    for (const api of ctx.apis ?? []) {
      const key = `${api.method.toUpperCase()} ${api.path}`;
      if (!apis.some((contract) => `${contract.method.toUpperCase()} ${contract.path}` === key)) {
        ctx.warn?.(`Code route missing from OpenAPI contract: ${key} (${api.evidence[0] ?? 'unknown'})`);
      }
    }
    return {
      entities,
      apis,
    };
  },
};
