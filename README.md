# VoxOps

VoxOps is an early hackathon project for a voice-first developer operations agent for Alexa+. Its current local, read-only API provides repository status, open issues, open pull requests, and recent workflow runs over REST and MCP Streamable HTTP. Public repositories work anonymously; a configured GitHub App enables access to private repositories available to its installation.

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
curl http://127.0.0.1:3000/api/repositories/modelcontextprotocol/typescript-sdk/issues
curl http://127.0.0.1:3000/api/repositories/modelcontextprotocol/typescript-sdk/pull-requests
curl http://127.0.0.1:3000/api/repositories/modelcontextprotocol/typescript-sdk/workflow-runs
```

The three list routes accept an optional `?limit=1` through `?limit=25` (default 10). Open issues exclude pull requests. Lists show recent items from GitHub's first page; pagination and workflow logs are not available yet.

## MCP endpoint

Connect a Streamable HTTP MCP client to `http://127.0.0.1:3000/mcp`. The `voxops` server exposes four read-only tools:

- `get_repository_status` — metadata, default branch, latest commit, and repository state.
- `list_open_issues` — unresolved issues, excluding pull requests.
- `list_pull_requests` — open pull requests and their branches.
- `list_workflow_runs` — recent GitHub Actions activity and conclusions.

Each tool takes `owner` and `repo`. The list tools also accept `limit` from 1 through 25 (default 10). They return both concise text and structured data. For example, repository status text looks like:

```text
Repository example/repo
Default branch: main
Latest commit: abc1234 — Update README
Last pushed: 2026-09-17T00:00:00Z
Private: no
Archived: no
```

To verify a running local server with a real MCP client, run `pnpm mcp:smoke` in another terminal. The command checks initialization, tool listing, and live calls to all four tools. It uses `ibodev1/voxops` when both GitHub App environment variables are set, or a public repository otherwise. Set `PORT` in both terminals if using a port other than 3000.

Current local capabilities are read-only public/private repository status, open issue and pull request listings, recent workflow run listings, and GitHub App authentication. The developer reports Milestones 5A–5C live and verified in `eu-central-1`, including Tier 1 service authentication and remote MCP **discovery only**. Service tokens can initialize and list the four tools; every `tools/call` receives HTTP 403 before GitHub access. Milestone 5D stopped at its [Tier 2 compatibility gate](docs/alexa-tier2-compatibility.md): current documentation does not establish compatible Cognito discovery and separate Tier 1/Tier 2 issuer selection. User authorization, Alexa+ Add-on integration, AI analysis, and write actions remain deferred.

Local unauthenticated MCP smoke tests continue to work when `VOXOPS_ALEXA_AUTH_SECRET_ID` is absent. The Lambda entrypoint always requires service authentication for MCP, including when configuration is missing. Use `pnpm mcp:service-smoke` with the temporary credential environment described in the AWS runbook; it verifies token issuance, discovery, and HTTP 403 on execution without printing credentials or tokens.

With neither GitHub App setting configured, public repository access and `/health` work without credentials. With an App configured, VoxOps resolves the installation for each repository. If no installation is visible, it tries anonymous access so public repositories still work. Inaccessible private repositories and missing repositories both return 404. Invalid references return 400, GitHub rate limits or authentication failures return 503, and other upstream failures return 502. Authentication failures are server configuration problems, not HTTP client login challenges.

## GitHub App development setup

1. Create a GitHub App in GitHub's developer settings. Leave webhooks disabled.
2. Grant only repository **Metadata: Read-only**, **Contents: Read-only**, **Issues: Read-only**, **Pull requests: Read-only**, and **Actions: Read-only** permissions. No organization or write permissions are needed.
3. Install the App on selected repositories, including the private repository you want to read.
4. Generate an App private key and store the downloaded `.pem` file **outside this repository**.
5. Set `VOXOPS_GITHUB_APP_ID` and `VOXOPS_GITHUB_PRIVATE_KEY_PATH` in the server process environment. The path must be absolute. `.env.example` documents the names; `.env` is optional and is not loaded automatically.

In PowerShell, from the repository root:

```powershell
$env:VOXOPS_GITHUB_APP_ID = Read-Host 'GitHub App ID'
$env:VOXOPS_GITHUB_PRIVATE_KEY_PATH = Read-Host 'Absolute path to the external PEM file'
pnpm dev:server
```

In another terminal:

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/api/repositories/ibodev1/voxops/status
```

No PAT, client secret, or manually supplied installation token is used. Octokit creates short-lived installation tokens and manages their cache in memory; tokens are never persisted. Write permissions are not enabled. Credentials load on the first GitHub capability request. Partial configuration, unreadable paths, keys inside the repository (including symlinks), and invalid RSA PEM files cause a sanitized capability error; `/health` remains available. In local mode, leave `VOXOPS_GITHUB_SECRET_ID` empty.

The HTTP API trusts the local caller and binds only to `127.0.0.1`. GitHub App authentication authorizes the server's GitHub access; it does not authenticate HTTP callers. Anyone able to call this local server can read repositories granted to the App. Do not expose it through a tunnel or network listener without adding caller authorization.

## Quality checks

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm infra:synth
```

Run `pnpm format` to apply formatting. Lefthook checks formatting and linting before commits; CI also runs type checking and tests.

## Repository layout

`apps/server` holds the shared HTTP app and local/Lambda entrypoints; `packages/contracts` holds validated request and response shapes; `packages/github` contains the Octokit integration; `infra` holds the single CDK development stack. Decisions and real development friction belong in `docs/`.

## AWS development

See [AWS development instructions](docs/aws-development.md) for exact PowerShell identity checks, safe service-secret creation, deployment, remote smoke tests, and log discovery. The developer now uses the non-root `voxops-admin` profile. Prefer IAM Identity Center or an assumed role with temporary credentials; the identity check stops on `:root`. Existing bootstrap and GitHub secret setup need not be repeated.

`pnpm infra:synth` is offline; `infra:diff`, `infra:bootstrap`, and `infra:deploy` are explicit manual AWS commands. One HTTP API routes `GET /health`, two public OAuth metadata documents, `POST /oauth/token`, and authenticated `POST /mcp` to the existing Lambda. Repository REST routes, `GET /mcp`, and catch-all routes remain absent. Seven-day access logs and 10 requests/second, burst 20 throttling limit development traffic without creating a hard spending cap. The runtime role reads exactly the two named secrets. Codex has not deployed 5C or created credentials. [Alexa authentication research](docs/alexa-auth-research.md) records the Tier 1 design and Cognito M2M resource-binding constraint; full Alexa compatibility requires later end-to-end testing.
