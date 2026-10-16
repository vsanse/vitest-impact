export interface InputRule {
  files: string[]
  tests: string[]
}

export interface ImpactConfig {
  version: 1
  sourcePatterns: string[]
  inputs: InputRule[]
  forceFull: string[]
  ignore: string[]
  alwaysRun: string[]
  resources: {
    maxWorkers?: number
    memoryBudgetMb?: number
    workerMemoryMb?: number
    reserveMemoryMb?: number
  }
}

export interface Change { path: string; status: string }
export interface GitChanges {
  head: string | null
  base: string | null
  changes: Change[]
  fallback: string | null
}
export interface TestFile { id: string; file: string; project: string }
export interface TestDecision extends TestFile { selected: boolean; reasons: string[] }
export interface ResourceBudget {
  maxWorkers: number
  availableCpu: number
  memoryBudgetMb: number
  workerMemoryMb: number
  reserveMemoryMb: number
  memoryEstimate: 'configured' | 'default-assumption'
  warnings: string[]
}
export interface Plan {
  schemaVersion: 1
  toolVersion: string
  vitestVersion: string
  nodeVersion: string
  root: string
  createdAt: string
  git: GitChanges
  configurationHash: string
  workspaceFingerprint: string | null
  mode: 'full' | 'selective' | 'empty'
  fallbackReasons: string[]
  ignoredChanges: string[]
  decisions: TestDecision[]
  resources: ResourceBudget
  planningMs: number
  warnings: string[]
}
export interface FileResult {
  id: string
  file: string
  state: string
  durationMs: number
  passed: number
  failed: number
  skipped: number
  pending: number
}
export interface RunReport {
  schemaVersion: 1
  mode: 'shadow' | 'selected' | 'full'
  plan: Plan
  executed: FileResult[]
  unhandledErrors: string[]
  runLevelFailure: boolean
  executionMs: number
  missingFiles: string[]
  unexpectedFiles: string[]
  missedFailingFiles: string[]
  validation: 'not-shadow' | 'no-failures-observed' | 'all-observed-failures-selected' | 'missed-failures' | 'incomplete'
  observedFailureRecall: number | null
  estimatedSelectedDurationFraction: number | null
  exitCode: number
}
export interface WorkspacePackage {
  name: string
  dir: string
  kind: 'vitest' | 'script' | 'none'
  vitestConfig: string | null
  testScript: string | null
}
