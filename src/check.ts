import { resolve } from 'node:path'
import { execute } from './index.js'
import { loadConfig } from './config.js'
import { runSeparate } from './separate.js'
import { budgetResources } from './resources.js'
import { discoverPackages } from './workspace.js'

export interface CheckResult { package: string; shared: 'passed' | 'failed'; alone: 'passed' | 'failed' | 'not-run' }

/** One shared run that ignores the `isolated` list; each package with a failed file is then run alone. */
export async function checkIsolation(root: string, options: { filters: string[]; config?: string; vitestConfig?: string }): Promise<CheckResult[]> {
  root = resolve(root)
  const { plan, report } = await execute({
    root, command: 'run', mode: 'full', ignoreIsolated: true, filters: options.filters,
    ...(options.config ? { config: options.config } : {}),
    ...(options.vitestConfig ? { vitestConfig: options.vitestConfig } : {}),
  })
  if (!report) throw new Error('check: the shared run produced no report')
  const apart = new Set(plan.separate.map(s => s.package))
  const names = [...new Set(report.executed.filter(f => report.packages.some(p => p.name === f.project && p.mode === 'shared')).map(f => f.project))].sort()
  const failed = new Set(report.executed.filter(f => f.state === 'failed').map(f => f.project))
  const dirs = new Map((await discoverPackages(root)).map(p => [p.name, p.dir]))
  const resources = budgetResources({ ...(await loadConfig(root, options.config)).config.resources })
  const results: CheckResult[] = []
  for (const name of names) {
    if (apart.has(name)) continue
    if (!failed.has(name)) { results.push({ package: name, shared: 'passed', alone: 'not-run' }); continue }
    const tests = plan.decisions.filter(t => t.project === name)
    const unit = { package: name, dir: dirs.get(name)!, kind: 'vitest' as const, files: [], idsByFile: new Map(tests.map(t => [t.file, t.id] as const)) }
    const { result } = await runSeparate(root, unit, resources.maxWorkers, resolve(root, '.vitest-impact', 'check'))
    results.push({ package: name, shared: 'failed', alone: result.exitCode === 0 ? 'passed' : 'failed' })
  }
  return results
}
