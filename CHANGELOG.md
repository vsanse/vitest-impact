# Changelog

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

## 0.1.0

First prototype: one Vitest project, shadow mode, selection, resource budget.
