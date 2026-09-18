import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AccessLogFormat,
  EndpointType,
  LambdaIntegration,
  ResponseTransferMode,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import {
  HttpApi,
  HttpMethod,
  CorsHttpMethod,
  LogGroupLogDestination,
  PayloadFormatVersion,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { RestApiOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  type IBucket,
} from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export class VoxOpsDevStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const logs = new LogGroup(this, "RuntimeLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new Role(this, "RuntimeRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logs.grantWrite(role);
    const chatLogs = new LogGroup(this, "ChatRuntimeLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const chatRole = new Role(this, "ChatRuntimeRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    chatLogs.grantWrite(chatRole);
    const profileArn = this.formatArn({
      service: "bedrock",
      resource: "inference-profile",
      resourceName: "eu.amazon.nova-micro-v1:0",
    });
    chatRole.addToPolicy(
      new PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: [profileArn],
      }),
    );
    chatRole.addToPolicy(
      new PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: ["eu-central-1", "eu-north-1", "eu-west-1", "eu-west-3"].map((region) =>
          this.formatArn({
            service: "bedrock",
            region,
            account: "",
            resource: "foundation-model",
            resourceName: "amazon.nova-micro-v1:0",
          }),
        ),
        conditions: { StringEquals: { "bedrock:InferenceProfileArn": profileArn } },
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
      timeout: Duration.seconds(60),
      role,
      logGroup: logs,
      environment: { VOXOPS_PUBLIC_REPOSITORIES: "ibodev1/voxops" },
      bundling: {
        target: "node24",
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: false,
        bundleAwsSDK: true,
      },
    });
    const chatRuntime = new NodejsFunction(this, "ChatRuntime", {
      entry: join(root, "apps/server/src/chat-lambda.ts"),
      projectRoot: root,
      depsLockFilePath: join(root, "pnpm-lock.yaml"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(60),
      reservedConcurrentExecutions: 2,
      role: chatRole,
      logGroup: chatLogs,
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
    const webBucket = new Bucket(this, "WebBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const webDistribution = new Distribution(this, "WebDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        // CDK's Bucket.isWebsite optional type conflicts with IBucket under exactOptionalPropertyTypes.
        origin: S3BucketOrigin.withOriginAccessControl(webBucket as IBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
    });
    // No default integration: only explicitly added routes may invoke the runtime.
    const api = new HttpApi(this, "HealthApi", {
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowHeaders: ["content-type"],
      },
    });
    chatRuntime.addEnvironment("VOXOPS_MCP_REMOTE_URL", `${api.apiEndpoint}/mcp`);
    const integration = new HttpLambdaIntegration("HealthIntegration", runtime, {
      payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
      scopePermissionToRoute: true,
    });
    api.addRoutes({
      path: "/health",
      methods: [HttpMethod.GET],
      integration,
    });
    api.addRoutes({ path: "/mcp", methods: [HttpMethod.POST], integration });
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
    const chatApi = new RestApi(this, "ChatApi", {
      endpointTypes: [EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: "dev",
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });
    chatApi.root
      .addResource("api")
      .addResource("demo")
      .addResource("chat")
      .addMethod(
        "POST",
        new LambdaIntegration(chatRuntime, {
          proxy: true,
          responseTransferMode: ResponseTransferMode.STREAM,
          timeout: Duration.seconds(60),
          allowTestInvoke: false,
        }),
      );
    webDistribution.addBehavior("api/demo/chat", new RestApiOrigin(chatApi), {
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
    });
    new CfnOutput(this, "FunctionName", { value: runtime.functionName });
    new CfnOutput(this, "FunctionArn", { value: runtime.functionArn });
    new CfnOutput(this, "ApiEndpoint", { value: api.apiEndpoint });
    new CfnOutput(this, "ChatApiEndpoint", { value: chatApi.urlForPath("/api/demo/chat") });
    new CfnOutput(this, "ChatRuntimeLogGroupName", { value: chatLogs.logGroupName });
    new CfnOutput(this, "RuntimeLogGroupName", { value: logs.logGroupName });
    new CfnOutput(this, "ApiAccessLogGroupName", { value: accessLogs.logGroupName });
    new CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new CfnOutput(this, "WebDistributionId", { value: webDistribution.distributionId });
    new CfnOutput(this, "WebUrl", { value: `https://${webDistribution.distributionDomainName}` });
  }
}
