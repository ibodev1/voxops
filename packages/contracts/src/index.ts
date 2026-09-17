import { z } from "zod";

export const RepositoryRefSchema = z.strictObject({
  owner: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
  repo: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/)
    .refine((name) => name !== "." && name !== ".."),
});

export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export const RepositoryStatusSchema = z.strictObject({
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(3),
  description: z.string().nullable(),
  defaultBranch: z.string().min(1),
  private: z.boolean(),
  archived: z.boolean(),
  url: z.url(),
  pushedAt: z.iso.datetime({ offset: true }).nullable(),
  latestCommit: z.strictObject({
    sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
    message: z.string(),
    authorName: z.string().nullable(),
    committedAt: z.iso.datetime({ offset: true }).nullable(),
  }),
});

export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;

export const RepositoryListInputSchema = RepositoryRefSchema.extend({
  limit: z.number().int().min(1).max(25).default(10),
});

export type RepositoryListInput = z.input<typeof RepositoryListInputSchema>;

export const OpenIssuesResultSchema = z.strictObject({
  repository: z.string(),
  issues: z.array(
    z.strictObject({
      number: z.number().int().positive(),
      title: z.string(),
      state: z.literal("open"),
      url: z.url(),
      authorLogin: z.string().nullable(),
      labels: z.array(z.string()),
      createdAt: z.iso.datetime({ offset: true }),
      updatedAt: z.iso.datetime({ offset: true }),
    }),
  ),
});

export type OpenIssuesResult = z.infer<typeof OpenIssuesResultSchema>;

export const PullRequestsResultSchema = z.strictObject({
  repository: z.string(),
  pullRequests: z.array(
    z.strictObject({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.url(),
      authorLogin: z.string().nullable(),
      draft: z.boolean(),
      sourceBranch: z.string(),
      targetBranch: z.string(),
      createdAt: z.iso.datetime({ offset: true }),
      updatedAt: z.iso.datetime({ offset: true }),
    }),
  ),
});

export type PullRequestsResult = z.infer<typeof PullRequestsResultSchema>;

export const WorkflowRunsResultSchema = z.strictObject({
  repository: z.string(),
  workflowRuns: z.array(
    z.strictObject({
      id: z.number().int().positive(),
      workflowName: z.string(),
      event: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      branch: z.string().nullable(),
      commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
      url: z.url(),
      createdAt: z.iso.datetime({ offset: true }),
      updatedAt: z.iso.datetime({ offset: true }),
    }),
  ),
});

export type WorkflowRunsResult = z.infer<typeof WorkflowRunsResultSchema>;
