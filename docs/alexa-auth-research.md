# Alexa+ MCP authentication requirements

Checked against official documentation on 2026-09-17. Milestone 5B is live with health only. Milestone 5C implements Tier 1 service authentication and MCP discovery, pending manual deployment. This is not a claim of full Alexa compatibility; Tier 2 and actual Add-on interoperability are untested.

## User account linking

The [Alexa+ MCP quickstart](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html) and [account-linking guide](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html) specify:

- OAuth 2.1 Authorization Code Grant with PKCE `S256`.
- Access and refresh tokens; access tokens sent as Bearer credentials in the Authorization header, never the URL query.
- A `resource` parameter identifying the canonical MCP URI in authorization and code-exchange requests. The account-linking guide says it is not sent on refresh requests.
- RFC 9728 Protected Resource Metadata and OAuth authorization-server metadata, including advertised `S256` support.
- Static client registration, including Alexa redirect URIs. Dynamic Client Registration is not supported.

Tier 2 account linking is required for access to user-specific private data. Before enabling tool execution, VoxOps must establish which repositories each linked user may access; GitHub App installation access alone does not authorize that user. None of the account-linking capabilities above is implemented or advertised in 5C.

## Service authentication

The [Alexa+ authentication guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html) describes Tier 1 `client_credentials` service authentication as the foundation before user linking. Its token request requires `resource`; `mcp:service` permits user-independent discovery, while user-specific tools need user authorization. It issues no refresh token for this grant. The guide explicitly lists WWW-Authenticate headers in 401 responses as unsupported. VoxOps returns safe JSON 401/403 responses without that header.

5C supports only client_secret_basic, the exact resource `<trusted-origin>/mcp`, and scope `mcp:service`. A one-hour HS256 JWT authorizes initialize, initialized notifications, ping, tools/list, and the current SDK's server/discover. All four GitHub tools can expose private information, so **every tools/call is HTTP 403 before dispatch**, even with valid service credentials. Token and signing secrets are separate random values in Secrets Manager. Metadata advertises only this implemented grant, token endpoint, client authentication method and scope; it includes no authorization endpoint, PKCE, user scope or refresh support.

The [MCP SDK authorization guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md) and [HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md) describe verifier/AuthInfo integration. Inspection of installed SDK 2.0.0 found that its bearer challenge helpers emit WWW-Authenticate, its protected-resource builder requires authorization_endpoint, and the scopeChallenge mechanism shown on the current main branch is unavailable in this pinned release. VoxOps reuses verifyBearerToken, AuthInfo, and the protected-resource metadata type, maps challenge responses itself, and checks only the cloned top-level method before passing the original request to the official handler. No MCP transport or dispatch is reimplemented. A real SDK-client test verifies POST-only discovery; GET /mcp is not exposed.

## Cognito constraint

[Cognito supports PKCE authorization-code flows](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), access/refresh tokens, custom scopes, and client_credentials. Its [resource-server documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html) describes user resource binding and explicitly excludes resource binding for client_credentials M2M grants. Alexa Tier 1 requires validation of resource, so Cognito alone is not assumed to satisfy that contract. No Cognito or proxy is added.

Actual Alexa integration must still verify static registration, discovery and HTTP challenge behavior, exact URI handling, and Tier 1/Tier 2 composition. Tier 2 identity/provider selection, PKCE, refresh, consent, account linking, and repository authorization remain design work for 5D. Service discovery alone does not establish end-to-end Alexa compatibility.
