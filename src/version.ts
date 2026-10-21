export const TESTED_VITEST: readonly string[] = ['4.0.18', '4.1.7', '5.0.5']

export function versionPolicy(version: string):
  | { ok: true; selection: boolean; warning?: string }
  | { ok: false; error: string } {
  const [major, minor = 0, patch = 0] = version.split('.').map(n => parseInt(n))
  if (major !== 5 && !(major === 4 && (minor > 0 || patch >= 18))) return { ok: false, error: `Unsupported Vitest ${version}. vitest-impact needs Vitest 4.0.18 or later, or Vitest 5.` }
  if (TESTED_VITEST.includes(version)) return { ok: true, selection: true }
  return { ok: true, selection: false, warning: `untested-vitest-version: ${version}` }
}
