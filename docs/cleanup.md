# End-of-hackathon AWS cleanup

Run this only after judging, the winner announcement, and any required demo availability period are over. This removes the live VoxOps demo. Nothing in this runbook has been executed during finalization.

## 1. Capture the state

Use a reviewed, temporary, non-root AWS identity for the correct account. Do not use root or create long-lived root keys.

```powershell
$env:AWS_PROFILE = '<temporary-non-root-profile>'
$env:AWS_REGION = 'eu-central-1'
$stack = 'VoxOpsDevStack'
$archive = Join-Path $env:USERPROFILE 'voxops-final-archive'
New-Item -ItemType Directory -Path $archive -Force | Out-Null
$identity = aws sts get-caller-identity --profile $env:AWS_PROFILE --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$identity -or $identity.Arn -match ':root$') { throw 'Valid non-root identity required' }
aws cloudformation describe-stacks --stack-name $stack --region $env:AWS_REGION --profile $env:AWS_PROFILE --query 'Stacks[0].Outputs' --output json > (Join-Path $archive 'outputs.json')
aws cloudformation list-stack-resources --stack-name $stack --region $env:AWS_REGION --profile $env:AWS_PROFILE --output json > (Join-Path $archive 'resources.json')
$bucket = aws cloudformation describe-stacks --stack-name $stack --region $env:AWS_REGION --profile $env:AWS_PROFILE --query "Stacks[0].Outputs[?OutputKey=='WebBucketName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or !$bucket -or $bucket -eq 'None') { throw 'Web bucket output unavailable' }
```

The two generated JSON files stay outside the repository; they contain non-secret resource identifiers but should not be committed. Optionally download the final seven days of Runtime, ChatRuntime, and HTTP API access logs using their stack output names and `aws logs tail <log-group-name> --since 7d`. Review any log export before sharing it.

## 2. Remove the stack

The web bucket has `RemovalPolicy.DESTROY` but does not auto-delete objects. After checking the captured bucket name, empty it, then destroy the stack. These commands are deliberately manual and destructive:

```powershell
aws s3 rm "s3://$bucket" --recursive --region $env:AWS_REGION --profile $env:AWS_PROFILE
if ($LASTEXITCODE -ne 0) { throw 'Web bucket emptying failed' }
pnpm --filter @voxops/infra exec cdk destroy VoxOpsDevStack
```

Wait for CloudFormation and CloudFront deletion to complete. If CDK reports a non-empty bucket or another retained resource, inspect the stack events and resolve that exact resource; do not delete unrelated account resources.

## 3. Verify leftovers

- Confirm `VoxOpsDevStack` is gone in CloudFormation. Compare the archived `resources.json` against Lambda, API Gateway HTTP and REST APIs, CloudFront, the web S3 bucket, and all three VoxOps CloudWatch log groups. Check that no VoxOps-specific resource remains.
- Check Secrets Manager for historical VoxOps secrets created outside CDK. If any remain, decide separately whether to delete them with the normal recovery window. The current runtime does not use Secrets Manager.
- Review AWS Budgets/anomaly monitoring and account usage. Keep or retire demo-specific monitoring as appropriate.
- The Bedrock Nova Micro inference profile is on-demand: a quota or model-access entitlement alone is not a hosted instance and does not incur model-token usage without invocation. There is no model instance to delete.
- CDK bootstrap assets and roles are account-level infrastructure and may be shared with other stacks. Keep them unless an account administrator confirms they are unused and intentionally removes them separately.

Do not remove the GitHub repository or public submission material as part of AWS cleanup unless the developer makes that separate decision.
