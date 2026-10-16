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
  /** Package names that always run in their own Vitest process. */
  isolated: string[]
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
  /** Workspace packages in this plan (empty without a workspace). */
  packages: string[]
  /** Vitest packages that must run in their own process. */
  separate: { package: string; reason: string }[]
  /** Packages whose test script runs as-is. */
  scripts: string[]
  /** Vitest packages with no test files whose config sets passWithNoTests; left out of the run. */
  emptyPackages: string[]
  resources: ResourceBudget
  planningMs: number
  warnings: string[]
}
export interface FileResult {
  id: string
  file: string
  project: string
  state: string
  durationMs: number
  passed: number
  failed: number
  skipped: number
  pending: number
}
export interface PackageResult { name: string; mode: 'shared' | 'separate' | 'script'; exitCode: number | null; durationMs: number }
export interface RunReport {
  schemaVersion: 1
  mode: 'shadow' | 'selected' | 'full'
  plan: Plan
  executed: FileResult[]
  packages: PackageResult[]
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
