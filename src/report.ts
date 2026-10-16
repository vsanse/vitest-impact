import { mkdir, rename, writeFile, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { scriptInShard, shardRunSet } from './shard.js'
import type { FileResult, LoadSummary, PackageResult, Phases, Plan, RunReport } from './types.js'

export function analyzeRun(plan: Plan, mode: RunReport['mode'], executed: FileResult[], unhandledErrors: string[], executionMs: number, runLevelFailure = false, packages?: PackageResult[], load?: LoadSummary | null): RunReport {
  const selected = new Set(plan.decisions.filter(t => t.selected).map(t => t.id))
  const { shard } = plan
  const expected = new Set(shardRunSet(plan.decisions, mode, shard).map(t => t.id))
  const observed = new Set(executed.map(t => t.id))
  const missingFiles = plan.decisions.filter(t => expected.has(t.id) && !observed.has(t.id)).map(t => t.file)
  const unexpectedFiles = executed.filter(t => !expected.has(t.id)).map(t => t.file)
  const failed = executed.filter(t => t.state === 'failed' || t.failed > 0)
  const misses = mode === 'shadow' ? failed.filter(t => !selected.has(t.id)) : []
  // A planned separate or script unit with no result is incomplete; a unit that exited non-zero fails the run
  // (coverage thresholds, unhandled errors and teardown errors show only in the exit code).
  const results = new Set((packages ?? []).map(p => p.name))
  const unitMissing = packages !== undefined && [...plan.scripts.filter(n => scriptInShard(n, shard)), ...plan.separate.map(s => s.package).filter(n => plan.decisions.some(t => t.project === n && expected.has(t.id)))].some(n => !results.has(n))
  const unitFailed = (packages ?? []).some(p => p.mode !== 'shared' && p.exitCode !== 0)
  const incomplete = unitMissing || missingFiles.length > 0 || unexpectedFiles.length > 0 || unhandledErrors.length > 0 || executed.some(t => t.state === 'queued' || t.state === 'pending' || t.pending > 0)
  const unreliable = incomplete || unitFailed
  const validation = mode !== 'shadow' ? 'not-shadow' : unreliable ? 'incomplete' : misses.length ? 'missed-failures' : failed.length ? 'all-observed-failures-selected' : 'no-failures-observed'
  const duration = executed.reduce((sum, t) => sum + t.durationMs, 0)
  // Shared packages carry no timing of their own: their phases are the sum over their files.
  const sums = (name: string): Phases | null => {
    const withPhases = executed.filter(t => t.project === name && t.phases)
    return withPhases.length ? withPhases.reduce<Phases>((s, t) => ({ importMs: s.importMs + t.phases!.importMs, environmentMs: s.environmentMs + t.phases!.environmentMs, setupMs: s.setupMs + t.phases!.setupMs, testsMs: s.testsMs + t.phases!.testsMs }), { importMs: 0, environmentMs: 0, setupMs: 0, testsMs: 0 }) : null
  }
  return {
    schemaVersion: 1, mode, plan, executed, packages: (packages ?? []).map(p => p.mode === 'shared' ? { ...p, phases: sums(p.name) } : p),
    slowestFiles: [...executed].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10).map(t => ({ file: t.file, durationMs: t.durationMs })),
    timeouts: executed.flatMap(t => t.timedOut.map(test => ({ file: t.file, test }))), load: load ?? null, unhandledErrors, executionMs, runLevelFailure,
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
  const sec = (ms: number) => `${(ms / 1000).toFixed(2)}s`
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
    (report.packages.length ? `Time per package:\n\n| Package | Mode | Files | Duration | Import | Environment | Tests |\n| --- | --- | --- | --- | --- | --- | --- |\n${report.packages.map(p => `| ${safe(p.name)} | ${p.mode} | ${report.executed.filter(t => t.project === p.name).length} | ${sec(p.durationMs)} | ${p.phases ? sec(p.phases.importMs) : '-'} | ${p.phases ? sec(p.phases.environmentMs) : '-'} | ${p.phases ? sec(p.phases.testsMs) : '-'} |`).join('\n')}\n\n` : '') +
    (report.slowestFiles.length ? `Slowest files:\n\n${report.slowestFiles.map(f => `- ${safe(f.file)}: ${sec(f.durationMs)}`).join('\n')}\n\n` : '') +
    (report.timeouts.length ? `Timeouts:\n\n${report.timeouts.map(t => `- ${safe(t.file)}: ${safe(t.test)}`).join('\n')}\n\n${report.load ? `Peak load per CPU: ${report.load.peakPerCpu.toFixed(2)} (mean ${report.load.meanPerCpu.toFixed(2)}, ${report.load.samples} samples). A load above 1 means the machine was overloaded and these timeouts may come from that.` : 'Load was not measured on this platform.'}\n\n` : '') +
    (report.missedFailingFiles.length ? `Failures selection would have missed:\n\n${report.missedFailingFiles.map(r => `- ${safe(r)}`).join('\n')}\n\n` : '') +
    'Shadow mode runs the full suite. Passing runs do not establish failure recall. File-duration fractions are not wall-clock or cost savings.\n'
}
export async function writeSummary(report: RunReport, file: string): Promise<void> {
  await writeFile(file, markdownSummary(report))
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownSummary(report))
}
