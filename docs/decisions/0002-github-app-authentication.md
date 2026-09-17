# 0002: GitHub App authentication

**Status:** Accepted

Use a GitHub App instead of personal access tokens. Installation scope, least privilege, and short-lived tokens suit an application used with selected repositories. Current permissions are strictly read-only: Metadata and Contents. Expand permissions only with an intentional future decision.

`packages/github` owns configuration validation and authentication. Its factory exposes only `getRepositoryStatus`; Octokit, JWTs, and installation tokens remain internal. An App-authenticated request resolves the repository installation on each operation. Octokit's official authentication factory shares its in-memory token cache with installation clients and refreshes tokens as needed. No token manager or persistent credential store is added.

Absent configuration preserves anonymous public access. A missing installation falls back to anonymous access; absent or inaccessible private repositories receive the same 404. Authentication failures return a generic 503 because the server owns the credentials. Responses and startup diagnostics omit upstream messages and sensitive paths.

Startup accepts only a readable, external RSA PEM. Real paths prevent an in-repository key from being accepted through a symlink. This remains a local, trusted-caller API bound to loopback; GitHub App authentication does not provide HTTP caller authorization. Network exposure needs a separate authorization decision.
