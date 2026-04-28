import type {
  AiChatRequest,
  AiChatResponse,
  AiChatStreamCallbacks,
  AiChatStreamDelta,
  AiChatStreamMeta,
  AiStatusPayload,
} from './ai.types';
import {
  generateAiReplyViaPython,
  streamAiReplyViaPython,
} from './python-agent.client';
import { getAiStatusWithRuntime, runWithAiRuntime, type AiResolvedRuntime } from './ai.runtime-facade';

export type {
  AiStatusPayload,
  AiChatRequest,
  AiChatResponse,
  AiChatStreamMeta,
  AiChatStreamDelta,
  AiChatStreamCallbacks,
};
type RuntimeOperation = 'status' | 'chat' | 'chat_stream';
export type { AiResolvedRuntime };

export interface AiRuntimeExecution<T> {
  data: T;
  runtime: AiResolvedRuntime;
}

async function runWithPythonPrimary<T>(
  operation: RuntimeOperation,
  runPrimary: () => Promise<T>,
): Promise<AiRuntimeExecution<T>> {
  const execution = await runWithAiRuntime(operation, runPrimary);
  return {
    data: execution.data,
    runtime: execution.runtimeUsed,
  };
}

export async function getAiStatusForRuntime(token: string): Promise<AiStatusPayload> {
  const execution = await getAiStatusWithRuntime(token);
  return execution.data;
}

export async function generateAiReplyWithRuntime(input: AiChatRequest): Promise<AiRuntimeExecution<AiChatResponse>> {
  return runWithPythonPrimary('chat', async () => generateAiReplyViaPython(input));
}

export async function streamAiReplyWithRuntime(
  input: AiChatRequest,
  callbacks: AiChatStreamCallbacks = {},
): Promise<AiRuntimeExecution<AiChatResponse>> {
  return runWithPythonPrimary('chat_stream', async () => streamAiReplyViaPython(input, callbacks));
}

