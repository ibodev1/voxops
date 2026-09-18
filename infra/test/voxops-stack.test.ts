import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, expect, it } from "vitest";
import { VoxOpsDevStack } from "../lib/voxops-stack.js";

const outdir = mkdtempSync(join(tmpdir(), "voxops-infra-test-"));
const app = new App({ outdir, analyticsReporting: false });
const stack = new VoxOpsDevStack(app, "TestStack");
const template = Template.fromStack(stack);
app.synth();
afterAll(() => rmSync(outdir, { recursive: true, force: true }));

const resource = (type: string) => Object.entries(template.findResources(type));

it("keeps the existing HTTP API limited to health and MCP", () => {
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
  expect(
    resource("AWS::ApiGatewayV2::Route")
      .map(([, value]) => value.Properties.RouteKey)
      .sort(),
  ).toEqual(["GET /health", "POST /mcp"]);
  template.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
  template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
    IntegrationType: "AWS_PROXY",
    PayloadFormatVersion: "2.0",
  });
  expect(JSON.stringify(resource("AWS::ApiGatewayV2::Route"))).not.toMatch(/demo\/chat|\$default/);
});

it("creates one explicit regional REST streaming POST method with no other REST routes", () => {
  template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
  template.resourceCountIs("AWS::ApiGateway::Method", 1);
  template.hasResourceProperties("AWS::ApiGateway::RestApi", {
    EndpointConfiguration: { Types: ["REGIONAL"] },
  });
  const [, method] = resource("AWS::ApiGateway::Method")[0]!;
  expect(method.Properties.HttpMethod).toBe("POST");
  expect(method.Properties.AuthorizationType).toBe("NONE");
  expect(method.Properties.Integration).toMatchObject({
    Type: "AWS_PROXY",
    IntegrationHttpMethod: "POST",
    ResponseTransferMode: "STREAM",
  });
  expect(JSON.stringify(method.Properties.Integration.Uri)).toContain(
    "/response-streaming-invocations",
  );
  expect(JSON.stringify(method.Properties.Integration.Uri)).toContain("ChatRuntime");
  expect(
    resource("AWS::ApiGateway::Resource").map(([, value]) => value.Properties.PathPart),
  ).toEqual(expect.arrayContaining(["api", "demo", "chat"]));
});

it("routes one uncached CloudFront chat behavior to the REST stage", () => {
  template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  const [, distribution] = resource("AWS::CloudFront::Distribution")[0]!;
  const config = distribution.Properties.DistributionConfig;
  expect(config.DefaultCacheBehavior.AllowedMethods).toEqual(["GET", "HEAD"]);
  expect(config.CacheBehaviors).toHaveLength(1);
  expect(config.CacheBehaviors[0]).toMatchObject({
    PathPattern: "api/demo/chat",
    CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
  });
  expect(config.Origins).toHaveLength(2);
  template.resourceCountIs("AWS::S3::Bucket", 1);
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

it("bounds Lambda cost and Bedrock permissions to the chat execution role", () => {
  template.resourceCountIs("AWS::Lambda::Function", 2);
  template.resourceCountIs("AWS::IAM::Role", 2);
  template.resourceCountIs("AWS::IAM::Policy", 2);
  const functions = resource("AWS::Lambda::Function");
  for (const [, fn] of functions) {
    expect(fn.Properties).toMatchObject({
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      MemorySize: 256,
      Timeout: 60,
    });
    expect(fn.Properties.VpcConfig).toBeUndefined();
  }
  const runtime = functions.find(
    ([, fn]) => fn.Properties.Environment?.Variables?.VOXOPS_PUBLIC_REPOSITORIES,
  );
  const chat = functions.find(
    ([, fn]) => fn.Properties.Environment?.Variables?.VOXOPS_MCP_REMOTE_URL,
  );
  expect(runtime).toBeDefined();
  expect(chat).toBeDefined();
  expect(runtime![1].Properties.ReservedConcurrentExecutions).toBeUndefined();
  expect(chat![1].Properties.ReservedConcurrentExecutions).toBe(2);
  expect(runtime![1].Properties.Environment.Variables.VOXOPS_MCP_REMOTE_URL).toBeUndefined();
  expect(chat![1].Properties.Environment.Variables.VOXOPS_PUBLIC_REPOSITORIES).toBeUndefined();
  const policies = resource("AWS::IAM::Policy");
  const runtimePolicy = policies.find(([, value]) =>
    JSON.stringify(value.Properties.Roles).includes("RuntimeRole"),
  );
  expect(JSON.stringify(runtimePolicy)).not.toContain("bedrock:");
  const bedrock = policies
    .flatMap(([, value]) => value.Properties.PolicyDocument.Statement)
    .filter(
      (statement: { Action: string | string[] }) =>
        typeof statement.Action === "string" && statement.Action.startsWith("bedrock:"),
    );
  expect(bedrock).toHaveLength(2);
  expect(
    bedrock.every(
      (statement: { Action: string }) =>
        statement.Action === "bedrock:InvokeModelWithResponseStream",
    ),
  ).toBe(true);
  expect(JSON.stringify(bedrock)).toContain("eu.amazon.nova-micro-v1:0");
  expect(JSON.stringify(bedrock)).toContain("bedrock:InferenceProfileArn");
  expect(JSON.stringify(bedrock)).not.toContain('"Resource":"*"');
});

it("uses finite runtime/HTTP access logs and excludes costly or secret resources", () => {
  template.resourceCountIs("AWS::Logs::LogGroup", 3);
  for (const [, log] of resource("AWS::Logs::LogGroup"))
    expect(log.Properties.RetentionInDays).toBe(7);
  template.hasResourceProperties("AWS::ApiGateway::Stage", {
    MethodSettings: Match.arrayWith([
      Match.objectLike({
        ThrottlingRateLimit: 10,
        ThrottlingBurstLimit: 20,
      }),
    ]),
  });
  const wire = JSON.stringify(template.toJSON());
  expect(wire).not.toMatch(
    /authorizationHeader|requestBody|privateKey|clientSecret|tokenSigningSecret/,
  );
  const types = Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map(
    (entry) => entry.Type,
  );
  for (const forbidden of [
    "AWS::Lambda::Url",
    "AWS::ApiGateway::Authorizer",
    "AWS::ApiGatewayV2::Authorizer",
    "AWS::EC2::VPC",
    "AWS::EC2::NatGateway",
    "AWS::Cognito::UserPool",
    "AWS::SecretsManager::Secret",
    "AWS::RDS::DBInstance",
  ])
    expect(types).not.toContain(forbidden);
  expect(Object.keys(template.toJSON().Outputs)).toEqual(
    expect.arrayContaining([
      "ApiEndpoint",
      "ChatApiEndpoint",
      "RuntimeLogGroupName",
      "ChatRuntimeLogGroupName",
      "WebUrl",
      "WebBucketName",
    ]),
  );
});

it("bundles both handlers without credentials and preserves the health fixture", () => {
  const assets = readdirSync(outdir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("asset."))
    .map((entry) => join(outdir, entry.name, "index.js"));
  expect(assets).toHaveLength(2);
  for (const path of assets) {
    const bundle = readFileSync(path, "utf8");
    expect(bundle).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(bundle).not.toContain("VOXOPS_GITHUB_SECRET_ID");
    expect(bundle).not.toContain("VOXOPS_ALEXA_AUTH_SECRET_ID");
  }
  const healthBundle = assets.find((path) => readFileSync(path, "utf8").includes("/health"));
  expect(healthBundle).toBeDefined();
  const fixturePath = fileURLToPath(
    new URL("../../scripts/aws/events/health.json", import.meta.url),
  );
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const deny = () => { throw new Error('Network disabled'); };
    require('node:http').request = deny;
    require('node:https').request = deny;
    globalThis.fetch = deny;
    const { handler } = require(process.argv[1]);
    const event = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
    handler(event).then(result => {
      require('node:assert/strict').equal(result.statusCode, 200);
      require('node:assert/strict').deepEqual(JSON.parse(result.body), { status: 'ok' });
      console.log('health passed');
    }).catch(() => process.exitCode = 1);
  `,
      healthBundle!,
      fixturePath,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, VOXOPS_PUBLIC_REPOSITORIES: "ibodev1/voxops" },
      timeout: 10_000,
    },
  );
  expect(output.trim()).toBe("health passed");
});
