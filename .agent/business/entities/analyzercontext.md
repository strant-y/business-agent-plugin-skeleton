# AnalyzerContext

> Status: high

## Description
Discovered from AST in src\core\analyzer.ts.

## Attributes
- config: AgentConfig
- entities: Entity[]
- rules: BusinessRule[]
- relations: Relation[]
- apis: ApiRoute[]
- warn: (message: string) => void

## Evidence
- src\core\analyzer.ts
