# VoxOps project guidance

VoxOps is feature complete for its hackathon scope: a public, read-only developer assistant with one allowlisted GitHub repository, a self-hosted MCP server, and a Bedrock-backed simulated Alexa+ web experience. Do not add private GitHub access, write actions, account linking, or an Alexa Add-on as part of finalization. Any future write or destructive action needs explicit user confirmation.

## Architecture

- Keep the pnpm workspace with `apps/web`, `apps/server`, `packages/contracts`, `packages/github`, and `infra`. The final architecture is recorded in `docs/decisions/0010-final-hackathon-architecture.md`.
- Runtime Lambda serves health and MCP through API Gateway HTTP API. A separate Chat Lambda serves AI SDK/Bedrock response streaming through REST API. CloudFront serves private S3 assets and forwards the chat path.
- GitHub reads are anonymous, restricted to `ibodev1/voxops`, and verified public on every tool call. Never add production secrets, static AWS credentials, or a private-repository fallback.

## Engineering workflow

- Inspect Git state and relevant code before editing. Prefer deleting dead code over adding abstractions; preserve the working live demo.
- Use strict TypeScript, runtime validation at untrusted boundaries, and deterministic tests. Avoid `any`, speculative layers, and unnecessary dependencies.
- Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm infra:synth`, and the web build before completion. CI requires no AWS credentials and does not deploy.
- Apply the Karpathy coding guidelines for small, verifiable changes. Use Hallmark only for requested UI design work.

## Security and operations

- Keep GitHub operations read-only; do not expose credentials or raw provider errors. Bedrock IAM stays scoped to the Nova Micro inference profile and required model ARNs.
- Use a non-root temporary AWS identity for manual AWS operations. Never deploy or tear down infrastructure without an explicit request. API throttling is best-effort protection, not a billing cap.
- Preserve genuine development friction in `docs/friction-log.md`. Follow `docs/cleanup.md` after judging and the winner announcement.
