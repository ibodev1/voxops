# 0004: AWS Lambda runtime

**Status:** Accepted

Milestone 5A adds one TypeScript CDK v2 development stack and a Node.js 24 Lambda using Hono's official AWS adapter. Local and Lambda entrypoints share `createApp`, the four read-only MCP tools, and GitHub operations. Lambda provides low idle compute cost and an AWS-native hackathon deployment. ARM64 suits the JavaScript-only bundle; use 256 MB, a 10-second timeout, no VPC or preallocated concurrency, and an explicit log group with seven-day retention. Local esbuild produces a single CommonJS bundle including the pinned Secrets Manager SDK.

AWS credentials for the GitHub App come from one existing Secrets Manager secret, `voxops/dev/github-app`, imported by name. Only its identifier enters Lambda configuration. The execution role can write to the created log group and call `GetSecretValue` on the fixed secret name plus its six-character AWS ARN suffix. The secret uses the same account/region and the default AWS-managed Secrets Manager encryption key; no KMS permissions are added.

The server selects local external-PEM configuration or AWS secret configuration, rejecting mixed modes. Credentials and the GitHub client initialize lazily on capability use, so health and MCP discovery work without a populated secret. This supersedes ADR 0002's startup-only credential validation. Successes are cached in memory for warm invocations; failures can retry. Key rotation requires recycling warm processes. Secrets, JWTs, and installation tokens are neither logged nor written to disk.

There is no public HTTP entrypoint in Milestone 5A. Only AWS IAM-authorized Lambda invocation is supported, using representative HTTP API v2 events. Remote caller authorization must exist before public exposure. Existing localhost Host/Origin guards remain enabled. API Gateway, OAuth/Cognito, public MCP, Alexa+, write actions, Bedrock, and DynamoDB are deferred.

Synthesis calls `app.synth()` directly so local checks and CI need no AWS credentials, SDK account discovery, or cloud lookups. Normal CDK diff/bootstrap/deploy commands remain explicit developer actions. This milestone implements and tests infrastructure locally; it does not deploy or prove live AWS operation.
