# ContextManifest

> Status: high

## Description
Discovered from AST in src\commands\context.ts.

## Attributes
- entities: Array<{ name: string; description: string; confidence: string }>
- apis: ApiRoute[]
- conflicts: RuleConflict[]
- states: StateMachine[]
- workflows: WorkflowTemplate[]
- pages: FrontendPage[]
- actions: UserAction[]

## Evidence
- src\commands\context.ts
