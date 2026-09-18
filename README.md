# VoxOps

VoxOps is a voice-first Alexa+ developer assistant that reads **public GitHub repository state** through MCP Streamable HTTP. It offers a real self-hosted MCP server and an optional web-based **simulated Alexa+ experience** for conversational demos. The simulation is not the official Alexa Web Simulator. The [Alexa+ hackathon rules](https://amazonappdev2026.devpost.com/rules) allow a simulated Alexa+ experience; Alexa developer-tool onboarding for the live Add-on flow remains pending. The MCP server has four read-only tools:

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

### Run the simulated experience

The web app streams a server-side AI SDK answer from Bedrock Nova Micro. AI SDK tools use the official MCP client to call the same VoxOps `/mcp` endpoint; they do not call GitHub directly. For local development, use AWS temporary credentials with Bedrock access and run the server and web app in separate terminals:

```powershell
$env:AWS_PROFILE = '<your-temporary-credential-profile>'
$env:AWS_REGION = 'eu-central-1'
$env:VOXOPS_PUBLIC_REPOSITORIES = 'ibodev1/voxops'
pnpm dev:server
```

```powershell
pnpm --filter @voxops/web dev
```

Open `http://127.0.0.1:5173`. Vite proxies local `/api` requests to the server on port 3000; its local-only streaming chat adapter uses the loopback `/mcp` endpoint by default. To use a deployed MCP server instead, set `VOXOPS_MCP_REMOTE_URL` to the full public `/mcp` URL before starting the server. In production, the browser sends same-origin `/api/demo/chat` through CloudFront. No AWS credentials belong in Vite variables. The Bedrock profile and manual deployment prerequisites are in [AWS development](docs/aws-development.md).

## AWS boundary

CDK keeps the HTTP API and its Lambda for only `GET /health` and `POST /mcp`. A separate regional REST API streams `POST /api/demo/chat` from a 256 MB ARM64 Lambda. CloudFront forwards that one path without caching; its default behavior still serves private S3 assets. Both APIs have best-effort throttling. No REST repository routes, catch-all, Cognito, Secrets Manager access, database, VPC, or always-on compute are configured. [AWS development and manual deployment](docs/aws-development.md) has the commands and smoke checks.

Account linking and service authentication are intentionally disabled for this public, user-independent demo. [The Alexa CLI access blocker](docs/alexa-cli-access-blocker.md) and [Alexa M6 checklist](docs/alexa-m6-checklist.md) record the remaining live Add-on work. Private repository GitHub App access, account linking, and safe write actions are possible future work, outside this demo.

## Verify changes

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm infra:synth
pnpm --filter @voxops/web build
```
