# AgentConfig

> Status: high

## Description
Discovered from AST in src\core\config.ts.

## Attributes
- ignoreDirs: string[]
- allowedExt: string[]
- preferredEntities: string[]
- maxFileBytes: number
- maxEntities: number
- maxSampleFiles: number
- maxSamplesPerExt: number
- maxSampleChars: number
- relationWindow: number
- analyzers: string[]
- autoPromote: 'never' | 'high' | 'medium'
- llm: LlmConfig

## Evidence
- src\core\config.ts
