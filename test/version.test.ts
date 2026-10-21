import { expect, test } from 'vitest'
import { versionPolicy } from '../src/version.js'

test('tested 5.x selects, untested 5.x runs the full set, other majors are refused', () => {
  expect(versionPolicy('5.0.5')).toEqual({ ok: true, selection: true })
  expect(versionPolicy('5.1.0')).toEqual({ ok: true, selection: false, warning: 'untested-vitest-version: 5.1.0' })
  expect(versionPolicy('5.2.0-beta.1')).toEqual({ ok: true, selection: false, warning: 'untested-vitest-version: 5.2.0-beta.1' })
  expect(versionPolicy('4.1.7')).toEqual({ ok: false, error: 'Unsupported Vitest 4.1.7. vitest-impact needs Vitest 5.' })
  expect(versionPolicy('6.0.0')).toEqual({ ok: false, error: 'Unsupported Vitest 6.0.0. vitest-impact needs Vitest 5.' })
})
