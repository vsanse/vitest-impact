import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const cli = resolve(projectRoot, 'dist/cli.js')
export async function git(root, ...args) {
  return (await exec('git', ['-C', root, ...args], { timeout: 10_000 })).stdout.trim()
}
export async function put(root, path, content) {
  await mkdir(dirname(resolve(root, path)), { recursive: true })
  await writeFile(resolve(root, path), content)
}
export async function makeFixture(options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'vitest-impact-'))
  await symlink(resolve(projectRoot, 'node_modules'), resolve(root, 'node_modules'), 'dir')
  const config = {
    version: 1,
    sourcePatterns: ['src/**/*.ts'],
    inputs: [{ files: ['fixtures/**'], tests: ['test/fixture.test.ts'] }],
    ignore: ['docs/**'],
    resources: { maxWorkers: 1, workerMemoryMb: 128, reserveMemoryMb: 128 },
    ...options,
  }
  const files = {
    '.gitignore': 'node_modules/\n.vitest/\n.vitest-impact/\n',
    'package.json': JSON.stringify({ type: 'module', private: true, devDependencies: { vitest: '5.0.5' } }),
    'vitest.config.ts': "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['test/**/*.test.ts'], maxWorkers: 1 } })\n",
    'vitest-impact.config.json': JSON.stringify(config, null, 2),
    'src/math.ts': 'export const add = (a: number, b: number) => a + b\n',
    'src/strings.ts': 'export const upper = (s: string) => s.toUpperCase()\n',
    'test/math.test.ts': "import { test, expect } from 'vitest'; import { add } from '../src/math'; test('adds', () => expect(add(2, 3)).toBe(5))\n",
    'test/strings.test.ts': "import { test, expect } from 'vitest'; import { upper } from '../src/strings'; test('uppercases', () => expect(upper('hi')).toBe('HI'))\n",
    'test/fixture.test.ts': "import { test, expect } from 'vitest'; import { readFileSync } from 'node:fs'; test('reads fixture', () => expect(readFileSync('fixtures/rate.txt', 'utf8').trim()).toBe('10'))\n",
    'fixtures/rate.txt': '10\n',
    'docs/readme.md': 'Example documentation\n',
  }
  await Promise.all(Object.entries(files).map(([path, content]) => put(root, path, content)))
  await git(root, 'init', '-q')
  await git(root, 'add', '.')
  await git(root, '-c', 'user.name=Vitest Impact Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'fixture baseline')
  return { root, config, base: await git(root, 'rev-parse', 'HEAD'), cleanup: () => rm(root, { recursive: true, force: true }) }
}

export async function invoke(root, args, timeout = 30_000) {
  let code = 0
  let output = ''
  const env = { ...process.env, CI: 'true', NO_COLOR: '1' }
  delete env.GITHUB_STEP_SUMMARY
  try {
    const result = await exec(process.execPath, [cli, ...args], { cwd: root, env, timeout, maxBuffer: 2 * 1024 * 1024 })
    output = result.stdout + result.stderr
  } catch (error) {
    if (error.killed || typeof error.code !== 'number') throw error
    code = error.code
    output = error.stdout + error.stderr
  }
  const load = async name => { try { return JSON.parse(await readFile(resolve(root, '.vitest-impact', name), 'utf8')) } catch { return null } }
  return { code, output, plan: await load('plan.json'), report: await load('report.json') }
}
