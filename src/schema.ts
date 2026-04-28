import { z } from 'zod';
import { TaskPayloadSchema } from '@petedio/shared/agents';

export const CodeReviewInputSchema = z
  .object({
    target: z.enum(['local-diff', 'pr']).describe('local-diff: git diff HEAD; pr: gh pr diff <num>'),
    prUrl: z.string().url().optional().describe('Required for target=pr — full GitHub PR URL'),
    focus: z
      .array(z.enum(['security', 'logic', 'style']))
      .min(1)
      .default(['security', 'logic'])
      .describe('Categories to emphasize in the review'),
  })
  .superRefine((input, ctx) => {
    if (input.target === 'pr' && !input.prUrl) {
      ctx.addIssue({ code: 'custom', message: 'target=pr requires prUrl' });
    }
  });

export type CodeReviewInput = z.infer<typeof CodeReviewInputSchema>;

export const CodeReviewTaskPayloadSchema = TaskPayloadSchema.extend({
  input: CodeReviewInputSchema,
});
