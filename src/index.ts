import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { rm } from 'node:fs/promises'
import { VitestAdapter } from './adapter.js'
import { loadConfig } from './config.js'
import { changedFiles, localPath, workspaceFingerprint } from './git.js'
import { matches, selectTests } from './planner.js'
import { budgetResources, startLoadSampler } from './resources.js'
import { analyzeRun, writeJson, writeSummary } from './report.js'
import { withRunLock } from './lock.js'
import { discoverPackages, filterPackages, untrackedDependents } from './workspace.js'
import { parseShard, scriptInShard, shardRunSet } from './shard.js'
import { runSeparate } from './separate.js'
import type { FileResult, ImpactConfig, LoadSummary, PackageResult, Plan, RunReport, WorkspacePackage } from './types.js'

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
  /** `i/n`: run only this share of the planned files. */
  shard?: string
  /** Treat the config's `isolated` list as empty (used by `check`). */
  ignoreIsolated?: boolean
}

export async function execute(options: Options): Promise<{ plan: Plan; report?: RunReport }> {
  const root = resolve(options.root ?? process.cwd())
  return withRunLock(root, () => executeLocked({ ...options, root }))
}

async function executeLocked(options: Options): Promise<{ plan: Plan; report?: RunReport }> {
  const start = performance.now()
  const shard = options.shard === undefined ? null : parseShard(options.shard)
  const root = resolve(options.root ?? process.cwd())
  const output = resolve(root, '.vitest-impact')
  // Never leave a prior successful result looking like the result of a failed invocation.
  await Promise.all(['plan.json', 'report.json', 'summary.md'].map(file => rm(resolve(output, file), { force: true })))
  const loaded = await loadConfig(root, options.config)
  const resources = budgetResources({ ...loaded.config.resources, ...options.resources })
  const git = await changedFiles(root, options.base)
  const extra = [loaded.path, ...(options.vitestConfig ? [resolve(root, options.vitestConfig)] : [])]
  const fingerprint = await workspaceFingerprint(root, extra)
  const workspace = await workspacePackages(root, options, options.ignoreIsolated ? [] : loaded.config.isolated)
  const packages = workspace?.packages ?? null
  const vitestPackages = packages?.filter(p => p.kind === 'vitest') ?? []
  // With no Vitest package (only scripts), createVitest would throw "No projects were found".
  const adapter = packages && !vitestPackages.length ? null
    : await VitestAdapter.open(root, resources, packages
      ? { packages: vitestPackages, isolated: options.ignoreIsolated ? [] : loaded.config.isolated }
      : options.vitestConfig ? { vitestConfig: options.vitestConfig } : {})
  try {
    const forced: string[] = []
    if (adapter?.versionWarning) forced.push(adapter.versionWarning)
    if (options.mode === 'full') forced.push('explicit-full-run')
    if (!loaded.found) forced.push('no-impact-config: configure input ownership before selecting tests')
    if (adapter?.context.config.coverage.enabled) forced.push('coverage-enabled: preserve complete-suite coverage')
    if (workspace && adapter) {
      const testFiles = new Set(adapter.tests().map(t => t.file))
      const sources = git.changes.map(c => c.path).filter(path => !testFiles.has(path) && matches(path, loaded.config.sourcePatterns))
      forced.push(...await untrackedDependents(root, workspace.found, workspace.packages, sources))
    }
    const selection = adapter ? await selectTests({
      tests: adapter.tests(), git, config: loaded.config,
      protectedFiles: extra.map(file => localPath(root, file)),
      forceReasons: forced, related: paths => adapter.related(paths),
    }) : { mode: 'full' as const, fallbackReasons: [...forced], ignoredChanges: [], decisions: [] }
    const separate = adapter?.separate() ?? []
    // A package with its own coverage settings always runs in full, so its coverage and thresholds stay complete.
    const coveragePackages = adapter?.coveragePackages() ?? new Set<string>()
    for (const test of selection.decisions) {
      if (!coveragePackages.has(test.project)) continue
      test.selected = true
      test.reasons = [...test.reasons.filter(r => !r.startsWith('not-selected')), 'coverage: package runs in full']
    }
    const selectedCount = selection.decisions.filter(t => t.selected).length
    selection.mode = selectedCount === selection.decisions.length ? 'full' : selectedCount ? 'selective' : 'empty'
    const plan: Plan = {
      schemaVersion: 1, toolVersion: '0.2.0', vitestVersion: adapter?.version ?? 'n/a',
      nodeVersion: process.version, root, createdAt: new Date().toISOString(), git,
      configurationHash: loaded.hash, workspaceFingerprint: fingerprint, ...selection,
      packages: packages?.map(p => p.name) ?? [], separate,
      scripts: packages?.filter(p => p.kind === 'script').map(p => p.name) ?? [], coveragePackages: [...coveragePackages].sort(),
      emptyPackages: adapter?.emptyPackages ?? [], shard, resources,
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
    const mode = options.mode ?? 'shadow'
    const runSet = shardRunSet(plan.decisions, mode, shard, plan.coveragePackages)
    const inRun = new Set(runSet.map(t => t.id))
    const wanted = (t: { id: string }) => inRun.has(t.id)
    const ids = inRun
    const emptyShard = !!shard && !runSet.length && !plan.scripts.some(n => scriptInShard(n, shard))
    if (emptyShard) console.log(`Shard ${shard.index}/${shard.count} has no test files.`)
    const runStart = performance.now()
    let report: RunReport
    const stopLoad = startLoadSampler()
    try {
      const files: FileResult[] = []
      const unhandled: string[] = []
      const results: PackageResult[] = []
      let runLevelFailure = false
      // The shared run covers the packages that are not separate (run() skips the separate ones). With none left it is skipped.
      if (adapter && !emptyShard) {
        const result = await adapter.run(ids)
        files.push(...adapter.results(result))
        unhandled.push(...result.unhandledErrors.map(error => error instanceof Error ? error.message : String(error)))
        // Global teardown can set Vitest's failure status. Finish it before publishing results.
        await adapter.close()
        runLevelFailure = Number(process.exitCode ?? 0) !== 0
        for (const name of new Set(files.map(f => f.project))) {
          results.push({ name, mode: 'shared', exitCode: null, durationMs: files.filter(f => f.project === name).reduce((sum, f) => sum + f.durationMs, 0), phases: null })
        }
      }
      const outDir = resolve(output, 'separate')
      for (const pkg of packages ?? []) {
        const apart = plan.separate.some(s => s.package === pkg.name)
        if (emptyShard || pkg.kind === 'none' || (pkg.kind === 'vitest' && !apart)) continue
        if (pkg.kind === 'script' && !scriptInShard(pkg.name, shard)) continue
        const tests = plan.decisions.filter(t => t.project === pkg.name)
        const chosen = tests.filter(wanted)
        // ponytail: a vitest unit with no selected files is skipped; scripts are always selected.
        if (pkg.kind === 'vitest' && !chosen.length) continue
        const unit = {
          package: pkg.name, dir: pkg.dir, kind: pkg.kind,
          files: chosen.length === tests.length ? [] : chosen.map(t => resolve(root, t.file)),
          idsByFile: new Map(tests.map(t => [t.file, t.id] as const)),
        }
        const workers = Math.min(resources.maxWorkers, adapter?.workerLimit(pkg.name) ?? resources.maxWorkers)
        const { result, files: unitFiles, errors } = await runSeparate(root, unit, workers, outDir)
        results.push(result)
        unhandled.push(...errors)
        files.push(...unitFiles)
      }
      report = analyzeRun(plan, mode, files, unhandled, performance.now() - runStart, runLevelFailure, results, loadOrNull(stopLoad()))
    } catch (error) {
      report = analyzeRun(plan, mode, [], [error instanceof Error ? error.stack ?? error.message : String(error)], performance.now() - runStart, false, undefined, loadOrNull(stopLoad()))
    }
    await writeJson(resolve(output, 'report.json'), report)
    await writeSummary(report, resolve(output, 'summary.md'))
    return { plan, report }
  } finally { await adapter?.close() }
}

/** All workspace packages and those with tests after --filter, or null for today's single-project run (no workspace, or --vitest-config). */
async function workspacePackages(root: string, options: Options, isolated: string[]): Promise<{ found: WorkspacePackage[]; packages: WorkspacePackage[] } | null> {
  const filters = options.filters ?? []
  if (options.vitestConfig) {
    if (isolated.length) throw new Error(`isolated package not found: ${isolated[0]}`)
    if (filters.length) throw new Error('--filter cannot be used with --vitest-config')
    return null
  }
  const found = await discoverPackages(root)
  if (found.length === 1 && found[0]!.dir === '.') {
    if (isolated.length) throw new Error(`isolated package not found: ${isolated[0]}`)
    if (filters.length) throw new Error('--filter needs a workspace (pnpm-workspace.yaml or package.json workspaces)')
    return null
  }
  for (const name of isolated) if (!found.some(p => p.name === name)) throw new Error(`isolated package not found: ${name}`)
  const packages = filterPackages(found, filters)
  if (!packages.length) {
    throw new Error(filters.length ? 'No package with tests matches the filters'
      : 'No workspace package has a Vitest test script. Use --vitest-config for a suite run from one root config.')
  }
  return { found, packages }
}

// os.loadavg() is all zeros on Windows, so there is no load to report.
function loadOrNull(load: LoadSummary): LoadSummary | null { return load.peakPerCpu > 0 ? load : null }
