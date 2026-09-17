# 0001: Monorepo and tooling

**Status:** Accepted

Use a pnpm workspace and strict TypeScript. Keep formatting, linting, type checking, and testing as separate commands with Oxfmt, Oxlint, TypeScript, and Vitest. Use Lefthook for fast local formatting and lint checks; CI runs all four checks.

The project is small enough that pnpm workspace scripts are sufficient. Turborepo and additional orchestration would add configuration before there is work to orchestrate. Type-aware Oxlint is deferred until there is application TypeScript to lint and its value can be evaluated. The root typecheck currently covers only Vitest configuration; it must be extended when the first code workspace is added.
