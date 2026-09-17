# VoxOps project guidance

VoxOps is a voice-first developer operations agent for Alexa+. It will cover GitHub repositories, issues, pull requests, workflows, and deployment state. Design reads first. Any write or destructive action needs explicit user confirmation.

## Architecture direction

- Use a pnpm workspace and strict TypeScript. Add workspaces only when they have real code: `apps/web` (React + Vite), `apps/server` (Hono + MCP), `packages/contracts`, `packages/domain`, `packages/github`, and `infra` (AWS CDK in TypeScript).
- Target AWS Lambda and API Gateway later; add DynamoDB only for a demonstrated storage need. Avoid always-on servers unless justified. Use Amazon Bedrock only for a concrete AI use case.
- Integrate GitHub through a GitHub App with narrowly scoped permissions, not personal access tokens.

## Engineering workflow

- Work one milestone at a time. Inspect existing files and Git state before editing; keep diffs small and avoid speculative abstractions, generic utility layers, and unused files.
- Use explicit types at public boundaries. Avoid `any`; validate untrusted input at runtime. Prefer Web Standard APIs and minimal dependencies. Comments should explain why, not restate what the code does.
- Keep tests deterministic. Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` before completion. Report architecture decisions and explain each added dependency. Do not implement future milestones early.
- Use the Karpathy coding guidelines for simple, verifiable changes. Apply Hallmark when UI work begins.

## Security and quality

- Follow least privilege for GitHub App permissions and AWS IAM. Prefer read actions; require explicit confirmation for writes.
- Never commit production secrets or credentials. Later, store them in appropriate AWS or GitHub secret facilities.
- Aim for a real working demo with explainable architecture, low AWS cost, observable behavior, and a clean public repository. Record actual development friction in `docs/friction-log.md`.
