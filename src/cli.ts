#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { execute } from './index.js'
import { parseShard } from './shard.js'
import { DEFAULT_CONFIG } from './config.js'
import type { ImpactConfig, RunReport } from './types.js'

const HELP = `vitest-impact — conservative Vitest execution (MVP)

Usage:
  vitest-impact init [--root PATH]
  vitest-impact plan --base REF [options]
  vitest-impact run --base REF [--mode shadow|selected|full] [options]

Options:
  --root PATH                 Git repository root (default: current directory)
  --config PATH               Impact JSON config, relative to root
  --vitest-config PATH        Vitest config, relative to root (skips workspace discovery)
  --filter PKG                Package name or ./folder-glob; ! excludes; repeatable
  --base REF                  Explicit ancestor revision; absent/invalid means full suite
  --mode MODE                 shadow (default), selected, or full
  --shard i/n                 Run only the i-th of n shares of the planned files
  --max-workers N             Worker ceiling, capped by CPU/memory estimate
  --memory-mb N               Available memory budget in MB
  --worker-memory-mb N        Estimated incremental memory per worker
  --reserve-memory-mb N       Memory kept for coordinator/services
  --help                      Show this help

Artifacts: .vitest-impact/{plan.json,report.json,summary.md}
Exit codes: 0 passed, 1 test failures, 2 configuration/infrastructure/incomplete run.
A workspace runs its Vitest packages in one process. Shadow mode runs ALL tests.
`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' }, config: { type: 'string' }, 'vitest-config': { type: 'string' },
      filter: { type: 'string', multiple: true },
      base: { type: 'string' }, shard: { type: 'string' }, mode: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      'max-workers': { type: 'string' }, 'memory-mb': { type: 'string' },
      'worker-memory-mb': { type: 'string' }, 'reserve-memory-mb': { type: 'string' },
    },
  })
  if (values.help) { console.log(HELP); return }
  const command = positionals[0]
  if (positionals.length !== 1 || !['init', 'plan', 'run'].includes(command ?? '')) throw new Error(HELP)
  if (values.mode && !['shadow', 'selected', 'full'].includes(values.mode)) throw new Error('--mode must be shadow, selected, or full')
  if (command !== 'run' && values.mode) throw new Error('--mode is only supported with run')
  if (values.shard !== undefined) parseShard(values.shard)
  const root = resolve(values.root ?? process.cwd())
  if (command === 'init') {
    const example: ImpactConfig = {
      version: 1,
      sourcePatterns: [],
      isolated: [],
      inputs: [], forceFull: [], ignore: [], alwaysRun: [],
      resources: { workerMemoryMb: 512, reserveMemoryMb: 512 },
    }
    await writeFile(resolve(root, DEFAULT_CONFIG), `${JSON.stringify(example, null, 2)}\n`, { flag: 'wx' })
    let ignore = ''
    try { ignore = await readFile(resolve(root, '.gitignore'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!ignore.split(/\r?\n/).includes('.vitest-impact/')) await appendFile(resolve(root, '.gitignore'), `${ignore.endsWith('\n') || !ignore ? '' : '\n'}.vitest-impact/\n`)
    console.log(`Created ${DEFAULT_CONFIG}. Add reviewed sourcePatterns and input rules. Until then, unclassified changes run the full suite.`)
    return
  }
  const resources: ImpactConfig['resources'] = {}
  const resourceOptions = { 'max-workers': 'maxWorkers', 'memory-mb': 'memoryBudgetMb', 'worker-memory-mb': 'workerMemoryMb', 'reserve-memory-mb': 'reserveMemoryMb' } as const
  for (const [flag, key] of Object.entries(resourceOptions)) {
    const raw = values[flag as keyof typeof resourceOptions]
    if (raw === undefined) continue
    const n = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < (key === 'reserveMemoryMb' ? 0 : 1)) throw new Error(`Invalid --${flag}: ${raw}`)
    resources[key] = n
  }
  const { plan, report } = await execute({
    root, command: command as 'plan' | 'run', resources,
    ...(values.base !== undefined ? { base: values.base } : {}),
    ...(values.config ? { config: values.config } : {}),
    ...(values['vitest-config'] ? { vitestConfig: values['vitest-config'] } : {}),
    ...(values.filter ? { filters: values.filter } : {}),
    ...(values.shard !== undefined ? { shard: values.shard } : {}),
    ...(values.mode ? { mode: values.mode as RunReport['mode'] } : {}),
  })
  console.log(`\nImpact plan: ${plan.decisions.filter(t => t.selected).length}/${plan.decisions.length} files; ${plan.mode}; ${plan.resources.maxWorkers} workers.`)
  for (const reason of plan.fallbackReasons) console.log(`  Full suite: ${reason}`)
  if (report) {
    console.log(`Executed ${report.executed.length} files in ${(report.executionMs / 1000).toFixed(2)}s (${report.mode}); ${report.validation}.`)
    if (report.missedFailingFiles.length) console.error(`Selection missed failing files: ${report.missedFailingFiles.join(', ')}`)
    process.exitCode = Math.max(Number(process.exitCode ?? 0), report.exitCode)
  }
  console.log(`Details: ${resolve(root, '.vitest-impact', report ? 'report.json' : 'plan.json')}`)
}

main().catch(error => {
  console.error(`vitest-impact: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})
