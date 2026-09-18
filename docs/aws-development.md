# AWS development and manual deployment

VoxOps uses `VoxOpsDevStack` in `eu-central-1`: one API Gateway HTTP API, one ARM64 Node.js 24 Lambda (256 MB, 10 seconds), one execution role with log-write permission, and two seven-day log groups. The default stage routes only `GET /health` and `POST /mcp`. There is no application Secrets Manager dependency. CDK bootstrap storage is separate.

## Identity and review

Use an administrative IAM Identity Center identity with temporary credentials. Root AWS identity must **never** be the routine deployment identity; do not create long-lived root access keys. Before any diff or deployment:

```powershell
$env:AWS_REGION = 'eu-central-1'
aws sts get-caller-identity
```

Stop if the returned ARN ends in `:root`. Review the current account and identity before proceeding. `pnpm infra:diff` uses CDK `diff --no-change-set` and is read-only; `pnpm infra:deploy` changes AWS and must be run manually after review:

```powershell
pnpm install --frozen-lockfile
pnpm infra:synth
pnpm infra:diff
pnpm infra:deploy
```

CDK configures `VOXOPS_PUBLIC_REPOSITORIES=ibodev1/voxops` on Lambda. Change that explicit value in [the stack](../infra/lib/voxops-stack.ts) and review before deploying if the demo repository changes. No credentials are needed for anonymous public GitHub reads.

**Public repository prerequisite:** On 2026-09-18, an anonymous `GET https://api.github.com/repos/ibodev1/voxops` returned HTTP 404 while a known public repository returned HTTP 200. Verify the chosen demo repository is actually public before deployment. The application deliberately denies inaccessible/private repositories; do not restore a GitHub credential fallback. The developer must make the intended repository public or explicitly change the allowlist to another public repository and update smoke inputs.

## Remote smoke checks

Read the endpoint from stack outputs:

```powershell
$voxopsApiEndpoint = aws cloudformation describe-stacks --stack-name VoxOpsDevStack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or !$voxopsApiEndpoint) { throw 'ApiEndpoint unavailable' }
curl.exe -i "$voxopsApiEndpoint/health"
$env:VOXOPS_MCP_URL = "$voxopsApiEndpoint/mcp"
$env:VOXOPS_PUBLIC_REPOSITORIES = 'ibodev1/voxops'
pnpm mcp:smoke
```

Health must return HTTP 200 and exactly `{ "status": "ok" }`. MCP smoke must initialize, list four read-only tools, invoke each with a public repository, and reject a nonallowlisted repository. Check negative API Gateway routing:

```powershell
curl.exe -i "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/status"
curl.exe -i "$voxopsApiEndpoint/oauth/token"
curl.exe -i "$voxopsApiEndpoint/.well-known/oauth-protected-resource"
curl.exe -i "$voxopsApiEndpoint/mcp"
```

Each negative request must return HTTP 404. `GET /mcp` is deliberately absent; only POST is remotely routed. A nonallowlisted repository must return an MCP tool error saying it is not on the public allowlist. Do not place tokens or private repository names in demo commands.

Access logs record request ID, method, route key, status, and response/integration latency; they omit headers, bodies, paths, and MCP payloads. The 10 requests/second, burst-20 stage throttle is best effort, not a hard spending cap. Anonymous GitHub rate limits and public API traffic are intentional hackathon cost and availability tradeoffs. Find actual log groups through `RuntimeLogGroupName` and `ApiAccessLogGroupName` stack outputs rather than assuming a conventional Lambda log-group name.

## Old secrets: manual cleanup only after successful new deployment and MCP tests

The two legacy secrets were created outside CDK. They remain in AWS until the developer explicitly removes them. **Run these commands only after the new public Lambda is deployed and all remote MCP tests pass. Codex has not run them.** First verify identity again, including the non-root ARN check, then use the standard recovery window:

```powershell
aws sts get-caller-identity
aws secretsmanager delete-secret --secret-id voxops/dev/github-app --recovery-window-in-days 7 --region eu-central-1
aws secretsmanager delete-secret --secret-id voxops/dev/alexa-service-auth --recovery-window-in-days 7 --region eu-central-1
```

The old architecture and investigation remain in [the historical ADRs](decisions/) and [Tier 2 compatibility report](alexa-tier2-compatibility.md).
