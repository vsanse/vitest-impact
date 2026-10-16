import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { rm } from 'node:fs/promises'
import { VitestAdapter } from './adapter.js'
import { loadConfig } from './config.js'
import { changedFiles, localPath, workspaceFingerprint } from './git.js'
import { selectTests } from './planner.js'
import { budgetResources } from './resources.js'
import { analyzeRun, writeJson, writeSummary } from './report.js'
import { withRunLock } from './lock.js'
import { discoverPackages, filterPackages } from './workspace.js'
import type { ImpactConfig, Plan, RunReport, WorkspacePackage } from './types.js'

export type { ImpactConfig, Plan, RunReport } from './types.js'
export { selectTests } from './planner.js'
export { analyzeRun } from './report.js'
export { budgetResources } from './resources.js'

export interface Options {
  root?: string
  base?: string
  config?: string
  vitestConfig?: string
  filters?: string[]
  command: 'plan' | 'run'
  mode?: RunReport['mode']
  resources?: ImpactConfig['resources']
}

export async function execute(options: Options): Promise<{ plan: Plan; report?: RunReport }> {
  const root = resolve(options.root ?? process.cwd())
  return withRunLock(root, () => executeLocked({ ...options, root }))
}

async function executeLocked(options: Options): Promise<{ plan: Plan; report?: RunReport }> {
  const start = performance.now()
  const root = resolve(options.root ?? process.cwd())
  const output = resolve(root, '.vitest-impact')
  // Never leave a prior successful result looking like the result of a failed invocation.
  await Promise.all(['plan.json', 'report.json', 'summary.md'].map(file => rm(resolve(output, file), { force: true })))
  const loaded = await loadConfig(root, options.config)
  const resources = budgetResources({ ...loaded.config.resources, ...options.resources })
  const git = await changedFiles(root, options.base)
  const extra = [loaded.path, ...(options.vitestConfig ? [resolve(root, options.vitestConfig)] : [])]
  const fingerprint = await workspaceFingerprint(root, extra)
  const packages = await workspacePackages(root, options)
  const adapter = await VitestAdapter.open(root, resources, packages
    ? { packages: packages.filter(p => p.kind === 'vitest') }
    : options.vitestConfig ? { vitestConfig: options.vitestConfig } : {})
  try {
    const forced: string[] = []
    if (adapter.versionWarning) forced.push(adapter.versionWarning)
    if (options.mode === 'full') forced.push('explicit-full-run')
    if (!loaded.found) forced.push('no-impact-config: configure input ownership before selecting tests')
    if (adapter.context.config.coverage.enabled) forced.push('coverage-enabled: preserve complete-suite coverage')
    const selection = await selectTests({
      tests: adapter.tests(), git, config: loaded.config,
      protectedFiles: extra.map(file => localPath(root, file)),
      forceReasons: forced, related: paths => adapter.related(paths),
    })
    const plan: Plan = {
      schemaVersion: 1, toolVersion: '0.1.0', vitestVersion: adapter.version,
      nodeVersion: process.version, root, createdAt: new Date().toISOString(), git,
      configurationHash: loaded.hash, workspaceFingerprint: fingerprint, ...selection,
      packages: packages?.map(p => p.name) ?? [], separate: adapter.separate(),
      scripts: packages?.filter(p => p.kind === 'script').map(p => p.name) ?? [], resources,
      planningMs: performance.now() - start,
      warnings: [
        'Selection assumes sourcePatterns use statically resolvable dependencies; declare other inputs or force a full run.',
        'Untracked ignored files, external services, and environment drift across revisions are not inferred.',
        'Git ancestry is checked; successful validation of the chosen base is not verified.',
        'This MVP has no historical graph or result cache. Deletions and unknown inputs broaden execution.',
        ...resources.warnings,
      ],
    }
    if (fingerprint !== await workspaceFingerprint(root, extra)
      || JSON.stringify(git) !== JSON.stringify(await changedFiles(root, options.base))
      || loaded.hash !== (await loadConfig(root, options.config)).hash) {
      throw new Error('Workspace changed during planning. Retry to compute a fresh selection.')
    }
    plan.planningMs = performance.now() - start
    await writeJson(resolve(output, 'plan.json'), plan)
    if (options.command === 'plan') return { plan }
    if (plan.separate.length || plan.scripts.length) throw new Error('Separate execution is not implemented')
    const mode = options.mode ?? 'shadow'
    const ids = new Set(plan.decisions.filter(t => mode !== 'selected' || t.selected).map(t => t.id))
    const runStart = performance.now()
    let report: RunReport
    try {
      const result = await adapter.run(ids)
      const files = adapter.results(result)
      // Global teardown can set Vitest's failure status. Finish it before publishing results.
      await adapter.close()
      report = analyzeRun(plan, mode, files, result.unhandledErrors.map(error => error instanceof Error ? error.message : String(error)), performance.now() - runStart, Number(process.exitCode ?? 0) !== 0)
    } catch (error) {
      report = analyzeRun(plan, mode, [], [error instanceof Error ? error.stack ?? error.message : String(error)], performance.now() - runStart)
    }
    await writeJson(resolve(output, 'report.json'), report)
    await writeSummary(report, resolve(output, 'summary.md'))
    return { plan, report }
  } finally { await adapter.close() }
}

/** Workspace packages with tests after --filter, or null for today's single-project run (no workspace, or --vitest-config). */
async function workspacePackages(root: string, options: Options): Promise<WorkspacePackage[] | null> {
  const filters = options.filters ?? []
  if (options.vitestConfig) {
    if (filters.length) throw new Error('--filter cannot be used with --vitest-config')
    return null
  }
  const found = await discoverPackages(root)
  if (found.length === 1 && found[0]!.dir === '.') {
    if (filters.length) throw new Error('--filter needs a workspace (pnpm-workspace.yaml or package.json workspaces)')
    return null
  }
  const packages = filterPackages(found, filters)
  if (!packages.length) throw new Error('No package with tests matches the filters')
  return packages
}
