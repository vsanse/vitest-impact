import { afterEach, expect, test } from 'vitest'
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { makeFixture, put, invoke, git, projectRoot } from '../scripts/fixture.mjs'

const cleanups: (() => Promise<void>)[] = []
async function fixture(options = {}) {
  const value = await makeFixture(options)
  cleanups.push(value.cleanup)
  return value
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

test('native selection executes one exact test file and preserves passing status', async () => {
  const { root, base } = await fixture()
  await put(root, 'src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  const run = await invoke(root, ['run', '--base', base, '--mode', 'selected'])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed.map(t => t.file)).toEqual(['test/math.test.ts'])
  expect(run.report.plan.mode).toBe('selective')
})

test('shadow is the default: runs all files without claiming measured recall', async () => {
  const { root, base } = await fixture()
  await put(root, 'src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  const run = await invoke(root, ['run', '--base', base])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed).toHaveLength(3)
  expect(run.report.plan.decisions.filter(t => t.selected)).toHaveLength(1)
  expect(run.report.validation).toBe('no-failures-observed')
  expect(run.report.observedFailureRecall).toBeNull()
})

test('declared filesystem input selects its owner and propagates a real failure', async () => {
  const { root, base } = await fixture()
  await put(root, 'fixtures/rate.txt', '99\n')
  const run = await invoke(root, ['run', '--base', base, '--mode', 'selected'])
  expect(run.code, run.output).toBe(1)
  expect(run.report.executed.map(t => t.file)).toEqual(['test/fixture.test.ts'])
  expect(run.report.executed[0].failed).toBe(1)
})

test('shadow identifies a miss caused by an intentionally unsafe ignore contract', async () => {
  const { root, base } = await fixture({ inputs: [], ignore: ['fixtures/**'] })
  await put(root, 'fixtures/rate.txt', '99\n')
  await put(root, 'src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  const run = await invoke(root, ['run', '--base', base])
  expect(run.code, run.output).toBe(1)
  expect(run.report.validation).toBe('missed-failures')
  expect(run.report.missedFailingFiles).toEqual(['test/fixture.test.ts'])
})

test('a deleted imported file forces full execution and reports collection failure', async () => {
  const { root, base } = await fixture()
  await rm(resolve(root, 'src/math.ts'))
  const run = await invoke(root, ['run', '--base', base, '--mode', 'selected'])
  expect(run.code, run.output).toBe(1)
  expect(run.report.executed).toHaveLength(3)
  expect(run.plan.fallbackReasons.some(r => r.startsWith('structural-change'))).toBe(true)
})

test('an invalid revision broadens to full rather than treating diff failure as no changes', async () => {
  const { root } = await fixture()
  const run = await invoke(root, ['run', '--base', 'missing-branch', '--mode', 'selected'])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed).toHaveLength(3)
  expect(run.plan.fallbackReasons[0]).toContain('git-unavailable')
})

test('plan does not execute test bodies; newly added tests are included', async () => {
  const { root, base } = await fixture()
  await put(root, 'test/new.test.ts', "import { test } from 'vitest'; test('must not execute', () => { throw new Error('executed') })\n")
  const run = await invoke(root, ['plan', '--base', base])
  expect(run.code, run.output).toBe(0)
  expect(run.report).toBeNull()
  expect(run.plan.decisions.find(t => t.file === 'test/new.test.ts').selected).toBe(true)
})

test('includes both committed PR changes and uncommitted edits since the base', async () => {
  const { root, base } = await fixture()
  await put(root, 'src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  await git(root, 'add', 'src/math.ts')
  await git(root, '-c', 'user.name=Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'math change')
  await put(root, 'src/strings.ts', 'export const upper = (s: string) => String(s).toUpperCase()\n')
  const run = await invoke(root, ['plan', '--base', base])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.decisions.filter(t => t.selected).map(t => t.file)).toEqual(['test/math.test.ts', 'test/strings.test.ts'])
})

test('invalid configuration exits nonzero and clears stale success artifacts', async () => {
  const { root, base } = await fixture()
  await put(root, '.vitest-impact/report.json', '{"exitCode":0}')
  await put(root, 'vitest-impact.config.json', '{"version":1,"typo":true}')
  const run = await invoke(root, ['run', '--base', base])
  expect(run.code).toBe(2)
  expect(run.report).toBeNull()
  expect(run.output).toContain('Unknown config option')
})

test('native analysis respects aliases and transitive imports', async () => {
  const { root } = await fixture()
  await put(root, 'vitest.config.ts', "import { defineConfig } from 'vitest/config'; import { fileURLToPath } from 'node:url'; export default defineConfig({ resolve: { alias: { '@src': fileURLToPath(new URL('./src', import.meta.url)) } }, test: { include: ['test/**/*.test.ts'] } })\n")
  await put(root, 'src/barrel.ts', "export { add } from '@src/math'\n")
  await put(root, 'test/math.test.ts', "import { test, expect } from 'vitest'; import { add } from '@src/barrel'; test('adds transitively', () => expect(add(2, 3)).toBe(5))\n")
  await git(root, 'add', '.')
  await git(root, '-c', 'user.name=Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'alias setup')
  const base = await git(root, 'rev-parse', 'HEAD')
  await put(root, 'src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  const run = await invoke(root, ['run', '--base', base, '--mode', 'selected'])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed.map(t => t.file)).toEqual(['test/math.test.ts'])
})

test('a configured name filter is rejected instead of claiming full validation', async () => {
  const { root, base } = await fixture()
  await put(root, 'vitest.config.ts', "export default { test: { testNamePattern: 'adds', include: ['test/**/*.test.ts'] } }\n")
  const run = await invoke(root, ['run', '--base', base])
  expect(run.code).toBe(2)
  expect(run.report).toBeNull()
  expect(run.output).toContain('filters')
})

test('coverage mode plans the full suite even for a small source change', async () => {
  const { root } = await fixture()
  await put(root, 'vitest.config.ts', "export default { test: { coverage: { enabled: true }, include: ['test/**/*.test.ts'] } }\n")
  await git(root, 'add', '.')
  await git(root, '-c', 'user.name=Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'coverage config')
  const base = await git(root, 'rev-parse', 'HEAD')
  await put(root, 'src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  const run = await invoke(root, ['plan', '--base', base])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.mode).toBe('full')
  expect(run.plan.fallbackReasons.join(' ')).toContain('coverage-enabled')
})

test('docs-only changes allow zero execution after valid discovery', async () => {
  const { root, base } = await fixture()
  await put(root, 'docs/readme.md', 'Documentation change\n')
  const run = await invoke(root, ['run', '--base', base, '--mode', 'selected'])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.decisions).toHaveLength(3)
  expect(run.plan.mode).toBe('empty')
  expect(run.report.executed).toEqual([])
})

test('test.only cannot make a full shadow run silently narrower', async () => {
  const { root, base } = await fixture()
  await put(root, 'test/math.test.ts', "import { test } from 'vitest'; test.only('focused', () => {})\n")
  const run = await invoke(root, ['run', '--base', base])
  expect(run.code, run.output).toBe(1)
  expect(run.report.exitCode).toBe(1)
})

test('active run lock is respected without deleting the owning run artifacts', async () => {
  const { root, base } = await fixture()
  await put(root, '.vitest-impact/run.lock', JSON.stringify({ pid: process.pid }))
  await put(root, '.vitest-impact/report.json', '{"owner":"other"}')
  const run = await invoke(root, ['run', '--base', base])
  expect(run.code).toBe(2)
  expect(run.output).toContain('Another invocation')
  expect(run.report.owner).toBe('other')
})

test('empty discovery is an error rather than a green run', async () => {
  const { root, base } = await fixture()
  await rm(resolve(root, 'test'), { recursive: true })
  const run = await invoke(root, ['run', '--base', base])
  expect(run.code).toBe(2)
  expect(run.output).toContain('No test files')
})

test('global teardown failures are included in the saved exit status', async () => {
  const { root, base } = await fixture()
  await put(root, 'vitest.config.ts', "export default { test: { globalSetup: ['./global.ts'], include: ['test/**/*.test.ts'] } }\n")
  await put(root, 'global.ts', "export default () => () => { throw new Error('teardown broke') }\n")
  const run = await invoke(root, ['run', '--base', base])
  expect(run.code, run.output).toBe(1)
  expect(run.report.exitCode).toBe(1)
  expect(run.report.runLevelFailure).toBe(true)
})

test('aborts a plan if a config plugin writes source files during discovery', async () => {
  const { root, base } = await fixture()
  await put(root, 'vitest.config.ts', "import { writeFileSync } from 'node:fs'; writeFileSync('src/generated.ts', 'export const generated = 1'); export default { test: { include: ['test/**/*.test.ts'] } }\n")
  const run = await invoke(root, ['plan', '--base', base])
  expect(run.code, run.output).toBe(2)
  expect(run.output).toContain('Workspace changed during planning')
  expect(run.plan).toBeNull()
})

test('preserves native serial execution instead of enabling parallelism', async () => {
  const { root, base } = await fixture()
  await put(root, 'vitest.config.ts', "export default { test: { fileParallelism: false, include: ['test/**/*.test.ts'] } }\n")
  const run = await invoke(root, ['run', '--base', base, '--max-workers', '2'])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.resources.maxWorkers).toBe(1)
})

test('a single-project run sets NODE_ENV to test, as plain vitest does', async () => {
  const { root } = await fixture()
  await put(root, 'test/env.test.ts', "import { test, expect } from 'vitest'; test('node env', () => expect(process.env.NODE_ENV).toBe('test'))\n")
  const run = await invoke(root, ['run', '--mode', 'full'])
  expect(run.code, run.output).toBe(0)
  expect(run.report.executed.find(t => t.file === 'test/env.test.ts').state).toBe('passed')
})

test("a single project that sets no maxWorkers gets the budget, not Vitest's default", async () => {
  const { root } = await fixture()
  await put(root, 'vitest.config.ts', "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })\n")
  // Vitest's default is the CPU count minus one, which the old code kept as if the project had set it.
  const run = await invoke(root, ['plan', '--max-workers', String(availableParallelism())])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.resources.maxWorkers).toBe(run.plan.resources.availableCpu)
  expect(run.plan.resources.warnings.join(' ')).not.toContain('Preserved')
})

test('a root Vitest config with several projects is refused with a message that says so', async () => {
  const { root } = await fixture()
  await put(root, 'vitest.config.ts', "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { projects: [{ test: { name: 'one', include: ['test/math.test.ts'] } }, { test: { name: 'two', include: ['test/strings.test.ts'] } }] } })\n")
  const run = await invoke(root, ['plan', '--vitest-config', 'vitest.config.ts'])
  expect(run.code).toBe(2)
  expect(run.output).toContain('A root Vitest config with several projects (test.projects) is not supported yet.')
})

test('the plan carries the package version and no outdated cache warning', async () => {
  const { root } = await fixture()
  const run = await invoke(root, ['plan'])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.toolVersion).toBe(JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8')).version)
  expect(run.plan.warnings.join(' ')).not.toContain('result cache')
  expect(run.plan.warnings).toContain('No dependency records are kept between runs yet. Deletions and unknown inputs broaden execution.')
})

test('an untested Vitest 5.x version forces a full plan', async () => {
  const { root } = await fixture()
  // node_modules with a vitest folder whose package.json says 5.0.99; every other file links to the real install.
  const real = resolve(projectRoot, 'node_modules')
  await rm(resolve(root, 'node_modules'))
  await mkdir(resolve(root, 'node_modules/vitest'), { recursive: true })
  for (const entry of await readdir(real)) if (entry !== 'vitest' && !entry.startsWith('.')) await symlink(resolve(real, entry), resolve(root, 'node_modules', entry))
  for (const entry of await readdir(resolve(real, 'vitest'))) if (entry !== 'package.json') await symlink(resolve(real, 'vitest', entry), resolve(root, 'node_modules/vitest', entry))
  const manifest = JSON.parse(await readFile(resolve(real, 'vitest/package.json'), 'utf8'))
  await writeFile(resolve(root, 'node_modules/vitest/package.json'), JSON.stringify({ ...manifest, version: '5.0.99' }))
  // The baseline committed the node_modules symlink; commit its removal.
  await git(root, 'add', '-A')
  await git(root, '-c', 'user.name=Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'real node_modules')
  const base = await git(root, 'rev-parse', 'HEAD')
  await put(root, 'src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  const run = await invoke(root, ['plan', '--base', base])
  expect(run.code, run.output).toBe(0)
  expect(run.plan.vitestVersion).toBe('5.0.99')
  expect(run.plan.fallbackReasons).toContain('untested-vitest-version: 5.0.99')
  expect(run.plan.mode).toBe('full')
})
