import { App } from "aws-cdk-lib";
import { VoxOpsDevStack } from "../lib/voxops-stack.js";

const app = new App({ outdir: "cdk.out", analyticsReporting: false });
new VoxOpsDevStack(app, "VoxOpsDevStack", {
  env: {
    ...(process.env.CDK_DEFAULT_ACCOUNT ? { account: process.env.CDK_DEFAULT_ACCOUNT } : {}),
    ...(process.env.CDK_DEFAULT_REGION ? { region: process.env.CDK_DEFAULT_REGION } : {}),
  },
});
// Direct synthesis avoids the CLI's default-account discovery for the offline quality gate.
app.synth();
