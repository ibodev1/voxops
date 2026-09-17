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
