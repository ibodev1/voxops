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

it("synthesizes only the function, logs, and scoped execution IAM", () => {
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::Logs::LogGroup", 1);
  template.resourceCountIs("AWS::IAM::Role", 1);
  template.resourceCountIs("AWS::IAM::Policy", 1);
  // A resource allowlist also catches gateways, URLs, permissions, VPCs, and custom resources.
  const resources = template.toJSON().Resources as Record<string, { Type: string }>;
  expect(
    Object.values(resources)
      .map((resource) => resource.Type)
      .sort(),
  ).toEqual(["AWS::IAM::Policy", "AWS::IAM::Role", "AWS::Lambda::Function", "AWS::Logs::LogGroup"]);
});

it("uses bounded runtime cost and environment settings", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Handler: "index.handler",
    Architectures: ["arm64"],
    MemorySize: 256,
    Timeout: 10,
    Environment: {
      Variables: Match.objectEquals({ VOXOPS_GITHUB_SECRET_ID: "voxops/dev/github-app" }),
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

it("allows only log writes and reading exactly the named secret", () => {
  const logs = Object.keys(template.findResources("AWS::Logs::LogGroup"))[0];
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
        {
          Effect: "Allow",
          Action: "secretsmanager:GetSecretValue",
          Resource: {
            "Fn::Join": [
              "",
              [
                "arn:",
                { Ref: "AWS::Partition" },
                ":secretsmanager:",
                { Ref: "AWS::Region" },
                ":",
                { Ref: "AWS::AccountId" },
                ":secret:voxops/dev/github-app-??????",
              ],
            ],
          },
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
    "FunctionArn",
    "FunctionName",
    "GitHubAppSecretName",
  ]);
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
  expect(JSON.stringify(template.toJSON())).not.toMatch(
    /privateKey|PRIVATE KEY|VOXOPS_GITHUB_APP_ID|VOXOPS_GITHUB_PRIVATE_KEY_PATH/,
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
    handler(event).then(result => {
      require('node:assert/strict').equal(result.statusCode, 200);
      require('node:assert/strict').deepEqual(JSON.parse(result.body), { status: 'ok' });
      console.log('health passed');
    }).catch(() => process.exitCode = 1);
  `,
      bundlePath,
      fixturePath,
    ],
    {
      encoding: "utf8",
      env: { VOXOPS_GITHUB_SECRET_ID: "voxops/dev/github-app" },
      timeout: 10_000,
    },
  );
  expect(output.trim()).toBe("health passed");
});
