import { mkdir, open, unlink } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

/** One plan/run per checkout: protects the latest artifacts and workspace snapshot. */
export async function withRunLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const directory = resolve(root, '.vitest-impact')
  await mkdir(directory, { recursive: true })
  const path = resolve(directory, 'run.lock')
  let handle
  try { handle = await open(path, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another invocation owns ${path}. If a previous process was killed, verify it has stopped before removing the stale lock.`)
    throw error
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  await handle.close()
  const onExit = () => { try { unlinkSync(path) } catch { /* Best effort on process exit. */ } }
  process.once('exit', onExit)
  try { return await work() }
  finally {
    process.removeListener('exit', onExit)
    await unlink(path).catch(() => {})
  }
}
