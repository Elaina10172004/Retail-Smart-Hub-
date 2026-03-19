import { env, getActiveAiApiKeyEnv, getActiveAiModel, isAiConfigured } from '../../config/env';
import { getKnowledgeStats } from './rag.service';
import type { AiStatusPayload } from './ai.types';

export function getAiStatusSnapshot(): AiStatusPayload {
  const knowledgeStats = getKnowledgeStats();
  return {
    configured: isAiConfigured(),
    provider: env.aiProvider,
    model: getActiveAiModel(),
    ragEnabled: knowledgeStats.chunkCount > 0 || knowledgeStats.lancedb.enabled,
    functionUseEnabled: false,
    apiKeyEnv: `${getActiveAiApiKeyEnv()} / python-runtime / chunks:${knowledgeStats.chunkCount}`,
  };
}
