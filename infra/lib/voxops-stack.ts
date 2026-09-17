import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export class VoxOpsDevStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const secret = Secret.fromSecretNameV2(this, "GitHubAppSecret", "voxops/dev/github-app");
    const logs = new LogGroup(this, "RuntimeLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new Role(this, "RuntimeRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logs.grantWrite(role);
    role.addToPolicy(
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        // Secrets Manager adds exactly six random characters to this named secret's ARN.
        resources: [`${secret.secretArn}-??????`],
      }),
    );
    const runtime = new NodejsFunction(this, "Runtime", {
      entry: join(root, "apps/server/src/lambda.ts"),
      projectRoot: root,
      depsLockFilePath: join(root, "pnpm-lock.yaml"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      role,
      logGroup: logs,
      environment: { VOXOPS_GITHUB_SECRET_ID: secret.secretName },
      bundling: {
        target: "node24",
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: false,
        bundleAwsSDK: true,
      },
    });
    new CfnOutput(this, "FunctionName", { value: runtime.functionName });
    new CfnOutput(this, "FunctionArn", { value: runtime.functionArn });
    new CfnOutput(this, "GitHubAppSecretName", { value: secret.secretName });
  }
}
