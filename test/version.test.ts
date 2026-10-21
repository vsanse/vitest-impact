import { expect, test } from 'vitest'
import { versionPolicy } from '../src/version.js'

const refused = (version: string) => ({ ok: false, error: `Unsupported Vitest ${version}. vitest-impact needs Vitest 4.0.18 or later, or Vitest 5.` })

test('tested versions select, untested 4.x and 5.x run the full set, other versions are refused', () => {
  expect(versionPolicy('4.0.18')).toEqual({ ok: true, selection: true })
  expect(versionPolicy('4.1.7')).toEqual({ ok: true, selection: true })
  expect(versionPolicy('5.0.5')).toEqual({ ok: true, selection: true })
  expect(versionPolicy('4.2.0')).toEqual({ ok: true, selection: false, warning: 'untested-vitest-version: 4.2.0' })
  expect(versionPolicy('5.1.0')).toEqual({ ok: true, selection: false, warning: 'untested-vitest-version: 5.1.0' })
  expect(versionPolicy('5.2.0-beta.1')).toEqual({ ok: true, selection: false, warning: 'untested-vitest-version: 5.2.0-beta.1' })
  expect(versionPolicy('4.0.17')).toEqual(refused('4.0.17'))
  expect(versionPolicy('4.0.9')).toEqual(refused('4.0.9'))
  expect(versionPolicy('3.2.4')).toEqual(refused('3.2.4'))
  expect(versionPolicy('6.0.0')).toEqual(refused('6.0.0'))
})
