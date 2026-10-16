import { minimatch } from 'minimatch'
import type { ImpactConfig, GitChanges, TestFile, TestDecision } from './types.js'

export const matches = (path: string, patterns: string[]): boolean => patterns.some(pattern => minimatch(path, pattern, { dot: true, nonegate: true, nocomment: true }))

const PROTECTED = [
  '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
  '**/bun.lock', '**/bun.lockb', '**/npm-shrinkwrap.json', '**/deno.lock',
  '**/vitest.config.*', '**/vite.config.*',
  '**/vitest.workspace.*', '**/vitest.projects.*', '**/tsconfig*.json',
  '**/.env', '**/.env.*', '**/.npmrc', '**/.nvmrc', '**/.node-version',
  '**/vitest-impact.config.json', '.github/**',
]

export interface Selection {
  mode: 'full' | 'selective' | 'empty'
  fallbackReasons: string[]
  ignoredChanges: string[]
  decisions: TestDecision[]
}

export async function selectTests(args: {
  tests: TestFile[]
  git: GitChanges
  config: ImpactConfig
  protectedFiles?: string[]
  forceReasons?: string[]
  related: (paths: string[]) => Promise<string[]>
}): Promise<Selection> {
  const { tests, git, config } = args
  if (!tests.length) throw new Error('No test files discovered. Refusing to report an empty suite as success.')
  const decisions = tests.map(test => ({ ...test, selected: false, reasons: [] as string[] }))
  const fallbackReasons = [...(args.forceReasons ?? [])]
  if (git.fallback) fallbackReasons.push(git.fallback)
  const ignoredChanges: string[] = []
  const nativePaths: string[] = []
  const select = (test: TestDecision, reason: string) => { test.selected = true; test.reasons.push(reason) }

  for (const pattern of config.alwaysRun) {
    const mandatory = decisions.filter(t => matches(t.file, [pattern]))
    if (!mandatory.length) throw new Error(`alwaysRun pattern matches no tests: ${pattern}`)
    mandatory.forEach(t => select(t, `mandatory: ${pattern}`))
  }

  for (const change of git.changes) {
    const path = change.path
    if (matches(path, [...PROTECTED, ...config.forceFull]) || args.protectedFiles?.includes(path)) {
      fallbackReasons.push(`global-input: ${path}`)
      continue
    }
    const changedTests = decisions.filter(t => t.file === path)
    if (changedTests.length) {
      changedTests.forEach(t => select(t, `changed-test: ${path}`))
      // Test files may also be imported by other tests.
      nativePaths.push(path)
      continue
    }
    if (matches(path, config.ignore)) { ignoredChanges.push(path); continue }
    if (change.status !== 'M' && change.status !== 'A') {
      fallbackReasons.push(`structural-change: ${change.status} ${path}`)
      continue
    }
    const rules = config.inputs.filter(rule => matches(path, rule.files))
    for (const rule of rules) {
      const owners = decisions.filter(t => matches(t.file, rule.tests))
      if (!owners.length) fallbackReasons.push(`input-rule-has-no-tests: ${path}`)
      owners.forEach(t => select(t, `declared-input: ${path}`))
    }
    if (matches(path, config.sourcePatterns)) nativePaths.push(path)
    else if (!rules.length) fallbackReasons.push(`unclassified-input: ${path}`)
  }

  if (!fallbackReasons.length && nativePaths.length) {
    try {
      const ids = new Set(await args.related(nativePaths))
      const known = new Set(decisions.map(t => t.id))
      if ([...ids].some(id => !known.has(id))) throw new Error('Native selection returned an unknown test specification')
      if (!ids.size) fallbackReasons.push('native-selection-empty-for-source-change')
      for (const test of decisions) if (ids.has(test.id)) select(test, `native-related: one or more of ${nativePaths.join(', ')}`)
    } catch (error) {
      fallbackReasons.push(`native-analysis-failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const reasons = [...new Set(fallbackReasons)].sort()
  if (reasons.length) decisions.forEach(test => select(test, 'full-suite-fallback: see fallbackReasons'))
  for (const test of decisions) if (!test.selected) test.reasons.push('not-selected: no relationship found under the configured input contract')
  decisions.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id))
  const count = decisions.filter(t => t.selected).length
  return { mode: count === tests.length ? 'full' : count ? 'selective' : 'empty', fallbackReasons: reasons, ignoredChanges, decisions }
}
