import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { makeFixture, put, invoke, projectRoot } from './fixture.mjs'

const sample = await makeFixture()
try {
  await put(sample.root, 'src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  const selected = await invoke(sample.root, ['run', '--base', sample.base, '--mode', 'selected'])
  if (selected.code !== 0 || selected.report?.executed.length !== 1) throw new Error(selected.output)
  const shadow = await invoke(sample.root, ['run', '--base', sample.base])
  if (shadow.code !== 0 || shadow.report?.executed.length !== 3) throw new Error(shadow.output)
  await put(sample.root, 'fixtures/rate.txt', '99\n')
  const broken = await invoke(sample.root, ['run', '--base', sample.base, '--mode', 'selected'])
  if (broken.code !== 1 || !broken.report?.executed.some(t => t.file === 'test/fixture.test.ts' && t.failed === 1)) throw new Error(broken.output)
  const artifacts = resolve(projectRoot, '.vitest-impact/demo')
  await mkdir(artifacts, { recursive: true })
  for (const [name, run] of Object.entries({ selected, shadow, 'fixture-failure': broken })) {
    await writeFile(resolve(artifacts, `${name}.json`), JSON.stringify(run.report, null, 2) + '\n')
  }
  console.log('Demo verified:')
  console.log('  Source-only edit: selected and ran 1 of 3 files; passed.')
  console.log('  Shadow mode: planned 1 file, ran all 3; no failures observed.')
  console.log('  Broken fixture: selected its owning test; preserved failing exit status.')
  console.log(`Reports: ${artifacts}`)
} finally { await sample.cleanup() }
