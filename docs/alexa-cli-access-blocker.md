# Alexa AI CLI access blocker

**Historical Add-on investigation.** The final hackathon submission uses the working self-hosted MCP server and a clearly labeled web simulation. No Alexa Add-on deployment is planned for this submission.

The Alexa AI CLI package is hosted in Amazon CodeArtifact. Installation requires assuming the `AddOn3PDeveloperToolsRead` role. The developer's local identity policy allowed `sts:AssumeRole`, but the cross-account assumption was denied. Amazon-side onboarding or trust access appears necessary; the exact cause is unverified. The developer submitted a feedback/support request. Root access was not used as a workaround.

The live VoxOps self-hosted MCP endpoint is working. The optional web app demonstrates the conversational experience through that endpoint. It is a simulated Alexa+ experience, not the official Alexa Web Simulator. Any later Add-on project would first need authorized CLI access and separate interoperability verification.
