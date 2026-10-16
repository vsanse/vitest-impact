# Working folder per package in one Vitest process

Date: 2026-10-16. Vitest 5.0.5, Node 22.

## Question

In one Vitest process with one project per package, can each package's tests see the package folder
as `process.cwd()`, as they do when the package runs alone (`vitest run` in that folder)? Vitest has
no setting for a project's working folder (design section 9).

## Candidates

- **A.** After `createVitest`, for each project set `project.config.env.VITEST_IMPACT_CWD` to the
  package folder and put `dist/cwd-shim.js` first in `project.config.setupFiles`. The shim calls
  `process.chdir(process.env.VITEST_IMPACT_CWD)`.
- **B.** Inline projects `{ extends: <config path>, test: { root, name, env, setupFiles } }` with the
  same shim.

## Result

Spike: two packages, each with a test that reads `process.cwd()` at module level and in a test, and
reads `data.txt` with a relative path; root `config: false`, packages as `test.projects` config paths.

| Case | Result |
|---|---|
| A, `forks`, `isolate: true` | passes |
| A, `forks`, `isolate: false` | passes (Vitest reuses a worker only within one project) |
| A, `vmForks` | passes |
| A, `threads` | fails: `process.chdir() is not supported in workers` |
| no shim (control) | fails: `process.cwd()` is the repo root |
| B, `forks` | passes |

Both A and B work. **We use A**: it keeps each package's own config file as the project, with no
`extends` merge. It works because Vitest serializes `project.config` for each run, and builds each
worker's environment from `project.config.env` at spawn time. `config.env` is `undefined` by default,
so the adapter assigns a new object instead of writing into it.

The folder is the package folder (where the package's `test` script runs), not `project.config.root`,
which a config can move with `test.root`.

## globalSetup

`globalSetup` runs in the main process. Its `process.cwd()` is the folder the tool started in (the repo
root) under both A and B, not the package folder. So a package with `globalSetup` gets the separate
reason `global-setup` and runs in its own process.

## Other findings (Vitest 5.0.5)

- Projects with different `maxWorkers` in the same `sequence.groupOrder` make Vitest throw
  ("have different 'maxWorkers' but same 'sequence.groupOrder'"). The adapter gives each
  (groupOrder, maxWorkers) pair its own group, in the configured order, so a package keeps a lower
  limit that it sets.
- Whether a config sets `maxWorkers` is only visible in the untyped `config.providedOptions`. A
  project that does not set it resolves to Vitest's default (CPU count minus one), which the adapter
  replaces with the tool's budget. If `providedOptions` is missing, the adapter keeps the lower value.
- Vitest copies the root `coverage` into every project and applies the CLI `passWithNoTests` to every
  project, so a package's own values are lost after `createVitest`. The adapter reads them from the
  package config file (Vite `loadConfigFromFile`, a second load of the file): `coverage.enabled` gives
  the separate reason `coverage`; `passWithNoTests: true` lets a package with no test files be left
  out (`plan.emptyPackages`) instead of failing the run.
- Vitest names a file project after its `package.json` name. The tool does not rely on that: it maps
  each project to the discovered package that holds its root.

## Environment

`vitest run` sets `TEST=true`, `VITEST=true` and `NODE_ENV ??= 'test'` (startVitest) before it loads a
config. `createVitest` does not, and Vite then sets `NODE_ENV=development`, which every worker inherits.
The adapter sets the three variables the same way before `createVitest`, so the package configs (both
loads) and the shared workers see them. Separate and script units are spawned with a copy of the
environment taken when the tool starts, so a separate `vitest run` sets them itself and a script package
sees what its own runner gives it.

`npm run test` in a package also sets `npm_package_name`, `npm_package_version`, `npm_lifecycle_event=test`
and puts the `node_modules/.bin` of the package folder and of each folder above it first on `PATH`. Each
shared project gets these through `project.config.env` (the package's own `env` wins, as in its own run),
and each separate `vitest` unit through its spawn environment. Script units run through the package
manager, which sets them itself.

## Known gaps

- A package config that reads `process.cwd()` while it loads (for example in `include`) sees the repo
  root, not the package folder. The spike did not cover this.
- Vite plugins run in the main process. A plugin that calls `process.cwd()` while it transforms a file
  sees the repo root, not the package folder.
- Package-manager variables other than the four above (`npm_package_json`, `npm_lifecycle_script`, other
  `npm_package_*` fields, `npm_config_*`, `INIT_CWD`, and pnpm's or yarn's own) keep the values the tool
  was started with. npm walks `PATH` up to the filesystem root and adds `node-gyp-bin`; the tool stops at
  the repo root and adds nothing else. Package configs and Vite plugins run in the main process, with
  the tool's environment. In single-project mode the tests see the environment the tool was started with.
- With the root `config: false`, settings that Vitest takes only from the root config (for example
  `reporters`, `teardownTimeout`, `onConsoleLog`) come from the tool, not from a package config.
  `coverage` is handled (reason `coverage`), but only as the config file sets it: a Vite plugin that
  turns coverage on in its `config` hook is not seen by the second load.

## Caches

- Shared runs set `test.fsModuleCachePath: .vitest-impact/cache/modules` and Vite
  `cacheDir: .vitest-impact/cache/vite` as root overrides. Vitest 5.0.5 defaults `fsModuleCache` to true
  (`resolved.fsModuleCache ??= true`), so the tool never forces it on. Referenced projects fall back to the
  root module-cache path.
- A package whose own config sets `fsModuleCache: false` (the root option would govern the shared run) is
  planned separate with reason `fs-module-cache-off`; its own run applies its own setting.
- The results cache (`results.json`) and the dependency records are read from the ROOT config's `cacheDir`,
  so they always land under `.vitest-impact/cache/vite`, also in workspace mode. A package's own `cacheDir`
  only affects its Vite pre-bundle cache.
- Separate `vitest` units: Vitest 5.0.5 has the CLI flag `--fsModuleCachePath`, so they get the same path.
  They keep their own `fsModuleCache` value and their own Vite `cacheDir` (no CLI flag for it).
- In single-project mode the tool overrides the user's own `cacheDir` and `fsModuleCachePath` for its runs;
  the user's own `fsModuleCache` value stays (the first run after adoption starts cold; plain `vitest` runs
  keep their own location).
- The tool never deletes `.vitest-impact/cache`; only `plan.json`, `report.json` and `summary.md` are removed at start.
