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
import { getAiStatusSnapshot } from './ai.status';

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

export function getAiStatus(permissions: string[] = []): AiStatusPayload {
  void permissions;
  return getAiStatusSnapshot();
}

export async function getAiStatusForRuntime(token: string): Promise<AiStatusPayload> {
  const execution = await getAiStatusWithRuntime(token);
  return execution.data;
}

export async function generateAiReplyWithRuntime(input: AiChatRequest): Promise<AiRuntimeExecution<AiChatResponse>> {
  return runWithPythonPrimary('chat', async () => generateAiReplyViaPython(input));
}

export async function generateAiReply(input: AiChatRequest): Promise<AiChatResponse> {
  const execution = await generateAiReplyWithRuntime(input);
  return execution.data;
}

export async function streamAiReplyWithRuntime(
  input: AiChatRequest,
  callbacks: AiChatStreamCallbacks = {},
): Promise<AiRuntimeExecution<AiChatResponse>> {
  return runWithPythonPrimary('chat_stream', async () => streamAiReplyViaPython(input, callbacks));
}

export async function streamAiReply(
  input: AiChatRequest,
  callbacks: AiChatStreamCallbacks = {},
): Promise<AiChatResponse> {
  const execution = await streamAiReplyWithRuntime(input, callbacks);
  return execution.data;
}
