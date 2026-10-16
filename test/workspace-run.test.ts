import { afterEach, expect, test } from 'vitest'
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

test('structural packages and script packages are planned outside the shared run, which refuses until it can run them', async () => {
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
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code).toBe(2)
  expect(run.output).toContain('Separate execution is not implemented')
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
