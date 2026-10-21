export const TESTED_VITEST: readonly string[] = ['5.0.5']

export function versionPolicy(version: string):
  | { ok: true; selection: boolean; warning?: string }
  | { ok: false; error: string } {
  if (version.split('.')[0] !== '5') return { ok: false, error: `Unsupported Vitest ${version}. vitest-impact needs Vitest 5.` }
  if (TESTED_VITEST.includes(version)) return { ok: true, selection: true }
  return { ok: true, selection: false, warning: `untested-vitest-version: ${version}` }
}
