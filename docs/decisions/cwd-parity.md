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
- Vitest names a file project after its `package.json` name. The tool does not rely on that: it maps
  each project to the discovered package that holds its root.

## Known gaps

- A package config that reads `process.cwd()` while it loads (for example in `include`) sees the repo
  root, not the package folder. The spike did not cover this.
- With the root `config: false`, settings that Vitest takes only from the root config (for example
  `coverage`, `reporters`, `teardownTimeout`, `onConsoleLog`) come from the tool, not from a package config.
