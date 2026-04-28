/**
 * Deterministic step plan for code-review-agent.
 *
 * 1. fetch-diff — local: `git diff HEAD` in WORKSPACE_ROOT
 *                 pr:    `gh pr diff <num> --repo <owner>/<repo>`
 * 2. analyze    — Ollama (petedio-coder, GPU1) reviews the diff with focus areas
 * 3. report     — formats findings into a markdown artifact
 *
 * Diff and analysis are shared across steps via a mutable ReviewState.
 */

import type { CodeReviewInput } from './schema.js';
import { ollamaChat, spawnCmd, parsePrNumberFromUrl } from './clients.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/home/pedro/PeteDio-Labs';
const MAX_DIFF_BYTES = 200_000;

export type ReviewAction = 'fetch-diff' | 'analyze' | 'report';

export interface ReviewStep {
  title: string;
  action: ReviewAction;
}

export interface ReviewStepLog {
  step: ReviewStep;
  status: 'complete' | 'failed' | 'skipped';
  output: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface ReviewState {
  diff: string;
  diffSummary: string;
  findings: string;
}

export function createInitialState(): ReviewState {
  return { diff: '', diffSummary: '', findings: '' };
}

export function buildPlan(input: CodeReviewInput): ReviewStep[] {
  const where = input.target === 'pr' ? `PR ${input.prUrl}` : `local diff in ${WORKSPACE_ROOT}`;
  return [
    { title: `Fetch diff (${where})`, action: 'fetch-diff' },
    { title: `Analyze with petedio-coder (focus: ${input.focus.join(', ')})`, action: 'analyze' },
    { title: 'Format review report', action: 'report' },
  ];
}

export function createExecuteStep(
  input: CodeReviewInput,
  state: ReviewState,
): (step: ReviewStep) => Promise<string> {
  return async (step) => {
    switch (step.action) {
      case 'fetch-diff': {
        let raw: string;
        if (input.target === 'pr') {
          if (!input.prUrl) throw new Error('prUrl missing for target=pr');
          const { owner, repo, number } = parsePrNumberFromUrl(input.prUrl);
          const result = await spawnCmd(
            'gh',
            ['pr', 'diff', String(number), '--repo', `${owner}/${repo}`],
            { timeoutMs: 30_000 },
          );
          if (result.exitCode !== 0) {
            throw new Error(`gh pr diff failed (${result.exitCode}): ${result.stderr.trim()}`);
          }
          raw = result.stdout;
        } else {
          const result = await spawnCmd('git', ['diff', 'HEAD'], {
            cwd: WORKSPACE_ROOT,
            timeoutMs: 30_000,
          });
          if (result.exitCode !== 0) {
            throw new Error(`git diff failed (${result.exitCode}): ${result.stderr.trim()}`);
          }
          raw = result.stdout;
        }

        if (raw.trim().length === 0) {
          state.diff = '';
          state.diffSummary = 'Empty diff — nothing to review.';
          return state.diffSummary;
        }

        const truncated = raw.length > MAX_DIFF_BYTES;
        state.diff = truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw;
        const fileCount = (raw.match(/^diff --git /gm) ?? []).length;
        state.diffSummary = [
          `Diff size: ${raw.length} bytes (${truncated ? 'truncated to ' + MAX_DIFF_BYTES : 'full'})`,
          `Files touched: ${fileCount}`,
        ].join('\n');
        return state.diffSummary;
      }

      case 'analyze': {
        if (!state.diff) {
          state.findings = 'No diff to analyze.';
          return state.findings;
        }

        const focusList = input.focus.join(', ');
        const system = [
          'You are PeteDio code-review-agent backed by petedio-coder.',
          `Review the diff with emphasis on: ${focusList}.`,
          'For each issue, output a bullet starting with [SEVERITY: file:line] then a one-line description and suggested fix.',
          'Severity levels: BLOCKER, MAJOR, MINOR, NIT. Use BLOCKER only for security or correctness issues.',
          'If a focus area has no findings, write "No <area> issues found." Do not invent issues.',
          'End with a one-line overall verdict: APPROVE, APPROVE_WITH_NITS, REQUEST_CHANGES, or REJECT.',
        ].join(' ');

        const user = [
          `Focus: ${focusList}`,
          '',
          'Diff:',
          '```diff',
          state.diff,
          '```',
        ].join('\n');

        state.findings = await ollamaChat([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]);
        return state.findings;
      }

      case 'report': {
        // Report formatting is the final formatReport call; this step is a noop placeholder
        // so the deterministic runner reflects "report" as a real, timed step.
        return state.findings ? 'Findings ready for report.' : 'No findings to format.';
      }

      default:
        throw new Error(`Unknown review action: ${(step as ReviewStep).action}`);
    }
  };
}

export function formatReport(
  input: CodeReviewInput,
  state: ReviewState,
  logs: ReviewStepLog[],
): string {
  const lines: string[] = [
    `# Code Review`,
    '',
    `Target: ${input.target === 'pr' ? input.prUrl : 'local diff'}`,
    `Focus: ${input.focus.join(', ')}`,
    '',
  ];
  if (state.diffSummary) {
    lines.push('## Diff Summary', '', '```', state.diffSummary, '```', '');
  }
  if (state.findings) {
    lines.push('## Findings', '', state.findings, '');
  }
  lines.push('## Steps', '');
  for (const [i, log] of logs.entries()) {
    lines.push(`${i + 1}. **${log.step.title}** [${log.status}, ${log.durationMs}ms]`);
  }
  return lines.join('\n');
}
