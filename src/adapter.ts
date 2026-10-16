import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TestSpecification, Vitest, TestRunResult } from 'vitest/node'
import { localPath } from './git.js'
import { versionPolicy } from './version.js'
import type { FileResult, ResourceBudget, TestFile } from './types.js'

export class VitestAdapter {
  private constructor(readonly context: Vitest, readonly root: string, readonly specs: TestSpecification[], readonly version: string, readonly versionWarning?: string) {}

  static async open(root: string, budget: ResourceBudget, config?: string): Promise<VitestAdapter> {
    const require = createRequire(resolve(root, 'package.json'))
    const pkg = require('vitest/package.json') as { version: string }
    const policy = versionPolicy(pkg.version)
    if (!policy.ok) throw new Error(policy.error)
    const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')).href) as typeof import('vitest/node')
    const context = await createVitest({
      root,
      ...(config ? { config: resolve(root, config) } : {}),
      watch: false,
      run: true,
      allowOnly: false,
      dangerouslyIgnoreUnhandledErrors: false,
      bail: 0,
      passWithNoTests: false,
      update: false,
      experimental: { recordDependencies: false },
    })
    try {
      if (context.projects.length !== 1) throw new Error('MVP supports exactly one Vitest project. Run each project separately with an outer concurrency budget.')
      const project = context.projects[0]!
      const cfg = context.config
      if (cfg.changed || cfg.related || cfg.shard || cfg.testNamePattern || cfg.tagsFilter?.length || cfg.project?.length) {
        throw new Error('Remove Vitest changed/related/shard/project/name/tag filters: vitest-impact must discover the entire configured suite.')
      }
      if (project.config.testNamePattern || project.config.tagsFilter?.length) throw new Error('Project-level name/tag filters are not supported.')
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
      const specs = await context.globTestSpecifications()
      if (!specs.length) throw new Error('No test files discovered. Refusing an empty successful run.')
      return new VitestAdapter(context, root, specs, pkg.version, policy.selection ? undefined : policy.warning)
    } catch (error) { await context.close(); throw error }
  }

  tests(): TestFile[] {
    return this.specs.map(spec => ({ id: spec.taskId, file: localPath(this.root, spec.moduleId), project: spec.project.name }))
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
    const specs = this.specs.filter(spec => ids.has(spec.taskId))
    if (!specs.length) return { testModules: [], unhandledErrors: [] }
    await this.context.standalone()
    return this.context.runTestSpecifications(specs, specs.length === this.specs.length)
  }

  results(result: TestRunResult): FileResult[] {
    return result.testModules.map(module => {
      const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 }
      for (const test of module.children.allTests()) counts[test.result().state]++
      return { id: module.id, file: localPath(this.root, module.moduleId), state: module.state(), durationMs: module.diagnostic().duration, ...counts }
    })
  }
  close(): Promise<void> { return this.context.close() }
}
