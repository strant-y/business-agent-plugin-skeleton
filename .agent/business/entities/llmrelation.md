# LlmRelation

> Status: high

## Description
Discovered from AST in src\core\analyzers\llm-rules.ts.

## Attributes
- source: string
- target: string
- relationship: string
- cardinality: '1:1' | '1:N' | 'N:1' | 'N:M' | 'unknown'
- description: string

## Evidence
- src\core\analyzers\llm-rules.ts
