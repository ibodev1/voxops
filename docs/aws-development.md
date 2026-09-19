# AWS development and manual deployment

VoxOps uses `VoxOpsDevStack` in `eu-central-1`. The deployed HTTP API and Runtime Lambda serve `GET /health` and `POST /mcp`; the final source revision adds `GET /mcp` to return the 2025-11-25 specification's required 405 when no standalone SSE stream is offered. **Manually deploy this route before judging.** One regional REST API and a separate Node.js 24 ARM64 Lambda stream `POST /api/demo/chat` through CloudFront. Each Lambda is 256 MB with a 60-second timeout; three log groups retain seven days. The web assets remain in a private S3 bucket behind the same CloudFront distribution. There is no application Secrets Manager dependency. CDK bootstrap storage is separate.

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

CDK configures `VOXOPS_PUBLIC_REPOSITORIES=ibodev1/voxops` on the existing MCP Lambda and derives `VOXOPS_MCP_REMOTE_URL` from the HTTP API endpoint on the streaming chat Lambda. Change the allowlist in [the stack](../infra/lib/voxops-stack.ts) and review before deploying if the demo repository changes. Anonymous public GitHub reads need no credentials. AI SDK streams Bedrock inference and calls the existing public MCP URL through its official client. The separate chat Lambda isolates Lambda response-streaming semantics from the stable MCP runtime.

The developer made `ibodev1/voxops` public and verified all four live MCP tools. The application still denies inaccessible, private, or nonallowlisted repositories.

## Bedrock and browser prerequisites

The demo uses the on-demand **EU cross-region inference profile** `eu.amazon.nova-micro-v1:0`, because Amazon Nova Micro is not a direct `eu-central-1` model ID. [AWS lists the supported EU destinations](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-micro.html); [Nova supports Converse tool use](https://docs.aws.amazon.com/nova/latest/userguide/using-converse-api.html). Before deploying, verify the selected temporary-credential identity, account access to the profile, and any organization policy allowing EU cross-region inference:

```powershell
$env:AWS_REGION = 'eu-central-1'
aws sts get-caller-identity
aws bedrock get-inference-profile --inference-profile-identifier eu.amazon.nova-micro-v1:0 --region $env:AWS_REGION
```

Stop if the identity ARN ends in `:root`. Confirm the profile is `ACTIVE`, includes the expected Nova Micro model, and is callable under your account's Bedrock and organization policies. Only the chat Lambda role receives `bedrock:InvokeModelWithResponseStream` on the profile ARN and its four EU foundation-model ARNs; destination access is conditioned on the profile ARN. If access is denied, resolve it with the account administrator before deployment; do not broaden the policy to `bedrock:*`. The deployed Nova Micro chat was verified live on 2026-09-18. Synth and automated tests require no AWS account.

The browser calls same-origin `/api/demo/chat` through a single uncached CloudFront behavior. The REST API has no wildcard CORS. The existing HTTP API retains its two local development CORS origins for health/MCP. No browser build-time API URL or AWS credentials are needed. The REST chat stage has only `POST /api/demo/chat` and throttles at 2 requests/second with burst 2. The existing HTTP API stage retains 10 requests/second with burst 20. Chat Lambda has no reserved or provisioned concurrency. API Gateway throttling is best-effort cost/load protection, not authentication or a hard billing cap.

## Static web deployment (manual, after review)

The CDK stack provisions a private S3 bucket and a CloudFront distribution with signed Origin Access Control. It does not upload `apps/web/dist`, create an S3 website endpoint, or add a deployment Lambda. The default behavior serves `/` from `index.html`, accepts only `GET` and `HEAD`, and redirects HTTP to HTTPS. The exact `/api/demo/chat` behavior forwards requests to the regional REST stage without caching and without forwarding the viewer's Host header. There is no client-side router or SPA error rewrite. The manual upload below gives hashed Vite assets a one-year immutable browser cache and overwrites `index.html` with `no-cache, no-store, must-revalidate`; the managed default cache policy may still cache it at the edge for its one-second minimum TTL. Invalidate after upload.

The CloudFront-generated domain uses its default certificate. [AWS documents](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cloudfront-distribution-viewercertificate.html) that this forces the `TLSv1` security policy, even if a newer minimum is specified. HTTPS is enabled and HTTP redirects, but a TLS 1.2 minimum cannot be enforced on this domain without a custom domain and certificate. This is a known limitation of the requested minimal setup.

From the repository root, use a reviewed administrative IAM Identity Center session with temporary credentials. **Do not use root or long-lived root access keys.** The following commands provision infrastructure; Codex has not run them:

```powershell
$env:AWS_REGION = 'eu-central-1'
aws sts get-caller-identity
if ($LASTEXITCODE -ne 0) { throw 'AWS identity unavailable' }
$awsArn = aws sts get-caller-identity --query Arn --output text
if ($LASTEXITCODE -ne 0 -or $awsArn -match ':root$') { throw 'Use a non-root deployment identity' }
pnpm install --frozen-lockfile
pnpm infra:synth
pnpm infra:diff
pnpm infra:deploy
```

CloudFront deployment can take several minutes. Retrieve stack outputs, build the browser bundle, then upload assets. Run these after the stack reaches `CREATE_COMPLETE` or `UPDATE_COMPLETE`:

```powershell
$stack = 'VoxOpsDevStack'
$voxopsApiEndpoint = aws cloudformation describe-stacks --stack-name $stack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue | [0]" --output text
$chatApiEndpoint = aws cloudformation describe-stacks --stack-name $stack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='ChatApiEndpoint'].OutputValue | [0]" --output text
$bucket = aws cloudformation describe-stacks --stack-name $stack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='WebBucketName'].OutputValue | [0]" --output text
$distribution = aws cloudformation describe-stacks --stack-name $stack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='WebDistributionId'].OutputValue | [0]" --output text
$webUrl = aws cloudformation describe-stacks --stack-name $stack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or !$voxopsApiEndpoint -or !$chatApiEndpoint -or !$bucket -or !$distribution -or !$webUrl -or (@($voxopsApiEndpoint, $chatApiEndpoint, $bucket, $distribution, $webUrl) -contains 'None')) { throw 'Required stack output unavailable' }
pnpm --filter @voxops/web build
if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
aws s3 sync apps/web/dist "s3://$bucket" --delete --cache-control 'public, max-age=31536000, immutable' --region $env:AWS_REGION
if ($LASTEXITCODE -ne 0) { throw 'Web asset sync failed' }
aws s3 cp apps/web/dist/index.html "s3://$bucket/index.html" --cache-control 'no-cache, no-store, must-revalidate' --content-type 'text/html; charset=utf-8' --region $env:AWS_REGION
if ($LASTEXITCODE -ne 0) { throw 'index.html upload failed' }
aws cloudfront create-invalidation --distribution-id $distribution --paths '/*'
if ($LASTEXITCODE -ne 0) { throw 'CloudFront invalidation failed' }
$webUrl
curl.exe -i $webUrl
```

`--delete` removes obsolete hashed files immediately; a visitor holding the previous page open during a release can briefly request a removed asset. For a hackathon demo, schedule the upload between sessions. CloudFront and S3 usage depend on traffic and storage; monitor them rather than assuming a fixed price.

## Hackathon AWS cleanup

After judging and the winner announcement, follow the separate [cleanup runbook](cleanup.md). It archives stack outputs, empties the private web bucket, destroys the stack, and verifies service-level leftovers. Do not perform cleanup during an ordinary update.

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
curl.exe -i -H 'Accept: text/event-stream' "$voxopsApiEndpoint/mcp"
curl.exe -i -X POST "$voxopsApiEndpoint/api/demo/chat" -H 'content-type: application/json' --data-raw '{"messages":[{"role":"user","content":"status"}]}'
```

The repository, OAuth, and old buffered chat paths must return HTTP 404. `GET /mcp` must return HTTP 405; `POST /mcp` performs MCP requests. A nonallowlisted repository must return an MCP tool error saying it is not on the public allowlist. Do not place tokens or private repository names in demo commands.

After deploying the backend and confirming Bedrock access, test the REST streaming endpoint with `curl.exe --no-buffer`. The output is AI SDK UI-message SSE, so expect several `data:` lines, including tool input/output events and successive text deltas. Watch them arrive at different times; a single final batch is not proof of streaming.

```powershell
$chatBody = '{"messages":[{"role":"user","content":"What is the latest VoxOps commit?"}]}'
curl.exe --no-buffer -N -i -X POST $chatApiEndpoint -H 'content-type: application/json' --data-raw $chatBody
curl.exe --no-buffer -N -sS -X POST $chatApiEndpoint -H 'content-type: application/json' --data-raw $chatBody | ForEach-Object { "$(Get-Date -Format o) $_" }
curl.exe --no-buffer -N -i -X POST "$webUrl/api/demo/chat" -H 'content-type: application/json' --data-raw $chatBody
pnpm infra:diff
```

Expect HTTP 200, multiple timestamped SSE lines as Bedrock chunks arrive, `get_repository_status` tool activity, and a concise answer with no `<thinking>` content or reasoning parts. The agent must use the real `/mcp` route. Open `$webUrl` in a browser after uploading the new bundle; verify incremental answer text, updating MCP tool activity, collapsed details, retry, history, suggestions, and repository context. If chat returns `demo_unavailable`, inspect `ChatRuntimeLogGroupName` and Bedrock profile access; the HTTP response intentionally omits internal errors. An empty, malformed, or oversized request is rejected before Bedrock is called. The API is public, so throttling is a best-effort cost limit rather than hard authorization. After deployment, `pnpm infra:diff` should show zero changes.

HTTP API access logs record request ID, method, route key, status, and latency; they omit headers, bodies, and MCP payloads. The REST API relies on its Lambda's seven-day runtime log and API Gateway metrics. [AWS requires an account-level logging role](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-logging.html) for REST CloudWatch access logs; this isolated stack does not change account-level logging settings. The REST chat stage's 2 requests/second, burst-2 throttle is best effort, not a hard billing cap. Anonymous GitHub rate limits and public API traffic are intentional hackathon cost and availability tradeoffs. Find actual log groups through `RuntimeLogGroupName`, `ChatRuntimeLogGroupName`, and `ApiAccessLogGroupName` stack outputs rather than assuming a conventional Lambda log-group name.

The old private/authentication architecture remains in [historical ADRs](decisions/) and the [Tier 2 compatibility report](alexa-tier2-compatibility.md). Historical secrets created outside CDK must be reviewed separately during cleanup; the current application has no Secrets Manager dependency.
