import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { localPath } from './git.js'
import type { FileResult, PackageResult } from './types.js'

export type { PackageResult } from './types.js'

export function packageManager(root: string): 'pnpm' | 'yarn' | 'npm' {
  try {
    const field = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { packageManager?: unknown }).packageManager
    const name = typeof field === 'string' ? field.split('@')[0] : ''
    if (name === 'pnpm' || name === 'yarn' || name === 'npm') return name
  } catch { /* no readable package.json: fall through to the lockfile */ }
  if (existsSync(resolve(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(resolve(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

interface JsonReport { testResults?: { name: string; status: string; startTime: number; endTime: number; assertionResults?: { status: string }[] }[] }

export function parseJsonReport(json: unknown, root: string, idsByFile: Map<string, string>, project: string): FileResult[] {
  return ((json as JsonReport).testResults ?? []).map(result => {
    const file = localPath(root, result.name)
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 }
    for (const test of result.assertionResults ?? []) {
      if (test.status === 'passed') counts.passed++
      else if (test.status === 'failed') counts.failed++
      else if (test.status === 'pending') counts.pending++
      else counts.skipped++
    }
    // A file the plan does not know keeps its path as id, so the plan check reports it as unexpected.
    return { id: idsByFile.get(file) ?? file, file, project, state: result.status, durationMs: result.endTime - result.startTime, ...counts }
  })
}

export interface SeparateUnit {
  package: string
  dir: string
  kind: 'vitest' | 'script'
  /** Absolute test file paths to pass as filters. Empty runs the whole package. Ignored for scripts. */
  files: string[]
  /** Planned test files (root-relative) to their ids, for mapping the JSON report. */
  idsByFile: Map<string, string>
}

function exec(command: string, args: string[], cwd: string): Promise<{ code: number | null; error?: string }> {
  return new Promise(done => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command !== process.execPath })
    child.on('error', error => done({ code: null, error: `could not start ${command}: ${(error as NodeJS.ErrnoException).code ?? error.message}` }))
    child.on('close', code => done({ code }))
  })
}

// ponytail: separate units run one after another; run them in parallel within the budget if they dominate wall time.
export async function runSeparate(root: string, unit: SeparateUnit, maxWorkers: number, outDir: string): Promise<{ result: PackageResult; files: FileResult[]; errors: string[] }> {
  const cwd = resolve(root, unit.dir)
  const start = performance.now()
  let exitCode: number | null
  let files: FileResult[] = []
  const errors: string[] = []
  const note = (run: { code: number | null; error?: string }) => { if (run.error) errors.push(`${unit.package}: ${run.error}`); return run.code }
  if (unit.kind === 'script') {
    exitCode = note(await exec(packageManager(root), ['run', 'test'], cwd))
  } else {
    const require = createRequire(resolve(cwd, 'package.json'))
    const pkgFile = require.resolve('vitest/package.json')
    const bin = (JSON.parse(await readFile(pkgFile, 'utf8')) as { bin: string | Record<string, string> }).bin
    const vitestBin = resolve(dirname(pkgFile), typeof bin === 'string' ? bin : bin.vitest!)
    await mkdir(outDir, { recursive: true })
    const out = resolve(outDir, `${encodeURIComponent(unit.package)}.json`)
    await rm(out, { force: true })
    exitCode = note(await exec(process.execPath, [vitestBin, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, `--maxWorkers=${maxWorkers}`, '--fsModuleCache', `--fsModuleCachePath=${resolve(root, '.vitest-impact', 'cache', 'modules')}`, ...unit.files], cwd))
    // No usable report: the planned files become missingFiles, and the cause is recorded.
    let text: string | null = null
    try { text = await readFile(out, 'utf8') } catch { errors.push(`${unit.package}: no JSON report`) }
    if (text !== null) {
      try { files = parseJsonReport(JSON.parse(text), root, unit.idsByFile, unit.package) }
      catch { errors.push(`${unit.package}: JSON report did not parse`) }
    }
  }
  return { result: { name: unit.package, mode: unit.kind === 'script' ? 'script' : 'separate', exitCode, durationMs: performance.now() - start }, files, errors }
}
