import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TestProject, TestSpecification, Vitest, TestRunResult } from 'vitest/node'
import type { ViteUserConfig } from 'vitest/config'
import { localPath } from './git.js'
import { TIMED_OUT, packageEnv } from './separate.js'
import { versionPolicy } from './version.js'
import type { FileResult, ResourceBudget, SharedGroup, TestFile, WorkspacePackage } from './types.js'

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
  // The root cache setting governs the shared run: a package that turned its module cache off keeps that in its own run.
  if (own.fsModuleCache === false) return 'fs-module-cache-off'
  return null
}

/** One Vitest instance: the packages that resolve one physical Vitest copy (or the single project). */
interface Group { context: Vitest; specs: TestSpecification[]; vitest: string; members: WorkspacePackage[] }
/** What the groups of one run find about their packages. */
interface Found {
  owners: Map<TestProject, WorkspacePackage>; reasons: Map<WorkspacePackage, string>; passWithNoTests: Set<WorkspacePackage>
  coverage: Set<string>; limits: Map<string, number>
}

export class VitestAdapter {
  private constructor(
    private readonly groups: Group[], readonly root: string,
    private readonly owners: Map<TestProject, WorkspacePackage>, private readonly separated: { package: string; reason: string }[],
    readonly emptyPackages: string[],
    private readonly coverage: Set<string>, private readonly limits: Map<string, number>,
    readonly version: string, readonly versionWarnings: string[], readonly sharedGroups: SharedGroup[],
  ) {}

  static async open(root: string, budget: ResourceBudget, options: { vitestConfig?: string; packages?: WorkspacePackage[]; isolated?: string[] } = {}): Promise<VitestAdapter> {
    const { packages } = options
    // A package's tests import the vitest that package resolves (pnpm can install several copies of one version),
    // so each copy gets its own Vitest instance, created from that copy. Single-project mode uses the root's copy.
    const copies = new Map<string, WorkspacePackage[]>()
    if (!packages) copies.set(realpathSync(dirname(createRequire(resolve(root, 'package.json')).resolve('vitest/package.json'))), [])
    for (const p of packages ?? []) {
      let file: string
      try { file = createRequire(resolve(root, p.dir, 'package.json')).resolve('vitest/package.json') }
      catch (cause) { throw new Error(`Cannot resolve vitest from ${p.dir}/package.json`, { cause }) }
      const copy = realpathSync(dirname(file))
      copies.set(copy, [...copies.get(copy) ?? [], p])
    }
    const versions: string[] = []
    const versionWarnings: string[] = []
    for (const copy of copies.keys()) {
      const { version } = JSON.parse(readFileSync(resolve(copy, 'package.json'), 'utf8')) as { version: string }
      const policy = versionPolicy(version)
      if (!policy.ok) throw new Error(policy.error)
      if (!versions.includes(version)) versions.push(version)
      if (policy.warning && !versionWarnings.includes(policy.warning)) versionWarnings.push(policy.warning)
    }
    // As `vitest run` does before it loads a config. Without it Vite sets NODE_ENV=development for every worker.
    process.env.TEST = 'true'
    process.env.VITEST = 'true'
    process.env.NODE_ENV ??= 'test'
    // Warm caches live in the state folder so one CI cache step carries them between runs.
    const cache = resolve(root, '.vitest-impact', 'cache')
    // The shim sits inside the repo: a client environment (jsdom, for example) cannot load it from a tool folder outside the repo.
    const shim = resolve(root, '.vitest-impact', 'cwd-shim.mjs')
    if (packages) await writeFile(shim, readFileSync(CWD_SHIM, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, ''))
    const realRoot = realpathSync(root)
    const found: Found = { owners: new Map(), reasons: new Map(), passWithNoTests: new Set(), coverage: new Set(), limits: new Map() }
    const groups: Group[] = []
    try {
      for (const [copy, members] of copies) {
        const vitest = localPath(realRoot, copy)
        // Each group keeps its own Vite cache, which holds Vitest's results.json; the module cache is shared.
        const cacheDir = packages ? resolve(cache, 'vite', createHash('sha256').update(vitest).digest('hex').slice(0, 12)) : resolve(cache, 'vite')
        const { context, specs } = await VitestAdapter.openGroup(root, budget, copy, cacheDir, shim, packages ? members : undefined, options, found)
        groups.push({ context, specs, vitest, members })
      }
      // Vitest refuses a project name used twice only within one instance. Task ids hash the name, so refuse it across copies too.
      const names = new Map<string, string>()
      for (const project of groups.flatMap(g => g.context.projects)) {
        const file = found.owners.get(project)?.vitestConfig ?? ''
        const earlier = names.get(project.name)
        if (earlier !== undefined) throw new Error(`Project name "${project.name}" from "${file}" is not unique. The project is already defined by "${earlier}". All projects should have unique names. Make sure your configuration is correct.`)
        names.set(project.name, file)
      }
      const specs = groups.flatMap(g => g.specs)
      if (!specs.length) throw new Error('No test files discovered. Refusing an empty successful run.')
      const empty = (packages ?? []).filter(p => !specs.some(spec => found.owners.get(spec.project) === p))
      for (const p of empty) if (!found.passWithNoTests.has(p)) throw new Error(`No test files discovered in ${p.name}. Refusing an empty successful run.`)
      const emptyPackages = empty.map(p => p.name)
      const runs = (p: WorkspacePackage) => !emptyPackages.includes(p.name)
      const separated = (packages ?? []).filter(p => found.reasons.has(p) && runs(p)).map(p => ({ package: p.name, reason: found.reasons.get(p)! }))
      const sharedGroups = groups.map(g => ({ vitest: g.vitest, packages: g.members.filter(p => !found.reasons.has(p) && runs(p)).map(p => p.name) })).filter(g => g.packages.length)
      return new VitestAdapter(groups, root, found.owners, separated, emptyPackages, found.coverage, found.limits, versions.join(', '), versionWarnings, sharedGroups)
    } catch (error) {
      for (const group of groups) await group.context.close()
      throw error
    }
  }

  private static async openGroup(root: string, budget: ResourceBudget, copy: string, cacheDir: string, shim: string, packages: WorkspacePackage[] | undefined,
    options: { vitestConfig?: string; isolated?: string[] }, found: Found): Promise<{ context: Vitest; specs: TestSpecification[] }> {
    const require = createRequire(resolve(copy, 'package.json'))
    const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')).href) as typeof import('vitest/node')
    const overrides: ViteUserConfig = {
      cacheDir,
      test: { fsModuleCachePath: resolve(root, '.vitest-impact', 'cache', 'modules'), ...(packages ? { projects: packages.map(p => resolve(root, p.vitestConfig!)) } : {}) },
    }
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
    }, overrides)
    try {
      if (!packages && context.projects.length !== 1) throw new Error('A root Vitest config with several projects (test.projects) is not supported yet. Run each project separately with an outer concurrency budget.')
      const cfg = context.config
      if (cfg.changed || cfg.related || cfg.shard || cfg.testNamePattern || cfg.tagsFilter?.length || cfg.project?.length) {
        throw new Error('Remove Vitest changed/related/shard/project/name/tag filters: vitest-impact must discover the entire configured suite.')
      }
      for (const project of context.projects) {
        if (project.config.testNamePattern || project.config.tagsFilter?.length) throw new Error('Project-level name/tag filters are not supported.')
      }
      const { owners, reasons, coverage, limits } = found
      if (!packages) {
        const project = context.projects[0]!
        if (!['forks', 'threads'].includes(String(project.config.pool)) || project.config.browser.enabled || project.config.typecheck.enabled) {
          throw new Error('MVP supports Node forks/threads pools only (including jsdom/happy-dom). Browser, VM/custom pools, and typecheck suites are not yet supported.')
        }
        // Cap native concurrency; never override a user's stricter serial/worker setting.
        // Vitest's default (CPU count minus one) is not a user setting: as in workspace mode, it is replaced.
        const userSet = (c: { maxWorkers: number } & Untyped) => c.providedOptions?.maxWorkers !== false || c.fileParallelism === false
        const configuredLimit = Math.min(...[cfg, project.config].filter(userSet).map(c => c.maxWorkers), Infinity)
        if (configuredLimit < budget.maxWorkers) {
          budget.warnings.push(`Preserved Vitest's stricter ${configuredLimit}-worker limit.`)
          budget.maxWorkers = configuredLimit
        }
        cfg.maxWorkers = budget.maxWorkers
        project.config.maxWorkers = budget.maxWorkers
        project.config.allowOnly = false
      } else {
        // Vitest gives every project the root coverage and the CLI passWithNoTests, so read both from the package's own config.
        const vite = await import(pathToFileURL(require.resolve('vite')).href) as ViteLoader
        const own = new Map(await Promise.all(packages.map(async p => {
          const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'test' }, resolve(root, p.vitestConfig!), resolve(root, p.dir), 'silent')
          return [p, loaded?.config.test ?? {}] as const
        })))
        // Name each project after the discovered package that holds its root, not Vitest's default name.
        for (const project of context.projects) {
          const dir = localPath(root, project.config.root)
          const owner = packages.filter(p => dir === p.dir || dir.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]
          if (!owner) throw new Error(`Vitest project root is outside every package: ${dir}`)
          owners.set(project, owner)
          const reason = options.isolated?.includes(owner.name) ? 'isolated-in-config' : separateReason(project, own.get(owner)!)
          if (reason && !reasons.has(owner)) reasons.set(owner, reason)
        }
        for (const p of packages) if (own.get(p)!.coverage?.enabled) coverage.add(p.name)
        for (const p of packages) if (own.get(p)!.passWithNoTests === true) found.passWithNoTests.add(p)
        // A package's own worker limit, read before the shared-project code below rewrites it.
        for (const project of context.projects) {
          const owner = owners.get(project)!
          if ((project.config as Untyped).providedOptions?.maxWorkers === false) continue
          limits.set(owner.name, Math.min(limits.get(owner.name) ?? Infinity, project.config.maxWorkers))
        }
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
          // The package's own `env` wins over what its package manager would set, as in its own run.
          project.config.env = { ...packageEnv(root, owner.dir), ...project.config.env, VITEST_IMPACT_CWD: resolve(root, owner.dir) }
          project.config.setupFiles = [shim, ...project.config.setupFiles]
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
      return { context, specs: await context.globTestSpecifications() }
    } catch (error) { await context.close(); throw error }
  }

  /** Packages whose own config enables coverage, whatever else separates them. */
  coveragePackages(): Set<string> { return this.coverage }

  /** The worker limit a package sets in its own config, or undefined. */
  workerLimit(name: string): number | undefined { return this.limits.get(name) }

  /** Packages that must not run in this process. */
  separate(): { package: string; reason: string }[] { return this.separated }

  /** Vitest's own coverage setting: the single project's config (workspace mode has no root config). */
  coverageEnabled(): boolean { return this.groups.some(g => g.context.config.coverage.enabled) }

  tests(): TestFile[] {
    return this.groups.flatMap(g => g.specs).map(spec => ({ id: spec.taskId, file: localPath(this.root, spec.moduleId), project: this.owners.get(spec.project)?.name ?? spec.project.name }))
  }

  /** The tests every group relates to the paths. */
  async related(paths: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const { context, specs } of this.groups) {
      // Vitest 5.0.5 does not expose a public select-without-running API.
      // Keep the sole internal bridge isolated, version-pinned and fail-to-full.
      const internal = context as unknown as { specifications?: { filterTestsBySource?: (specs: TestSpecification[]) => Promise<TestSpecification[]> } }
      const selector = internal.specifications
      if (typeof selector?.filterTestsBySource !== 'function') throw new Error('Native selection interface unavailable')
      const previous = context.config.related
      context.config.related = paths.map(path => resolve(this.root, path))
      try { ids.push(...(await selector.filterTestsBySource(specs)).map(spec => spec.taskId)) }
      finally {
        if (previous) context.config.related = previous
        else delete context.config.related
      }
    }
    return ids
  }

  /** Runs the shared files one group after another, each with the full worker budget, and closes each group when its run ends. */
  async run(ids: Set<string>): Promise<{ files: FileResult[]; unhandledErrors: unknown[] }> {
    const apart = new Set(this.separated.map(s => s.package))
    const files: FileResult[] = []
    const unhandledErrors: unknown[] = []
    for (const group of this.groups) {
      const specs = group.specs.filter(spec => ids.has(spec.taskId) && !apart.has(this.owners.get(spec.project)?.name ?? ''))
      if (specs.length) {
        await group.context.standalone()
        const result = await group.context.runTestSpecifications(specs, specs.length === group.specs.length)
        files.push(...this.results(result))
        unhandledErrors.push(...result.unhandledErrors)
      }
      // Global teardown can set Vitest's failure status. Finish it before the next group and before results are published.
      await group.context.close()
    }
    return { files, unhandledErrors }
  }

  private results(result: TestRunResult): FileResult[] {
    return result.testModules.map(module => {
      const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 }
      for (const test of module.children.allTests()) counts[test.result().state]++
      const timedOut = [...module.children.allTests()].filter(t => t.result().errors?.some(e => TIMED_OUT.test(e.message))).map(t => t.fullName)
      const d = module.diagnostic()
      // importMs = collectDuration, environmentMs = environmentSetupDuration, setupMs = prepareDuration + setupDuration, testsMs = duration
      const phases = { importMs: d.collectDuration, environmentMs: d.environmentSetupDuration, setupMs: d.prepareDuration + d.setupDuration, testsMs: d.duration }
      return { id: module.id, file: localPath(this.root, module.moduleId), project: this.owners.get(module.project)?.name ?? module.project.name, state: module.state(), durationMs: d.duration, ...counts, phases, timedOut }
    })
  }
  async close(): Promise<void> { for (const group of this.groups) await group.context.close() }
}
