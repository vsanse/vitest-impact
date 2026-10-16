import { afterEach, expect, test } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { makeFixture, makeWorkspaceFixture, put, invoke } from '../scripts/fixture.mjs'

const cleanups: (() => Promise<void>)[] = []
async function workspaceFixture(options: { packages?: Record<string, string>; config?: object } = {}) {
  const value = await makeWorkspaceFixture(options)
  cleanups.push(value.cleanup)
  return value
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

const config = (test: string) => `import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['test/**/*.test.ts'], ${test} } })\n`

test('runs every vitest package in one process, each with its own working folder', async () => {
  const { root } = await workspaceFixture()
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed.map(t => t.file).sort()).toEqual([
    'packages/a/test/cwd.test.ts', 'packages/a/test/same.test.ts', 'packages/a/test/unit.test.ts',
    'packages/b/test/cwd.test.ts', 'packages/b/test/same.test.ts', 'packages/b/test/unit.test.ts',
  ])
  expect(new Set(run.report.plan.decisions.map(t => t.project))).toEqual(new Set(['@w/a', '@w/b']))
})

test('--filter narrows packages; a filter that matches nothing exits 2', async () => {
  const { root } = await workspaceFixture()
  const only = await invoke(root, ['run', '--mode', 'full', '--filter', '@w/b'])
  expect(only.code, only.output).toBe(0)
  expect(only.report.executed).toHaveLength(3)
  expect(only.report.executed.every(t => t.file.startsWith('packages/b/'))).toBe(true)
  const none = await invoke(root, ['run', '--mode', 'full', '--filter', '@w/nope'])
  expect(none.code).toBe(2)
  expect(none.output).toContain('Filter matches no package: @w/nope')
})

test('a threads-pool package is planned for a separate process', async () => {
  const { root } = await workspaceFixture({ packages: { 'packages/b/vitest.config.ts': "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'threads' } })\n" } })
  const plan = await invoke(root, ['plan'])
  expect(plan.code, plan.output).toBe(0)
  expect(plan.plan.separate).toEqual([{ package: '@w/b', reason: 'pool:threads' }])
})

test('structural packages and script packages are planned outside the shared run', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/b/vitest.config.ts': config('fileParallelism: false'),
    'packages/c/package.json': JSON.stringify({ name: '@w/c', type: 'module', scripts: { test: 'vitest run' } }),
    'packages/c/vitest.config.ts': config("globalSetup: ['./global.ts']"),
    'packages/c/global.ts': 'export default () => {}\n',
    'packages/c/test/c.test.ts': "import { test } from 'vitest'; test('c', () => {})\n",
    'packages/d/package.json': JSON.stringify({ name: '@w/d', type: 'module', scripts: { test: 'vitest run' } }),
    'packages/d/vitest.config.ts': config('typecheck: { enabled: true }'),
    'packages/d/test/d.test.ts': "import { test } from 'vitest'; test('d', () => {})\n",
    'packages/e/package.json': JSON.stringify({ name: '@w/e', scripts: { test: 'node check.mjs' } }),
    'packages/e/check.mjs': 'process.exit(0)\n',
  } })
  const plan = await invoke(root, ['plan'])
  expect(plan.code, plan.output).toBe(0)
  expect(plan.plan.separate).toEqual([
    { package: '@w/b', reason: 'file-parallelism-off' },
    { package: '@w/c', reason: 'global-setup' },
    { package: '@w/d', reason: 'typecheck' },
  ])
  expect(plan.plan.scripts).toEqual(['@w/e'])
  expect(plan.plan.packages).toEqual(['@w/a', '@w/b', '@w/c', '@w/d', '@w/e'])
  const run = await invoke(root, ['run', '--mode', 'full'], 60_000)
  expect(run.code, run.output).toBe(0)
  expect(run.report.packages.map(p => [p.name, p.mode, p.exitCode]).sort()).toEqual([
    ['@w/a', 'shared', null], ['@w/b', 'separate', 0], ['@w/c', 'separate', 0], ['@w/d', 'separate', 0], ['@w/e', 'script', 0],
  ])
})

test('a package keeps its own lower worker limit without lowering the budget', async () => {
  // isolate: false, because Vitest already runs an isolated 1-worker project in a group of its own.
  const { root } = await workspaceFixture({ packages: { 'packages/a/vitest.config.ts': config('maxWorkers: 1, isolate: false') } })
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed).toHaveLength(6)
  expect(run.plan.resources.maxWorkers).toBe(2)
  expect(run.plan.resources.warnings).toContain("Kept @w/a's 1-worker limit.")
})

test('packages that reuse workers (isolate: false) still run in their own folders', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/a/vitest.config.ts': config('isolate: false'),
    'packages/b/vitest.config.ts': config('isolate: false'),
  } })
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed.filter(t => t.file.endsWith('/cwd.test.ts')).map(t => [t.file, t.state])).toEqual([
    ['packages/a/test/cwd.test.ts', 'passed'], ['packages/b/test/cwd.test.ts', 'passed'],
  ])
})

test('a package with coverage enabled in its own config runs in its own process', async () => {
  const { root } = await workspaceFixture({ packages: { 'packages/b/vitest.config.ts': config('coverage: { enabled: true }') } })
  const plan = await invoke(root, ['plan'])
  expect(plan.code, plan.output).toBe(0)
  expect(plan.plan.separate).toEqual([{ package: '@w/b', reason: 'coverage' }])
})

test('a package with no test files is left out only when its config sets passWithNoTests', async () => {
  const empty = (config: string) => ({
    'packages/c/package.json': JSON.stringify({ name: '@w/c', type: 'module', scripts: { test: 'vitest run' } }),
    'packages/c/vitest.config.ts': config,
  })
  const { root } = await workspaceFixture({ packages: empty(config('passWithNoTests: true')) })
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.emptyPackages).toEqual(['@w/c'])
  expect(run.report.executed).toHaveLength(6)
  const strict = await workspaceFixture({ packages: empty(config('')) })
  const failed = await invoke(strict.root, ['plan'])
  expect(failed.code).toBe(2)
  expect(failed.output).toContain('No test files discovered in @w/c')
})

test('selection maps a changed source file to its own package tests', async () => {
  const { root, base } = await workspaceFixture()
  await put(root, 'packages/a/src/index.ts', "export const name = 'a' as string\n")
  const plan = await invoke(root, ['plan', '--base', base])
  expect(plan.code, plan.output).toBe(0)
  expect(plan.plan.decisions.filter(t => t.selected).map(t => t.file)).toEqual(['packages/a/test/unit.test.ts'])
})

test('filters need a workspace, and must leave a package with tests', async () => {
  const single = await makeFixture()
  cleanups.push(single.cleanup)
  const noWorkspace = await invoke(single.root, ['plan', '--filter', 'x'])
  expect(noWorkspace.code).toBe(2)
  expect(noWorkspace.output).toContain('--filter needs a workspace (pnpm-workspace.yaml or package.json workspaces)')
  const { root } = await workspaceFixture()
  const empty = await invoke(root, ['plan', '--filter', '!@w/a', '--filter', '!@w/b'])
  expect(empty.code).toBe(2)
  expect(empty.output).toContain('No package with tests matches the filters')
  const scriptless = await workspaceFixture({ packages: {
    'packages/a/package.json': JSON.stringify({ name: '@w/a' }),
    'packages/b/package.json': JSON.stringify({ name: '@w/b' }),
  } })
  const none = await invoke(scriptless.root, ['plan'])
  expect(none.code).toBe(2)
  expect(none.output).toContain('No workspace package has a Vitest test script. Use --vitest-config for a suite run from one root config.')
})

test('an isolated package runs in its own process and joins the report', async () => {
  const { root } = await workspaceFixture({ config: { isolated: ['@w/b'] } })
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.separate).toEqual([{ package: '@w/b', reason: 'isolated-in-config' }])
  expect(run.report.packages.find(p => p.name === '@w/b')).toMatchObject({ mode: 'separate', exitCode: 0 })
  expect(run.report.executed.filter(t => t.project === '@w/b')).toHaveLength(3)
  expect(run.report.executed.filter(t => t.project === '@w/a')).toHaveLength(3)
})

test('an isolated name that is not a package exits 2', async () => {
  const { root } = await workspaceFixture({ config: { isolated: ['@w/nope'] } })
  const run = await invoke(root, ['plan'])
  expect(run.code).toBe(2)
  expect(run.output).toContain('isolated package not found: @w/nope')
})

test('a failing script package fails the run with exit 1', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/c/package.json': JSON.stringify({ name: '@w/c', scripts: { test: 'node fail.mjs' } }),
    'packages/c/fail.mjs': 'process.exit(3)\n' } })
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code).toBe(1)
  expect(run.report.packages.find(p => p.name === '@w/c')).toMatchObject({ mode: 'script', exitCode: 3 })
})

test('a separate package whose process exits non-zero fails the run even when every test passed', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/b/vitest.config.ts': config("pool: 'threads'"),
    'packages/b/test/late.test.ts': "import { test } from 'vitest'; test('late error', async () => { setTimeout(() => { throw new Error('late') }, 0); await new Promise(r => setTimeout(r, 200)) })\n",
  } })
  const run = await invoke(root, ['run', '--mode', 'full'], 60_000)
  expect(run.code, run.output).toBe(1)
  const b = run.report.packages.find(p => p.name === '@w/b')
  expect(b.mode).toBe('separate')
  expect(b.exitCode).not.toBe(0)
  const bFiles = run.report.executed.filter(t => t.project === '@w/b')
  expect(bFiles).toHaveLength(4)
  expect(bFiles.every(t => t.failed === 0)).toBe(true)
})

test('a workspace whose only package is a script package plans and runs it', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/a/package.json': JSON.stringify({ name: '@w/a' }), 'packages/b/package.json': JSON.stringify({ name: '@w/b' }),
    'packages/c/package.json': JSON.stringify({ name: '@w/c', scripts: { test: 'node ok.mjs' } }),
    'packages/c/ok.mjs': 'process.exit(0)\n' } })
  const plan = await invoke(root, ['plan'])
  expect(plan.code, plan.output).toBe(0)
  expect(plan.plan.scripts).toEqual(['@w/c'])
  const run = await invoke(root, ['run'])
  expect(run.code, run.output).toBe(0)
  expect(run.report.packages).toMatchObject([{ name: '@w/c', mode: 'script', exitCode: 0 }])
})

test('selected mode skips a separate package with no selected files; a coverage package runs in full', async () => {
  const { root, base } = await workspaceFixture({ packages: { 'packages/b/vitest.config.ts': config("pool: 'threads'") } })
  await put(root, 'packages/a/src/index.ts', "export const name = 'a' as string\n")
  const run = await invoke(root, ['run', '--mode', 'selected', '--base', base])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed.map(t => t.file)).toEqual(['packages/a/test/unit.test.ts'])
  expect(run.report.packages.map(p => p.name)).toEqual(['@w/a'])
  const cov = await workspaceFixture({ packages: { 'packages/b/vitest.config.ts': config('coverage: { enabled: true }') } })
  await put(cov.root, 'packages/a/src/index.ts', "export const name = 'a' as string\n")
  const plan = await invoke(cov.root, ['plan', '--base', cov.base])
  const b = plan.plan.decisions.filter(t => t.project === '@w/b')
  expect(b).toHaveLength(3)
  expect(b.every(t => t.selected && t.reasons.includes('coverage: package runs in full'))).toBe(true)
  expect(plan.plan.decisions.filter(t => t.project === '@w/a' && t.selected)).toHaveLength(1)
})

test('a coverage package that is also separate for another reason still runs in full', async () => {
  const { root, base } = await workspaceFixture({ packages: { 'packages/b/vitest.config.ts': config("pool: 'threads', coverage: { enabled: true }") } })
  await put(root, 'packages/a/src/index.ts', "export const name = 'a' as string\n")
  const plan = await invoke(root, ['plan', '--base', base])
  expect(plan.plan.separate).toEqual([{ package: '@w/b', reason: 'pool:threads' }])
  const b = plan.plan.decisions.filter(t => t.project === '@w/b')
  expect(b).toHaveLength(3)
  expect(b.every(t => t.selected && t.reasons.includes('coverage: package runs in full'))).toBe(true)
})

test('a separate package keeps its own lower worker limit', async () => {
  const slow = (name: string) => `import { test } from 'vitest'; import { appendFileSync } from 'node:fs'
test('${name}', async () => { appendFileSync('log.txt', 's\\n'); await new Promise(r => setTimeout(r, 700)); appendFileSync('log.txt', 'e\\n') })\n`
  const { root } = await workspaceFixture({ packages: {
    'packages/b/vitest.config.ts': config("pool: 'threads', maxWorkers: 1"),
    'packages/b/test/slow1.test.ts': slow('one'),
    'packages/b/test/slow2.test.ts': slow('two'),
  } })
  const run = await invoke(root, ['run', '--mode', 'full'], 60_000)
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed.filter(t => t.project === '@w/b')).toHaveLength(5)
  // One worker: the two slow files never overlap (s e s e). With the budget's 2 workers it would be s s e e.
  expect(await readFile(resolve(root, 'packages/b/log.txt'), 'utf8')).toBe('s\ne\ns\ne\n')
})

test('a separate process that exits before writing its report leaves no stale result behind', async () => {
  const setup = (body: string) => ({
    'packages/b/vitest.config.ts': config("pool: 'threads', globalSetup: ['./global.ts']"),
    'packages/b/global.ts': `export default () => { ${body} }\n`,
  })
  const { root } = await workspaceFixture({ packages: setup('') })
  const first = await invoke(root, ['run', '--mode', 'full'], 60_000)
  expect(first.code, first.output).toBe(0)
  await put(root, 'packages/b/global.ts', 'export default () => { process.exit(0) }\n')
  const second = await invoke(root, ['run', '--mode', 'full'], 60_000)
  expect(second.code, second.output).toBe(2)
  expect(second.report.missingFiles.sort()).toEqual(['packages/b/test/cwd.test.ts', 'packages/b/test/same.test.ts', 'packages/b/test/unit.test.ts'])
  expect(second.report.unhandledErrors).toContain('@w/b: no JSON report')
})

test('a shard with no files exits 0 and says so', async () => {
  const { root } = await workspaceFixture()
  const run = await invoke(root, ['run', '--mode', 'full', '--filter', '@w/a', '--shard', '4/4'])
  // @w/a has 3 files: size 1, shard 4 is empty
  expect(run.code, run.output).toBe(0)
  expect(run.output).toContain('Shard 4/4 has no test files.')
  const report = JSON.parse(await readFile(resolve(root, '.vitest-impact/report.json'), 'utf8'))
  expect(report).toMatchObject({ exitCode: 0, missingFiles: [], unexpectedFiles: [], executed: [] })
  await readFile(resolve(root, '.vitest-impact/summary.md'), 'utf8')
})

test('selected mode shards the selected files, not all files', async () => {
  const { root, base } = await workspaceFixture()
  await put(root, 'packages/a/src/index.ts', "export const name = 'a' as string\n")
  await put(root, 'packages/b/src/index.ts', "export const name = 'b' as string\n")
  const seen: string[] = []
  const sizes: number[] = []
  for (const i of [1, 2, 3]) {
    const run = await invoke(root, ['run', '--mode', 'selected', '--base', base, '--shard', `${i}/3`])
    expect(run.code, run.output).toBe(0)
    sizes.push(run.report.executed.length)
    expect(run.report.missingFiles).toEqual([])
    expect(run.report.unexpectedFiles).toEqual([])
    seen.push(...run.report.executed.map(t => t.file))
  }
  expect(sizes).toEqual([1, 1, 0]) // ceil(2 selected / 3) = 1 per shard
  expect(seen.sort()).toEqual(['packages/a/test/unit.test.ts', 'packages/b/test/unit.test.ts'])
})

test('a script package runs in exactly one shard and is not missing in the other', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/e/package.json': JSON.stringify({ name: '@w/e', scripts: { test: 'node check.mjs' } }),
    'packages/e/check.mjs': 'process.exit(0)\n',
  } })
  const ran: boolean[] = []
  for (const i of [1, 2]) {
    const run = await invoke(root, ['run', '--mode', 'full', '--shard', `${i}/2`])
    expect(run.code, run.output).toBe(0)
    expect(run.report.missingFiles).toEqual([])
    ran.push(run.report.packages.some(p => p.name === '@w/e'))
  }
  expect(ran.filter(Boolean)).toHaveLength(1)
})

test('shards together run every file once with a clean report', async () => {
  const { root } = await workspaceFixture()
  const seen: string[] = []
  for (const i of [1, 2]) {
    const run = await invoke(root, ['run', '--mode', 'full', '--shard', `${i}/2`])
    expect(run.code, run.output).toBe(0)
    const report = JSON.parse(await readFile(resolve(root, '.vitest-impact/report.json'), 'utf8'))
    expect(report.plan.shard).toEqual({ index: i, count: 2 })
    expect(report.missingFiles).toEqual([])
    expect(report.unexpectedFiles).toEqual([])
    seen.push(...report.executed.map((f: { file: string }) => f.file))
  }
  const plan = await invoke(root, ['plan'])
  expect(plan.code, plan.output).toBe(0)
  const all = JSON.parse(await readFile(resolve(root, '.vitest-impact/plan.json'), 'utf8')).decisions.map((d: { file: string }) => d.file)
  expect(seen.sort()).toEqual(all.sort())
})

test('check finds a package that fails only in the shared process, and --write records it', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/b/test/env.test.ts': "import { test, expect } from 'vitest'; test('alone only', () => expect(process.env.VITEST_IMPACT_CWD).toBeUndefined())\n" } })
  const check = await invoke(root, ['check', '--write'], 90_000)
  expect(check.code, check.output).toBe(0)
  expect(check.output).toContain('@w/b: shared failed, alone passed -> isolated candidate')
  const config = JSON.parse(await readFile(resolve(root, 'vitest-impact.config.json'), 'utf8'))
  expect(config.isolated).toEqual(['@w/b'])
  expect(config.sourcePatterns).toEqual(['packages/*/src/**/*.ts'])
  const run = await invoke(root, ['run', '--mode', 'full'], 90_000)
  expect(run.code, run.output).toBe(0)
})

test('check: a package that fails shared and alone is a real failure (exit 1)', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/b/test/bad.test.ts': "import { test, expect } from 'vitest'; test('bad', () => expect(1).toBe(2))\n" } })
  const check = await invoke(root, ['check'], 90_000)
  expect(check.code, check.output).toBe(1)
  expect(check.output).toContain('@w/b: shared failed, alone failed -> real failure')
})

test('check: a failing structural package is reported and exits 1', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/b/vitest.config.ts': "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'threads' } })\n",
    'packages/b/test/bad.test.ts': "import { test, expect } from 'vitest'; test('bad', () => expect(1).toBe(2))\n" } })
  const check = await invoke(root, ['check'], 90_000)
  expect(check.code, check.output).toBe(1)
  expect(check.output).toContain('@w/b: runs alone (structural: pool:threads), failed -> real failure')
})

test('check: a test file that throws at import is a real failure', async () => {
  const { root } = await workspaceFixture({ packages: { 'packages/b/test/boom.test.ts': "throw new Error('boom')\n" } })
  const check = await invoke(root, ['check'], 90_000)
  expect(check.code, check.output).toBe(1)
  expect(check.output).toContain('@w/b: shared failed, alone failed -> real failure')
})

test('check: a separate process that exits without a report is an incomplete run (exit 2)', async () => {
  const { root } = await workspaceFixture({ packages: {
    'packages/b/vitest.config.ts': config("pool: 'threads', globalSetup: ['./global.ts']"),
    'packages/b/global.ts': 'export default () => { process.exit(0) }\n' } })
  const check = await invoke(root, ['check'], 90_000)
  expect(check.code, check.output).toBe(2)
  expect(check.output).toContain('check: the run was incomplete')
})

test('check --write merges into an existing isolated list, sorted', async () => {
  const { root } = await workspaceFixture({
    config: { isolated: ['@w/z'] },
    packages: {
      'packages/z/package.json': JSON.stringify({ name: '@w/z', type: 'module', scripts: { test: 'vitest run' } }),
      'packages/z/vitest.config.ts': "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })\n",
      'packages/z/test/z.test.ts': "import { test } from 'vitest'; test('z', () => {})\n",
      'packages/b/test/env.test.ts': "import { test, expect } from 'vitest'; test('alone only', () => expect(process.env.VITEST_IMPACT_CWD).toBeUndefined())\n" } })
  const check = await invoke(root, ['check', '--write'], 90_000)
  expect(check.code, check.output).toBe(0)
  const config = JSON.parse(await readFile(resolve(root, 'vitest-impact.config.json'), 'utf8'))
  expect(config.isolated).toEqual(['@w/b', '@w/z'])
})

test('runs keep their module cache in .vitest-impact/cache across invocations', async () => {
  const { root } = await workspaceFixture()
  expect((await invoke(root, ['run', '--mode', 'full'])).code).toBe(0)
  expect((await readdir(resolve(root, '.vitest-impact/cache/modules'))).length).toBeGreaterThan(0)
  expect((await readdir(resolve(root, '.vitest-impact/cache/vite'), { recursive: true })).some(f => f.endsWith('results.json'))).toBe(true)
  expect((await invoke(root, ['run', '--mode', 'full'])).code).toBe(0)
})

test('a package with fsModuleCache: false is planned separate and the shared cache still fills', async () => {
  const { root } = await workspaceFixture({ packages: { 'packages/b/vitest.config.ts': config('fsModuleCache: false') } })
  const plan = await invoke(root, ['plan'])
  expect(plan.plan.separate).toEqual([{ package: '@w/b', reason: 'fs-module-cache-off' }])
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code, run.output).toBe(0)
  expect((await readdir(resolve(root, '.vitest-impact/cache/modules'))).filter(f => /^[0-9a-f]{40}$/.test(f)).length).toBeGreaterThan(0)
})

test('shared, separate and script units see the environment they get without the tool', async () => {
  const nodeEnv = "import { test, expect } from 'vitest'; test('node env', () => expect(process.env.NODE_ENV).toBe('test'))\n"
  const flagged = (x: string) => `import { defineConfig } from 'vitest/config'; export default defineConfig({ define: { __CONFIG_VITEST__: JSON.stringify(process.env.VITEST ?? 'unset') }, test: { include: ['test/**/*.test.ts'], ${x} } })\n`
  const flag = "import { test, expect } from 'vitest'; declare const __CONFIG_VITEST__: string; test('config saw VITEST', () => expect(__CONFIG_VITEST__).toBe('true'))\n"
  const { root } = await workspaceFixture({ packages: {
    'packages/a/vitest.config.ts': flagged(''), 'packages/a/test/env.test.ts': nodeEnv, 'packages/a/test/flag.test.ts': flag,
    'packages/b/vitest.config.ts': flagged("pool: 'threads'"), 'packages/b/test/env.test.ts': nodeEnv, 'packages/b/test/flag.test.ts': flag,
    'packages/e/package.json': JSON.stringify({ name: '@w/e', scripts: { test: 'node check.mjs' } }),
    // The package manager sets neither, so the script sees the shell's values (unset), not the tool's.
    'packages/e/check.mjs': 'process.exit(process.env.NODE_ENV === undefined && process.env.VITEST === undefined ? 0 : 1)\n',
  } })
  const run = await invoke(root, ['run', '--mode', 'full'], 60_000)
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed.filter(t => /\/(env|flag)\.test\.ts$/.test(t.file)).map(t => [t.file, t.state]).sort()).toEqual([
    ['packages/a/test/env.test.ts', 'passed'], ['packages/a/test/flag.test.ts', 'passed'],
    ['packages/b/test/env.test.ts', 'passed'], ['packages/b/test/flag.test.ts', 'passed'],
  ])
  expect(run.report.packages.find(p => p.name === '@w/e')).toMatchObject({ mode: 'script', exitCode: 0 })
})
