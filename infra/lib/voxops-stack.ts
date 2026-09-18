import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  HttpApi,
  HttpMethod,
  LogGroupLogDestination,
  PayloadFormatVersion,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
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
    const serviceSecret = Secret.fromSecretNameV2(
      this,
      "AlexaServiceAuthSecret",
      "voxops/dev/alexa-service-auth",
    );
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
        resources: [`${secret.secretArn}-??????`, `${serviceSecret.secretArn}-??????`],
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
      environment: {
        VOXOPS_GITHUB_SECRET_ID: secret.secretName,
        VOXOPS_ALEXA_AUTH_SECRET_ID: serviceSecret.secretName,
      },
      bundling: {
        target: "node24",
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: false,
        bundleAwsSDK: true,
      },
    });
    const accessLogs = new LogGroup(this, "ApiAccessLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // No default integration: only explicitly added routes may invoke the runtime.
    const api = new HttpApi(this, "HealthApi", { createDefaultStage: false });
    const integration = new HttpLambdaIntegration("HealthIntegration", runtime, {
      payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
      scopePermissionToRoute: true,
    });
    api.addRoutes({
      path: "/health",
      methods: [HttpMethod.GET],
      integration,
    });
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
    ]) {
      api.addRoutes({ path, methods: [HttpMethod.GET], integration });
    }
    for (const path of ["/oauth/token", "/mcp"]) {
      api.addRoutes({ path, methods: [HttpMethod.POST], integration });
    }
    api.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
      detailedMetricsEnabled: false,
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            method: "$context.httpMethod",
            routeKey: "$context.routeKey",
            status: "$context.status",
            responseLatency: "$context.responseLatency",
            integrationLatency: "$context.integrationLatency",
          }),
        ),
      },
    });
    new CfnOutput(this, "FunctionName", { value: runtime.functionName });
    new CfnOutput(this, "FunctionArn", { value: runtime.functionArn });
    new CfnOutput(this, "GitHubAppSecretName", { value: secret.secretName });
    new CfnOutput(this, "ApiEndpoint", { value: api.apiEndpoint });
    new CfnOutput(this, "RuntimeLogGroupName", { value: logs.logGroupName });
    new CfnOutput(this, "ApiAccessLogGroupName", { value: accessLogs.logGroupName });
    new CfnOutput(this, "AlexaServiceAuthSecretName", { value: serviceSecret.secretName });
  }
}
