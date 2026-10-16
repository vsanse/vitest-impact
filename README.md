# vitest-impact

Run a repository's Vitest tests faster, and (opt-in) only the tests a change can affect.

- **Speed part.** One Vitest process for all the packages of a monorepo, a worker count sized for the machine (including container CPU limits), warm caches in `.vitest-impact/cache`, and a report with time per package and phase.
- **Selection part.** From a base revision, it computes which tests a change can affect. **Shadow mode is the default: it computes the selection, then runs the whole suite and reports any failure the selection would have missed.** `--mode selected` is an opt-in that runs only the selection. When the tool is not sure, it runs the full set and says why.

One measurement, not a promise: in one private monorepo, running 44 packages in one Vitest process used 47% fewer CPU-seconds and 64% less peak memory than one Vitest process per package under Turbo (one local measurement). Measure your own repository.

Requires Node 22.12+ and Vitest ^5.0.5. Tested with Vitest 5.0.5. Another 5.x version runs, but selection is turned off and the full set runs (with a warning in the plan). Vitest 4 and older are rejected.

## Install

```bash
npm install --save-dev vitest-impact
npx vitest-impact init
```

`init` writes `vitest-impact.config.json` and adds `.vitest-impact/` to `.gitignore`. It refuses to overwrite an existing config. Commit the config.

## Commands

```bash
vitest-impact init  [--root PATH]
vitest-impact plan  --base REF [options]
vitest-impact run   [--base REF] [--mode shadow|selected|full] [options]
vitest-impact check [--filter TOKEN] [--write]
```

| Flag | Meaning |
| --- | --- |
| `--root PATH` | Repository root (default: current folder). |
| `--config PATH` | The impact config, relative to the root (default `vitest-impact.config.json`). |
| `--vitest-config PATH` | Use this Vitest config and skip workspace discovery. |
| `--base REF` | An ancestor revision. Without a valid base the full set runs. |
| `--mode` | `shadow` (default): select, then run everything. `selected`: run only the selection. `full`: run everything, no selection. Only for `run`. |
| `--filter TOKEN` | Repeatable. Only an exact package name or `./<folder glob>` is supported. `!` excludes. A positive token that matches no package is an error; a negated token that matches nothing is not. Needs a workspace. |
| `--shard i/n` | Run the i-th of n shares of the planned files (Vitest packages, shared or separate, by file; script packages and packages with their own coverage by package name, so each of those runs whole in one shard). An empty shard still writes its report. |
| `--max-workers N`, `--memory-mb N`, `--worker-memory-mb N`, `--reserve-memory-mb N` | Resource budget (see below). |
| `--write` | Only for `check`: record candidates in the config's `isolated` list. |

`plan` loads the Vitest configuration and transforms modules but runs no test bodies. Configuration files and plugins are executable code, as in any Vitest run. Saved plans are for inspection; each run computes a fresh plan.

Example for CI, keeping a Turbo-style filter:

```bash
npx vitest-impact run --base "$IMPACT_BASE" --mode shadow --filter '!./tools/*'
```

## Workspace mode

If the root has a `pnpm-workspace.yaml` (its `packages:` list) or a `package.json` `workspaces` field, the tool finds the packages and runs their Vitest tests in one process. `pnpm-workspace.yaml` wins when both exist. Without a workspace, the tool runs the single project as before; that mode still accepts the `threads` pool (only workspace mode separates it).

- The root package's own `test` script is never run.
- A package is a **Vitest package** when its `test` script is exactly `vitest` or `vitest run` and it has a `vitest.config.*` or `vite.config.*` file. A package with any other `test` script (for example lint, then Vitest), or with that script but no config file, is a **script package**: its script runs as it is, in its own process, through the repository's package manager. A package with no `test` script is left out.
- No root Vitest config is used in workspace mode. A root-level shared config is ignored. Settings Vitest reads only from the root (for example `reporters`) come from the tool.
- A package that fails to parse, an empty filter result, or a Vitest package with no test files (unless its config sets `passWithNoTests: true`) is an error (exit 2). A package with `passWithNoTests: true` and no test files is left out and listed as `emptyPackages` in the plan.
- `process.cwd()` in a package's tests is the package folder, as with `vitest run` inside that folder. It works in the shared process, which uses only the `forks` pool (a shim calls `process.chdir`), including `isolate: false`. Any other pool runs separately (see below). The shim was also shown to work with `vmForks`, but the tool separates that pool by policy. See [docs/decisions/cwd-parity.md](docs/decisions/cwd-parity.md).

- Environment: like `vitest run`, the tool sets `TEST=true`, `VITEST=true` and `NODE_ENV=test` (unless `NODE_ENV` is already set) before it loads any config, so configs and tests see the values plain Vitest gives them. Separate and script units start from the environment the tool was started with, not from the tool's own process.

**Known gaps of the working-folder guarantee:** the package config file is loaded with the repo root as the working folder, and Vite plugins run in the main process, so code in either that calls `process.cwd()` sees the repo root. A package with `globalSetup` runs separately, because global setup also sees the repo root.

### Packages that run in their own process

A Vitest package runs in its own Vitest process, with its own settings, when the plan shows one of these reasons (`plan.json`, field `separate`):

| Reason | Why it cannot share the process |
| --- | --- |
| `isolated-in-config` | The package is in the config's `isolated` list. |
| `pool:<name>` | The pool is not `forks`. Only `forks` shares the process: `threads` cannot `chdir`, and `vmForks` is separated by policy. |
| `browser` | Browser mode. |
| `typecheck` | Typecheck is enabled. |
| `file-parallelism-off` | `fileParallelism: false` is a per-package setting. |
| `global-setup` | `globalSetup` runs in the main process and sees the repo root. |
| `coverage` | Coverage is on in the package config. The package runs alone, in full (under `--shard`, whole in one shard), with its own thresholds. |
| `fs-module-cache-off` | The package sets `fsModuleCache: false`, which a shared run cannot honor for one package only. |

A separate package keeps its own result: if its process exits non-zero, the run exits 1, even if every test passed (coverage thresholds, unhandled errors). Separate units run one after another.

## The `isolated` list and `check`

Some packages pass alone but fail when sharing a process (shared module state, ports, global mocks). Put them in `isolated`:

```json
{ "version": 1, "isolated": ["@acme/legacy-api"] }
```

`vitest-impact check` finds them. It runs every discovered package: Vitest packages with no structural reason to run apart go in the shared process (ignoring the current `isolated` list), and each package that fails there is rerun alone. Structural-separate and script packages run alone, and a non-zero exit there is a real failure. A package that fails shared but passes alone is a candidate. A package that also fails alone is a real failure (exit 1). `check` ignores `--max-workers` and the other resource flags; it uses the config's `resources`. `check --write` merges the candidates into `isolated` (sorted, no duplicates, all other keys kept). Commit the config. In CI a listed package runs in its own process from the start. The tool never turns a failure into a pass.

`check` overwrites `.vitest-impact/plan.json`, `report.json` and `summary.md`, because it is a run too.

## Caches

Shared runs write to `.vitest-impact/cache`:

- `cache/modules`: Vitest's transform cache (`fsModuleCachePath`). Separate Vitest units get the same path.
- `cache/vite`: Vite's `cacheDir`, which also holds Vitest's results cache (file durations, used to start slow files first).

The tool never forces `fsModuleCache` on (Vitest 5.0.5 defaults it to true), and a package that sets it to `false` runs separately. In **single-project mode** the tool overrides your `cacheDir` and `fsModuleCachePath` for its own runs; plain `vitest` runs keep theirs. The first run after adoption starts cold. In workspace mode, a package's own `cacheDir` only affects its Vite pre-bundle cache.

The tool never deletes `.vitest-impact/cache`. In CI, restore and save that folder with the cache step of your CI, keyed on lockfiles and config files:

```yaml
- uses: actions/cache@v4
  with:
    path: .vitest-impact/cache
    key: vitest-impact-${{ runner.os }}-${{ hashFiles('**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', 'vitest-impact.config.json', '**/vitest.config.*', '**/vite.config.*') }}
```

See [`examples/consumer-workflow.yml`](examples/consumer-workflow.yml).

## Resource budget

`maxWorkers` is a ceiling, capped by the CPU count (including cgroup quota) and an estimate of memory: `(available memory - reserve) / worker estimate`. Defaults: 512 MB per worker, 512 MB reserve. On macOS the tool uses total memory, because `os.freemem` leaves out reclaimable cache. The numbers are estimates for admission, not limits; they do not guard against out-of-memory. The tool refuses a budget that cannot fit one worker (exit 2). A package's own lower `maxWorkers` is kept, and `fileParallelism: false` is kept. The tool does not change test timeouts.

```json
{ "resources": { "maxWorkers": 2, "workerMemoryMb": 1024, "reserveMemoryMb": 1024 } }
```

## Report and exit codes

`plan` deletes the old `report.json` and `summary.md` and writes only `plan.json`. A `run` replaces all three files in `.vitest-impact/`: `plan.json` (decisions and reasons, separate units, script packages, coverage packages, empty packages, resources, warnings), `report.json`, and `summary.md` (also appended to `GITHUB_STEP_SUMMARY` when set). Plans do not hold source contents or environment values.

The report holds:

- **Time per package and phase.** For one-process packages, phases are summed over files; for separate units no phase data exists, only wall time. Phases map to Vitest's own Duration line like this: the tool's `import` is Vitest's collect time, so it includes the collect part of Vitest's separate "transform" wait. The tool's `setup` is Vitest's setup plus its "worker" time, so it includes Vitest's "worker" time and the setup part of the "transform" wait. These two do not equal Vitest's numbers one by one. `environment` and `tests` match Vitest's.
- **Slowest files** (top 10).
- **Timeouts**: each test or hook that timed out, with the peak and mean load per CPU during the run (`load` is null where the OS gives no load average, such as Windows). A peak above 1 means the machine was overloaded and a timeout may come from that.
- **Failed separate units**, and units that produced no report.
- In shadow mode, `missedFailingFiles`, and recall of observed failures. An all-green run reports `no-failures-observed` with `null` recall, never "100% safe".

Exit codes: `0` passed. `1` a test failed, a run-level Vitest failure, or a separate unit exited non-zero. `2` invalid configuration, infrastructure error (including a process that could not start), or an incomplete run (missing or unexpected files, unhandled errors). A shadow run fails if any full-suite test fails, even one the selection would skip.

Each run takes `.vitest-impact/run.lock`. Run one at a time per checkout. After a killed process, confirm the owner is gone before removing the lock.

## Selection

Config keys (`vitest-impact.config.json`): `sourcePatterns`, `inputs` (`{ files, tests }` rules for files tests read without importing), `forceFull`, `ignore`, `alwaysRun`, `isolated`, `resources`. Globs are positive, repository-relative POSIX paths. `init` starts with empty lists, so unclassified changes run the full set until you declare ownership. `ignore` is your assertion that a path cannot affect tests; a wrong rule can hide a failure, which shadow mode helps expose.

The selection uses Git changes from `--base` to the working tree (committed, staged, unstaged and non-ignored untracked files) and Vitest's own related-test analysis. It runs the **full set** for: `--mode full`, no impact config file (`no-impact-config`), no `--base` (`missing-base`), no git or an invalid or non-ancestor base (`git-unavailable-or-invalid-base`), deleted or type-changed files, unknown paths, protected files (configs, lockfiles, environment files), an empty native selection for changed source, an `inputs` rule whose tests match no test file (`input-rule-has-no-tests`), coverage turned on, an untested Vitest version, and any known selection error. Changed tests and `alwaysRun` tests always run. An `alwaysRun` pattern that matches no test is a configuration error (exit 2). With coverage on, selection is off for that package and it runs in full, also under `--shard` (`plan.coveragePackages`).

### What it guarantees, and what it does not

- Every planned file is compared with what ran. Missing or unexpected files make the report invalid (exit 2), never a quiet success.
- Shadow mode runs everything, so it cannot hide a failure; it only tells you whether the selection would have.
- There is **no universal completeness guarantee** for unrestricted JavaScript. It does not follow dynamic imports, filesystem reads, `.env` edits, external services, generated files outside Git, or links between workspace packages through `dist`. Old import graphs are not rebuilt, so deletions run the full set. No dependency records are kept between runs yet. Keep your full-suite gates and use shadow mode first.
- A base is only checked to be an ancestor. Git does not prove the base passed its tests.
- Concurrent edits during a run are not supported.

### Vitest internals it depends on

- `specifications.filterTestsBySource`, a private method used to get a selection without running. If it is missing or throws, the full set runs.
- `context.specifications` and `runTestSpecifications`, to run exact test files.
- Changes to `project.config` after `createVitest`: `maxWorkers`, `env`, `setupFiles`, `allowOnly` and `sequence.groupOrder`.
- Re-loading each package config through Vite's `loadConfigFromFile`, to read `coverage`, `fsModuleCache` and `passWithNoTests`, which Vitest overrides.
- `config.providedOptions`, an untyped field used to see whether a package set its own `maxWorkers`. If it is missing, the lower value is kept.
- `process.exitCode`, read as the run-level failure signal.

An unsupported major version is rejected before any run. These are the main compatibility risk and the reason for the exact tested version.

## Development

```bash
npm ci
npm run check      # typecheck, build, tests
npm run demo       # temporary repository: selection, shadow run, a failing fixture input
npm run benchmark -- --files 1000 --runs 1
```

CI runs Node 22 and 24. The benchmark is a scale smoke test, not a performance estimate.
