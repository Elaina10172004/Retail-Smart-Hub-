import { getPythonAgentStatus, isPythonRuntimeEnabled } from './python-agent.client';
import { ensurePythonSidecarStarted } from './python-sidecar.service';
import { ApiError } from '../../shared/api-error';
import type { AiStatusPayload } from './ai.types';

export type AiResolvedRuntime = 'python';

export interface AiRuntimeFacadeResult<T> {
  data: T;
  runtimeUsed: AiResolvedRuntime;
}

export interface AiRuntimeRunOptions {
  // Reserved for future runtime strategy options.
}

export async function runWithAiRuntime<TPrimary>(
  operation: string,
  runPrimary: () => Promise<TPrimary>,
  options: AiRuntimeRunOptions = {},
): Promise<AiRuntimeFacadeResult<TPrimary>> {
  void options;
  if (!isPythonRuntimeEnabled()) {
    throw new ApiError(503, `Python runtime is required for ${operation}`, 'PYTHON_RUNTIME_REQUIRED');
  }

  await ensurePythonSidecarStarted();
  return {
    data: await runPrimary(),
    runtimeUsed: 'python',
  };
}

export async function ensurePythonRuntime(operation: string) {
  if (!isPythonRuntimeEnabled()) {
    throw new ApiError(503, `Python runtime is required for ${operation}`, 'PYTHON_RUNTIME_REQUIRED');
  }
  await ensurePythonSidecarStarted();
}

export async function getAiStatusWithRuntime(
  token: string,
): Promise<AiRuntimeFacadeResult<AiStatusPayload>> {
  return runWithAiRuntime('status', async () => getPythonAgentStatus(token));
}
