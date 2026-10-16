import { expect, test } from 'vitest'
import { budgetResources } from '../src/resources.js'
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
