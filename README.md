# Vitest Impact

A working, deliberately narrow MVP for explaining and validating change-based Vitest execution on constrained CI runners. It wraps Vitest's own selection logic, adds explicit non-code input ownership and conservative fallbacks, and chooses a worker budget.

**Default execution mode is shadow: compute a selection, then run the entire suite.** Selective execution is an explicit opt-in. This is a prototype, not a proven zero-miss selector or a published npm package.

Requires Node 22.12+ or 24+ as supported by Vitest, **Vitest exactly 5.0.5**, and one Node-based project using the `forks` or `threads` pool. DOM environments in those pools are supported by the adapter but have not yet been benchmarked here. Browser/VM/custom pools, multi-project workspaces, and typechecking suites are rejected.

## Try the working demo

```bash
npm ci
npm run check
npm run demo
```

The demo creates a temporary Git repository with three test files. It verifies source selection, full-suite shadow execution, and a failing filesystem fixture dependency. Reports are copied to `.vitest-impact/demo/`; the temporary repository is removed. The intentional fixture failure is expected, so the demo itself succeeds when the failure is correctly detected.

## Use it in an existing project

Build this checkout, then invoke its CLI from a target repository that has Vitest 5.0.5 installed:

```bash
# In this checkout:
npm run build

# In the target repository:
node /absolute/path/to/vitest-impact/dist/cli.js init
```

Review and commit `vitest-impact.config.json` and the `.gitignore` entry that `init` adds. `init` refuses to overwrite an existing config. Its source/input/ignore lists start empty: unclassified changes trigger the full suite until you deliberately declare ownership.

```json
{
  "version": 1,
  "sourcePatterns": ["src/**/*.ts"],
  "inputs": [
    { "files": ["fixtures/**"], "tests": ["test/fixture.test.ts"] }
  ],
  "forceFull": ["schemas/**"],
  "ignore": ["docs/**"],
  "alwaysRun": [],
  "resources": {
    "maxWorkers": 2,
    "workerMemoryMb": 1024,
    "reserveMemoryMb": 512
  }
}
```

Glob patterns are positive, repository-relative POSIX paths; matching includes dotfiles. `sourcePatterns` is an **input contract**: changes to those paths can be analyzed through static imports plus your declared inputs. Do not classify arbitrary filesystem reads, variable imports, directory scans, or external-service dependencies as fully handled by that graph. Add `inputs` or `forceFull` rules instead. `ignore` is a user assertion that a path cannot affect tests; an incorrect ignore rule can hide failures. Shadow mode helps expose such mistakes.

Use an explicit ancestor revision. `HEAD` is useful for local uncommitted edits; CI needs the PR/merge candidate's proper base:

Choose a baseline with appropriate successful validation. Git ancestry alone does not prove that the baseline passed its tests; this MVP does not query CI to verify that history.

```bash
node /absolute/path/to/vitest-impact/dist/cli.js plan --base HEAD
node /absolute/path/to/vitest-impact/dist/cli.js run --base HEAD
node /absolute/path/to/vitest-impact/dist/cli.js run --base HEAD --mode selected
node /absolute/path/to/vitest-impact/dist/cli.js run --mode full
```

`--root` selects the repository root. `--config` selects the impact JSON config; `--vitest-config` selects the Vitest config. Saved plans are inspection artifacts, not executable cache entries: each run computes a fresh plan. `plan` loads Vitest configuration and transforms modules but does not execute test bodies. Configuration files and transform plugins are executable code, as in a normal Vitest invocation.

For a local package installation, `npm pack` creates a tarball; install it as a dev dependency in the target project. The package is private and has not been published. Its `vitest-impact` bin then becomes available to npm scripts. Keep the exact Vitest peer version until the adapter compatibility matrix is expanded.

## What it guarantees within its implemented contract

- Uses Git changes from the supplied revision to the working tree, including committed changes, staged/unstaged changes and non-ignored untracked files.
- Requires the base to be an ancestor of HEAD. Missing Git history, no base, invalid revisions, and divergent bases broaden to the full configured suite.
- Includes changed/new tests, declared fixture owners, and mandatory tests.
- Runs the full suite for deleted/type-changed inputs, unknown paths, protected configuration/lock/environment files, and known selection errors. Declared ignored documentation is an exception to structural fallback.
- Protected inputs and directly changed tests take precedence over ignore rules.
- A declared fixture owner matching no tests triggers a full run. An `alwaysRun` pattern matching no tests is a configuration error.
- Empty native selection for changed source falls back to full. An empty selection is otherwise allowed for no changes or explicitly ignored changes, after confirming that the configured suite is nonempty.
- Coverage-enabled configurations run the full suite, preserving whole-suite coverage behaviour.
- Rejects existing changed/related/shard/project/name/tag filters that would silently narrow the validation universe. Test `.only` markers and unhandled errors cannot be configured away through this wrapper.
- Executes exact Vitest test specifications, not substring filename filters.
- Detects tracked and non-ignored file-content edits during planning. This is a drift check, not a filesystem transaction; concurrent edits during execution are unsupported.
- Compares expected and observed file identities. Missing/unexpected executions invalidate the report rather than looking like success.

There is no universal completeness guarantee for unrestricted JavaScript. The MVP does not reconstruct old import graphs: deletions use full fallback. It does not infer ignored `.env` edits, external-service changes, runtime drift since the baseline, generated inputs outside Git, or arbitrary dynamic dependencies. No persistent dependency graph or test-result cache is used. Keep full validation gates while evaluating it.

## Resource budgeting

`maxWorkers` is a ceiling, capped by available CPU and an estimated memory budget. The implementation uses Node's capacity information and Linux cgroup v2 quota/memory information where available. Default concurrency is at most two workers, with a **512 MB unmeasured worker estimate** and a 512 MB reserve.

```bash
vitest-impact run --base HEAD --max-workers 2 \
  --memory-mb 4096 --worker-memory-mb 1024 --reserve-memory-mb 1024
```

Memory numbers are estimates used for admission, not enforced limits. They do not guarantee against OOM. The tool refuses an estimated budget that cannot fit one worker. It preserves stricter Vitest worker settings and `fileParallelism: false`. It does not measure peak memory or coordinate other test processes/service containers automatically. Account for those in your reserve and outer task-runner concurrency. It does not change test timeouts or automatically disable isolation.

## Reports and exit status

Each invocation acquires `.vitest-impact/run.lock` and replaces these local artifacts:

| Artifact | Content |
| --- | --- |
| `plan.json` | Base/head, versions, impact-config hash, changed paths, test decisions/reasons, fallback reasons, worker budget, warnings |
| `report.json` | Plan plus executed files, outcomes, timings, missing executions and shadow misses |
| `summary.md` | Human-readable CI summary; also appended to `GITHUB_STEP_SUMMARY` when present |

A native selection reason names the input set it analyzed; it is not a fabricated edge-by-edge dependency proof. Plans do not store source contents or environment-variable values. File paths and test outcomes remain in local artifacts unless your CI uploads them.

Shadow mode computes its selection **before** executing the full suite. A failing file outside the selection is reported in `missedFailingFiles`. Failing-file recall is measured only when a complete shadow run observes failures. All-green runs report `no-failures-observed` with `null` recall, never “100% safe.” File-level collection failures count as failures. Incomplete runs cannot claim recall.

Summed test-body/hook durations produce a duration fraction, not predicted wall-clock savings or reduced billed minutes. Planning overhead includes discovery and the workspace drift check. There is no historical learning in this version.

Exit codes: `0` passed, `1` test/run-level failure, `2` invalid configuration, infrastructure error, or incomplete execution. A shadow run fails if any full-suite test fails, even when the proposed selection would skip it. Reports preserve run-level Vitest failure status. Prior reports are removed at invocation start so a failed startup cannot leave an old green report behind.

Run one invocation per checkout. A second invocation fails while the lock is held. If a process is killed without cleanup, inspect `run.lock` and confirm the owner has stopped before removing that lock. Concurrent invocations in separate checkouts are independent.

## GitHub Actions

See [`examples/consumer-workflow.yml`](examples/consumer-workflow.yml). It fetches full history, passes the PR base through an environment variable, runs shadow mode, and uploads artifacts even when tests fail. It assumes you have installed this local package in the consumer repository; it is not an instruction to download an unpublished package from npm.

For merge queues, select against the actual merge candidate and its validated base. A nightly full run is a delayed detection mechanism, not equivalent to full pre-merge assurance. Retain existing full-suite gates during the pilot. Source-only selection and runner sharding have different effects on total billed minutes.

## Implementation and validation

The adapter uses public Vitest discovery/execution APIs and one private, version-pinned bridge for selection without execution: `specifications.filterTestsBySource`. Its absence/failure falls back to full selection. An unsupported Vitest version is rejected before running. This is the primary compatibility risk and a good candidate for an upstream public API proposal.

Modules:

- `src/planner.ts`: input rules, fallback policy and decision explanations.
- `src/git.ts`: revision validation, NUL-safe Git parsing and drift fingerprints.
- `src/adapter.ts`: version guard, native selection and exact execution.
- `src/resources.ts`: CPU/memory estimates and worker budget.
- `src/report.ts`: outcome validation, observed miss detection and CI summary.
- `src/index.ts` / `src/cli.ts`: orchestration and commands.

`npm run check` compiles the implementation and runs unit plus real CLI integration tests. Integration tests create temporary Git repositories and execute actual Vitest workers. They include a deliberately unsafe ignore rule to verify that shadow mode detects a real missed failure, not just a mocked selection discrepancy.

The repository CI workflow checks Node 22 and 24. Local validation results apply only to the runtime actually used; a workflow file is not evidence that remote CI has run.

An optional generated scale experiment compares native full and native changed execution, wrapper full execution, wrapper selection, and shadow mode:

```bash
npm run benchmark -- --files 1000 --runs 1
```

This creates 1,000 trivial files in 20 independent source groups, then changes one group without introducing a failure. It verifies exact execution counts, disables persistent transform caching, records whole-process times, and saves `.vitest-impact/benchmark.json`. One repetition is a scale smoke test, not a robust performance estimate; it does not measure production failure recall. Increase `--runs` for repeated measurements and use real repositories before making savings claims.

Next experiments: representative Node/DOM suites, measured worker memory, native-versus-wrapper overhead, historical failed-PR replay, and a public selection API. Dynamic scheduling, remote caching, Rust, individual-test-case exclusion, and AI selection are intentionally outside this MVP.
