import { availableParallelism, freemem } from 'node:os'
import { readFileSync } from 'node:fs'
import type { ImpactConfig, ResourceBudget } from './types.js'

export interface HostCapacity { cpu: number; availableMemoryMb: number }
export function detectCapacity(): HostCapacity {
  let cpu = availableParallelism()
  // Linux quotas can be smaller than the affinity reported by Node/libuv.
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/)
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) cpu = Math.min(cpu, Math.max(1, Math.floor(Number(quota) / Number(period))))
  } catch { /* Portable fallback: Node affinity. */ }
  const available = typeof process.availableMemory === 'function' ? process.availableMemory() : freemem()
  let memory = Math.min(available, freemem())
  try {
    const max = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim())
    const used = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim())
    if (Number.isFinite(max) && Number.isFinite(used) && max > 0) memory = Math.min(memory, Math.max(0, max - used))
  } catch { /* Portable fallback: Node's available memory. */ }
  return { cpu, availableMemoryMb: Math.floor(memory / 1024 / 1024) }
}

export function budgetResources(options: ImpactConfig['resources'], host = detectCapacity()): ResourceBudget {
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (name === 'reserveMemoryMb' ? 0 : 1))) throw new Error(`Invalid resource budget: ${name}`)
  }
  const memoryBudgetMb = Math.min(options.memoryBudgetMb ?? host.availableMemoryMb, host.availableMemoryMb)
  const workerMemoryMb = options.workerMemoryMb ?? 512
  const reserveMemoryMb = options.reserveMemoryMb ?? 512
  const memoryWorkers = Math.floor((memoryBudgetMb - reserveMemoryMb) / workerMemoryMb)
  if (memoryWorkers < 1) throw new Error(`Insufficient estimated memory: ${memoryBudgetMb} MB available, ${reserveMemoryMb} MB reserve, ${workerMemoryMb} MB per worker. Adjust the estimate or use a larger runner.`)
  const requested = options.maxWorkers ?? Math.min(2, host.cpu)
  const maxWorkers = Math.max(1, Math.min(requested, host.cpu, memoryWorkers))
  const warnings = ['Memory estimates choose concurrency; they are not enforced heap limits or an OOM guarantee.']
  if (!options.workerMemoryMb) warnings.push('Using an unmeasured 512 MB per-worker assumption. Calibrate this on your suite.')
  if (maxWorkers < requested) warnings.push(`Capped requested ${requested} workers to ${maxWorkers} for CPU/memory capacity.`)
  return { maxWorkers, availableCpu: host.cpu, memoryBudgetMb, workerMemoryMb, reserveMemoryMb, memoryEstimate: options.workerMemoryMb ? 'configured' : 'default-assumption', warnings }
}
