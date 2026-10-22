import { afterEach, expect, test } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { packageManager, parseJsonReport, runSeparate } from '../src/separate.js'

test('parseJsonReport maps Vitest JSON results to file results', () => {
  const json = { testResults: [{ name: '/r/packages/b/test/u.test.ts', status: 'failed', startTime: 100, endTime: 350,
    assertionResults: [{ status: 'passed' }, { status: 'failed' }, { status: 'skipped' }] }] }
  expect(parseJsonReport(json, '/r', new Map([['packages/b/test/u.test.ts', 'id-u']]), '@w/b')).toEqual([
    { id: 'id-u', file: 'packages/b/test/u.test.ts', project: '@w/b', state: 'failed', durationMs: 250, passed: 1, failed: 1, skipped: 1, pending: 0, phases: null, timedOut: [] },
  ])
})

test('a file the plan does not know keeps its path as id', () => {
  const json = { testResults: [{ name: '/r/x.test.ts', status: 'passed', startTime: 0, endTime: 1, assertionResults: [] }] }
  expect(parseJsonReport(json, '/r', new Map(), 'p')[0]!.id).toBe('x.test.ts')
})

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(resolve(tmpdir(), 'vi-pm-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) await writeFile(resolve(dir, name), content)
  return dir
}

test('packageManager reads the packageManager field, then the lockfile, else npm', async () => {
  expect(packageManager(await repo({ 'package.json': '{"packageManager":"pnpm@9.1.0"}', 'yarn.lock': '' }))).toBe('pnpm')
  expect(packageManager(await repo({ 'package.json': '{}', 'yarn.lock': '' }))).toBe('yarn')
  expect(packageManager(await repo({ 'package.json': '{}', 'pnpm-lock.yaml': '' }))).toBe('pnpm')
  expect(packageManager(await repo({ 'package.json': '{"packageManager":"bun@1"}' }))).toBe('npm')
  expect(packageManager(await repo({}))).toBe('npm')
})

test('a script that cannot start is reported as an error, not a plain exit code', async () => {
  const dir = await repo({ 'package.json': '{}' })
  const run = await runSeparate(dir, { package: '@w/x', dir: 'missing', kind: 'script', files: [], idsByFile: new Map() }, 1, resolve(dir, 'out'))
  expect(run.result.exitCode).toBeNull()
  expect(run.errors).toEqual(['@w/x: could not start npm: ENOENT'])
})

test('parseJsonReport lists tests whose failure is a timeout', () => {
  const json = { testResults: [{ name: '/r/s.test.ts', status: 'failed', startTime: 0, endTime: 1, assertionResults: [
    { status: 'failed', fullName: 'slow waits', failureMessages: ['Test timed out in 5000ms.'] },
    { status: 'failed', fullName: 'vitest 4', failureMessages: ['Error: STACK_TRACE_ERROR\n    at task (file:///r/node_modules/@vitest/runner/dist/chunk-artifact.js:1784:27)'] },
    { status: 'failed', fullName: 'other', failureMessages: ['AssertionError'] }] }] }
  expect(parseJsonReport(json, '/r', new Map(), 'p')[0]!.timedOut).toEqual(['slow waits', 'vitest 4'])
})
