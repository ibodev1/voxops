# VoxOps

VoxOps is an early hackathon project for a voice-first developer operations agent for Alexa+. The intended product will let a developer inspect GitHub repositories, issues, pull requests, workflows, and deployment state, with explicit confirmation before write actions. No product features are implemented yet.

## Requirements

- Node.js 24 LTS
- pnpm 11.23.0

## Development

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Run `pnpm format` to apply formatting. Lefthook checks formatting and linting before commits; CI also runs type checking and tests.

## Repository layout

The root currently holds shared tooling and project guidance. Planned workspaces are `apps/web`, `apps/server`, `packages/contracts`, `packages/domain`, and `packages/github`. `infra` will hold deployment code when that milestone begins. Decisions and real development friction belong in `docs/`.
