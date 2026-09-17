# 0001: Monorepo and tooling

**Status:** Accepted

Use a pnpm workspace and strict TypeScript. Keep formatting, linting, type checking, and testing as separate commands with Oxfmt, Oxlint, TypeScript, and Vitest. Use Lefthook for fast local formatting and lint checks; CI runs all four checks.

The project is small enough that pnpm workspace scripts are sufficient. Turborepo and additional orchestration would add configuration before there is work to orchestrate. Type-aware Oxlint remains deferred while strict `tsc --noEmit` covers all current application, package, and test TypeScript. The root typecheck includes new workspaces as they are added.
