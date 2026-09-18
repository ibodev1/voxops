# 0008: Public, read-only hackathon demo

**Status:** Accepted for Milestone 5E; live Alexa+ interoperability remains to be tested in M6.

VoxOps now reads only explicitly allowlisted public GitHub repositories. All four MCP tools are read-only; no REST repository or write routes are exposed. Every tool call checks the allowlist before any GitHub request and anonymously fetches repository metadata to verify `private === false` before reading commits, issues, pull requests, or workflows. Missing or invalid allowlist configuration fails startup. Anonymous GitHub rate limits are accepted for the hackathon.

The Alexa+ [account-linking guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html) makes linking optional for tools that behave the same for all users. The [authentication guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html) describes Tier 1 `client_credentials` for private MCP servers. This public, user-independent demo therefore disables account linking and service authentication. The [quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html) has a broad authentication checklist; actual Add-on creation and Web Simulator behavior must validate the interpretation in M6 before claiming Alexa compatibility.

Keep the existing HTTP API, Lambda, logs, and throttling. API Gateway routes only `GET /health` and `POST /mcp`. Remove active GitHub App, Secrets Manager, custom OAuth/JWT service authorization, metadata routes, and local REST debug routes. The execution role writes only to the runtime log group. The two manually managed old secrets are not deleted by CDK and must be cleaned up manually after a successful deployment and MCP smoke test.

This narrower public scope removes credential handling and user identity questions without creating a replacement auth system. Private repository GitHub App access, account linking, and safe write actions can be reconsidered after the hackathon with explicit user authorization and a verified Alexa authentication contract.
