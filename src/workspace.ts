import { readdir, readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { minimatch } from 'minimatch'
import type { WorkspacePackage } from './types.js'

const CONFIG_BASES = ['vitest.config', 'vite.config']
const CONFIG_EXTS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']

const exists = (path: string) => access(path).then(() => true, () => false)
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const readJson = async (path: string, shown: string): Promise<Record<string, unknown> | null> => {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try { return JSON.parse(text) } catch { throw new Error(`Invalid package.json: ${shown}`) }
}

// ponytail: line parser for the packages: list only; use a YAML parser if real files break it.
/** The packages: globs, or null when the file has no packages: key (a single-package repo keeping settings there). */
function pnpmPackages(text: string): string[] | null {
  let globs: string[] | null = null
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    if (/^[^\s#-]/.test(line)) { inside = /^packages\s*:/.test(line); if (inside) globs ??= []; continue }
    if (!inside) continue
    const item = /^\s*-\s+(?:'([^']*)'|"([^"]*)"|([^#\s][^#]*?))\s*(?:#.*)?$/.exec(line)
    if (item) globs!.push(item[1] ?? item[2] ?? item[3]!)
  }
  return globs
}

async function workspaceGlobs(root: string): Promise<string[] | null> {
  let yaml: string | null = null
  try { yaml = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8') } catch (error) {
    if (!isMissing(error)) throw error
  }
  if (yaml !== null) {
    // pnpm ignores package.json workspaces, so a file with no packages: key means no workspace.
    const globs = pnpmPackages(yaml)
    if (globs?.length === 0) throw new Error('pnpm-workspace.yaml has no packages list')
    return globs
  }
  const workspaces = (await readJson(resolve(root, 'package.json'), 'package.json'))?.workspaces
  if (Array.isArray(workspaces)) return workspaces.map(String)
  const nested = (workspaces as { packages?: unknown } | undefined)?.packages
  return Array.isArray(nested) ? nested.map(String) : null
}

async function packageFolders(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(resolve(root, dir), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = dir ? `${dir}/${entry.name}` : entry.name
      if (await exists(resolve(root, child, 'package.json'))) found.push(child)
      await walk(child)
    }
  }
  await walk('')
  return found
}

async function describePackage(root: string, dir: string): Promise<WorkspacePackage> {
  const json = await readJson(resolve(root, dir, 'package.json'), dir === '.' ? 'package.json' : `${dir}/package.json`)
  const scripts = (json?.scripts ?? {}) as Record<string, unknown>
  const testScript = typeof scripts.test === 'string' ? scripts.test.trim() : null
  let vitestConfig: string | null = null
  for (const base of CONFIG_BASES) {
    for (const ext of CONFIG_EXTS) {
      const file = `${base}.${ext}`
      if (!vitestConfig && await exists(resolve(root, dir, file))) vitestConfig = dir === '.' ? file : `${dir}/${file}`
    }
  }
  const plain = testScript === 'vitest' || testScript === 'vitest run'
  return {
    name: typeof json?.name === 'string' && json.name ? json.name : dir,
    dir,
    kind: testScript === null ? 'none' : plain && vitestConfig ? 'vitest' : 'script',
    vitestConfig,
    testScript,
  }
}

export async function discoverPackages(root: string): Promise<WorkspacePackage[]> {
  const globs = await workspaceGlobs(root)
  if (globs === null) return [await describePackage(root, '.')]
  const include = globs.filter(g => !g.startsWith('!'))
  const exclude = globs.filter(g => g.startsWith('!')).map(g => g.slice(1))
  const match = (dir: string, patterns: string[]) => patterns.some(p => minimatch(dir, p.replace(/^\.\//, '').replace(/\/$/, ''), { dot: true }))
  const dirs = (await packageFolders(root)).filter(d => match(d, include) && !match(d, exclude))
  const packages = await Promise.all(dirs.map(d => describePackage(root, d)))
  return packages.sort((a, b) => a.dir.localeCompare(b.dir))
}

export function filterPackages(packages: WorkspacePackage[], filters: string[]): WorkspacePackage[] {
  const hit = (token: string) => {
    const matched = token.startsWith('./')
      ? packages.filter(p => minimatch(p.dir, token.slice(2), { dot: true }))
      : packages.filter(p => p.name === token)
    return matched
  }
  const positive = filters.filter(t => !t.startsWith('!'))
  const negative = filters.filter(t => t.startsWith('!'))
  const picked = new Set(positive.length ? positive.flatMap(hit) : packages)
  for (const token of positive) if (!hit(token).length) throw new Error(`Filter matches no package: ${token}`)
  for (const token of negative) {
    const matched = hit(token.slice(1))
    matched.forEach(p => picked.delete(p))
  }
  return packages.filter(p => picked.has(p) && p.kind !== 'none')
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/**
 * Design 6.2.3, "run the full set when not sure": a change in package X can reach a package that depends on X
 * through X's built output (dist/), which the import graph does not link to X's sources. 0.2.0 does not track
 * those links, so a changed source path inside X forces full when a package in the run set depends on X,
 * directly or through other discovered packages (with or without tests).
 */
export async function untrackedDependents(root: string, all: WorkspacePackage[], runSet: WorkspacePackage[], changedSources: string[]): Promise<string[]> {
  const changed = new Set<string>()
  for (const path of changedSources) {
    const owner = all.filter(p => p.dir !== '.' && path.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]
    if (owner) changed.add(owner.name)
  }
  if (!changed.size) return []
  // Package name -> the discovered packages that list it.
  const dependents = new Map<string, string[]>()
  for (const p of all) {
    const json = await readJson(resolve(root, p.dir, 'package.json'), `${p.dir}/package.json`)
    for (const field of DEPENDENCY_FIELDS) for (const name of Object.keys((json?.[field] ?? {}) as object)) dependents.set(name, [...dependents.get(name) ?? [], p.name])
  }
  const inRun = new Set(runSet.map(p => p.name))
  const reachesRun = (name: string) => {
    const seen = new Set<string>()
    const queue = [name]
    while (queue.length) for (const d of dependents.get(queue.pop()!) ?? []) if (!seen.has(d)) { seen.add(d); queue.push(d) }
    seen.delete(name)
    return [...seen].some(d => inRun.has(d))
  }
  return [...changed].filter(reachesRun).sort().map(name => `workspace-dependents-not-tracked: ${name}`)
}
