# Vitest at CI scale: research and project decision memo

Research date: 16 October 2026. Target scenario: thousands of tests on GitHub Actions. The repository, installed versions, CI logs, runner configuration, and test history were not supplied. This memo reviews primary documentation and research, then proposes an architecture and validation programme. It does not claim measured savings, production readiness, or a code audit of the products discussed.

**Recommendation: begin with a benchmark and a small TypeScript orchestration layer around Vitest. Evaluate contribution to existing tools before creating a separate product.** A framework rewrite is premature. The possible opportunity is reliable, explainable change selection combined with resource budgeting, particularly for teams that do not want to adopt a monorepo platform or hosted prediction service. Whether that opportunity is substantial remains an empirical question.

1. **The problem contains several different bottlenecks.**

Thousands of test cases do not imply thousands of concurrent workers. Vitest normally parallelizes files through a bounded worker pool. Tests within a file normally run sequentially; explicit concurrent tests share that file's worker. File count, import graph, environments, and fixture cost can matter more than assertion count. [Vitest parallelism](https://vitest.dev/guide/parallelism).

Investigate these independently:

| Cost or failure source | What to measure | Likely intervention |
| --- | --- | --- |
| Too much simultaneous work | CPU throttling, aggregate memory, worker count, other processes | Reduce and coordinate concurrency |
| Repeated module/environment initialization | Transform, import, setup, environment timing | Narrow imports/setup, appropriate environments, supported caches |
| Expensive test bodies | Per-file duration, CPU versus waiting | Improve algorithms, fixtures, waits, service handling |
| Repeated unchanged work | Task cache hits and input fingerprints | Correctly keyed caching |
| Unrelated tests rerun | Changed paths and selected dependency closure | Affected-test selection |
| A few slow files dominate | Duration distribution and shard completion times | Rebalance shards or split oversized files |
| Races, leaks, external-service contention | Failure signatures, resource traces, repeatability | Fix the test or application; manage shared-resource limits |

GitHub currently documents standard Linux x64 runners at 2 CPUs/8 GB for private repositories and 4 CPUs/16 GB for public repositories. Other labels differ. Record actual runner specifications rather than treating `ubuntu-latest` as one universal capacity. [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

A useful causal experiment holds code and runner shape fixed and varies only workers. If fewer workers improve both completion time and timeout rate, contention is implicated. If one worker still times out, investigate the slow test, leaked handles, service behaviour, or a genuinely insufficient timeout. This is evidence, not an absolute diagnostic rule.

2. **A substantial part of the proposed solution already exists.**

| Existing option | Relevant capability | Implication for this project |
| --- | --- | --- |
| Vitest | Worker controls, changed/related selection, sharding, performance tooling | Mandatory baseline; do not reinvent the basic features |
| Nx | Affected project graph, task caching, Vitest CI splitting | Strong option if the repository already uses Nx |
| Turborepo | Affected package/task execution and caching | Often sufficient for package-level independence |
| `vitest-affected` | Persistent import graph and affected-file selection | Closest open-source candidate to evaluate or improve |
| Launchable | Predictive selection with a documented Vitest integration | Direct alternative when hosted prediction and its tradeoffs are acceptable |
| Develocity | Predictive selection for Gradle/Maven | Useful design precedent, not a verified drop-in Vitest option |

Vitest 5 is particularly relevant: its release notes describe persistent transform caching, smaller installation, shared Vite servers for eligible projects, and reduced runtime overhead. It also introduces `vitest doctor` to compare configurations. These are reasons to test the current supported version before attributing the problem to framework bloat; its published benchmarks are not estimates for your CI. [Vitest 5 announcement](https://vitest.dev/blog/vitest-5).

Native `--changed` accepts a revision. Current documentation describes invalidation for setup/config dependencies, loaded environment files, mocks, and snapshots, with limitations such as untracked `toMatchFileSnapshot` dependencies. `forceRerunTriggers` can broaden selection. [Vitest changed configuration](https://vitest.dev/config/changed).

`vitest related` supports statically identifiable imports, including literal dynamic-import specifiers, but not arbitrary `import(variable)` resolution. `vitest doctor` executes alternative configurations, so run it as a controlled tuning experiment rather than adding it to every PR. [Vitest CLI](https://vitest.dev/guide/cli).

Nx affected execution works at project granularity. Its current Vitest integration can also create atomized CI tasks; that splitting should not be confused with proving which individual files a source change affects. Evaluate both together where Nx is already present. [Nx affected](https://nx.dev/docs/features/ci-features/affected), [Nx Vitest integration](https://nx.dev/docs/technologies/test-tools/vitest/introduction).

Turborepo's cached task results depend on declared inputs. Undeclared environment or service dependencies undermine that result reuse; selection and caching share an input-modelling problem but solve different things. [Turborepo caching](https://turborepo.dev/docs/crafting-your-repository/caching), [affected execution](https://turborepo.dev/docs/reference/run).

The `vitest-affected` README describes runtime import tracking, incremental parsing, persistence, explanations, shadow mode, and full-suite fallbacks. It also documents fixture/environment/alias limitations and warns that stale caches only produce warnings. Its snapshot-only-change assumption needs scrutiny: external snapshots can change without the owning test changing. Treat its speed claims as author-reported, and validate compatibility and correctness on a challenge corpus before using it as a gate. [Project documentation](https://github.com/craigvandotcom/vitest-affected).

Launchable explicitly documents a Vitest integration and an observation mode. Evaluate it as a real buy-versus-build candidate, including subscription cost, supported versions, outage handling, data sharing, and measured failure recall. This research did not establish a current price quote or validate the integration in a live account. [Vitest integration](https://help.launchableinc.com/resources/integrations/vitest/), [observation mode](https://help.launchableinc.com/features/predictive-test-selection/observing-subset-behavior/).

Develocity explicitly presents predictive selection as a speed/coverage tradeoff and recommends subsequent execution of remaining tests. Its documented guide targets Gradle and Maven. [Develocity selection guide](https://docs.develocity.ai/2026.2/guides/predictive-test-selection/).

3. **The difficult part is dependency completeness, not graph traversal.**

A deterministic algorithm gives the same selection for the same inputs. That does not imply that its inputs model everything capable of changing test behaviour. For example, a test may read `fixtures/rates.csv` through `fs.readFile`, without any JavaScript import edge. Changing the CSV can break the test while an import-only selector skips it.

Two fundamentally different selection contracts should remain distinct:

- Conservative dependency selection: run every test that could be affected under an explicit input model; broaden the run when that model is known to be incomplete.
- Predictive selection: run the tests most likely to reveal failures, accepting a measurable chance of missing some relevant tests.

Even conservative selection cannot promise universal safety for arbitrary JavaScript with undeclared filesystem, network, environment, time, or process inputs. Formal RTS safety results rely on a specified language and execution model; they are not a guarantee transferable to unrestricted Vitest projects. [Formal safety work for an Ekstazi-style algorithm](https://experts.illinois.edu/en/publications/safety-of-a-smart-classes-used-regression-test-selection-algorith/).

Proposed selection model, at test-file granularity:

`selected = changed/new test files ∪ reverse dependency closure(changed inputs) ∪ mandatory tests ∪ conservative fallbacks`

Use the union of applicable base and head dependency graphs when interpreting changes. Keep old paths/edges for deletions and renames. Build head-side static edges before execution so newly introduced dependencies are considered. Runtime observations should add evidence, not erase a static dependency simply because one execution did not take that branch.

Combine three kinds of information:

- Static module relationships, resolved with Vite-compatible aliases and project configuration.
- Observed module relationships from previous completed runs.
- Declared non-module inputs: fixtures, schemas, generated inputs, snapshots, relevant environment fingerprints, and resource dependencies.

Do not assume a hand-written TypeScript import parser reproduces Vite plugins, virtual modules, conditional exports, or custom resolution. Reuse framework resolution where possible and treat unsupported resolution as a reason to broaden the run.

| Challenge case | Required conservative behaviour |
| --- | --- |
| Changed or newly added test | Include it regardless of cached history |
| Deleted or renamed source | Follow old graph relationships as well as current ones |
| Changed setup, config, transform plugin, runtime version | Invalidate the relevant project, or all projects when scope is uncertain |
| Lockfile change | Start with broad invalidation; narrow only with verified dependency resolution |
| Changed fixture/schema/non-imported asset | Follow explicit inputs; otherwise broaden to its owning project |
| Snapshot-only modification | Include the owning test even when test source is unchanged |
| New file discovered through a glob or directory scan | Model directory membership and glob patterns, not just previously observed files |
| File existence changes | Model negative lookups where practical, or conservatively invalidate the containing scope |
| Variable imports, workers, subprocesses, opaque plugins | Declare dependencies or broaden execution |
| New code branch or changed mock behaviour | Recompute current relationships; historical coverage alone is insufficient |
| Missing history, corrupt graph, wrong baseline, unknown schema | Run the full relevant suite |
| Changed CI environment or external service | Invalidate through declared fingerprints; otherwise keep dependent tests outside selective guarantees |

Fallback must broaden execution, never turn an analysis error into an empty successful run. A zero-test decision needs a valid discovery result and explicit evidence that all changes are irrelevant. Unknown files should not be silently treated as documentation.

Historical line coverage is useful as an additional signal, but should not be the MVP's exclusion authority. New branches, changed control flow, mocks, asynchronous hooks, and shared fixtures make per-test attribution difficult. File-level selection also preserves existing within-file hook and ordering behaviour.

4. **Resource management has value even when every test is affected.**

Treat concurrency as a budget across all test processes on the same machine. If a task runner launches four Vitest processes and each allocates four workers, the host sees considerably more work than a single four-worker run. Conversely, separate GitHub matrix jobs usually have separate runners, so their memory budgets are independent, though they may still contend for a shared database.

For the first version, recommend a fixed `maxWorkers` per runner profile from measurements. Use CPU quota, available memory, Vite/main-process overhead, service containers, and observed worker memory peaks. CPU count alone is insufficient. Under worker threads, process RSS is shared across threads and must not be multiplied as though each measurement were a separate process. Prefer aggregate job/container memory measurements.

A simple design heuristic is:

`worker budget ≈ min(measured CPU-friendly limit, floor((memory limit − coordinator/services − reserve) / estimated incremental worker peak))`

This is a starting heuristic, not an OOM guarantee. If even one worker does not fit, report inadequate capacity instead of pretending that concurrency tuning can fix it. Runtime memory spikes, shared pages, and garbage collection require margin and observation.

Then evaluate duration-aware shard balancing, plus caps for expensive DOM/browser/database work. Vitest already supports custom sorting/sharding and normally uses duration information for ordering; mere longest-first sorting is not new. [Vitest sequence configuration](https://vitest.dev/config/sequence).

A reporter or sequencer alone cannot promise arbitrary memory-aware admission control. True adaptive dispatch may need a custom pool or an upstream scheduler hook. Vitest describes the custom-pool interface as experimental and low-level. Keep this out of the initial compatibility promise. [Custom pools](https://vitest.dev/guide/advanced/pool).

Disabling isolation changes semantics. A passing shuffled run is useful evidence, not proof that all order dependencies are absent. Likewise, changing DOM implementations requires compatibility validation. Prefer eliminating unnecessary DOM use for pure Node tests before globally changing environments.

5. **Rust is a possible implementation detail, not the initial product thesis.**

JavaScript tests still require a JavaScript runtime. Moving orchestration to Rust does not automatically accelerate React rendering, DOM simulation, database waits, fixture loading, or test-body JavaScript. Matching Vitest's mocks, ESM handling, plugins, snapshots, coverage, and environments creates substantial compatibility work.

Apply Amdahl's law to the measured bottleneck. If orchestration accounts for 20% of elapsed time, making it infinitely fast yields at most `1 / 0.8 = 1.25×` overall speedup. That is an illustrative calculation, not a measured Vitest profile.

Use TypeScript first. Consider Rust/native bindings only for proven CPU-heavy analysis, hashing, parsing, or graph persistence where the overhead is material. Reusing existing native components is cheaper than maintaining a new test engine. Vite 8 already incorporates Rust-based Rolldown and Oxc; build-speed announcements must not be interpreted as equivalent unit-test speedups. [Vite 8 announcement](https://vite.dev/blog/announcing-vite8.html).

Bun is an alternative benchmark when runtime migration is acceptable, but its documentation describes compatibility goals and partial Vitest-style mocking support. It should be assessed against the actual suite rather than assumed to be a drop-in replacement. [Bun test runner](https://bun.sh/docs/test), [Bun mocks](https://bun.sh/docs/test/mocks).

6. **Optional AI should initially add coverage or change order, not remove required tests.**

A useful bring-your-own-model interface could suggest missing non-code input rules, explain coupling, identify expensive setup patterns, or rank selected tests for earlier failure feedback. Adding tests and changing priority preserve the conservative selected set, although they do not directly reduce the work in that set.

A later experimental prediction mode could exclude some dependency-relevant tests, but it must expose that different contract, retain mandatory tests, and report measured missed failures. Start with simple history-based baselines before an LLM: previous failures, dependency proximity, and estimated duration may be enough. Do not interpret model confidence as a calibrated probability of safety.

Facebook's published predictive-selection system reported approximately halving infrastructure cost while retaining over 95% of individual failures and over 99.9% of faulty changes in its setting. Those are different recall metrics, and the result is specific to its data and infrastructure. The paper used learned historical signals; it is not evidence that an LLM can safely shortlist an arbitrary Vitest suite. [Predictive Test Selection](https://arxiv.org/html/1810.05286v2).

Record model/provider version and selection output for reproducibility. Inference failure should revert to deterministic selection. Start with path/graph/timing metadata and make any source-code transmission explicit. The useful abstraction is a pluggable scorer, not an LLM dependency in the execution path.

7. **Proposed architecture and first deliverable.**

Build a CLI wrapper plus a small Vitest adapter/reporter. Keep it local-first, with CI artifacts or a trusted cache supplying history; no hosted service should be required for the basic workflow.

```text
Git baseline + tested revision + declared inputs
                      |
           Change and validity checks
                      |
    Native selection / dependency adapter
                      |
       Conservative rules and fallbacks
                      |
   Immutable plan: selected files + reasons
                      |
    Runner budget + optional shard balancing
                      |
                  Vitest
                      |
       Results, timings, graph observations
                      |
       Full-run comparison and next baseline
```

Vitest exposes test discovery and execution through `globTestSpecifications` and `runTestSpecifications`. Use exact specifications when practical rather than treating positional CLI filters as exact filenames. Put framework-specific integration behind a versioned adapter. [Vitest programmatic API](https://vitest.dev/api/advanced/vitest).

Every saved plan should record base/head revisions, project identity, runner environment, Node/Vitest/config/lockfile fingerprints, graph provenance, selected tests, fallback reasons, resource settings, and whether this was a full or selective run. Reject execution if the relevant workspace inputs changed after planning. Graphs must be keyed to configuration and environment, not merely to repository name.

Choose the Git baseline explicitly. A PR merge-base answers what the branch changed; a last successful validated revision answers what has changed since known-good validation. They are different questions. GitHub may test a synthetic merge commit, and merge queues can create another candidate. Select against the actual tested tree, fetch the necessary history, verify graph ancestry, and never treat a shallow-checkout diff failure as no changes. Recompute selection when the merge candidate or target branch changes.

Do not overwrite a complete graph with only the files observed during a selective run. Publish history atomically, retain full-baseline provenance, and isolate untrusted PR cache writes from trusted baseline data. Do not treat failed/aborted instrumentation as a complete observation.

Start with a deliberately small feature set:

- Explainable selection built on native capabilities, with explicit fixture/config rules and full-run fallback.
- Fixed resource budgets per runner profile; coordinate the outer task runner and inner Vitest workers.
- A shadow mode that selects first, executes everything, and compares observed failures with the saved plan.
- A GitHub Actions summary showing decisions, time, memory, fallback causes, and validation status.
- A clear full-suite override and one pinned, tested compatibility range.

Defer custom worker pools, individual-test-case selection, arbitrary filesystem interception, remote result caching, and AI exclusion. Extend an existing plugin if it can meet the contract cleanly. Propose generic dependency invalidation or scheduler improvements upstream where they belong.

8. **Benchmark the incremental benefit, not a favourable comparison with defaults.**

Use several suite shapes: CPU-heavy Node tests, DOM-heavy component tests, a modular monorepo, and a tightly coupled application. Thousands of cases in ten files and thousands of small files must be represented separately. Include both selective changes and common-module/configuration changes that correctly trigger broad runs.

Compare:

| Variant | Question |
| --- | --- |
| Current pinned CI baseline | What is the observed problem? |
| Tuned current Vitest | How much is configuration alone? |
| Supported upgrade plus tuning | How much is already fixed upstream? |
| Native changed selection plus explicit triggers | Is an extra selector necessary? |
| Existing Nx/Turbo setup, where applicable | Can current task infrastructure solve it? |
| `vitest-affected` in shadow mode | Does an existing plugin meet the contract? |
| Proposed wrapper | What additional benefit survives all those baselines? |
| Launchable pilot, if feasible | Is buying prediction preferable to maintaining it? |

Run worker sweeps on the target runner shape, including one worker and the native default. Separate cold-cache and restored-cache runs. Pin dependencies/runtime and alternate benchmark order to reduce drift. Use enough independent runs to characterize spread; do not report a meaningful p95 from three observations. Record setup and cache-transfer time as well as test time.

Use a chronological PR replay: build only the history available before each change, compute the selection, then execute the full suite on the same revision and environment. Never populate a selector with the very full run it is being judged against. Historical broken PR revisions are more informative for recall than successful merge commits alone.

Add adversarial mutations that exercise the challenge cases above. Confirm that a full run actually detects each injected defect before counting it as a selection opportunity. Mutants supplement real regressions; they do not establish production recall by themselves. Diagnose flaky outcomes separately and retain timeout/OOM failures in the reliability results.

Track at least:

- Wall-clock time and time to first meaningful failure.
- Total runner minutes, runner-price-weighted cost, retries, audit runs, and setup overhead.
- Aggregate peak memory, CPU utilization/throttling, OOM and timeout incidence.
- Selected file fraction and duration-weighted selected fraction.
- Analysis/collection overhead and full-suite fallback rate.
- Failure recall: failing tests included by selection divided by all relevant failing tests found by full runs.
- Faulty-change recall: failing changes where selection catches at least one relevant failure divided by all failing changes.

Passing-only history cannot demonstrate failure recall. Even zero misses among 100 independent failing changes leaves an approximate 95% upper bound near 3% for the miss rate, using the rule of three. Roughly 3,000 independent opportunities with zero misses would be needed to push that bound near 0.1%; real changes are correlated, so this is illustrative rather than a certification method.

9. **Faster feedback and lower cost must be optimized separately.**

Illustrative example: one runner taking 20 minutes uses 20 runner-minutes. Four equal-price runners taking 7 minutes each finish sooner but use 28 runner-minutes, a 40% increase. Actual billing also depends on runner prices, included minutes, rounding, and product fees.

Evaluate the entire policy:

`total cost = selective runs + retries + full audit/gate runs + setup/cache overhead + service fees`

A full nightly run discovers misses later; it does not restore the same pre-merge assurance as a full pre-merge run. Start in shadow mode with existing gates intact. During an initial rollout, use selective PR feedback plus a full gate on the actual merge candidate. Moving that full gate after merge is a separate reliability tradeoff, not a free optimization.

Coverage reports from a selected subset are not automatically whole-suite coverage reports. Do not merge stale coverage from unrelated revisions or use partial reports to silently satisfy an unchanged global coverage policy. Keep coverage validation explicit and version-aware.

10. **A practical research-to-MVP sequence.**

For a small experienced team, a rough planning hypothesis is a 4–6 week investigation and narrow prototype, not a production-readiness promise:

- First, reproduce the contention problem and establish tuned native baselines on representative suites.
- Next, run native selection and existing plugin comparisons in shadow mode, with a deliberately difficult input-dependency corpus.
- Implement only demonstrated gaps: explicit input invalidation, plan explanations, provenance, runner budgets, and CI reporting.
- Replay history and pilot in real CI, then decide whether to contribute upstream, improve an existing plugin, use a commercial service, or maintain a separate tool.

Suggested go/no-go criteria are product targets rather than empirical results: materially lower total cost or feedback latency beyond the best practical baseline (for example, a 20% incremental target); no unexplained misses in the deterministic challenge corpus; no regression in contention-related reliability; and small analysis overhead relative to savings. Report uncertainty rather than converting a finite test corpus into a zero-miss promise.

Do not proceed with a standalone product if ordinary tuning solves the problem, native changed selection is sufficient, full-suite fallbacks dominate representative changes, or compatibility upkeep exceeds the incremental benefit. A reusable benchmark corpus and upstream fixes would still be valuable outcomes.

The unresolved inputs are the actual Vitest/Node versions, number of test files versus cases, runner label and repository visibility, environment mix, coverage settings, outer task-runner concurrency, timeout signatures, and availability of failed PR history. Those determine whether the highest-value work is scheduling, test cleanup, selection, or a combination.
