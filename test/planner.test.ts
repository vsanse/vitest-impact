import { describe, expect, test } from 'vitest'
import { selectTests } from '../src/planner.js'
import { parseConfig } from '../src/config.js'
import type { Change } from '../src/types.js'

const tests = [
  { id: 'math', file: 'test/math.test.ts', project: '' },
  { id: 'strings', file: 'test/strings.test.ts', project: '' },
  { id: 'fixture', file: 'test/fixture.test.ts', project: '' },
]
const configuration = {
  version: 1, sourcePatterns: ['src/**/*.ts'], ignore: ['docs/**'],
  inputs: [{ files: ['fixtures/**'], tests: ['test/fixture.test.ts'] }],
}
const plan = (changes: Change[], overrides = {}, related = async () => ['math']) => selectTests({
  tests, git: { head: 'head', base: 'base', changes, fallback: null },
  config: parseConfig({ ...configuration, ...overrides }), related,
})

describe('selection contract', () => {
  test('combines native dependencies with declared fixtures', async () => {
    const result = await plan([{ path: 'src/math.ts', status: 'M' }, { path: 'fixtures/rate.txt', status: 'M' }])
    expect(result.decisions.filter(t => t.selected).map(t => t.id).sort()).toEqual(['fixture', 'math'])
    expect(result.mode).toBe('selective')
  })
  test('a source change that selects nothing forces full, even when another change selects tests', async () => {
    const related = async (paths: string[]) => (paths[0] === 'src/math.ts' ? ['math'] : [])
    const result = await plan([{ path: 'src/math.ts', status: 'M' }, { path: 'src/orphan.ts', status: 'M' }], {}, related)
    expect(result.mode).toBe('full')
    expect(result.fallbackReasons).toContain('native-selection-empty-for-source: src/orphan.ts')
  })
  test('a changed test file that no other test imports does not force full', async () => {
    const related = async (paths: string[]) => (paths[0] === 'src/math.ts' ? ['math'] : [])
    const result = await plan([{ path: 'test/strings.test.ts', status: 'M' }, { path: 'src/math.ts', status: 'M' }], {}, related)
    expect(result.mode).toBe('selective')
    expect(result.decisions.filter(t => t.selected).map(t => t.id).sort()).toEqual(['math', 'strings'])
  })
  test('new tests select themselves even when an ignore rule matches', async () => {
    const result = await plan([{ path: 'test/strings.test.ts', status: 'A' }], { ignore: ['**/*'] })
    expect(result.decisions.find(t => t.id === 'strings')?.selected).toBe(true)
  })
  test.each(['D', 'T', 'U'])('structural change %s broadens execution', async status => {
    expect((await plan([{ path: 'src/old.ts', status }])).mode).toBe('full')
  })
  test('unknown inputs broaden execution', async () => {
    expect((await plan([{ path: 'schema.graphql', status: 'M' }])).fallbackReasons[0]).toContain('unclassified-input')
  })
  test.each(['package.json', 'pnpm-lock.yaml', '.env.test', '.github/workflows/test.yml', 'vitest.config.ts', 'pnpm-workspace.yaml', '.yarnrc.yml', 'packages/a/.yarnrc.yml'])('protects %s from ignore rules', async path => {
    expect((await plan([{ path, status: 'M' }], { ignore: ['**/*'] })).mode).toBe('full')
  })
  test('an unmatched fixture owner falls back to full', async () => {
    const result = await plan([{ path: 'fixtures/rate.txt', status: 'M' }], { inputs: [{ files: ['fixtures/**'], tests: ['typo.test.ts'] }] })
    expect(result.mode).toBe('full')
    expect(result.fallbackReasons[0]).toContain('input-rule-has-no-tests')
  })
  test('native analysis failure falls back to full', async () => {
    const result = await plan([{ path: 'src/math.ts', status: 'M' }], {}, async () => { throw new Error('resolution failed') })
    expect(result.mode).toBe('full')
  })
  test('native empty result for source changes does not silently pass', async () => {
    expect((await plan([{ path: 'src/orphan.ts', status: 'M' }], {}, async () => [])).mode).toBe('full')
  })
  test('only explicitly ignored changes allow a valid empty selection', async () => {
    const result = await plan([{ path: 'docs/readme.md', status: 'M' }])
    expect(result.mode).toBe('empty')
    expect(result.ignoredChanges).toEqual(['docs/readme.md'])
  })
  test('mandatory tests still run on a docs-only change', async () => {
    const result = await plan([{ path: 'docs/readme.md', status: 'M' }], { alwaysRun: ['test/strings.test.ts'] })
    expect(result.decisions.filter(t => t.selected).map(t => t.id)).toEqual(['strings'])
  })
  test('rejects a typo in mandatory test ownership', async () => {
    await expect(plan([], { alwaysRun: ['missing/**'] })).rejects.toThrow('matches no tests')
  })
  test('missing Git history forces a full run', async () => {
    const result = await selectTests({ tests, git: { head: null, base: null, changes: [], fallback: 'invalid-base' }, config: parseConfig(configuration), related: async () => [] })
    expect(result.mode).toBe('full')
  })
  test('never accepts an empty discovered suite', async () => {
    await expect(selectTests({ tests: [], git: { head: null, base: null, changes: [], fallback: null }, config: parseConfig(configuration), related: async () => [] })).rejects.toThrow('No test files')
  })
})
