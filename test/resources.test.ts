import { expect, test } from 'vitest'
import { loadavg } from 'node:os'
import { availableMemoryBytes, budgetResources, startLoadSampler } from '../src/resources.js'
import { parseConfig } from '../src/config.js'
import { parseNameStatus } from '../src/git.js'

test('memory budget limits workers independently of CPU', () => {
  const result = budgetResources({ maxWorkers: 8, memoryBudgetMb: 2560, workerMemoryMb: 1024, reserveMemoryMb: 512 }, { cpu: 8, availableMemoryMb: 8192 })
  expect(result.maxWorkers).toBe(2)
  expect(result.memoryEstimate).toBe('configured')
})
test('CPU limit and available memory cap explicit requests', () => {
  expect(budgetResources({ maxWorkers: 8 }, { cpu: 2, availableMemoryMb: 8192 }).maxWorkers).toBe(2)
  expect(budgetResources({ maxWorkers: 8, memoryBudgetMb: 8192 }, { cpu: 8, availableMemoryMb: 1024 }).maxWorkers).toBe(1)
})
test('the default worker count is every available CPU, capped by memory', () => {
  expect(budgetResources({}, { cpu: 8, availableMemoryMb: 16384 }).maxWorkers).toBe(8)
  expect(budgetResources({}, { cpu: 2, availableMemoryMb: 8192 }).maxWorkers).toBe(2)
  expect(budgetResources({}, { cpu: 8, availableMemoryMb: 2048 }).maxWorkers).toBe(3)
})
test('refuses to pretend that a worker fits without memory', () => {
  expect(() => budgetResources({}, { cpu: 2, availableMemoryMb: 256 })).toThrow('Insufficient estimated memory')
})
test('config rejects unknown keys, negative patterns and malformed budgets', () => {
  expect(() => parseConfig({ version: 1, sourcePaterns: [] })).toThrow('Unknown')
  expect(() => parseConfig({ version: 1, ignore: ['!src/**'] })).toThrow('positive')
  expect(() => parseConfig({ version: 1, resources: { maxWorkers: 0 } })).toThrow('integer')
})
test('Git parsing preserves filenames containing whitespace', () => {
  expect(parseNameStatus('M\0src/with space.ts\0D\0src/with\nnewline.ts\0')).toEqual([
    { status: 'M', path: 'src/with space.ts' }, { status: 'D', path: 'src/with\nnewline.ts' },
  ])
})

test('macOS counts total memory, because its free figure leaves out reclaimable cache', () => {
  const MB = 1024 * 1024
  expect(availableMemoryBytes({ platform: 'darwin', freeBytes: 150 * MB, processAvailableBytes: 150 * MB, totalBytes: 16384 * MB, cgroupMaxBytes: null, cgroupUsedBytes: null })).toBe(16384 * MB)
  expect(availableMemoryBytes({ platform: 'linux', freeBytes: 4000 * MB, processAvailableBytes: 3000 * MB, totalBytes: 8192 * MB, cgroupMaxBytes: null, cgroupUsedBytes: null })).toBe(3000 * MB)
  expect(availableMemoryBytes({ platform: 'linux', freeBytes: 4000 * MB, processAvailableBytes: null, totalBytes: 8192 * MB, cgroupMaxBytes: 2048 * MB, cgroupUsedBytes: 1024 * MB })).toBe(1024 * MB)
})

test('the load sampler returns a summary with at least two samples', () => {
  const summary = startLoadSampler(1)()
  expect(summary.samples).toBe(2)
  expect(summary.peakPerCpu).toBeGreaterThanOrEqual(summary.meanPerCpu)
})

test("load per CPU divides by the CPU count it is given (the budget's, cgroup-aware)", () => {
  const before = loadavg()[0]!
  const summary = startLoadSampler(4)()
  const after = loadavg()[0]!
  // Both samples fall between the two reads, so each is one of the two values divided by 4.
  expect(summary.peakPerCpu).toBeGreaterThanOrEqual(Math.min(before, after) / 4 - 1e-9)
  expect(summary.peakPerCpu).toBeLessThanOrEqual(Math.max(before, after) / 4 + 1e-9)
})
