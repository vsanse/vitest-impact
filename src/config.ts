import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { ImpactConfig } from './types.js'

export const DEFAULT_CONFIG = 'vitest-impact.config.json'

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} option: ${key}`)
}
function patterns(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(p => typeof p !== 'string' || !p || p.startsWith('!') || p.startsWith('/') || p.includes('\\') || p.split('/').includes('..'))) {
    throw new Error(`${label} must contain non-empty, positive, root-relative POSIX glob patterns`)
  }
  return value as string[]
}

export function parseConfig(value: unknown): ImpactConfig {
  const data = object(value, 'Config')
  keys(data, ['version', 'sourcePatterns', 'inputs', 'forceFull', 'ignore', 'alwaysRun', 'resources'], 'config')
  if (data.version !== 1) throw new Error('Config version must be 1')
  const resources = object(data.resources ?? {}, 'resources')
  keys(resources, ['maxWorkers', 'memoryBudgetMb', 'workerMemoryMb', 'reserveMemoryMb'], 'resources')
  for (const [key, n] of Object.entries(resources)) {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < (key === 'reserveMemoryMb' ? 0 : 1)) throw new Error(`resources.${key} must be a valid positive integer (reserve may be zero)`)
  }
  if (data.inputs !== undefined && !Array.isArray(data.inputs)) throw new Error('inputs must be an array')
  const inputs = ((data.inputs ?? []) as unknown[]).map((input, index) => {
    const rule = object(input, `inputs[${index}]`)
    keys(rule, ['files', 'tests'], 'input rule')
    const files = patterns(rule.files, 'input.files')
    const tests = patterns(rule.tests, 'input.tests')
    if (!files.length || !tests.length) throw new Error('Each input rule needs files and tests')
    return { files, tests }
  })
  return {
    version: 1,
    sourcePatterns: patterns(data.sourcePatterns, 'sourcePatterns'),
    inputs,
    forceFull: patterns(data.forceFull, 'forceFull'),
    ignore: patterns(data.ignore, 'ignore'),
    alwaysRun: patterns(data.alwaysRun, 'alwaysRun'),
    resources: resources as ImpactConfig['resources'],
  }
}

export async function loadConfig(root: string, path?: string): Promise<{ config: ImpactConfig; hash: string; path: string; found: boolean }> {
  const filename = resolve(root, path ?? DEFAULT_CONFIG)
  let content: string
  try { content = await readFile(filename, 'utf8') }
  catch (error) {
    if (!path && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      content = '{"version":1}'
      return { config: parseConfig(JSON.parse(content)), hash: hash(content), path: filename, found: false }
    }
    throw error
  }
  return { config: parseConfig(JSON.parse(content)), hash: hash(content), path: filename, found: true }
}
export function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
