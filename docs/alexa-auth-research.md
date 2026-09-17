# Alexa+ MCP authentication requirements

Checked against official documentation on 2026-09-17. This is a requirements note, not an authentication implementation or compatibility claim. Milestone 5B exposes only public health; `/mcp` stays unavailable through API Gateway.

## User account linking

The [Alexa+ MCP quickstart](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html) and [account-linking guide](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html) specify:

- OAuth 2.1 Authorization Code Grant with PKCE `S256`.
- Access and refresh tokens; access tokens sent as Bearer credentials in the Authorization header, never the URL query.
- A `resource` parameter identifying the canonical MCP URI in authorization and code-exchange requests. The account-linking guide says it is not sent on refresh requests.
- RFC 9728 Protected Resource Metadata and OAuth authorization-server metadata, including advertised `S256` support.
- Static client registration, including Alexa redirect URIs. Dynamic Client Registration is not supported.

Account linking is required for access to user-specific private data. Before exposure, VoxOps must also establish which repositories each linked user may access; GitHub App installation access alone does not authorize that user.

## Service authentication

The [Alexa+ authentication guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html) describes `client_credentials` service authentication for private MCP servers, before user-level linking. Its token request requires `resource`; it separates service scopes from user scopes and does not issue refresh tokens for this grant. Verify the precise tier requirements, discovery behavior, scope handling, and audience validation in the actual Add-on integration. Do not assume user account linking alone covers private-server discovery.

## Cognito constraint

[Cognito supports PKCE authorization-code flows](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), including access and refresh tokens. It also supports custom OAuth scopes and [user resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html): a user authorization request can bind the token audience to a resource, and refreshes preserve that audience. That documentation explicitly excludes resource binding for `client_credentials` M2M grants.

These individual features do not establish Alexa+ compatibility. Both tiers, metadata discovery, registration, resource/audience behavior, token refresh, and user repository authorization require an end-to-end compatibility test before `/mcp` exposure. No Cognito, authorizer, custom OAuth server, proxy, or temporary token scheme is selected or added in Milestone 5B.
