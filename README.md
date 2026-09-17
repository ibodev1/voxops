# VoxOps

VoxOps is an early hackathon project for a voice-first developer operations agent for Alexa+. Its current Milestone 1 capability is a local, read-only HTTP API that returns metadata and the latest default-branch commit for a public GitHub repository.

## Requirements

- Node.js 24 LTS
- pnpm 11.23.0

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev:server
```

The server listens on `http://127.0.0.1:3000` by default. Set `PORT` to use a different port. In another terminal:

```sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/repositories/modelcontextprotocol/typescript-sdk/status
```

Only **public** GitHub repositories are supported. The API uses unauthenticated GitHub requests; GitHub App authentication is planned but not implemented. Invalid references return 400, missing repositories 404, GitHub rate limits 503, and other GitHub failures 502.

Quality checks:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Run `pnpm format` to apply formatting. Lefthook checks formatting and linting before commits; CI also runs type checking and tests.

## Repository layout

`apps/server` holds the HTTP app; `packages/contracts` holds validated request and response shapes; `packages/github` contains the Octokit integration. Future workspaces and infrastructure will be added when needed. Decisions and real development friction belong in `docs/`.
