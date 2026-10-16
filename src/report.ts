import { mkdir, rename, writeFile, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { shardFiles, shardOfName } from './shard.js'
import type { FileResult, PackageResult, Plan, RunReport } from './types.js'

export function analyzeRun(plan: Plan, mode: RunReport['mode'], executed: FileResult[], unhandledErrors: string[], executionMs: number, runLevelFailure = false, packages?: PackageResult[]): RunReport {
  const selected = new Set(plan.decisions.filter(t => t.selected).map(t => t.id))
  const { shard } = plan
  const inShard = new Set((shard ? shardFiles(plan.decisions, shard.index, shard.count) : plan.decisions).map(t => t.id))
  const expected = new Set(plan.decisions.filter(t => inShard.has(t.id) && (mode !== 'selected' || t.selected)).map(t => t.id))
  const observed = new Set(executed.map(t => t.id))
  const missingFiles = plan.decisions.filter(t => expected.has(t.id) && !observed.has(t.id)).map(t => t.file)
  const unexpectedFiles = executed.filter(t => !expected.has(t.id)).map(t => t.file)
  const failed = executed.filter(t => t.state === 'failed' || t.failed > 0)
  const misses = mode === 'shadow' ? failed.filter(t => inShard.has(t.id) && !selected.has(t.id)) : []
  // A planned separate or script unit with no result is incomplete; a unit that exited non-zero fails the run
  // (coverage thresholds, unhandled errors and teardown errors show only in the exit code).
  const results = new Set((packages ?? []).map(p => p.name))
  const unitMissing = packages !== undefined && [...plan.scripts.filter(n => !shard || shardOfName(n, shard.count) === shard.index), ...plan.separate.map(s => s.package).filter(n => plan.decisions.some(t => t.project === n && expected.has(t.id)))].some(n => !results.has(n))
  const unitFailed = (packages ?? []).some(p => p.mode !== 'shared' && p.exitCode !== 0)
  const incomplete = unitMissing || missingFiles.length > 0 || unexpectedFiles.length > 0 || unhandledErrors.length > 0 || executed.some(t => t.state === 'queued' || t.state === 'pending' || t.pending > 0)
  const unreliable = incomplete || unitFailed
  const validation = mode !== 'shadow' ? 'not-shadow' : unreliable ? 'incomplete' : misses.length ? 'missed-failures' : failed.length ? 'all-observed-failures-selected' : 'no-failures-observed'
  const duration = executed.reduce((sum, t) => sum + t.durationMs, 0)
  return {
    schemaVersion: 1, mode, plan, executed, packages: packages ?? [], unhandledErrors, executionMs, runLevelFailure,
    missingFiles, unexpectedFiles, missedFailingFiles: misses.map(t => t.file), validation,
    observedFailureRecall: mode === 'shadow' && !unreliable && failed.length ? (failed.length - misses.length) / failed.length : null,
    // Summed file execution durations are not a wall-clock or billing estimate.
    estimatedSelectedDurationFraction: mode === 'shadow' && !unreliable && duration > 0
      ? executed.filter(t => selected.has(t.id)).reduce((sum, t) => sum + t.durationMs, 0) / duration : null,
    exitCode: incomplete ? 2 : failed.length || runLevelFailure || unitFailed ? 1 : 0,
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

function safe(value: string): string { return value.replace(/[&<>`|\r\n]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '`': '&#96;', '|': '&#124;', '\r': ' ', '\n': ' ' }[c]!)) }
export function markdownSummary(report: RunReport): string {
  const selected = report.plan.decisions.filter(t => t.selected).length
  const units = (report.packages ?? []).filter(p => p.mode !== 'shared')
    .map(p => ({ ...p, noReport: p.mode === 'separate' && !report.executed.some(t => t.project === p.name) }))
    .filter(p => p.exitCode !== 0 || p.noReport)
  return `\n### Vitest Impact — ${report.mode}\n\n` +
    `| Metric | Result |\n| --- | --- |\n` +
    `| Planned files | ${selected} / ${report.plan.decisions.length} |\n` +
    `| Executed files | ${report.executed.length} |\n` +
    `| Workers | ${report.plan.resources.maxWorkers} |\n` +
    `| Planning | ${(report.plan.planningMs / 1000).toFixed(2)}s |\n` +
    `| Execution | ${(report.executionMs / 1000).toFixed(2)}s |\n` +
    `| Shadow validation | ${report.validation} |\n` +
    `| Exit code | ${report.exitCode} |\n` +
    `| Observed failing-file recall | ${report.observedFailureRecall === null ? 'Not measured' : `${(report.observedFailureRecall * 100).toFixed(1)}%`} |\n\n` +
    (report.plan.fallbackReasons.length ? `Full-run reasons:\n\n${report.plan.fallbackReasons.map(r => `- ${safe(r)}`).join('\n')}\n\n` : '') +
    (units.length ? `Units that failed or produced no report:\n\n${units.map(u => `- ${safe(u.name)} (${u.mode}): exit code ${u.exitCode}${u.noReport ? ', no report' : ''}`).join('\n')}\n\n` : '') +
    (report.missedFailingFiles.length ? `Failures selection would have missed:\n\n${report.missedFailingFiles.map(r => `- ${safe(r)}`).join('\n')}\n\n` : '') +
    'Shadow mode runs the full suite. Passing runs do not establish failure recall. File-duration fractions are not wall-clock or cost savings.\n'
}
export async function writeSummary(report: RunReport, file: string): Promise<void> {
  await writeFile(file, markdownSummary(report))
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownSummary(report))
}
