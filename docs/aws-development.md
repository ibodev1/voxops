# AWS development: Milestone 5A

The repository now synthesizes a deployable Lambda. No AWS resources were deployed or invoked during this milestone. Deployment and live verification are manual developer steps below. Remote HTTP, remote MCP, and Alexa+ integration remain deferred.

## Runtime and local checks

`apps/server/src/lambda.ts` uses Hono's official `handle` adapter and the same `createApp` as the loopback server. It accepts API Gateway HTTP API v2 shaped events through authenticated Lambda invocation; there is no gateway or Function URL. The fixtures use a synthetic loopback Host to satisfy the existing MCP adapter guards. Their headers are not authentication: AWS IAM controls who can invoke this function. Do not weaken those guards or add a public transport before designing caller authorization.

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

These commands contact AWS and may create billable resources. Run them yourself after reviewing the synthesized template. Use your existing authenticated AWS CLI session; do not create access keys. Stop if any command fails.

### 1. Identity and region

```powershell
aws sts get-caller-identity
if ($LASTEXITCODE -ne 0) { throw 'AWS identity check failed' }
$env:AWS_REGION = Read-Host 'AWS deployment region'
$env:AWS_DEFAULT_REGION = $env:AWS_REGION
$env:CDK_DEFAULT_REGION = $env:AWS_REGION
$env:CDK_DEFAULT_ACCOUNT = aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0) { throw 'AWS account lookup failed' }
```

### 2. Bootstrap only if required for this account/region

```powershell
pnpm infra:bootstrap
if ($LASTEXITCODE -ne 0) { throw 'CDK bootstrap failed' }
```

Bootstrap creates the separate CDK toolkit stack (including asset storage and deployment roles). Those resources and deployment privileges are separate from the four application resources and the narrow runtime role. Review your account's bootstrap policy before running this command.

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

`infra:diff` runs `cdk diff --no-change-set` for a template comparison without creating a changeset. `infra:deploy` runs `cdk deploy` only. Review the IAM changes in the CLI prompt. The only outputs are function name, function ARN, and secret name.

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

## Cost and lifecycle

The application stack creates one Lambda, one CloudWatch log group (seven-day retention), one IAM role, and one inline policy. There is no VPC, NAT, provisioned/reserved concurrency, tracing, or always-on server. Lambda invocations, logs, the separately managed Secrets Manager secret, and CDK bootstrap asset storage can incur charges. No live cost/performance measurement has been made; cold starts and GitHub/Secrets Manager latency may approach the 10-second timeout. Logs are deleted with the development stack; the imported secret and separate bootstrap stack remain until separately removed. Restrict invocation permissions because every authorized invoker can read repositories accessible to the GitHub App.

## References

- [AWS Node.js Lambda runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
- [Hono AWS Lambda adapter](https://hono.dev/docs/getting-started/aws-lambda)
- [CDK NodejsFunction bundling](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)
- [Secrets Manager GetSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html)
- [Secrets Manager ARN permissions](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html)
- [AWS CLI create-secret](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/create-secret.html), [put-secret-value](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/put-secret-value.html), and [Lambda invoke](https://docs.aws.amazon.com/cli/latest/reference/lambda/invoke.html)
