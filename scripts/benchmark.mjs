import { performance } from 'node:perf_hooks'
import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { makeFixture, put, invoke, git, projectRoot } from './fixture.mjs'

const exec = promisify(execFile)
const { values } = parseArgs({ options: { files: { type: 'string', default: '1000' }, runs: { type: 'string', default: '1' }, variants: { type: 'string' } } })
const count = Number(values.files)
const repetitions = Number(values.runs)
if (!Number.isInteger(count) || count < 20 || count > 10000 || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('Use --files 20..10000 and --runs 1..20')
const allVariants = ['native-full', 'native-selected', 'wrapper-full', 'wrapper-selected', 'wrapper-shadow']
const variants = values.variants ? values.variants.split(',') : allVariants
if (!variants.length || variants.some(v => !allVariants.includes(v))) throw new Error(`Supported variants: ${allVariants.join(',')}`)

const sample = await makeFixture({ inputs: [], ignore: [], resources: { maxWorkers: 2, workerMemoryMb: 512, reserveMemoryMb: 512 } })
const results = []
try {
  await rm(resolve(sample.root, 'test'), { recursive: true })
  await rm(resolve(sample.root, 'src'), { recursive: true })
  // Disable persistent transform caching for this cold-start synthetic experiment.
  await put(sample.root, 'vitest.config.ts', "export default { cacheDir: '.cache/vite', test: { include: ['test/**/*.test.ts'], fsModuleCache: false, maxWorkers: 2 } }\n")
  await put(sample.root, '.gitignore', 'node_modules/\n.vitest/\n.vitest-impact/\n.cache/\n')
  for (let group = 0; group < 20; group++) await put(sample.root, `src/group-${group}.ts`, `export const value = () => ${group}\n`)
  for (let i = 0; i < count; i++) {
    const group = i % 20
    await put(sample.root, `test/case-${String(i).padStart(5, '0')}.test.ts`, `import { test, expect } from 'vitest'; import { value } from '../src/group-${group}'; test('case ${i}', () => expect(value()).toBe(${group}))\n`)
  }
  await git(sample.root, 'add', '.')
  await git(sample.root, '-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'synthetic suite')
  const base = await git(sample.root, 'rev-parse', 'HEAD')
  await put(sample.root, 'src/group-0.ts', 'export const value = () => 0 + 0\n')

  for (let iteration = 0; iteration < repetitions; iteration++) {
    // Rotate execution order. One run is a scale smoke test, not a robust timing estimate.
    const order = [...variants.slice(iteration % variants.length), ...variants.slice(0, iteration % variants.length)]
    for (const variant of order) {
      await rm(resolve(sample.root, '.cache'), { recursive: true, force: true })
      await rm(resolve(sample.root, '.vitest'), { recursive: true, force: true })
      console.log(`Run ${iteration + 1}/${repetitions}: ${variant}, ${count} files...`)
      const start = performance.now()
      let report = null
      let nativeCount = count
      if (variant.startsWith('native-')) {
        await exec(process.execPath, [resolve(projectRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers', '2', '--reporter=json', '--outputFile=.cache/native.json', ...(variant === 'native-selected' ? ['--changed', base] : [])], {
          cwd: sample.root, env: { ...process.env, CI: 'true', NO_COLOR: '1' }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
        })
        nativeCount = JSON.parse(await readFile(resolve(sample.root, '.cache/native.json'), 'utf8')).testResults.length
        const expected = variant === 'native-selected' ? Math.ceil(count / 20) : count
        if (nativeCount !== expected) throw new Error(`Native execution count ${nativeCount} != ${expected}`)
      } else {
        const mode = variant.replace('wrapper-', '')
        const run = await invoke(sample.root, ['run', '--base', base, '--mode', mode], 300_000)
        if (run.code !== 0) throw new Error(run.output)
        report = run.report
        const expected = mode === 'selected' ? Math.ceil(count / 20) : count
        if (report.executed.length !== expected) throw new Error(`Wrong execution count: ${report.executed.length} != ${expected}`)
      }
      const elapsedMs = performance.now() - start
      const result = { iteration: iteration + 1, variant, elapsedMs, executedFiles: report?.executed.length ?? nativeCount, selectedFiles: report?.plan.decisions.filter(t => t.selected).length ?? nativeCount, planningMs: report?.plan.planningMs ?? null, workers: report?.plan.resources.maxWorkers ?? 2 }
      results.push(result)
      console.log(`  ${(elapsedMs / 1000).toFixed(2)}s; executed ${result.executedFiles} files`)
    }
  }
  const output = resolve(projectRoot, `.vitest-impact/benchmark${values.variants ? '-' + variants.join('-') : ''}.json`)
  await mkdir(resolve(projectRoot, '.vitest-impact'), { recursive: true })
  await writeFile(output, JSON.stringify({ createdAt: new Date().toISOString(), node: process.version, vitest: '5.0.5', files: count, groups: 20, repetitions, caveat: 'Synthetic trivial tests; cold transform caches; no real-repository recall, CI cost or p95 claim. Native baseline uses 2 workers; compare against recorded wrapper budgets.', results }, null, 2) + '\n')
  console.log(`Saved ${output}`)
} finally { await sample.cleanup() }
