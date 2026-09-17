# VoxOps

VoxOps is an early hackathon project for a voice-first developer operations agent for Alexa+. Its current Milestone 2 capability is a local, read-only HTTP API that returns repository metadata and the latest default-branch commit. Public repositories work anonymously; a configured GitHub App enables access to private repositories available to its installation.

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

With neither GitHub App setting configured, public repository access and `/health` work without credentials. With an App configured, VoxOps resolves the installation for each repository. If no installation is visible, it tries anonymous access so public repositories still work. Inaccessible private repositories and missing repositories both return 404. Invalid references return 400, GitHub rate limits or authentication failures return 503, and other upstream failures return 502. Authentication failures are server configuration problems, not HTTP client login challenges.

## GitHub App development setup

1. Create a GitHub App in GitHub's developer settings. Leave webhooks disabled.
2. Grant only repository **Metadata: Read-only** and **Contents: Read-only** permissions. No other repository or organization permissions are needed.
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

No PAT, client secret, or manually supplied installation token is used. Octokit creates short-lived installation tokens and manages their cache in memory; tokens are never persisted. Write permissions are not enabled. Partial configuration, unreadable paths, keys inside the repository (including symlinks), and invalid RSA PEM files cause a sanitized startup error.

The HTTP API trusts the local caller and binds only to `127.0.0.1`. GitHub App authentication authorizes the server's GitHub access; it does not authenticate HTTP callers. Anyone able to call this local server can read repositories granted to the App. Do not expose it through a tunnel or network listener without adding caller authorization.

## Quality checks

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Run `pnpm format` to apply formatting. Lefthook checks formatting and linting before commits; CI also runs type checking and tests.

## Repository layout

`apps/server` holds the HTTP app; `packages/contracts` holds validated request and response shapes; `packages/github` contains the Octokit integration. Future workspaces and infrastructure will be added when needed. Decisions and real development friction belong in `docs/`.
