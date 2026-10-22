# Design: a faster, safe Vitest for CI in monorepos

Date: 2026-10-16. Status: **approved by the owner on 2026-10-16.**
Name: `vitest-impact` (free on npm and on GitHub under `vsanse` on 2026-10-16; the owner confirms it
before the repo is created).

## 0. Starting code

The new repo starts from the owner's prototype `vitest-impact` 0.1.0
(the owner's local folder). The owner wrote it and relicenses it as MIT.

What the prototype already does, and what this design keeps:

- Full-suite fallback for unknown paths, deleted or type-changed files, protected files (lockfiles,
  `package.json`, Vite and Vitest configs, `tsconfig*.json`, `.env*`, `.npmrc`, `.github/**`), selection
  errors, and coverage.
- Explicit input ownership in `vitest-impact.config.json`: `sourcePatterns`, `inputs` (fixture globs to
  owning tests), `forceFull`, `ignore`, `alwaysRun`. With an empty config, every change runs the full set.
- A check that the files that ran are exactly the files that the plan expected. A missing or an extra
  file makes the run incomplete (exit code 2), never a pass.
- Exit codes: `0` passed, `1` test or run failure, `2` configuration error, infrastructure error, or
  incomplete run.
- Rejection of Vitest filters that narrow the suite without the tool knowing (`--changed`, `--related`,
  name, tag, and project filters). `.only` is not allowed.
- Reports: `plan.json`, `report.json`, `summary.md`, also written to `GITHUB_STEP_SUMMARY`.
- A run lock for each checkout.
- CPU and memory detection, including cgroup v2 limits.

What this design changes in the prototype:

- **Bug fix:** today it falls back to the full set only when the whole selection is empty
  (`src/planner.ts:73-79`). A changed source file that selects zero tests must also force the full set,
  even when other changes select tests. Without this fix, a change in a workspace package that tests
  load through `dist/` is skipped silently.
- **More than one Vitest project** (section 6.1). The prototype supports exactly one.
- **`--shard`** (sections 6.1 and 6.2). The prototype rejects it.
- **Shadow mode against the reference set**, not the full suite (section 6.2).
- **Dependency records and warm caches** (sections 6.1 and 6.2). The prototype sets
  `recordDependencies: false` and keeps no state between runs.
- **Worker count sized for the machine.** The prototype uses at most 2 workers by default.
- **Vitest versions:** a tested range of 5.x versions, not one exact version. The prototype calls a
  private Vitest API (`specifications.filterTestsBySource`). The builder prefers public APIs. Where the
  tool must use a private API, it pins the versions it has tested, and it runs the full set if that API
  is missing or fails.

## 1. Intent

As a project grows, its unit tests grow. The tests pass on a developer machine. On small CI runners
(for example a 2-vCPU GitHub runner) the same tests run for a long time, some time out, and the long
runs cost money.

The tool makes Vitest runs in CI faster and keeps them correct. It has two parts:

1. **Speed part.** Every run gets faster, including a run of the full suite. A release PR that changes
   most of the repo must also get faster.
2. **Selection part.** A normal PR runs only the tests that its changes can affect.

The tool is open source and is for any team that runs Vitest, not only for one repo.

### Success (owner's words)

"PR test time cut in half or below, with zero missed failures." The owner also said that the gain must
apply "through and through": when selection picks almost the full suite, that run must also be faster.

## 2. Evidence that shaped this design

| Fact | Source |
|---|---|
| Vitest `--shard` splits by a hash of the file path with an equal file count. It ignores timing. | Vitest `BaseSequencer.ts` |
| Vitest 5.0.4 (2026-10-12) added `experimental.recordDependencies`. It records the files that each test file loads at run time. `--changed` and `related` can then use these records. It does not record files read with `fs`, imports in a `vi.mock` factory, or dynamic imports that did not run. | Vitest docs, `config/experimental` |
| Open Vitest bugs: a change in a linked workspace package selects no tests and exits with code 0 (#11585). A test that imports a deleted file is skipped (#11566). | GitHub issues |

What the evidence rules out:

- A Rust rewrite or a new runner. The runner core is not the cost. Vite 8 already does transforms in
  Rust (Oxc).
- AI selection in version 1. There are no published accuracy numbers for LLM test selection in JS/TS.
  Meta and Google use classic models (gradient-boosted trees).

## 3. Goals

- **G1.** A full run is faster on a small CI runner than the same run under Turbo with one Vitest
  process per package.
- **G2.** A normal PR uses half of today's test time or less. "Today" means what the team's CI runs now.
  In a repo that uses Turbo, that is Turbo's affected packages with the Turbo cache. So the tool must beat a
  package-level filter, not only the full suite. (My reading of the owner's words "PR test time".)
- **G3.** Zero missed failures. Selection proves this in shadow mode before a team switches it on.
- **G4.** A team can adopt the tool with zero changes to its tests.
- **G5.** It works on any repo that uses Vitest: a pnpm, npm, or yarn workspace, or a single package.

## 4. Non-goals

- A new test runner, a fork of Vitest, or a Rust rewrite.
- AI or LLM selection. If it comes later, it may only add tests to the rule-based set, and only from a
  known list of test IDs. It may never remove a test.
- Shards balanced by timing.
- A hosted service or a backend. All state is in files that CI already stores (cache or artifacts).
- Faster pools (`vmForks`, `vmThreads`) or happy-dom as defaults. The spike showed out-of-memory errors
  and test failures. These can come later as an opt-in for each file, with a memory limit.
- Vitest browser mode.
- Vitest 4 or older.

## 5. Anti-goals

The tool is a failure, even if it works in other ways, if it does any of these:

- **It skips a test that would fail, and does not say so.** An exit code of 0 with no tests run, when
  changes could affect tests, is a failure of the tool. The #11585 bug is the example.
- **It hides real slowness.** For example, it must not raise test timeouts on its own. A timeout is a
  limit, not a budget.
- **It gives a result that plain Vitest would not give.** A test that passes in the tool must also pass
  in plain Vitest, and the reverse.
- **It forces a team to change its tests before it can be adopted.**

## 6. What the tool does

### 6.1 Speed part (ships first)

1. **One process for the whole repo.**
   - It finds the workspace packages whose `test` script runs Vitest. The script decides, not the
     presence of a config file, so the tool runs the same tests that the team runs today.
   - It keeps simple environment prefixes in a script (for example `NODE_OPTIONS=... vitest`).
   - A package whose `test` script does more than run Vitest (for example lint, then type-check, then
     Vitest) runs its script as-is, in its own process.
   - The CLI takes package filters with the same syntax as pnpm and Turbo (for example
     `--filter='!./tools/*'`), so CI can keep its current filters.
   - It runs the packages in one Vitest process (Vitest `projects`).
   - It accepts `--shard=i/n` for the one-process run, so a team can still split a suite across jobs.
   - It sizes the worker count for the machine. It reads the real CPU limit, including cgroup limits in
     containers. On a 2-vCPU runner it uses 2 workers, not the Vitest default of 1.
2. **Parity with the run of each package alone.**
   - Each package keeps its own working folder: `process.cwd()` in its tests is the package folder.
   - Each package keeps its own environment variables (for example `NODE_OPTIONS`), setup files, global
     setup, and Vite plugins.
3. **Isolation list, made at adoption time. No automatic retry in CI.**
   - A `check` command runs each package two ways: in the shared process, and alone. It runs on a
     developer machine or in a one-time CI job.
   - A package that fails in the shared process but passes alone goes on an "isolated" list in the
     tool's config file. The team commits that file.
   - In CI, a package on the list runs as its own process from the start. Every failure in CI is a
     failure. The tool never runs a failed package again to turn the result into a pass, because that
     would hide flaky tests and slowness (section 5).
   - So a team needs zero test changes to adopt (G4). The `check` output tells the team what to fix to
     move a package off the list.
4. **Warm caches between CI runs.**
   - It saves and restores the Vitest transform cache (`fsModuleCache`), the results cache (durations,
     used to start slow files first), and the dependency records.
   - The cache key includes the lockfile and the config files. On a key change, the tool starts cold.
   - Storage is a folder path. CI moves the folder with its own cache step (for example `actions/cache`).
5. **Report after each run.**
   - Time per phase (import, environment, tests), for each package.
   - The slowest test files.
   - Tests that timed out, with the load on the machine at that time.
   - The packages on the isolated list.
6. **Coverage.** The speed part works with coverage on. Selection does not: when coverage is on, the
   tool runs the full set and says so, because coverage thresholds have no meaning on a subset.

### 6.2 Selection part

1. **Input.**
   - The changed files: `git diff` against the merge base of the PR's base branch.
   - The dependency records from the last full run on the base branch.
2. **Selection.** It starts from Vitest's `recordDependencies` and adds the cases that Vitest misses:
   - Links between workspace packages: a change in package A's `src` selects the tests that load A
     through `dist`, through the optimizer, or through a workspace link.
   - Deleted files: a test that imported a deleted file is selected.
   - Files that tests read without importing them (fixtures, JSON): the team lists them as globs in the
     config. A change to a matching file selects the tests that the config links to that glob, or the
     full suite if it links to nothing.
3. **Run the full suite when the tool is not sure.** Examples:
   - No records exist for the base commit.
   - A change to a config file, the lockfile, a setup file, or a global setup file.
   - A changed file that the tool cannot link to anything, unless the team lists it as "never affects
     tests" (for example `docs/**`).
   - Any internal error in the tool.
   The output always says why it ran the full suite.
4. **Never a silent zero.** If changes exist and the tool selects no tests, it prints the reason for
   each changed file. It never exits with code 0 without that reason.
5. **Shadow mode** (the default when a team installs the tool).
   - On each PR, the tool computes the selection, then runs the same set of tests that CI runs today
     (the reference set), for example Turbo's affected packages. Shadow mode adds no test
     time compared with today.
   - The reference run decides pass or fail.
   - For each test that failed in the reference run, the tool checks whether the selection included it.
   - A miss is a failed test that the selection did not include and that fails again when it runs a
     second time. A test that passes on the second run is flaky and is not a miss. (This second run is
     only for the report. It never changes the pass or fail result.)
   - The full run on the base branch (item 7) is a second check. When a test fails there, the tool
     looks up the PRs merged since the last green full run. If one of those PRs had changed files that
     the failure depends on and its selection skipped the test, that is also a miss.
   - The tool reports the misses and the time that the selection would have saved.
6. **Switch on.** A team switches selection on with one setting. The documentation recommends shadow
   mode with zero misses for a fixed period first (4 weeks, my guess).
7. **Full run on the base branch.** Every merge to the base branch (for example `main`) runs the full
   suite and writes the dependency records that PRs read.
8. **Several CI jobs.** A suite can run in several jobs (for example several shards of one
   large package and 1 job for the rest).
   - On the base branch, each job writes its own records. A merge step combines them into one set.
   - If the records of any job are missing for a commit, PRs on that commit run the full set.
   - On a PR, the tool selects first, then shards the selected tests.
   - A merge step combines the shadow-mode reports of all jobs into one report.

### 6.3 How a team uses it

- It installs one npm package.
- In CI, it replaces the test command (for example `turbo test` or `vitest run`) with the tool's CLI.
- It adds one cache step for the tool's state folder.
- Optional: a config file for fixture globs, "never affects tests" globs, and the selection mode.

## 7. Constraints

- **Language and runtime:** TypeScript, ESM, Node 22.12 or later (the Vitest 5 minimum, kept for Vitest 4 too).
- **Vitest:** 4.0.18 or later, or Vitest 5 (`^4.0.18 || ^5.0.5`). Selection uses an internal Vitest
  method, so it runs only on tested versions (4.0.18, 4.1.7 and 5.0.5); another version in the range runs
  the full set. The tool's own CI also runs against the latest Vitest release, to find a break early.
- **Vitest APIs only:** the tool uses the public Node API (`createVitest`), `projects`, reporters, a
  custom sequencer, and `experimental.vcsProvider`. It does not patch Vitest.
- **License and home (owner's decision):** MIT, in a new public GitHub repo under the account `vsanse`,
  public from the start. The tool is published to npm as `0.x` versions.

## 8. How we measure success

| Goal | Measure | Target |
|---|---|---|
| G1 | Wall time of the test step for a full run, on the same runner size, tool against Turbo | Faster. |
| G2 | Test step time of a normal PR with selection on, against what CI runs today on the same PR | 50% or less, as a median over the PRs in the shadow period |
| G3 | Misses in shadow mode | 0 over the shadow period |
| G4 | Test files changed to adopt | 0 |
| Load failures | Share of runs that fail with a timeout or out of memory | Lower than today |

## 9. Risks

- **Vitest changes fast in this area.** `recordDependencies` is 4 days old. Vitest can absorb parts of
  the tool or change the API. The tool must stay a thin layer on top of Vitest and must not copy Vitest
  logic.
- **The working folder for each package.** Vitest has no setting for the working folder of a project.
  A spike must show a way to keep `process.cwd()` correct for each package in one process.
- **Selection gains depend on the repo.** In a frontend app, many tests import shared stores. A change
  to one shared file can select most of the suite. The 50% target can be out of reach for some PRs.
  Shadow mode shows the real number before a team relies on it.
- **A single large package is already one process.** The one-process gain applies to repos with many
  packages. For one large package, the gain must come from warm caches and from selection.

## 10. Left to the builder

- The CLI command names, if they differ from the prototype (`init`, `plan`, `run`).
- The internal structure of the code.
- The format of the state folder and of the report.
- The shape of the config file.
- How to keep the working folder of each package (after the spike in section 9).
- The order of work inside each part. The speed part comes before the selection part.
