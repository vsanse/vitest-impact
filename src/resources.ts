import { availableParallelism, freemem, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'
import type { ImpactConfig, ResourceBudget } from './types.js'

export interface HostCapacity { cpu: number; availableMemoryMb: number }
export interface MemoryInput {
  platform: NodeJS.Platform
  freeBytes: number
  processAvailableBytes: number | null
  totalBytes: number
  cgroupMaxBytes: number | null
  cgroupUsedBytes: number | null
}
export function availableMemoryBytes(input: MemoryInput): number {
  // ponytail: macOS freemem leaves out reclaimable cache, so total memory stands in; parse vm_stat if admission control ever matters on macOS.
  let memory = input.platform === 'darwin' ? input.totalBytes : Math.min(input.processAvailableBytes ?? input.freeBytes, input.freeBytes)
  const { cgroupMaxBytes: max, cgroupUsedBytes: used } = input
  if (max !== null && used !== null && Number.isFinite(max) && Number.isFinite(used) && max > 0) memory = Math.min(memory, Math.max(0, max - used))
  return memory
}

export function detectCapacity(): HostCapacity {
  let cpu = availableParallelism()
  // Linux quotas can be smaller than the affinity reported by Node/libuv.
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/)
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) cpu = Math.min(cpu, Math.max(1, Math.floor(Number(quota) / Number(period))))
  } catch { /* Portable fallback: Node affinity. */ }
  let cgroupMaxBytes: number | null = null
  let cgroupUsedBytes: number | null = null
  try {
    cgroupMaxBytes = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim())
    cgroupUsedBytes = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim())
  } catch { /* Portable fallback: no cgroup limit. */ }
  const memory = availableMemoryBytes({
    platform: process.platform,
    freeBytes: freemem(),
    processAvailableBytes: typeof process.availableMemory === 'function' ? process.availableMemory() : null,
    totalBytes: totalmem(),
    cgroupMaxBytes,
    cgroupUsedBytes,
  })
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
