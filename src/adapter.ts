import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TestProject, TestSpecification, Vitest, TestRunResult } from 'vitest/node'
import type { ViteUserConfig } from 'vitest/config'
import { localPath } from './git.js'
import { versionPolicy } from './version.js'
import type { FileResult, ResourceBudget, TestFile, WorkspacePackage } from './types.js'

const CWD_SHIM = fileURLToPath(new URL('./cwd-shim.js', import.meta.url))
// Vitest 5.0.5 resolves these per project but leaves them out of the ResolvedConfig type.
type Untyped = { fileParallelism?: boolean; providedOptions?: { maxWorkers?: boolean } }
type OwnTestConfig = NonNullable<ViteUserConfig['test']>
type ViteLoader = { loadConfigFromFile(env: { command: 'serve'; mode: string }, file: string, root: string, logLevel: 'silent'): Promise<{ config: ViteUserConfig } | null> }

/** Why a project cannot share this process, or null. See docs/decisions/cwd-parity.md. */
function separateReason(project: TestProject, own: OwnTestConfig): string | null {
  const config = project.config
  if (config.browser.enabled) return 'browser'
  if (config.typecheck.enabled) return 'typecheck'
  if (config.pool !== 'forks') return `pool:${config.pool}`
  if ((config as Untyped).fileParallelism === false) return 'file-parallelism-off'
  if ([config.globalSetup].flat().length) return 'global-setup'
  // Coverage is a root-only Vitest option: the shared process would drop the package's own.
  if (own.coverage?.enabled) return 'coverage'
  return null
}

export class VitestAdapter {
  private constructor(
    readonly context: Vitest, readonly root: string, readonly specs: TestSpecification[],
    private readonly owners: Map<TestProject, WorkspacePackage>, private readonly separated: { package: string; reason: string }[],
    readonly emptyPackages: string[],
    private readonly coverage: Set<string>, private readonly limits: Map<string, number>,
    readonly version: string, readonly versionWarning?: string,
  ) {}

  static async open(root: string, budget: ResourceBudget, options: { vitestConfig?: string; packages?: WorkspacePackage[]; isolated?: string[] } = {}): Promise<VitestAdapter> {
    const require = createRequire(resolve(root, 'package.json'))
    const pkg = require('vitest/package.json') as { version: string }
    const policy = versionPolicy(pkg.version)
    if (!policy.ok) throw new Error(policy.error)
    const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')).href) as typeof import('vitest/node')
    const { packages } = options
    const projects: ViteUserConfig | undefined = packages ? { test: { projects: packages.map(p => resolve(root, p.vitestConfig!)) } } : undefined
    const context = await createVitest({
      root,
      // Workspace mode: no root Vitest config; each package's own config is one project.
      ...(packages ? { config: false as const } : options.vitestConfig ? { config: resolve(root, options.vitestConfig) } : {}),
      watch: false,
      run: true,
      allowOnly: false,
      dangerouslyIgnoreUnhandledErrors: false,
      bail: 0,
      passWithNoTests: false,
      update: false,
      experimental: { recordDependencies: false },
    }, projects)
    try {
      if (!packages && context.projects.length !== 1) throw new Error('MVP supports exactly one Vitest project. Run each project separately with an outer concurrency budget.')
      const cfg = context.config
      if (cfg.changed || cfg.related || cfg.shard || cfg.testNamePattern || cfg.tagsFilter?.length || cfg.project?.length) {
        throw new Error('Remove Vitest changed/related/shard/project/name/tag filters: vitest-impact must discover the entire configured suite.')
      }
      for (const project of context.projects) {
        if (project.config.testNamePattern || project.config.tagsFilter?.length) throw new Error('Project-level name/tag filters are not supported.')
      }
      const owners = new Map<TestProject, WorkspacePackage>()
      let separated: { package: string; reason: string }[] = []
      let passWithNoTests = new Set<WorkspacePackage>()
      const coverage = new Set<string>()
      const limits = new Map<string, number>()
      if (!packages) {
        const project = context.projects[0]!
        if (!['forks', 'threads'].includes(String(project.config.pool)) || project.config.browser.enabled || project.config.typecheck.enabled) {
          throw new Error('MVP supports Node forks/threads pools only (including jsdom/happy-dom). Browser, VM/custom pools, and typecheck suites are not yet supported.')
        }
        // Cap native concurrency; never override a user's stricter serial/worker setting.
        const configuredLimit = Math.min(cfg.maxWorkers, project.config.maxWorkers)
        if (configuredLimit < budget.maxWorkers) {
          budget.warnings.push(`Preserved Vitest's stricter ${configuredLimit}-worker limit.`)
          budget.maxWorkers = configuredLimit
        }
        cfg.maxWorkers = budget.maxWorkers
        project.config.maxWorkers = budget.maxWorkers
        project.config.allowOnly = false
      } else {
        // Vitest gives every project the root coverage and the CLI passWithNoTests, so read both from the package's own config.
        const vite = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href) as ViteLoader
        const own = new Map(await Promise.all(packages.map(async p => {
          const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'test' }, resolve(root, p.vitestConfig!), resolve(root, p.dir), 'silent')
          return [p, loaded?.config.test ?? {}] as const
        })))
        // Name each project after the discovered package that holds its root, not Vitest's default name.
        const reasons = new Map<WorkspacePackage, string>()
        for (const project of context.projects) {
          const dir = localPath(root, project.config.root)
          const owner = packages.filter(p => dir === p.dir || dir.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]
          if (!owner) throw new Error(`Vitest project root is outside every package: ${dir}`)
          owners.set(project, owner)
          const reason = options.isolated?.includes(owner.name) ? 'isolated-in-config' : separateReason(project, own.get(owner)!)
          if (reason && !reasons.has(owner)) reasons.set(owner, reason)
        }
        separated = packages.filter(p => reasons.has(p)).map(p => ({ package: p.name, reason: reasons.get(p)! }))
        for (const p of packages) if (own.get(p)!.coverage?.enabled) coverage.add(p.name)
        // A package's own worker limit, read before the shared-project code below rewrites it.
        for (const project of context.projects) {
          const owner = owners.get(project)!
          if ((project.config as Untyped).providedOptions?.maxWorkers === false) continue
          limits.set(owner.name, Math.min(limits.get(owner.name) ?? Infinity, project.config.maxWorkers))
        }
        passWithNoTests = new Set(packages.filter(p => own.get(p)!.passWithNoTests === true))
        cfg.maxWorkers = budget.maxWorkers
        const shared = context.projects.filter(project => !reasons.has(owners.get(project)!))
        for (const project of shared) {
          const owner = owners.get(project)!
          // The budget is the root limit; a project that sets a lower limit keeps it.
          const setsLimit = (project.config as Untyped).providedOptions?.maxWorkers !== false
          const limit = setsLimit ? Math.min(project.config.maxWorkers, budget.maxWorkers) : budget.maxWorkers
          const kept = `Kept ${owner.name}'s ${limit}-worker limit.`
          if (limit < budget.maxWorkers && !budget.warnings.includes(kept)) budget.warnings.push(kept)
          project.config.maxWorkers = limit
          project.config.allowOnly = false
          project.config.env = { ...project.config.env, VITEST_IMPACT_CWD: resolve(root, owner.dir) }
          project.config.setupFiles = [CWD_SHIM, ...project.config.setupFiles]
        }
        // Vitest runs one sequence.groupOrder at a time and needs one maxWorkers value per group:
        // give each (groupOrder, maxWorkers) pair its own group, keeping the configured order.
        let group = -1
        let previous = ''
        for (const project of [...shared].sort((a, b) => a.config.sequence.groupOrder - b.config.sequence.groupOrder || b.config.maxWorkers - a.config.maxWorkers)) {
          const pair = `${project.config.sequence.groupOrder}/${project.config.maxWorkers}`
          if (pair !== previous) { group++; previous = pair }
          project.config.sequence.groupOrder = group
        }
      }
      const specs = await context.globTestSpecifications()
      if (!specs.length) throw new Error('No test files discovered. Refusing an empty successful run.')
      const empty = (packages ?? []).filter(p => !specs.some(spec => owners.get(spec.project) === p))
      for (const p of empty) if (!passWithNoTests.has(p)) throw new Error(`No test files discovered in ${p.name}. Refusing an empty successful run.`)
      const emptyPackages = empty.map(p => p.name)
      separated = separated.filter(s => !emptyPackages.includes(s.package))
      return new VitestAdapter(context, root, specs, owners, separated, emptyPackages, coverage, limits, pkg.version, policy.selection ? undefined : policy.warning)
    } catch (error) { await context.close(); throw error }
  }

  /** Packages whose own config enables coverage, whatever else separates them. */
  coveragePackages(): Set<string> { return this.coverage }

  /** The worker limit a package sets in its own config, or undefined. */
  workerLimit(name: string): number | undefined { return this.limits.get(name) }

  /** Packages that must not run in this process. */
  separate(): { package: string; reason: string }[] { return this.separated }

  tests(): TestFile[] {
    return this.specs.map(spec => ({ id: spec.taskId, file: localPath(this.root, spec.moduleId), project: this.owners.get(spec.project)?.name ?? spec.project.name }))
  }

  async related(paths: string[]): Promise<string[]> {
    // Vitest 5.0.5 does not expose a public select-without-running API.
    // Keep the sole internal bridge isolated, version-pinned and fail-to-full.
    const internal = this.context as unknown as { specifications?: { filterTestsBySource?: (specs: TestSpecification[]) => Promise<TestSpecification[]> } }
    const selector = internal.specifications
    if (typeof selector?.filterTestsBySource !== 'function') throw new Error('Native selection interface unavailable')
    const previous = this.context.config.related
    this.context.config.related = paths.map(path => resolve(this.root, path))
    try { return (await selector.filterTestsBySource(this.specs)).map(spec => spec.taskId) }
    finally {
      if (previous) this.context.config.related = previous
      else delete this.context.config.related
    }
  }

  async run(ids: Set<string>): Promise<TestRunResult> {
    const apart = new Set(this.separated.map(s => s.package))
    const specs = this.specs.filter(spec => ids.has(spec.taskId) && !apart.has(this.owners.get(spec.project)?.name ?? ''))
    if (!specs.length) return { testModules: [], unhandledErrors: [] }
    await this.context.standalone()
    return this.context.runTestSpecifications(specs, specs.length === this.specs.length)
  }

  results(result: TestRunResult): FileResult[] {
    return result.testModules.map(module => {
      const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 }
      for (const test of module.children.allTests()) counts[test.result().state]++
      return { id: module.id, file: localPath(this.root, module.moduleId), project: this.owners.get(module.project)?.name ?? module.project.name, state: module.state(), durationMs: module.diagnostic().duration, ...counts }
    })
  }
  close(): Promise<void> { return this.context.close() }
}
