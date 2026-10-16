import { expect, test } from 'vitest'
import { analyzeRun } from '../src/report.js'
import type { Plan, FileResult } from '../src/types.js'

const plan = { decisions: [{ id: 'a', file: 'a.test.ts', selected: true }, { id: 'b', file: 'b.test.ts', selected: false }] } as Plan
const result = (id: string, failed = false): FileResult => ({ id, file: `${id}.test.ts`, state: failed ? 'failed' : 'passed', durationMs: 10, passed: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0, pending: 0 })

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
