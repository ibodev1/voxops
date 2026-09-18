# Alexa AI CLI access blocker

The Alexa AI CLI package is hosted in Amazon CodeArtifact. Installation requires assuming the `AddOn3PDeveloperToolsRead` role. The developer's local identity policy allowed `sts:AssumeRole`, but the cross-account assumption was denied. Amazon-side onboarding or trust access appears necessary; the exact cause is unverified. The developer submitted a feedback/support request. Root access was not used as a workaround.

The live VoxOps self-hosted MCP endpoint is already working. The optional web app demonstrates the conversational experience through that endpoint while CLI access is pending. It is a simulated Alexa+ experience, not the official Alexa Web Simulator. Resume the live Add-on flow only after Amazon grants the required access.
