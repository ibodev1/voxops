# Judge testing instructions

## Public live demo

Open **https://d190htydn0gfle.cloudfront.net/** in a current desktop browser. There is no login, payment, AWS account, or deployment step. The page is a **simulated Alexa+ experience** backed by the real self-hosted VoxOps MCP server; it is not the official Alexa Web Simulator.

Try these questions, one at a time:

1. “What's happening with VoxOps?”
2. “What is the latest VoxOps commit?”
3. “Are there any open pull requests?”
4. “How are the recent workflows doing?”

The answer appears incrementally. The conversation shows live MCP tool activity separately from the model text, and the right panel fills with repository context returned by the tools. Results come from the current public [ibodev1/voxops](https://github.com/ibodev1/voxops) repository; counts and commits can change. Zero open issues or pull requests is a valid live result. No account linking or private GitHub data is involved.

## Source and MCP

- Source code and setup: **https://github.com/ibodev1/voxops**
- Public MCP endpoint: **https://sb8ffkmwta.execute-api.eu-central-1.amazonaws.com/mcp**
- Health check: **https://sb8ffkmwta.execute-api.eu-central-1.amazonaws.com/health** (expected HTTP 200 with `{"status":"ok"}`)

An optional direct protocol check needs only `curl`:

```bash
curl -i -X POST 'https://sb8ffkmwta.execute-api.eu-central-1.amazonaws.com/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"judge-check","version":"1.0.0"}}}'
```

Expect HTTP 200 and a JSON or SSE response with `result.protocolVersion` of `2025-11-25`. The official SDK smoke script (`pnpm mcp:smoke` with `VOXOPS_MCP_URL` set to the URL above) checks discovery, all four tools, the public allowlist, and a protocol version at or above that minimum.

The submitted final revision also routes `GET /mcp` to the SDK, which returns 405 when no standalone SSE stream is offered. **The developer must manually deploy that final route before judging**; the previously deployed route returns 404. The web demo and POST-based MCP calls already work. Please use the web link for the intended evaluation experience and avoid repeated load testing of this public demo.
