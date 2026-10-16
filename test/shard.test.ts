import { expect, test } from 'vitest'
import { parseShard, shardFiles, shardOfName } from '../src/shard.js'

test('shards cover every file once, in stable groups', () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ file: `t/${i}.test.ts` }))
  const parts = [1, 2, 3].map(i => shardFiles(files, i, 3))
  expect(parts.flat().map(f => f.file).sort()).toEqual(files.map(f => f.file).sort())
  expect(parts.map(p => p.length)).toEqual([4, 4, 2])
  expect(shardFiles([...files].reverse(), 2, 3)).toEqual(shardFiles(files, 2, 3))
})
test('parseShard rejects bad values', () => {
  expect(parseShard('2/3')).toEqual({ index: 2, count: 3 })
  for (const bad of ['0/3', '4/3', '1/0', 'a/b', '1']) expect(() => parseShard(bad)).toThrow(`Invalid --shard: ${bad}`)
})
test('a script unit maps to one shard in range', () => {
  for (const n of [1, 2, 5]) expect(shardOfName('@w/x', n)).toBeGreaterThanOrEqual(1), expect(shardOfName('@w/x', n)).toBeLessThanOrEqual(n)
})
