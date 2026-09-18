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

it("synthesizes only the public MCP HTTP boundary", () => {
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::Logs::LogGroup", 2);
  template.resourceCountIs("AWS::IAM::Role", 1);
  template.resourceCountIs("AWS::IAM::Policy", 1);
  // This exact resource allowlist excludes Function URLs, REST APIs, auth systems,
  // VPC/NAT/compute resources, extra Lambdas, and custom resources.
  const resources = template.toJSON().Resources as Record<string, { Type: string }>;
  expect(
    Object.values(resources)
      .map((resource) => resource.Type)
      .sort(),
  ).toEqual([
    "AWS::ApiGatewayV2::Api",
    "AWS::ApiGatewayV2::Integration",
    "AWS::ApiGatewayV2::Route",
    "AWS::ApiGatewayV2::Route",
    "AWS::ApiGatewayV2::Stage",
    "AWS::IAM::Policy",
    "AWS::IAM::Role",
    "AWS::Lambda::Function",
    "AWS::Lambda::Permission",
    "AWS::Lambda::Permission",
    "AWS::Logs::LogGroup",
    "AWS::Logs::LogGroup",
  ]);
});

const routeKeys = ["GET /health", "POST /mcp"];

it("routes only health and MCP POST to the existing Lambda", () => {
  const api = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"))[0];
  const integration = Object.keys(template.findResources("AWS::ApiGatewayV2::Integration"))[0];
  const runtime = Object.keys(template.findResources("AWS::Lambda::Function"))[0];
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
  template.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    ProtocolType: "HTTP",
    CorsConfiguration: Match.absent(),
    // No quick-create/default route or external OpenAPI routes.
    Target: Match.absent(),
    RouteKey: Match.absent(),
    Body: Match.absent(),
    BodyS3Location: Match.absent(),
  });
  expect(
    Object.values(template.findResources("AWS::ApiGatewayV2::Route"))
      .map((route) => route.Properties.RouteKey)
      .sort(),
  ).toEqual(routeKeys);
  for (const routeKey of routeKeys)
    template.hasResourceProperties(
      "AWS::ApiGatewayV2::Route",
      Match.objectEquals({
        ApiId: { Ref: api },
        RouteKey: routeKey,
        AuthorizationType: "NONE",
        Target: { "Fn::Join": ["", ["integrations/", { Ref: integration }]] },
      }),
    );
  template.hasResourceProperties(
    "AWS::ApiGatewayV2::Integration",
    Match.objectEquals({
      ApiId: { Ref: api },
      IntegrationType: "AWS_PROXY",
      IntegrationUri: { "Fn::GetAtt": [runtime, "Arn"] },
      PayloadFormatVersion: "2.0",
    }),
  );
  // Exact route keys forbid OAuth, repository routes, GET /mcp, ANY and $default catch-alls.
});

it("limits invocation grants to this API's two explicit paths", () => {
  const api = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"))[0];
  const runtime = Object.keys(template.findResources("AWS::Lambda::Function"))[0];
  template.resourceCountIs("AWS::Lambda::Permission", 2);
  for (const routeKey of routeKeys)
    template.hasResourceProperties(
      "AWS::Lambda::Permission",
      Match.objectEquals({
        Action: "lambda:InvokeFunction",
        FunctionName: { "Fn::GetAtt": [runtime, "Arn"] },
        Principal: "apigateway.amazonaws.com",
        SourceArn: {
          "Fn::Join": [
            "",
            [
              "arn:",
              { Ref: "AWS::Partition" },
              ":execute-api:",
              { Ref: "AWS::Region" },
              ":",
              { Ref: "AWS::AccountId" },
              ":",
              { Ref: api },
              `/*/*${routeKey.split(" ")[1]}`,
            ],
          ],
        },
      }),
    );
});

it("uses a throttled default stage and only minimal structured access logs", () => {
  const api = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"))[0];
  const logs = template.toJSON().Outputs.ApiAccessLogGroupName.Value.Ref as string;
  template.resourceCountIs("AWS::ApiGatewayV2::Stage", 1);
  template.hasResourceProperties(
    "AWS::ApiGatewayV2::Stage",
    Match.objectEquals({
      ApiId: { Ref: api },
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: {
        ThrottlingRateLimit: 10,
        ThrottlingBurstLimit: 20,
        DetailedMetricsEnabled: false,
      },
      AccessLogSettings: {
        DestinationArn: { "Fn::GetAtt": [logs, "Arn"] },
        Format: JSON.stringify({
          requestId: "$context.requestId",
          method: "$context.httpMethod",
          routeKey: "$context.routeKey",
          status: "$context.status",
          responseLatency: "$context.responseLatency",
          integrationLatency: "$context.integrationLatency",
        }),
      },
    }),
  );
  // The exact format excludes Authorization, bodies, paths, query strings and payloads.
  for (const log of Object.values(template.findResources("AWS::Logs::LogGroup"))) {
    expect(log.Properties.RetentionInDays).toBe(7);
    expect(log.DeletionPolicy).toBe("Delete");
  }
});

it("uses bounded runtime cost and environment settings", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Handler: "index.handler",
    Architectures: ["arm64"],
    MemorySize: 256,
    Timeout: 10,
    Environment: {
      Variables: Match.objectEquals({
        VOXOPS_PUBLIC_REPOSITORIES: "ibodev1/voxops",
      }),
    },
    VpcConfig: Match.absent(),
    ReservedConcurrentExecutions: Match.absent(),
    TracingConfig: Match.absent(),
    Layers: Match.absent(),
  });
  template.hasResource("AWS::Logs::LogGroup", {
    Properties: { RetentionInDays: 7 },
    DeletionPolicy: "Delete",
    UpdateReplacePolicy: "Delete",
  });
});

it("allows only log writes", () => {
  const logs = template.toJSON().Outputs.RuntimeLogGroupName.Value.Ref as string;
  const role = Object.keys(template.findResources("AWS::IAM::Role"))[0];
  template.hasResourceProperties("AWS::IAM::Role", {
    ManagedPolicyArns: Match.absent(),
    Policies: Match.absent(),
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
        },
      ],
    },
  });
  template.hasResourceProperties("AWS::IAM::Policy", {
    Roles: [{ Ref: role }],
    PolicyDocument: {
      Version: "2012-10-17",
      Statement: Match.arrayEquals([
        {
          Effect: "Allow",
          Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: { "Fn::GetAtt": [logs, "Arn"] },
        },
      ]),
    },
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Role: { "Fn::GetAtt": [role, "Arn"] },
    LoggingConfig: { LogGroup: { Ref: logs } },
  });
});

it("outputs identifiers only and packages only the bundled handler", () => {
  expect(Object.keys(template.toJSON().Outputs).sort()).toEqual([
    "ApiAccessLogGroupName",
    "ApiEndpoint",
    "FunctionArn",
    "FunctionName",
    "RuntimeLogGroupName",
  ]);
  const runtime = Object.keys(template.findResources("AWS::Lambda::Function"))[0];
  const api = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"))[0];
  template.hasOutput("ApiEndpoint", { Value: { "Fn::GetAtt": [api, "ApiEndpoint"] } });
  template.hasResourceProperties("AWS::Lambda::Function", {
    LoggingConfig: { LogGroup: template.toJSON().Outputs.RuntimeLogGroupName.Value },
  });
  template.hasOutput("FunctionArn", { Value: { "Fn::GetAtt": [runtime, "Arn"] } });
  const assets = readdirSync(outdir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("asset."),
  );
  expect(assets).toHaveLength(1);
  const asset = join(outdir, assets[0]!.name);
  expect(readdirSync(asset)).toEqual(["index.js"]);
  const bundle = readFileSync(join(asset, "index.js"), "utf8");
  // Parsers contain PEM delimiters; reject actual encoded key data, not delimiter literals.
  expect(/-----BEGIN (?:RSA )?PRIVATE KEY-----(?:\\r|\\n|\s)+[A-Za-z0-9+/=]{32}/.test(bundle)).toBe(
    false,
  );
  expect(bundle).not.toContain("@hono/node-server");
  expect(bundle).not.toContain("secretsmanager:GetSecretValue");
  expect(bundle).not.toContain("VOXOPS_GITHUB_SECRET_ID");
  expect(bundle).not.toContain("VOXOPS_ALEXA_AUTH_SECRET_ID");
  expect(JSON.stringify(template.toJSON())).not.toMatch(
    /privateKey|PRIVATE KEY|clientSecret|tokenSigningSecret|VOXOPS_GITHUB_APP_ID|VOXOPS_GITHUB_PRIVATE_KEY_PATH/,
  );
});

it("executes the actual CommonJS bundle with the health fixture and networking disabled", () => {
  const asset = readdirSync(outdir, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.startsWith("asset."),
  );
  const bundlePath = join(outdir, asset!.name, "index.js");
  const fixturePath = fileURLToPath(
    new URL("../../scripts/aws/events/health.json", import.meta.url),
  );
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const deny = () => { throw new Error('Network disabled in bundle smoke test'); };
    require('node:http').request = deny;
    require('node:https').request = deny;
    globalThis.fetch = deny;
    const { handler } = require(process.argv[1]);
    const event = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
    const domainName = 'voxops.example';
    const remote = { ...event, routeKey: 'GET /health', headers: { host: domainName },
      requestContext: { ...event.requestContext, domainName, routeKey: 'GET /health' } };
    Promise.all([handler(event), handler(remote)]).then(results => {
      for (const result of results) {
        require('node:assert/strict').equal(result.statusCode, 200);
        require('node:assert/strict').deepEqual(JSON.parse(result.body), { status: 'ok' });
      }
      console.log('health passed');
    }).catch(() => process.exitCode = 1);
  `,
      bundlePath,
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
