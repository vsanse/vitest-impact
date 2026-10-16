# MVP validation

Validated locally on 16 October 2026 with Node 24.19.0 and Vitest 5.0.5. The cloud environment reported two available CPUs. GitHub-hosted CI has not been run; the included workflow defines future Node 22/24 checks.

Completed checks:

- `npm run check`: TypeScript checking/build and **48 passing tests across four files**.
- Real CLI integration tests use temporary Git repositories and actual Vitest execution, not a mocked runner.
- `npm run demo`: source selection, full-suite shadow mode, and declared fixture failure detection all passed.
- A packed tarball was installed into a separate consumer project with its own dependency installation. The installed executable selected and ran exactly one of three test files and returned success.
- A deliberately bad ignore rule produced a real shadow miss, and the tool returned failure and named the omitted failing file.
- Regression checks cover full fallback, missing revisions, deleted modules, aliases/transitive imports, new tests, unknown config, empty discovery, name filters, coverage plans, `.only`, global teardown failures, concurrent invocation locks, workspace mutation during planning, and preservation of native serial execution.

The generated scale exercise used 1,000 trivial test files divided among 20 independent source groups. A behaviour-preserving edit touched one group, so exactly 50 files were relevant. Each variant used two workers; persistent transform caching was disabled.

| Development smoke observation | Files executed | Whole-process time |
| --- | ---: | ---: |
| Native full suite | 1,000 | 86.25s |
| Wrapper full suite | 1,000 | 86.96s |
| Wrapper shadow, with 50 selected | 1,000 | 87.89s |
| Native `--changed`, separate comparison | 50 | 6.29s |
| Wrapper selected, same comparison | 50 | 6.96s |

The initial wrapper-selected observation was 6.70s; the later native-selection comparison above is the more relevant comparison. These are single observations from development smoke runs, not controlled production benchmarks, confidence intervals, p95 estimates, CI-cost measurements, or evidence of real-world failure recall. The generated graph is deliberately easy to select. Final correctness checks and the package-consumer smoke test were completed after the resource-cap preservation fix.

The important finding is that native Vitest already supplies most of the speedup for this static-import case. The wrapper adds policy checks, explicit fixture ownership, fallback decisions, resource caps, and evidence of missed failures. It incurs overhead and has not established incremental speed or cost savings over tuned native selection.

Raw observations are available in `.vitest-impact/benchmark.json` and `.vitest-impact/benchmark-native-selected-wrapper-selected.json`. Demo reports are in `.vitest-impact/demo/`. The installable local package is `.vitest-impact/local-vitest-impact-0.1.0.tgz`.

Remaining validation needs representative Node and DOM suites, historical failed-PR replay, measured worker-memory profiles, and compatibility beyond the pinned Vitest release. Retain full-suite gates while collecting that evidence.
