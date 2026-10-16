import { mkdir, rename, writeFile, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileResult, Plan, RunReport } from './types.js'

export function analyzeRun(plan: Plan, mode: RunReport['mode'], executed: FileResult[], unhandledErrors: string[], executionMs: number, runLevelFailure = false): RunReport {
  const selected = new Set(plan.decisions.filter(t => t.selected).map(t => t.id))
  const expected = new Set(plan.decisions.filter(t => mode !== 'selected' || t.selected).map(t => t.id))
  const observed = new Set(executed.map(t => t.id))
  const missingFiles = plan.decisions.filter(t => expected.has(t.id) && !observed.has(t.id)).map(t => t.file)
  const unexpectedFiles = executed.filter(t => !expected.has(t.id)).map(t => t.file)
  const failed = executed.filter(t => t.state === 'failed' || t.failed > 0)
  const misses = mode === 'shadow' ? failed.filter(t => !selected.has(t.id)) : []
  const incomplete = missingFiles.length > 0 || unexpectedFiles.length > 0 || unhandledErrors.length > 0 || executed.some(t => t.state === 'queued' || t.state === 'pending' || t.pending > 0)
  const validation = mode !== 'shadow' ? 'not-shadow' : incomplete ? 'incomplete' : misses.length ? 'missed-failures' : failed.length ? 'all-observed-failures-selected' : 'no-failures-observed'
  const duration = executed.reduce((sum, t) => sum + t.durationMs, 0)
  return {
    schemaVersion: 1, mode, plan, executed, unhandledErrors, executionMs, runLevelFailure,
    missingFiles, unexpectedFiles, missedFailingFiles: misses.map(t => t.file), validation,
    observedFailureRecall: mode === 'shadow' && !incomplete && failed.length ? (failed.length - misses.length) / failed.length : null,
    // Summed file execution durations are not a wall-clock or billing estimate.
    estimatedSelectedDurationFraction: mode === 'shadow' && !incomplete && duration > 0
      ? executed.filter(t => selected.has(t.id)).reduce((sum, t) => sum + t.durationMs, 0) / duration : null,
    exitCode: incomplete ? 2 : failed.length || runLevelFailure ? 1 : 0,
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
    (report.missedFailingFiles.length ? `Failures selection would have missed:\n\n${report.missedFailingFiles.map(r => `- ${safe(r)}`).join('\n')}\n\n` : '') +
    'Shadow mode runs the full suite. Passing runs do not establish failure recall. File-duration fractions are not wall-clock or cost savings.\n'
}
export async function writeSummary(report: RunReport, file: string): Promise<void> {
  await writeFile(file, markdownSummary(report))
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownSummary(report))
}
