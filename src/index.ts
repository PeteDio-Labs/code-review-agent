/**
 * code-review-agent — runs petedio-coder against a local git diff or a PR diff.
 *
 * Accepts a TaskPayload from MC Backend, fetches the diff (`git diff HEAD`
 * for local-diff or `gh pr diff` for pr), runs Ollama on GPU1, and reports
 * findings back to MC.
 */

import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { CodeReviewInputSchema } from './schema.js';
import {
  buildPlan,
  createExecuteStep,
  createInitialState,
  formatReport,
  type ReviewStep,
  type ReviewStepLog,
} from './tools.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3012', 10);
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const SHARED_AGENTS_MODULE_PATH = process.env.SHARED_AGENTS_MODULE_PATH ?? '@petedio/shared/agents';

interface SharedAgentReporter {
  running(message: string): Promise<void>;
  complete(result: {
    taskId: string;
    agentName: string;
    status: 'complete';
    summary: string;
    artifacts: Array<{ type: string; label: string; content: string }>;
    durationMs: number;
    completedAt: string;
  }): Promise<void>;
  fail(message: string): Promise<void>;
}

interface SharedAgentsModule {
  AgentReporter: new (opts: { mcUrl: string; taskId: string; agentName: string }) => SharedAgentReporter;
  TaskPayloadSchema: z.ZodType<{
    taskId: string;
    agentName: string;
    trigger: string;
    input: Record<string, unknown>;
    issuedAt: string;
  }>;
  runDeterministicPlan: (opts: {
    steps: ReviewStep[];
    executeStep: (step: ReviewStep) => Promise<string>;
    onStepStart?: (step: ReviewStep, index: number) => void | Promise<void>;
    stopOnError?: boolean;
  }) => Promise<{
    status: 'complete' | 'failed';
    logs: ReviewStepLog[];
    completedSteps: number;
    skippedSteps: number;
    failedStep?: ReviewStepLog;
  }>;
}

async function loadSharedAgents(): Promise<SharedAgentsModule> {
  return import(SHARED_AGENTS_MODULE_PATH) as Promise<SharedAgentsModule>;
}

async function runReview(payload: { taskId: string; input: Record<string, unknown> }): Promise<void> {
  const startMs = Date.now();
  const input = CodeReviewInputSchema.parse(payload.input);
  const shared = await loadSharedAgents();
  const { AgentReporter, runDeterministicPlan } = shared;

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'code-review-agent',
  });

  await reporter.running(`Starting code review (${input.target})...`);
  log.info({ taskId: payload.taskId, input }, 'code-review-agent starting');

  const steps = buildPlan(input);
  const state = createInitialState();
  const executeStep = createExecuteStep(input, state);

  try {
    const result = await runDeterministicPlan({
      steps,
      executeStep,
      onStepStart: async (step, index) => {
        await reporter.running(`Step ${index + 1}/${steps.length}: ${step.title}`);
      },
    });

    const durationMs = Date.now() - startMs;
    const report = formatReport(input, state, result.logs);
    const summary = result.failedStep
      ? `Failed at: ${result.failedStep.step.title}`
      : `Code review complete — ${result.completedSteps} step(s) finished`;

    log.info(
      { taskId: payload.taskId, durationMs, steps: result.logs.length, status: result.status },
      'review complete',
    );

    if (result.status === 'failed') {
      await reporter.fail(`${summary}\n\n${report}`);
      return;
    }

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'code-review-agent',
      status: 'complete',
      summary,
      artifacts: [
        { type: 'review-report', label: 'Code Review', content: report },
      ],
      durationMs,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ taskId: payload.taskId, err: msg }, 'review failed');
    await reporter.fail(msg);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

const shared = await loadSharedAgents();
const { TaskPayloadSchema } = shared;

app.post('/run', async (req, res) => {
  const parsed = TaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
    return;
  }

  res.json({ accepted: true, taskId: parsed.data.taskId });

  runReview(parsed.data).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Unhandled review error');
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    agent: 'code-review-agent',
    sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH,
    ollamaModel: process.env.OLLAMA_MODEL ?? 'petedio-coder',
    ollamaUrl: process.env.OLLAMA_URL_GPU1 ?? process.env.OLLAMA_URL ?? 'http://192.168.50.59:11435',
  });
});

app.listen(PORT, () => {
  log.info({ port: PORT, sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH }, 'code-review-agent listening');
});
