import { expect, test } from 'vitest'
import { analyzeRun, markdownSummary } from '../src/report.js'
import type { Plan, FileResult } from '../src/types.js'

const plan = { decisions: [{ id: 'a', file: 'a.test.ts', selected: true }, { id: 'b', file: 'b.test.ts', selected: false }] } as Plan
const result = (id: string, failed = false): FileResult => ({ id, file: `${id}.test.ts`, project: 'p', state: failed ? 'failed' : 'passed', durationMs: 10, passed: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0, pending: 0, phases: null, timedOut: [] })

test('shadow mode exposes a failing file that selection would miss', () => {
  const report = analyzeRun(plan, 'shadow', [result('a'), result('b', true)], [], 100)
  expect(report.validation).toBe('missed-failures')
  expect(report.observedFailureRecall).toBe(0)
  expect(report.missedFailingFiles).toEqual(['b.test.ts'])
  expect(report.exitCode).toBe(1)
})
test('all-green runs do not claim perfect recall', () => {
  const report = analyzeRun(plan, 'shadow', [result('a'), result('b')], [], 100)
  expect(report.observedFailureRecall).toBeNull()
  expect(report.validation).toBe('no-failures-observed')
})
test('missing and unexpected files invalidate results', () => {
  const report = analyzeRun(plan, 'shadow', [result('a'), result('c')], [], 100)
  expect(report.missingFiles).toEqual(['b.test.ts'])
  expect(report.unexpectedFiles).toEqual(['c.test.ts'])
  expect(report.exitCode).toBe(2)
  expect(report.validation).toBe('incomplete')
})
test('unhandled errors cannot be mistaken for success', () => {
  expect(analyzeRun(plan, 'selected', [result('a')], ['Unhandled rejection'], 100).exitCode).toBe(2)
})
test('a module that fails during collection counts as a failure', () => {
  const failed = { ...result('b'), state: 'failed', passed: 0, failed: 0 }
  expect(analyzeRun(plan, 'shadow', [result('a'), failed], [], 100).missedFailingFiles).toEqual(['b.test.ts'])
})

const planWith = (ids: string[]) => ({
  decisions: ids.map(id => ({ id, file: `packages/b/test/${id.replace('id-', '')}.test.ts`, project: '@w/b', selected: true })),
  separate: [{ package: '@w/b', reason: 'pool:threads' }], scripts: [], fallbackReasons: [], resources: { maxWorkers: 1 }, planningMs: 0,
}) as unknown as Plan
test('a separate package with no JSON report makes the run incomplete', () => {
  const report = analyzeRun(planWith(['id-u']), 'full', [], [], 10, false, [{ name: '@w/b', mode: 'separate', exitCode: 1, durationMs: 5, phases: null }])
  expect(report.missingFiles).toEqual(['packages/b/test/u.test.ts'])
  expect(report.exitCode).toBe(2)
})
test('a planned unit with no result is incomplete, and a failed process fails a green run', () => {
  const file = { ...result('id-u'), file: 'packages/b/test/u.test.ts', project: '@w/b' }
  expect(analyzeRun(planWith(['id-u']), 'full', [file], [], 10, false, []).exitCode).toBe(2)
  const done = (exitCode: number) => analyzeRun(planWith(['id-u']), 'full', [file], [], 10, false, [{ name: '@w/b', mode: 'separate', exitCode, durationMs: 5, phases: null }])
  expect(done(0).exitCode).toBe(0)
  expect(done(1).exitCode).toBe(1)
})

test('a failed unit makes shadow validation incomplete and drops recall and fraction', () => {
  const file = { ...result('id-u'), file: 'packages/b/test/u.test.ts', project: '@w/b' }
  const report = analyzeRun(planWith(['id-u']), 'shadow', [file], [], 10, false, [{ name: '@w/b', mode: 'separate', exitCode: 1, durationMs: 5, phases: null }])
  expect(report.exitCode).toBe(1)
  expect(report.validation).toBe('incomplete')
  expect(report.estimatedSelectedDurationFraction).toBeNull()
  expect(report.observedFailureRecall).toBeNull()
})
test('the summary lists units that failed or produced no report', () => {
  const file = { ...result('id-u'), file: 'packages/b/test/u.test.ts', project: '@w/b' }
  const report = analyzeRun(planWith(['id-u']), 'full', [], [], 10, false, [{ name: '@w/b', mode: 'separate', exitCode: 7, durationMs: 5, phases: null }, { name: '@w/c', mode: 'script', exitCode: 3, durationMs: 5, phases: null }])
  const text = markdownSummary(report)
  expect(text).toContain('@w/b')
  expect(text).toContain('exit code 7')
  expect(text).toContain('@w/c')
  expect(text).toContain('exit code 3')
  expect(markdownSummary(analyzeRun(planWith(['id-u']), 'full', [file], [], 10, false, [{ name: '@w/b', mode: 'separate', exitCode: 0, durationMs: 5, phases: null }]))).not.toContain('exit code')
})

const fileResult = (partial: Partial<FileResult>): FileResult => ({ ...result('x'), ...partial })
const planFor = (files: FileResult[]) => ({
  decisions: files.map(f => ({ id: f.id, file: f.file, project: f.project, selected: true })),
  separate: [], scripts: [], fallbackReasons: [], resources: { maxWorkers: 1 }, planningMs: 0, shard: null,
}) as unknown as Plan

test('report sums phases per package and lists the 10 slowest files', () => {
  const files = Array.from({ length: 12 }, (_, i) => fileResult({ id: `f${i}`, file: `packages/${i % 2 ? 'a' : 'b'}/t${i}.test.ts`, project: i % 2 ? '@w/a' : '@w/b', durationMs: i * 10,
    phases: { importMs: 1, environmentMs: 2, setupMs: 0, testsMs: 3 } }))
  const report = analyzeRun(planFor(files), 'full', files, [], 100, false, [
    { name: '@w/a', mode: 'shared', exitCode: null, durationMs: 0, phases: null },
    { name: '@w/b', mode: 'shared', exitCode: null, durationMs: 0, phases: null }])
  expect(report.packages.find(p => p.name === '@w/a')?.phases).toEqual({ importMs: 6, environmentMs: 12, setupMs: 0, testsMs: 18 })
  expect(report.slowestFiles.map(f => f.durationMs)).toEqual([110, 100, 90, 80, 70, 60, 50, 40, 30, 20])
})
test('timeouts are listed with the peak load of the run', () => {
  const file = fileResult({ id: 'f', file: 'packages/a/slow.test.ts', project: '@w/a', state: 'failed', failed: 1, timedOut: ['slow > waits'] })
  const report = analyzeRun(planFor([file]), 'full', [file], [], 10, false, [], { peakPerCpu: 3.5, meanPerCpu: 2.1, samples: 10 })
  expect(report.timeouts).toEqual([{ file: 'packages/a/slow.test.ts', test: 'slow > waits' }])
  expect(markdownSummary(report)).toContain('Peak load per CPU: 3.50')
})
test('the summary lists the packages that run in their own process, with their reasons', () => {
  const plan = { ...planWith(['id-u']), separate: [{ package: '@w/b', reason: 'pool:threads' }, { package: '@w/c', reason: 'isolated-in-config' }] } as Plan
  const text = markdownSummary(analyzeRun(plan, 'full', [], [], 10, false, []))
  expect(text).toContain('Packages in their own process:\n\n- @w/b: pool:threads\n- @w/c: isolated-in-config\n')
  expect(markdownSummary(analyzeRun(planFor([]), 'full', [], [], 10, false, []))).not.toContain('own process')
})
