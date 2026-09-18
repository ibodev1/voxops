# AWS development: Milestones 5A–5C

The developer reports Milestones 5A/5B live in `eu-central-1`: Lambda health, GitHub App secret loading, private repository reads, explicit logs, and the health-only HTTP API work. Milestone 5C adds Tier 1 service authentication and remote MCP discovery, verified locally. Codex has not created the service secret, deployed, invoked AWS, or configured an Alexa Add-on. Run the manual steps below after review. User-specific tool execution and Tier 2 remain deferred.

## Runtime and local checks

`apps/server/src/lambda.ts` uses Hono's official `handle` adapter and the same `createApp` as the loopback server. One HTTP API reuses one payload-v2 integration and the existing Lambda. Its exact routes are `GET /health`, `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`, `POST /oauth/token`, and `POST /mcp`. No repository REST, GET MCP, catch-all, or Function URL is exposed. The `$default` stage is a stage name, not a route. No CORS or API Gateway authorizer is configured; Lambda enforces service authentication.

Health responds only with `{"status":"ok"}` without credentials. Metadata also loads no credentials. Lambda MCP always requires a signed Bearer token, regardless of Host or missing configuration. It permits initialize, initialized notifications, ping, tools/list, and the current SDK's server/discover. Every tools/call returns HTTP 403 before SDK dispatch or GitHub access. No 401/403 includes WWW-Authenticate, following Alexa's requirement. Local development retains localhost Host/Origin guards and unauthenticated MCP when service configuration is absent. Repository direct-invocation fixtures retain their synthetic loopback Host; AWS IAM protects direct invocation, so restrict that permission separately.

Hono reconstructs the Lambda URL from API Gateway `requestContext.domainName`. The remote auth layer verifies that origin against the adapter's trusted v2 request context and ignores forwarded-host/proto headers. Issuer is that HTTPS origin; resource/audience is exactly `<origin>/mcp`. A supplied Host must match; an absent Origin is accepted, while a different Origin is rejected. No generated API hostname is embedded in source. Named stages or custom-domain path mappings would need a separate canonical-URI review; this stack uses the default stage and endpoint.

The function uses Node.js 24, ARM64, 256 MB, and a 10-second timeout. ARM64 is suitable because the bundled application uses JavaScript and Node built-ins without native application dependencies. CDK `NodejsFunction` runs the root esbuild locally on Windows and Linux; Docker is not needed with dependencies installed. It emits one CommonJS `index.js`, including the pinned AWS SDK, with no source maps, repository copy, PEM, or environment files.

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm infra:synth
```

`infra:synth` executes the TypeScript CDK app and `app.synth()` directly, avoiding the CDK CLI's default-account discovery. It writes `infra/cdk.out` without AWS credentials or network lookups. Without `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION`, the template uses CloudFormation account/region tokens. CDK supplies these variables during normal CLI diff/deploy. No account, profile, or credential is embedded in source. Tests also synthesize offline and execute the bundled health handler with networking disabled. CI runs these same checks and never deploys.

## Credentials and permissions

- Local: set `VOXOPS_GITHUB_APP_ID` and `VOXOPS_GITHUB_PRIVATE_KEY_PATH` to an external RSA PEM as described in the README. Leave `VOXOPS_GITHUB_SECRET_ID` empty. With all three settings absent, anonymous public repository access is preserved.
- AWS: CDK sets `VOXOPS_GITHUB_SECRET_ID=voxops/dev/github-app` and `VOXOPS_ALEXA_AUTH_SECRET_ID=voxops/dev/alexa-service-auth`, never values. Leave local GitHub settings absent. The AWS SDK obtains credentials through the execution role.
- GitHub credentials load only on a GitHub capability call. Health and metadata load no credentials; authenticated MCP discovery loads only the service-auth secret. Partial local or mixed GitHub configuration fails safely on capability use.
- A successful credential load and the GitHub client are cached for the lifetime of the process, sharing Octokit's token cache. Failed loads are retried on the next request. Updating the secret does not refresh already warm processes: recycle execution environments after rotation (for example, a reviewed function code/configuration update). Automatic refresh is deferred.
- SecretString must contain exactly these JSON properties; `appId` is a positive integer encoded as a string, and `privateKey` is a complete, unencrypted RSA PEM. The example is a placeholder, not usable key material:

```json
{
  "appId": "<github-app-id>",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n<PEM base64 contents>\n-----END RSA PRIVATE KEY-----\n"
}
```

The stack imports both secrets by name without creating them or retrieving their values. Use the same account and region as the function and the default `aws/secretsmanager` encryption key. A customer-managed KMS key would require a separate reviewed `kms:Decrypt` grant and is not supported by this milestone's IAM policy.

The execution role trusts only Lambda. Its sole identity policy permits `logs:CreateLogStream` and `logs:PutLogEvents` for its log group, and `secretsmanager:GetSecretValue` for exactly `arn:<partition>:secretsmanager:<region>:<account>:secret:voxops/dev/github-app-??????` and `arn:<partition>:secretsmanager:<region>:<account>:secret:voxops/dev/alexa-service-auth-??????`. The six `?` characters match the six-character Secrets Manager suffix for each fixed name. No `*` secret resource, managed policies, or unrelated permissions are attached.

The second SecretString has exactly `clientId`, `clientSecret`, and `tokenSigningSecret`. The ID is a stable non-secret identifier (1–128 letters/digits/dots/underscores/hyphens). Each secret is canonical standard Base64 representing at least 32 independent random bytes; the two secrets must differ. The loader validates shape/representation with Zod, caches successful reads in memory, retries failures, and sanitizes errors. Size validation cannot prove entropy; use the generator below. HS256 service JWTs expire after 3600 seconds and carry only issuer, service subject, exact resource audience, issued-at, expiry, scope `mcp:service`, and client ID. No refresh/ID token is issued. Verification pins algorithm, issuer, exact audience, lifetime, client identity and scope.

Credential/signing-key rotation requires recycling warm Lambda environments after the secret update, using a reviewed function code/configuration update. Warm caches otherwise retain old credentials; there is no immediate revocation or automatic key rotation. Tokens are valid for at most one hour under an accepted signing key. Do not treat a secret update alone as immediate revocation.

## Manual AWS steps (PowerShell, repository root)

These commands contact AWS and may create billable resources. Run them yourself after reviewing the synthesized template. **Do not use the AWS root identity for routine deployments and do not create long-lived root access keys.** Use an administrative IAM Identity Center permission set or an appropriate assumed deployment role with temporary credentials. Account/Identity Center configuration is an operator task outside CDK. See [AWS root-user guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html). Stop if any command fails.

For the existing environment, run step 1, create the **new service secret in step 3b**, then review/deploy and smoke-test. Bootstrap and the GitHub secret are already present; skip steps 2 and 3 unless setting up another environment or rotating those credentials. The developer reports the `voxops-admin` profile currently uses a non-root IAM user; these instructions do not create identities or access keys. Temporary credentials remain the preferred routine deployment workflow.

### 1. Identity and region

```powershell
$env:AWS_PROFILE = 'voxops-admin'
$env:AWS_REGION = 'eu-central-1'
$voxopsIdentityJson = aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) { throw 'AWS identity check failed' }
$voxopsIdentity = $voxopsIdentityJson | ConvertFrom-Json
$voxopsIdentity | Format-List Account, Arn
if ($voxopsIdentity.Arn -match ':root$') {
  throw 'STOP: root identity must not deploy. Sign in with IAM Identity Center or a temporary-credential deployment role.'
}
$env:AWS_REGION = 'eu-central-1'
$env:AWS_DEFAULT_REGION = $env:AWS_REGION
$env:CDK_DEFAULT_REGION = $env:AWS_REGION
$env:CDK_DEFAULT_ACCOUNT = $voxopsIdentity.Account
```

### 2. Bootstrap only if required for this account/region

```powershell
pnpm infra:bootstrap
if ($LASTEXITCODE -ne 0) { throw 'CDK bootstrap failed' }
```

Bootstrap creates the separate CDK toolkit stack (including asset storage and deployment roles). Those resources and deployment privileges are separate from the application resources and narrow runtime role. Review your account's bootstrap policy before running this command. If CDK warns it cannot assume lookup/deploy roles and falls back to same-account credentials, verify the active identity and ask the account administrator to review bootstrap role trust and permissions. The previously observed warning's root cause has not been verified; do not use root to bypass it.

### 3. Manually create or update the secret outside CDK

Use a private Windows user temp directory outside the repository. This block asks for the existing external PEM path; the PEM contents never appear in command history. It writes UTF-8 without a BOM, uploads via `file://`, and removes the temporary JSON in `finally`. Do not use a shared or synchronized temp directory. The original PEM remains untouched.

```powershell
$voxopsRepo = (Get-Location).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
$voxopsPemPath = (Resolve-Path -LiteralPath (Read-Host 'Absolute path to your external GitHub App PEM')).Path
$voxopsTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$voxopsRepoPrefix = $voxopsRepo + [IO.Path]::DirectorySeparatorChar
foreach ($candidate in @($voxopsPemPath, $voxopsTempRoot)) {
  if ($candidate.Equals($voxopsRepo, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($voxopsRepoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'PEM and temporary JSON must be outside the repository'
  }
}
$voxopsAppId = Read-Host 'GitHub App ID'
if ($voxopsAppId -notmatch '^[1-9]\d*$') { throw 'App ID must be a positive integer' }
$voxopsSecretAction = Read-Host 'Type create for a new secret, or update for an existing secret'
if ($voxopsSecretAction -notin @('create', 'update')) { throw 'Choose create or update' }
$voxopsSecretFile = Join-Path $voxopsTempRoot ('voxops-secret-' + [guid]::NewGuid().ToString() + '.json')
try {
  $voxopsSecretJson = @{
    appId = $voxopsAppId
    privateKey = [IO.File]::ReadAllText($voxopsPemPath)
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($voxopsSecretFile, $voxopsSecretJson, [Text.UTF8Encoding]::new($false))
  if ($voxopsSecretAction -eq 'create') {
    aws secretsmanager create-secret --name voxops/dev/github-app --secret-string "file://$voxopsSecretFile" --region $env:AWS_REGION --query ARN --output text
  } else {
    aws secretsmanager put-secret-value --secret-id voxops/dev/github-app --secret-string "file://$voxopsSecretFile" --region $env:AWS_REGION --query ARN --output text
  }
  if ($LASTEXITCODE -ne 0) { throw 'Secret upload failed' }
} finally {
  if (Test-Path -LiteralPath $voxopsSecretFile) { Remove-Item -LiteralPath $voxopsSecretFile -Force }
  $voxopsSecretJson = $null
}
```

### 3b. Create the service-auth secret (new for 5C)

Run after the identity check. This generates two independent 32-byte values with .NET's cryptographic RNG. Use a private, local temporary directory outside the checkout; do not run in a shared terminal or enable AWS CLI debug logging. The only AWS output is the secret ARN. Choosing `update` replaces both credentials and requires the warm-environment rotation procedure above.

```powershell
$voxopsAction = Read-Host 'Type create for the new service secret, or update to rotate it'
if ($voxopsAction -notin @('create', 'update')) { throw 'Choose create or update' }
$voxopsRepo = (Resolve-Path -LiteralPath '.').Path.TrimEnd('\')
$voxopsTemp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')
if ($voxopsTemp.Equals($voxopsRepo, [StringComparison]::OrdinalIgnoreCase) -or
    $voxopsTemp.StartsWith($voxopsRepo + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Temporary directory must be outside the repository'
}
$voxopsAuthFile = Join-Path $voxopsTemp ('voxops-service-' + [guid]::NewGuid().ToString() + '.json')
$voxopsRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$voxopsClientBytes = New-Object byte[] 32
$voxopsSigningBytes = New-Object byte[] 32
try {
  $voxopsRng.GetBytes($voxopsClientBytes)
  $voxopsRng.GetBytes($voxopsSigningBytes)
  $voxopsAuthJson = @{
    clientId = 'voxops-alexa-dev'
    clientSecret = [Convert]::ToBase64String($voxopsClientBytes)
    tokenSigningSecret = [Convert]::ToBase64String($voxopsSigningBytes)
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($voxopsAuthFile, $voxopsAuthJson, [Text.UTF8Encoding]::new($false))
  if ($voxopsAction -eq 'create') {
    aws secretsmanager create-secret --name voxops/dev/alexa-service-auth --secret-string "file://$voxopsAuthFile" --region $env:AWS_REGION --query ARN --output text
  } else {
    aws secretsmanager put-secret-value --secret-id voxops/dev/alexa-service-auth --secret-string "file://$voxopsAuthFile" --region $env:AWS_REGION --query ARN --output text
  }
  if ($LASTEXITCODE -ne 0) { throw 'Service secret upload failed' }
} finally {
  if (Test-Path -LiteralPath $voxopsAuthFile) { Remove-Item -LiteralPath $voxopsAuthFile -Force }
  $voxopsRng.Dispose()
  [Array]::Clear($voxopsClientBytes, 0, $voxopsClientBytes.Length)
  [Array]::Clear($voxopsSigningBytes, 0, $voxopsSigningBytes.Length)
  $voxopsAuthJson = $null
}
```

To display **only the non-secret client ID**, capture the AWS result rather than writing SecretString to the terminal. Secrets Manager returns the whole JSON document; field selection happens in memory:

```powershell
try {
  $voxopsAuthJson = aws secretsmanager get-secret-value --secret-id voxops/dev/alexa-service-auth --region $env:AWS_REGION --query SecretString --output text
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read service credentials' }
  $voxopsAuth = $voxopsAuthJson | ConvertFrom-Json
  $voxopsAuth.clientId
} finally {
  $voxopsAuth = $null
  $voxopsAuthJson = $null
}
```

Do not configure the Alexa Add-on in 5C. In the later integration milestone, enter the client secret through Alexa CLI's **secure masked prompt**, never a plaintext CLI flag. Managed strings cannot be reliably zeroed; close the dedicated PowerShell session after credential handling.

### 4. Review and deploy

```powershell
pnpm infra:diff
if ($LASTEXITCODE -ne 0) { throw 'CDK diff failed' }
pnpm infra:deploy
if ($LASTEXITCODE -ne 0) { throw 'CDK deployment failed' }
```

`infra:diff` runs `cdk diff --no-change-set` for a template comparison without creating a changeset. `infra:deploy` delegates to `pnpm --filter @voxops/infra run deploy`; explicit `run` avoids pnpm's built-in deploy command. Review the IAM changes in the CLI prompt. Expect only the second named GetSecretValue resource in the execution policy, the service-secret environment identifier, code update, four new explicit routes and their path-scoped invocation permissions, and the new secret-name output. The existing API, integration, Lambda sizing, stage, and logs should remain. CDK does not create or modify secret values. API Gateway log-delivery control-plane permissions belong to the deploying identity, not the runtime role. See [HTTP API logging permissions](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging.html).

Outputs are `FunctionName`, `FunctionArn`, `GitHubAppSecretName`, `AlexaServiceAuthSecretName`, `ApiEndpoint`, `RuntimeLogGroupName`, and `ApiAccessLogGroupName`. None contains secret values.

### 5. Invoke the fixtures

Use an authenticated principal permitted to invoke this specific Lambda and read stack outputs. Response files may contain private repository metadata; the block stores and removes them in your private temporary directory.

```powershell
$voxopsFunction = aws cloudformation describe-stacks --stack-name VoxOpsDevStack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0) { throw 'Cannot read deployed function name' }
$voxopsResponseFile = Join-Path ([IO.Path]::GetTempPath()) ('voxops-response-' + [guid]::NewGuid().ToString() + '.json')
try {
  aws lambda invoke --function-name $voxopsFunction --region $env:AWS_REGION --invocation-type RequestResponse --cli-binary-format raw-in-base64-out --payload file://scripts/aws/events/health.json $voxopsResponseFile
  if ($LASTEXITCODE -ne 0) { throw 'Health invocation failed' }
  Get-Content -LiteralPath $voxopsResponseFile

  aws lambda invoke --function-name $voxopsFunction --region $env:AWS_REGION --invocation-type RequestResponse --cli-binary-format raw-in-base64-out --payload file://scripts/aws/events/repository-status.json $voxopsResponseFile
  if ($LASTEXITCODE -ne 0) { throw 'Repository invocation failed' }
  Get-Content -LiteralPath $voxopsResponseFile
} finally {
  if (Test-Path -LiteralPath $voxopsResponseFile) { Remove-Item -LiteralPath $voxopsResponseFile -Force }
}
```

Inspect both the AWS invocation result (no `FunctionError`) and the returned payload's `statusCode`. Health should be `200` with body `{"status":"ok"}`, even with a missing secret. Repository status should be `200` with repository metadata when the App installation has access. Invalid/missing credentials produce a sanitized `503`; inaccessible repositories produce `404`. An AWS invocation `StatusCode: 200` alone does not mean the application succeeded.

### 6. Remote positive and negative smoke checks

After deploying 5C, retrieve the endpoint and check health and metadata without credentials:

```powershell
$voxopsApiEndpoint = aws cloudformation describe-stacks --stack-name VoxOpsDevStack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($voxopsApiEndpoint) -or $voxopsApiEndpoint -eq 'None') { throw 'Cannot read API endpoint' }
$voxopsApiEndpoint = $voxopsApiEndpoint.TrimEnd('/')
curl.exe --silent --show-error --include "$voxopsApiEndpoint/health"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/.well-known/oauth-authorization-server"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/.well-known/oauth-protected-resource"
```

Expect HTTP **200**, exactly `{"status":"ok"}` for health, and the Tier 1 metadata described above. Metadata issuer/resource must match the retrieved endpoint exactly, with no secret fields or advertised authorization-code/PKCE/refresh support.

Unauthenticated remote POST MCP must return HTTP **401**, safe JSON `{"error":"invalid_token"}`, and **no WWW-Authenticate**:

```powershell
curl.exe --silent --show-error --include --request POST "$voxopsApiEndpoint/mcp"
```

These routes must still return API Gateway **404**:

```powershell
curl.exe --silent --show-error --include "$voxopsApiEndpoint/mcp"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/status"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/issues"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/pull-requests"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/workflow-runs"
curl.exe --silent --show-error --include --request POST "$voxopsApiEndpoint/health"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/unmatched"
```

The unrouted checks must produce route-not-found behavior (normally `{"message":"Not Found"}`), not Hono or repository responses. The template tests enforce the five exact method/path combinations; do not add `$default`, `ANY`, or greedy paths.

#### Live token, initialize/tools-list, and negative tools/call checks

Use a dedicated PowerShell session after step 1 and endpoint discovery above. The block captures the real service credential in memory, passes it through the child process environment, and cleans up afterward. It never prints the credential or token; no signing secret is passed to Node. Do not use shell tracing, AWS `--debug`, or environment dumps. The script enforces HTTPS and rejects redirects.

```powershell
try {
  $voxopsAuthJson = aws secretsmanager get-secret-value --secret-id voxops/dev/alexa-service-auth --region $env:AWS_REGION --query SecretString --output text
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read service credentials' }
  $voxopsAuth = $voxopsAuthJson | ConvertFrom-Json
  $env:VOXOPS_REMOTE_ORIGIN = $voxopsApiEndpoint
  $env:VOXOPS_ALEXA_CLIENT_ID = $voxopsAuth.clientId
  $env:VOXOPS_ALEXA_CLIENT_SECRET = $voxopsAuth.clientSecret
  $voxopsAuth = $null
  $voxopsAuthJson = $null

  # Exact client_credentials POST with Basic authentication, resource and scope.
  pnpm mcp:service-smoke token
  if ($LASTEXITCODE -ne 0) { throw 'Token endpoint check failed' }
  # Fresh token; official SDK initialize/discovery and listing of the four tools.
  pnpm mcp:service-smoke discovery
  if ($LASTEXITCODE -ne 0) { throw 'MCP discovery check failed' }
  # Fresh token; initialize/list, then require actual HTTP 403 on tools/call.
  pnpm mcp:service-smoke deny
  if ($LASTEXITCODE -ne 0) { throw 'Service/user boundary check failed' }
} finally {
  Remove-Item Env:VOXOPS_ALEXA_CLIENT_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:VOXOPS_ALEXA_CLIENT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:VOXOPS_REMOTE_ORIGIN -ErrorAction SilentlyContinue
  $voxopsAuth = $null
  $voxopsAuthJson = $null
}
```

`pnpm mcp:service-smoke` runs all checks in one session if preferred. `token` checks HTTP 200, the four response fields, 3600-second expiration, and no-store/no-cache. Client-secret Basic components are form-encoded before Base64 (RFC 6749), including `+`/`/`/`=` characters in standard Base64 secrets. `discovery` uses the official MCP client; its current protocol negotiates with `server/discover`, while server tests also exercise legacy `initialize`/`notifications/initialized`. `deny` calls `get_repository_status` with an obvious `example/private` fixture and asserts **HTTP 403**, `user_authorization_required`, and no WWW-Authenticate. A transport exception alone does not count as success. Any successful tool call is a failed security check; investigate before continuing.

For manual credential entry instead of the captured Secrets Manager result, set the client ID normally and use `Read-Host -AsSecureString` for the client secret. Do not paste it into a command or store it in `.env`. The documented capture workflow avoids displaying or manually copying it altogether.

### 7. Discover actual log groups

The runtime uses an explicit CDK log group. Do not assume `/aws/lambda/<function-name>`:

```powershell
$voxopsRuntimeLogGroup = aws cloudformation describe-stacks --stack-name VoxOpsDevStack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='RuntimeLogGroupName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0) { throw 'Cannot read runtime log group output' }
aws logs tail $voxopsRuntimeLogGroup --since 10m --region $env:AWS_REGION

$voxopsAccessLogGroup = aws cloudformation describe-stacks --stack-name VoxOpsDevStack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='ApiAccessLogGroupName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0) { throw 'Cannot read access log group output' }
aws logs tail $voxopsAccessLogGroup --since 10m --region $env:AWS_REGION
```

The fallback before the new outputs are deployed is `aws logs describe-log-groups --region eu-central-1`. Allow a short delivery delay after smoke checks. Inspect access logs for the health response and confirm no forbidden request reaches the runtime.

## Cost and lifecycle

The application stack contains eighteen resources: the existing Lambda, runtime log group, IAM role and inline policy, plus one HTTP API, five routes, one integration, one stage, five invocation permissions, and one access log group. Both log groups retain events for seven days and are deleted with the development stack. The service secret is created manually and imported; it adds a small Secrets Manager recurring cost. No compute is added. There is no Cognito, DynamoDB, custom KMS key, VPC, NAT, provisioned/reserved concurrency, tracing, or always-on server.

Stage throttling is 10 requests/second with a burst of 20; [API Gateway throttling is best effort](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html), not a hard spending cap. Public traffic can incur gateway, Lambda, and logging charges. Secrets Manager and bootstrap storage also have costs. Detailed stage metrics are disabled. Access logs include only request ID, method, route key, status, and response/integration latency; no headers, bodies, query strings, raw paths, tokens, or MCP payloads. An unmatched request may have no integration latency. Review logs after deployment to confirm delivery.

The imported secrets and separate bootstrap stack remain until separately removed. Restrict direct invocation permissions because authorized direct invokers can still read repositories through the existing repository fixtures. Live 5C behavior and Alexa interoperability remain unverified until the developer performs the appropriate manual checks; no Add-on configuration is part of this milestone.

## References

- [AWS Node.js Lambda runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
- [Hono AWS Lambda adapter](https://hono.dev/docs/getting-started/aws-lambda)
- [CDK NodejsFunction bundling](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)
- [Secrets Manager GetSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html)
- [Secrets Manager ARN permissions](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html)
- [AWS CLI create-secret](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/create-secret.html), [put-secret-value](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/put-secret-value.html), and [Lambda invoke](https://docs.aws.amazon.com/cli/latest/reference/lambda/invoke.html)
