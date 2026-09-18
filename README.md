# VoxOps

VoxOps is a voice-first Alexa+ developer assistant that reads **public GitHub repository state** through MCP Streamable HTTP. The hackathon demo has four read-only tools:

- `get_repository_status`: branch, latest commit, and repository state
- `list_open_issues`: open issues, excluding pull requests
- `list_pull_requests`: open pull requests
- `list_workflow_runs`: recent GitHub Actions runs

The server accepts only explicitly allowlisted `owner/repo` names and checks that GitHub reports each repository as public before every tool read. GitHub API calls are anonymous. There are no GitHub credentials, account linking, personalized data, or write operations. Anonymous GitHub API rate limits are an intentional demo tradeoff.

## Run locally

Use Node.js 24 and pnpm 11.23.0. Set the allowlist (comma-separated names are supported) and start the loopback server:

```powershell
pnpm install --frozen-lockfile
$env:VOXOPS_PUBLIC_REPOSITORIES = 'ibodev1/voxops'
pnpm dev:server
```

In another terminal:

```powershell
curl.exe http://127.0.0.1:3000/health
pnpm mcp:smoke
```

The smoke script initializes MCP, lists exactly four tools, invokes each against the configured public repository, and verifies that a nonallowlisted name is rejected. Set `VOXOPS_MCP_URL` to a full `/mcp` URL to test a deployed endpoint.

## AWS boundary

CDK defines one HTTP API with only `GET /health` and `POST /mcp`, one 256 MB ARM64 Lambda, and seven-day runtime/access logs. API Gateway throttling is 10 requests per second with burst 20. No REST repository routes, catch-all, Cognito, Secrets Manager access, database, VPC, or always-on compute are configured. [AWS development and manual deployment](docs/aws-development.md) has the commands and smoke checks.

Account linking and service authentication are intentionally disabled for this public, user-independent demo. [The Alexa M6 checklist](docs/alexa-m6-checklist.md) records the remaining live Add-on validation. Private repository GitHub App access, account linking, and safe write actions are possible future work, outside this demo.

## Verify changes

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm infra:synth
```
