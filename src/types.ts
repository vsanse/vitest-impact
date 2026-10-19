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
  /** Packages whose own config enables coverage: they run in full, and under --shard in one shard. */
  coveragePackages: string[]
  /** Vitest packages with no test files whose config sets passWithNoTests; left out of the run. */
  emptyPackages: string[]
  /** One shared Vitest process for each Vitest copy that shared packages resolve (empty without a workspace). */
  sharedGroups: SharedGroup[]
  /** The `--shard i/n` this invocation runs, or null. */
  shard: { index: number; count: number } | null
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
  /** Time per phase; null when the runner gives none (separate units). */
  phases: Phases | null
  /** Full names of tests that failed on their own timeout or a per-test hook's (separate.ts TIMED_OUT). */
  timedOut: string[]
}
export interface Phases { importMs: number; environmentMs: number; setupMs: number; testsMs: number }
export interface LoadSummary { peakPerCpu: number; meanPerCpu: number; samples: number }
export interface PackageResult { name: string; mode: 'shared' | 'separate' | 'script'; exitCode: number | null; durationMs: number; phases: Phases | null }
/** The shared packages that resolve one Vitest copy: `vitest` is the copy's folder relative to the root. */
export interface SharedGroup { vitest: string; packages: string[] }
export interface RunReport {
  schemaVersion: 1
  mode: 'shadow' | 'selected' | 'full'
  plan: Plan
  sharedGroups: SharedGroup[]
  executed: FileResult[]
  packages: PackageResult[]
  unhandledErrors: string[]
  runLevelFailure: boolean
  executionMs: number
  slowestFiles: { file: string; durationMs: number }[]
  timeouts: { file: string; test: string }[]
  load: LoadSummary | null
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
