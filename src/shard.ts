import { createHash } from 'node:crypto'

const sha = (value: string) => createHash('sha1').update(value).digest('hex')

export function parseShard(value: string): { index: number; count: number } {
  const m = /^(\d+)\/(\d+)$/.exec(value)
  const index = Number(m?.[1]), count = Number(m?.[2])
  if (!m || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index < 1 || index > count) throw new Error(`Invalid --shard: ${value}`)
  return { index, count }
}

/** Same split as Vitest: sort by the SHA-1 of the file, then take the i-th slice of ceil(n / count). */
export function shardFiles<T extends { file: string }>(items: T[], index: number, count: number): T[] {
  const size = Math.ceil(items.length / count)
  return items.map(item => ({ item, key: sha(item.file) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .slice((index - 1) * size, index * size).map(x => x.item)
}

/** 1-based shard that runs a script unit. */
export function shardOfName(name: string, count: number): number {
  return Number.parseInt(sha(name).slice(0, 8), 16) % count + 1
}
