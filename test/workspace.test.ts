import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { put } from '../scripts/fixture.mjs'
import { discoverPackages, filterPackages } from '../src/workspace.js'

const roots: string[] = []
const make = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'vitest-impact-ws-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const pkg = (root: string, dir: string, json: object, config?: string) =>
  Promise.all([put(root, `${dir}/package.json`, JSON.stringify(json)), config ? put(root, `${dir}/${config}`, '') : null])

async function pnpmFixture() {
  const root = await make()
  await put(root, 'package.json', JSON.stringify({ scripts: { test: 'turbo test' } }))
  await put(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - '!packages/ignored'\nonlyBuiltDependencies:\n  - esbuild\n")
  await pkg(root, 'packages/a', { name: '@x/a', scripts: { test: 'vitest run' } }, 'vitest.config.ts')
  await pkg(root, 'packages/b', { name: '@x/b', scripts: { test: 'pnpm lint && vitest run' } }, 'vitest.config.ts')
  await pkg(root, 'packages/c', { name: '@x/c' })
  await pkg(root, 'packages/d', { name: '@x/d', scripts: { test: 'vitest run' } })
  await pkg(root, 'packages/e', { name: '@x/e', scripts: { test: 'NODE_OPTIONS=--openssl-legacy-provider vitest' } }, 'vite.config.mts')
  await pkg(root, 'packages/ignored', { name: '@x/ignored', scripts: { test: 'vitest run' } }, 'vitest.config.ts')
  await put(root, 'packages/a/node_modules/dep/package.json', '{"name":"dep"}')
  return root
}

describe('workspace', () => {
  test('pnpm workspace: classifies packages and never returns the root', async () => {
    expect(await discoverPackages(await pnpmFixture())).toEqual([
      { name: '@x/a', dir: 'packages/a', kind: 'vitest', vitestConfig: 'packages/a/vitest.config.ts', testScript: 'vitest run' },
      { name: '@x/b', dir: 'packages/b', kind: 'script', vitestConfig: 'packages/b/vitest.config.ts', testScript: 'pnpm lint && vitest run' },
      { name: '@x/c', dir: 'packages/c', kind: 'none', vitestConfig: null, testScript: null },
      { name: '@x/d', dir: 'packages/d', kind: 'script', vitestConfig: null, testScript: 'vitest run' },
      { name: '@x/e', dir: 'packages/e', kind: 'script', vitestConfig: 'packages/e/vite.config.mts', testScript: 'NODE_OPTIONS=--openssl-legacy-provider vitest' },
    ])
  })

  test('npm workspaces object form, and a repo with no workspace', async () => {
    const rootA = await make()
    await put(rootA, 'package.json', JSON.stringify({ workspaces: { packages: ['libs/*'] } }))
    await pkg(rootA, 'libs/one', { name: 'one', scripts: { test: 'vitest' } }, 'vitest.config.ts')
    expect((await discoverPackages(rootA)).map(p => p.dir)).toEqual(['libs/one'])
    const rootB = await make()
    await pkg(rootB, '.', { name: 'solo', scripts: { test: 'vitest run' } }, 'vitest.config.ts')
    expect(await discoverPackages(rootB)).toEqual([{ name: 'solo', dir: '.', kind: 'vitest', vitestConfig: 'vitest.config.ts', testScript: 'vitest run' }])
  })

  test('nested globs, array workspaces, and a folder name for a package with no name', async () => {
    const root = await make()
    await put(root, 'package.json', JSON.stringify({ workspaces: ['apps/**'] }))
    await pkg(root, 'apps/web/ui', { scripts: { test: 'vitest run' } }, 'vitest.config.js')
    expect(await discoverPackages(root)).toEqual([
      { name: 'apps/web/ui', dir: 'apps/web/ui', kind: 'vitest', vitestConfig: 'apps/web/ui/vitest.config.js', testScript: 'vitest run' },
    ])
  })

  test('filters: names, folder globs, negation, and a token that matches nothing', async () => {
    const pkgs = await discoverPackages(await pnpmFixture())
    expect(filterPackages(pkgs, ['!./packages/b', '!@x/d', '!@x/e']).map(p => p.name)).toEqual(['@x/a'])
    expect(filterPackages(pkgs, ['@x/b']).map(p => p.name)).toEqual(['@x/b'])
    expect(filterPackages(pkgs, ['./packages/*']).map(p => p.name)).toEqual(['@x/a', '@x/b', '@x/d', '@x/e'])
    expect(() => filterPackages(pkgs, ['@x/zzz'])).toThrow('Filter matches no package: @x/zzz')
    expect(filterPackages(pkgs, ['!@x/zzz']).map(p => p.name)).toEqual(['@x/a', '@x/b', '@x/d', '@x/e'])
  })

  test('unindented pnpm list, and a pnpm file with no packages list', async () => {
    const root = await make()
    await put(root, 'pnpm-workspace.yaml', "packages:\n- 'packages/*'\n- \"apps/*\"\nother:\n- x\n")
    await pkg(root, 'packages/a', { name: 'a', scripts: { test: 'vitest' } }, 'vitest.config.ts')
    await pkg(root, 'apps/b', { name: 'b', scripts: { test: 'vitest' } }, 'vitest.config.ts')
    expect((await discoverPackages(root)).map(p => p.dir)).toEqual(['apps/b', 'packages/a'])
    for (const text of ['onlyBuiltDependencies:\n  - esbuild\n', "packages: ['packages/*']\n"]) {
      const bad = await make()
      await put(bad, 'pnpm-workspace.yaml', text)
      await expect(discoverPackages(bad)).rejects.toThrow('pnpm-workspace.yaml has no packages list')
    }
  })

  test('a malformed package.json in a workspace package throws', async () => {
    const root = await make()
    await put(root, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }))
    await put(root, 'packages/a/package.json', '{ not json')
    await expect(discoverPackages(root)).rejects.toThrow('Invalid package.json: packages/a/package.json')
  })
})
