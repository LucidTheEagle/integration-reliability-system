# IRS — Claude Code Project Instructions

## 1. Project purpose

Integration Reliability System (IRS) is a portfolio-grade reliability layer for business integrations. It demonstrates durable event and webhook handling, idempotency, retry and recovery policies, reconciliation, incident visibility, and operational control in the fictional Northstar Commerce environment. The goal is production-minded engineering evidence, not a generic demo or unnecessary infrastructure.

## 2. Governing documentation and authority

The following project documents live in `docs/specifications/`:

- `Integration_Reliability_System_Master_Specification_v1.0.docx` — approved formatted reference for Master Specification v1.0.
- `Integration_Reliability_System_Master_Specification_v1.0.md` — machine-readable Markdown companion converted from that DOCX to support search and coding-agent context.

Read the Markdown companion for efficient repository work. If a relevant requirement is ambiguous, consult the DOCX. If the files disagree, stop and report the discrepancy; never choose or reconcile silently. Do not independently edit either specification. Approved specification changes must be reconciled across both files by the founder.

Use these sources in order:

1. The founder's latest explicit decision and approved task-specific design/implementation handoff.
2. The approved IRS Master Specification and its decision register, following the document-authority note above.
3. Existing accepted implementation patterns and tests.
4. Your own inference, which must be labelled as inference and must not be treated as an accepted decision.

A task handoff may narrow or clarify implementation details but must not silently redesign the product architecture. When sources conflict, a requirement is ambiguous, or implementation needs an unapproved product, security, or data-model decision, STOP. Cite the relevant paths/sections, distinguish facts from assumptions, and present options.

## 3. Required working protocol

For every task:

1. **Establish context:** inspect the current directory, Git branch/status, task handoff, relevant Master Specification sections, source files, package manifests, and tests. Do not assume a file or script exists; verify it.
2. **Investigate first:** identify current behaviour, dependencies, conventions, gaps, and risks. Separate confirmed facts, inferences, and open questions.
3. **Present a bounded plan:** list exact files to add/change, proposed behaviour, decisions, tests, and acceptance criteria. Identify anything requiring a founder decision.
4. **Wait for approval:** do not edit implementation files until the founder approves the plan. Read-only investigation and a clearly labelled proposed plan are allowed beforehand.
5. **Implement only approved scope:** keep the diff focused. Do not opportunistically refactor, add features, alter public contracts, change database schema, upgrade dependencies, or introduce infrastructure outside the approved task.
6. **Validate:** run only relevant, verified commands. Inspect the diff for accidental files, unrelated changes, unsafe logging, secret leakage, and unhandled edge cases.
7. **Report precisely:** list changed files, behaviour delivered, decisions/assumptions, exact commands run and outcomes, tests not run, remaining risks, and known failures. Never imply a check passed if it was not executed.

If new evidence materially changes the approved plan, stop and explain the change before proceeding.

## 4. Repository and architecture guardrails

- This is a TypeScript pnpm-workspace monorepo. Read the current workspace configuration and package manifests before making assumptions about packages or commands.
- Keep domain logic independent of infrastructure and vendor SDKs. Integration code may depend on `@irs/domain`; `@irs/domain` must not depend on integration or infrastructure packages.
- Preserve capability-level integration contracts. Do not introduce a universal adapter to reduce the number of interfaces.
- Expected operational adapter failures use established result/error contracts. Do not leak vendor SDK errors, raw provider response bodies, secrets, or unfiltered sensitive payloads into shared contracts or logs.
- Preserve established state-machine, retry-policy, and shared-enum semantics. Do not add/change states, enum values, transitions, retry behaviour, or public contract shapes without explicit task authority.
- Treat Prisma/database schema changes and migrations as high-impact. Make them only when the approved task requires them; explain compatibility and migration consequences first.
- Security-sensitive work must consider trust boundaries, input validation, signature verification where applicable, replay/duplicate handling, safe error responses, payload limits, and data-minimising logs. Do not claim a control exists until implemented and tested.
- Do not add a dependency, provider, service, queue, database, or framework unless the task requires it and the choice is approved.

## 5. Change and repository safety

- Begin by checking `git status --short` and the active branch. Do not overwrite, reset, clean, or reformat the founder's existing work.
- Work only in the explicitly assigned task branch/worktree. If isolation has not been set up or the current worktree contains unrelated changes, stop and report that before editing.
- Do not commit, amend, push, deploy, publish packages, run destructive database operations, or change remote configuration. The founder owns code integration and commits unless they explicitly authorise a specific action.
- Do not modify editor settings, local environment files, secrets, generated output, lockfiles, or dependency versions unless required by the approved task. Explain necessary lockfile changes.
- Never place credentials, API keys, webhook secrets, tokens, private customer data, or production payloads in source code, tests, logs, task reports, or documentation.
- Never use a bypass-permissions option to avoid the normal review and approval process.

## 6. Verification commands and known caveat

The root workspace has previously used `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check` successfully. Verify current scripts before relying on them. Run focused package tests as well as suitable workspace checks for cross-package changes.

Do not report `pnpm lint` as a successful lint check: no package defined a `lint` script at the last verified baseline. Recheck current package scripts before reporting.

**Known fresh-clone typecheck caveat:** `@irs/domain` exports point to `dist`, while its `typecheck` script uses `--noEmit`. A typecheck before the domain package has been built can fail because `dist` is absent. The root `pnpm build` previously passed through workspace dependency ordering, and the test workflow emitted the domain build output. Treat this as known tooling debt; re-check current behaviour and do not silently change scripts as part of an unrelated task.

**Prisma client generation (Task 011).** The generated client (`packages/db/src/generated/prisma`) is gitignored and must exist before `@irs/db` is type-checked or built. `pnpm --filter @irs/db build` generates it first, with `prisma generate --config ../../prisma.generate.config.ts`. That config has no datasource and loads no `.env`, so generation needs no database URL. Always pass an explicit `--config` to Prisma: a bare `prisma` command auto-discovers `prisma7.config.ts`, which loads `.env` and requires `DATABASE_URL`. `prisma7.config.ts` is for `migrate` commands only. As with the domain `dist` caveat, `typecheck` alone can fail on a fresh clone until the client has been generated.

**Development database (DR-10b).** The development PostgreSQL listens on `127.0.0.1:5432` only; its password is held in `secrets/postgres_password` (git-ignored), never in tracked files. No AI session reads, prints, moves or edits that file or `.env`.

**Database tests (Task 011).** `pnpm test` is database-free: test scripts exclude `*.db.test.js`. Database tests run only through `pnpm --filter @irs/db test:db` and `pnpm --filter @irs/api test:db`. Both use the same test database, so **run them one after the other, never at the same time**; neither script runs the other. `apps/api`'s database tests load `@irs/db`'s test support from `packages/db/dist/test-support/` (its `test:db` builds `@irs/db` first). Each script needs `IRS_TEST_DATABASE_URL` and `IRS_TEST_ADMIN_DATABASE_URL`, fails loudly if either is missing, and refuses any target its guard (`packages/db/src/test-support/guard.ts`) does not accept: only `127.0.0.1:55433` and the registered `irs_011_*_test` databases carrying the sentinel. Never point these variables at `irs_dev` or any shared database. Prisma CLI processes started by the test support (`packages/db/src/test-support/prisma-cli.ts`) run with `CHECKPOINT_DISABLE=1`, so test runs make no Prisma update or telemetry check.

**Authoring a later migration (Task 011A).** Never use `migrate dev`, `db push` or `migrate reset`. From `packages/db`, after `pnpm run build`, with both `IRS_TEST_*` variables set, run `node dist/test-support/setup.js author-next prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` (UTC timestamp).
- It refuses `_init`, a timestamp that is not later than every existing migration, and an existing target directory.
- It runs `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script` through the guarded Prisma runner, with the drift config (`packages/db/src/test-support/prisma.drift.config.ts`) and the registered shadow database. Both sentinels are re-verified after the child exits.
- It writes the file only when the diff is non-empty.

SQL that Prisma cannot express (partial unique indexes, CHECKs, comments) is then appended to that file by hand. Keep LF line endings (`.gitattributes` pins them), append the name to `REQUIRED_MIGRATIONS` (`packages/db/src/schema-readiness.ts`), and apply it once with `node dist/test-support/setup.js provision`. That runs `migrate deploy`, then the registry grants, then the exact grant-set check.

MIG-T3's drift check cannot see hand-written SQL objects. The M2 tests in `migration.db.test.ts` and the readiness checks pin those objects instead.

**Database tests (Task 011A).**
- `@irs/api` `test:db` now also runs `audit-composed.db.test.js` and the synthetic load run `perf-011a.db.test.js` (about 6–7 minutes on its own), so a full run takes noticeably longer.
- Commit stalls ("RD-8") use `stallCommits` / `revertCommitStall` (`packages/db/src/test-support/syncrep-stall.ts`): a role-level `synchronous_commit = on` plus a non-existent `synchronous_standby_names`, so a COMMIT waits on SyncRep until its backend is terminated. Every revert is verified.
- The scratch database purpose `rle` (registry) is used for the readiness tests against an altered `RateLimitEvidence` table.

**On a host with limited memory**, run database tests one file at a time, using the package's own `test:db` steps with an explicit `dist/<file>.db.test.js`. Before and after each file, check that no node process remains and that enough memory is available.

Use the Node and pnpm versions declared by the repository. Do not install, upgrade, or globally reconfigure tools without approval.

## 7. Task completion report

Finish each implementation task with:

- **Result:** completed, partially completed, or blocked.
- **Files changed:** each file and its purpose.
- **Design notes:** approved decisions implemented; inferences and unresolved questions clearly separated.
- **Verification:** exact commands run and actual outcomes; identify checks not run.
- **Scope check:** whether anything outside approved scope changed.
- **Risks / follow-up:** remaining issues and dependency-gated next tasks, if known.

Be precise, conservative, and explicit. The founder is the system architect and final authority; your role is to investigate, plan, implement within approval, and report truthfully.
