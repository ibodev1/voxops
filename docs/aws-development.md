# AWS development and manual deployment

VoxOps uses `VoxOpsDevStack` in `eu-central-1`: one API Gateway HTTP API, one ARM64 Node.js 24 Lambda (256 MB, 60 seconds), one execution role with log-write and narrowly scoped Bedrock inference permission, and two seven-day log groups. The default stage routes only `GET /health`, `POST /mcp`, and `POST /api/demo/chat`. There is no application Secrets Manager dependency. CDK bootstrap storage is separate.

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

CDK configures `VOXOPS_PUBLIC_REPOSITORIES=ibodev1/voxops` and derives `VOXOPS_MCP_REMOTE_URL` from its HTTP API endpoint on Lambda. Change the allowlist in [the stack](../infra/lib/voxops-stack.ts) and review before deploying if the demo repository changes. No credentials are needed for anonymous public GitHub reads. Demo chat sends inference requests from Lambda to Bedrock, then calls the same public MCP URL through API Gateway. The 60-second timeout accommodates this bounded sequence; memory remains 256 MB. It does not create a second Lambda.

The developer made `ibodev1/voxops` public and verified all four live MCP tools. The application still denies inaccessible, private, or nonallowlisted repositories.

## Bedrock and browser prerequisites

The demo uses the on-demand **EU cross-region inference profile** `eu.amazon.nova-micro-v1:0`, because Amazon Nova Micro is not a direct `eu-central-1` model ID. [AWS lists the supported EU destinations](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-micro.html); [Nova supports Converse tool use](https://docs.aws.amazon.com/nova/latest/userguide/using-converse-api.html). Before deploying, verify the selected temporary-credential identity, account access to the profile, and any organization policy allowing EU cross-region inference:

```powershell
$env:AWS_REGION = 'eu-central-1'
aws sts get-caller-identity
aws bedrock get-inference-profile --inference-profile-identifier eu.amazon.nova-micro-v1:0 --region $env:AWS_REGION
```

Stop if the identity ARN ends in `:root`. Confirm the profile is `ACTIVE`, includes the expected Nova Micro model, and is callable under your account's Bedrock and organization policies. The profile ARN and its four EU foundation-model ARNs are the only runtime Bedrock resources granted `bedrock:InvokeModel`. If access is denied, resolve it with the account administrator before deployment; do not broaden the Lambda policy to `bedrock:*`. Local live model access could not be verified during implementation because the available AWS profiles did not return a usable identity. The synth and automated tests require no AWS account.

For the Vite development server, API Gateway CORS allows only `http://127.0.0.1:5173` and `http://localhost:5173`, with `GET`, `POST`, and `content-type`. For a reviewed HTTPS static host, set `VOXOPS_WEB_ORIGIN` to its exact origin **only for manual CDK synth/diff/deploy**. It must be an HTTPS origin without path or trailing slash. Set public `VITE_VOXOPS_API_URL` to `ApiEndpoint` at web build time. Never place AWS credentials in Vite env vars. CORS is a browser boundary; it does not authenticate the public demo API.

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

After deploying the backend and confirming Bedrock access, a server-side demo chat check is:

```powershell
$chatBody = '{"messages":[{"role":"user","content":"What is the latest VoxOps commit?"}]}'
curl.exe -i -X POST "$voxopsApiEndpoint/api/demo/chat" -H "content-type: application/json" --data-raw $chatBody
```

Expect HTTP 200 with a concise `message` and an `activity` entry for `get_repository_status`. The agent must use the real `/mcp` route. If the result is `demo_unavailable`, inspect the runtime log output and Bedrock profile access; the HTTP response intentionally omits internal errors. An empty, malformed, or oversized request is rejected before Bedrock is called. The API is public, so throttling is a best-effort cost limit rather than hard authorization.

Access logs record request ID, method, route key, status, and response/integration latency; they omit headers, bodies, paths, and MCP payloads. The 10 requests/second, burst-20 stage throttle is best effort, not a hard spending cap. Anonymous GitHub rate limits and public API traffic are intentional hackathon cost and availability tradeoffs. Find actual log groups through `RuntimeLogGroupName` and `ApiAccessLogGroupName` stack outputs rather than assuming a conventional Lambda log-group name.

## Old secrets: manual cleanup only after successful new deployment and MCP tests

The two legacy secrets were created outside CDK. They remain in AWS until the developer explicitly removes them. **Run these commands only after the new public Lambda is deployed and all remote MCP tests pass. Codex has not run them.** First verify identity again, including the non-root ARN check, then use the standard recovery window:

```powershell
aws sts get-caller-identity
aws secretsmanager delete-secret --secret-id voxops/dev/github-app --recovery-window-in-days 7 --region eu-central-1
aws secretsmanager delete-secret --secret-id voxops/dev/alexa-service-auth --recovery-window-in-days 7 --region eu-central-1
```

The old architecture and investigation remain in [the historical ADRs](decisions/) and [Tier 2 compatibility report](alexa-tier2-compatibility.md).
