import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, relative, sep } from 'node:path'
import { lstat, readlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Change, GitChanges } from './types.js'

const exec = promisify(execFile)
export const posix = (path: string): string => path.split(sep).join('/')
export const localPath = (root: string, file: string): string => posix(relative(root, file))

async function git(root: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 })).stdout
}

export function parseNameStatus(output: string): Change[] {
  const parts = output.split('\0')
  const changes: Change[] = []
  for (let i = 0; i < parts.length - 1; i += 2) {
    const status = parts[i]
    const path = parts[i + 1]
    if (!status || !path || !/^[ACDMTUXB]$/.test(status)) throw new Error('Unexpected Git diff output')
    changes.push({ status, path })
  }
  return changes
}

export async function changedFiles(root: string, baseRef?: string): Promise<GitChanges> {
  let head: string | null = null
  let base: string | null = null
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
    if (resolve(top) !== resolve(root)) throw new Error('Run from the Git repository root (or pass --root)')
    head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
    if (!baseRef) return { head, base, changes: [], fallback: 'missing-base: provide an explicit --base revision' }
    base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).trim()
    await git(root, ['merge-base', '--is-ancestor', base, head])
    const [diff, untracked] = await Promise.all([
      git(root, ['diff', '--name-status', '-z', '--no-renames', base, '--']),
      git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    const changes = new Map(parseNameStatus(diff).map(c => [c.path, c]))
    for (const path of untracked.split('\0').filter(Boolean)) changes.set(path, { path, status: 'A' })
    return { head, base, changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)), fallback: null }
  }
  catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return { head, base, changes: [], fallback: `git-unavailable-or-invalid-base: ${message}` }
  }
}

/** Detect edits while planning. This is not a cross-run dependency/result cache. */
export async function workspaceFingerprint(root: string, extraFiles: string[] = []): Promise<string | null> {
  let paths: string[]
  try {
    const files = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    paths = [...new Set([...files.split('\0').filter(Boolean), ...extraFiles.map(p => localPath(root, p))])].sort()
  } catch { return null }
  const h = createHash('sha256')
  h.update(await git(root, ['rev-parse', '--verify', 'HEAD']))
  for (const path of paths) {
    h.update(path).update('\0')
    try {
      const absolute = resolve(root, path)
      const stat = await lstat(absolute)
      h.update(String(stat.mode)).update('\0')
      if (stat.isSymbolicLink()) h.update(await readlink(absolute))
      else if (stat.isFile()) for await (const chunk of createReadStream(absolute)) h.update(chunk as Buffer)
      else h.update('non-file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      h.update('deleted')
    }
    h.update('\0')
  }
  return h.digest('hex')
}
