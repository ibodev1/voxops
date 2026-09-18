# 0003: MCP Streamable HTTP

**Status:** SUPERSEDED by [ADR 0008](0008-public-read-only-demo.md). MCP Streamable HTTP remains in use; the private GitHub and local-only assumptions below do not.

Use the official MCP TypeScript SDK v2 with a stateless Streamable HTTP endpoint at `/mcp`. The Hono adapter provides localhost Host and Origin validation, while `createMcpHandler` creates a fresh server for each request. The existing GitHub client remains shared so its installation token cache can be reused.

This provides the MCP transport needed for future Alexa+ integration through Web Standard requests and responses. The current repository-status tool needs no session storage, which also suits a later serverless deployment. The SDK's default compatibility path serves 2025-era Streamable HTTP clients, including protocol version 2025-11-25.

The endpoint is local and read-only. HTTP caller authentication is deferred until remote deployment; do not expose it beyond loopback in the meantime.
