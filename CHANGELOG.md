# Changelog

## 0.3.0

- Vitest 4 support: Vitest 4.0.18 and later run, in full mode and with selection. Packages on Vitest 4 and Vitest 5 copies run in one invocation, one shared process per copy.
- Module cache: on Vitest 4 it is experimental and off unless a package turns it on. The tool never turns it on and passes no cache path (no `fsModuleCachePath`, no `--fsModuleCachePath` for separate units), and `fs-module-cache-off` applies to Vitest 5 only, so the warm-cache gain applies to Vitest 5 only.
- Plugin parity on Vitest 4: each package runs as an inline project that extends its config file and adds a plugin named `vitest`, as its own `vitest run` has. Plugins that look for that name (such as vite-plugin-wasm) behave as in the package's own run. Project names and tags stay those of the config file.
- Version policy: `peerDependencies.vitest` is `^4.0.18 || ^5.0.5`. Selection runs on Vitest 4.0.18, 4.1.7 and 5.0.5; another 4.x or 5.x runs the full set with a warning; 4.0.17 and older, and 6.x, exit 2.

## 0.2.0

- Monorepo runs: discovers workspace packages (`pnpm-workspace.yaml` or `package.json` `workspaces`) and runs their Vitest tests in one process. Script packages run their own `test` script. The root package's test script is never run.
- `--filter` (exact names, `./<folder glob>`, `!` to exclude) and `--shard i/n`.
- Each package sees its own folder as `process.cwd()`.
- Packages that cannot share the process run separately, with the reason in the plan: `isolated-in-config`, `pool:<name>`, `browser`, `typecheck`, `file-parallelism-off`, `global-setup`, `coverage`, `fs-module-cache-off`. A separate unit that exits non-zero fails the run.
- `emptyPackages`: packages with no test files and `passWithNoTests: true` are left out and listed.
- New `isolated` config key and `vitest-impact check [--write]` to find and record packages that fail only in the shared process.
- Worker count follows the machine (CPU including cgroup limits, memory). No fixed default of 2.
- Warm caches in `.vitest-impact/cache/modules` and `.vitest-impact/cache/vite`.
- Report: time per package and phase, slowest files, timeouts with peak load per CPU, failed separate units.
- Vitest ^5.0.5; versions other than 5.0.5 run the full set with a warning.
- macOS: memory budget uses total memory, so the suite runs on a Mac with a full file cache.
- Fixes: selection of orphaned sources, strict workspace and config errors, spawn failures exit 2.
- Environment parity: `TEST`, `VITEST` and `NODE_ENV=test` are set before any config loads, as `vitest run` does (Vite had set `NODE_ENV=development`). Separate and script units start from the environment the tool was started with.
- Each Vitest package, shared or separate, gets `npm_package_name`, `npm_package_version`, `npm_lifecycle_event=test` and its `node_modules/.bin` folders first on `PATH`, as with `npm run test` in its folder.
- Single-project mode replaces Vitest's default worker count (CPU count minus one) with the budget, as workspace mode does.
- Under `--shard`, a package with its own coverage runs whole in one shard (`plan.coveragePackages`).
- Timeouts in separate units are listed; the README says which timeouts are listed.
- A source change in a workspace package that a package in the run depends on runs the full set (`workspace-dependents-not-tracked: <name>`), since links through `dist` are not tracked yet.
- Separate units refuse `.only` (`--allowOnly=false`), in CI or not.
- A root Vitest config with several projects (`test.projects`) is refused with a message that says it is not supported yet.
- A `pnpm-workspace.yaml` with no `packages:` key means no workspace. Changes to `pnpm-workspace.yaml` and `.yarnrc.yml` force the full set.
- `check` reports packages on the `isolated` list that pass in the shared process.
- The summary lists the packages that run in their own process, with their reasons. Load per CPU uses the budget's CPU count.
- `toolVersion` comes from `package.json`.
- Example workflow: also runs on pushes to the default branch, keeps the cache out of the artifact, and leaves `node_modules` out of the cache key.
- One shared Vitest process per Vitest copy: each Vitest package runs on the copy it resolves, the one its test files import (pnpm can install several copies of one version). Groups run one after the other with the full worker budget, each with its own Vite cache folder. The version policy applies to every copy, a package from which `vitest` cannot be resolved exits 2, and `report.json` lists `sharedGroups`.
- The working-folder shim is written to `.vitest-impact/cwd-shim.mjs`, inside the repo, so client environments (jsdom) load it when the tool is installed outside the repo root.
- The Git checks ignore `.vitest-impact/`, also when `.gitignore` does not list it ("Workspace changed during planning" and full sets from the tool's own files).
- Workspace dependents are found transitively, through every discovered package, so a change reaches a package in the run through packages without tests too.

## 0.1.0

First prototype: one Vitest project, shadow mode, selection, resource budget.
