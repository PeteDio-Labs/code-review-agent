/**
 * Clients for code-review-agent.
 * Spawns local CLIs (git, gh) and calls Ollama on GPU1 for the analysis.
 */

import { spawn } from 'node:child_process';

const OLLAMA_URL =
  process.env.OLLAMA_URL_GPU1 ||
  process.env.OLLAMA_URL ||
  'http://192.168.50.59:11435';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'petedio-coder';
const OLLAMA_TIMEOUT_MS = 300_000; // diff reviews can be long

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function ollamaChat(messages: OllamaChatMessage[], model = OLLAMA_MODEL): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama (${OLLAMA_URL}) → ${res.status}${body ? ` :: ${body}` : ''}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? '';
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function spawnCmd(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

export function parsePrNumberFromUrl(url: string): { owner: string; repo: string; number: number } {
  // https://github.com/<owner>/<repo>/pull/<number>
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Could not parse PR URL: ${url}`);
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}
