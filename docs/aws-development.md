# AWS development: Milestones 5A and 5B

The developer reports Milestone 5A live and verified in `eu-central-1`: Lambda health, Secrets Manager loading, private repository reads, and runtime logs work. Milestone 5B adds a health-only HTTP API, verified locally by synthesis and tests. Codex did not deploy or invoke AWS during 5B; the developer must deploy and run the remote checks below. Remote MCP and Alexa+ integration remain deferred.

## Runtime and local checks

`apps/server/src/lambda.ts` uses Hono's official `handle` adapter and the same `createApp` as the loopback server. One API Gateway HTTP API routes only `GET /health` to the existing Lambda using payload v2. There is no catch-all route or Function URL. `/mcp`, repository REST routes, and other methods/paths are not routed. The `$default` stage is a stage name, not a `$default` route. No CORS or authorizer is configured.

Health responds only with `{"status":"ok"}` and does not load credentials. It is mounted before the localhost guards to accept API Gateway's Host. MCP and repository routes retain those guards locally and during direct invocation. Existing direct-invocation fixtures use a synthetic loopback Host; their headers are not authentication. AWS IAM controls direct Lambda invocation. Do not expose any capability remotely until caller authorization is designed and verified.

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
- AWS: CDK sets only `VOXOPS_GITHUB_SECRET_ID=voxops/dev/github-app`. Leave both local settings absent. The AWS SDK obtains AWS authentication through the Lambda execution role.
- Both modes load only when a GitHub capability is called. `/health` and MCP tool discovery do not load credentials. Partial local or mixed configuration fails safely on capability use.
- A successful credential load and the GitHub client are cached for the lifetime of the process, sharing Octokit's token cache. Failed loads are retried on the next request. Updating the secret does not refresh already warm processes: recycle execution environments after rotation (for example, a reviewed function code/configuration update). Automatic refresh is deferred.
- SecretString must contain exactly these JSON properties; `appId` is a positive integer encoded as a string, and `privateKey` is a complete, unencrypted RSA PEM. The example is a placeholder, not usable key material:

```json
{
  "appId": "<github-app-id>",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n<PEM base64 contents>\n-----END RSA PRIVATE KEY-----\n"
}
```

The stack imports the secret by name without creating it or retrieving its value. Use the same account and region as the function and the default `aws/secretsmanager` encryption key. A customer-managed KMS key would require a separate reviewed `kms:Decrypt` grant and is not supported by this milestone's IAM policy.

The execution role trusts only Lambda. Its sole identity policy permits `logs:CreateLogStream` and `logs:PutLogEvents` for the created log group, and `secretsmanager:GetSecretValue` for `arn:<partition>:secretsmanager:<region>:<account>:secret:voxops/dev/github-app-??????`. The six `?` characters match only Secrets Manager's six-character suffix for this fixed secret name; there is no `*` secret resource or service-action wildcard. No managed policies or `DescribeSecret` permission are attached.

## Manual AWS steps (PowerShell, repository root)

These commands contact AWS and may create billable resources. Run them yourself after reviewing the synthesized template. **Do not use the AWS root identity for routine deployments and do not create long-lived root access keys.** Use an administrative IAM Identity Center permission set or an appropriate assumed deployment role with temporary credentials. Account/Identity Center configuration is an operator task outside CDK. See [AWS root-user guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html). Stop if any command fails.

For the existing 5A environment, run step 1, then step 4 and the smoke checks. Bootstrap and secret setup are already complete; skip steps 2 and 3 unless explicitly setting up a different environment or rotating credentials.

### 1. Identity and region

```powershell
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

### 4. Review and deploy

```powershell
pnpm infra:diff
if ($LASTEXITCODE -ne 0) { throw 'CDK diff failed' }
pnpm infra:deploy
if ($LASTEXITCODE -ne 0) { throw 'CDK deployment failed' }
```

`infra:diff` runs `cdk diff --no-change-set` for a template comparison without creating a changeset. `infra:deploy` delegates to `pnpm --filter @voxops/infra run deploy`, which runs `cdk deploy` only; explicit `run` avoids pnpm's built-in deploy command. Review the IAM changes in the CLI prompt. The execution role must remain unchanged. Expect an API Gateway invocation permission restricted to this API's health path and no secret changes. The deploying identity also needs permissions to enable API Gateway log delivery; those control-plane permissions are not added to the runtime role. See [HTTP API logging permissions](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging.html).

Outputs are `FunctionName`, `FunctionArn`, `GitHubAppSecretName`, `ApiEndpoint`, `RuntimeLogGroupName`, and `ApiAccessLogGroupName`. None contains secret values.

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

After deploying 5B, retrieve the endpoint and check health without any credentials:

```powershell
$voxopsApiEndpoint = aws cloudformation describe-stacks --stack-name VoxOpsDevStack --region $env:AWS_REGION --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($voxopsApiEndpoint) -or $voxopsApiEndpoint -eq 'None') { throw 'Cannot read API endpoint; verify 5B deployment' }
$voxopsApiEndpoint = $voxopsApiEndpoint.TrimEnd('/')
curl.exe --silent --show-error --include "$voxopsApiEndpoint/health"
```

Expect HTTP **200** and exactly `{"status":"ok"}`. This checks the Lambda integration with a real API Gateway Host. No configuration, environment data, internal errors, or secret identifiers belong in the response.

```powershell
curl.exe --silent --show-error --include "$voxopsApiEndpoint/mcp"
curl.exe --silent --show-error --include --request POST "$voxopsApiEndpoint/mcp"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/status"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/issues"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/pull-requests"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/api/repositories/ibodev1/voxops/workflow-runs"
curl.exe --silent --show-error --include --request POST "$voxopsApiEndpoint/health"
curl.exe --silent --show-error --include "$voxopsApiEndpoint/unmatched"
```

Every negative check must return API Gateway **404** / route-not-found behavior (normally `{"message":"Not Found"}`), not a successful Hono/MCP/repository response. A Hono `403` also warrants investigation: those requests should not reach Lambda at all. Do not add routes to make negative checks succeed. The template tests enforce exactly one route; do not replace it with `$default`, `ANY`, or a greedy path.

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

The application stack contains ten resources: the existing Lambda, runtime log group, IAM role and inline policy, plus one HTTP API, one route, one integration, one stage, one invocation permission, and one access log group. Both log groups retain events for seven days and are deleted with the development stack. There is no VPC, NAT, provisioned/reserved concurrency, tracing, or always-on server.

Stage throttling is 10 requests/second with a burst of 20; [API Gateway throttling is best effort](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html), not a hard spending cap. Public traffic can incur gateway, Lambda, and logging charges. Secrets Manager and bootstrap storage also have costs. Detailed stage metrics are disabled. Access logs include only request ID, method, route key, status, and response/integration latency; no headers, bodies, query strings, raw paths, tokens, or MCP payloads. An unmatched request may have no integration latency. Review logs after deployment to confirm delivery.

The imported secret and separate bootstrap stack remain until separately removed. Restrict direct invocation permissions because authorized direct invokers can still read repositories accessible to the GitHub App. Live 5B behavior and costs remain unverified until the developer runs the checks.

## References

- [AWS Node.js Lambda runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
- [Hono AWS Lambda adapter](https://hono.dev/docs/getting-started/aws-lambda)
- [CDK NodejsFunction bundling](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)
- [Secrets Manager GetSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html)
- [Secrets Manager ARN permissions](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html)
- [AWS CLI create-secret](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/create-secret.html), [put-secret-value](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/put-secret-value.html), and [Lambda invoke](https://docs.aws.amazon.com/cli/latest/reference/lambda/invoke.html)
