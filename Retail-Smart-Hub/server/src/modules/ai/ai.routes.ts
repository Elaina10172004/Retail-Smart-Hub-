import { createModuleRouter } from '../../shared/module-router';
import { registerAiActionRoutes } from './ai.routes.actions';
import { registerAiChatRoutes } from './ai.routes.chat';
import { registerAiMemoryRoutes } from './ai.routes.memory';
import { registerAiMiscRoutes } from './ai.routes.misc';
import { registerAiRagRoutes } from './ai.routes.rag';

export const aiRouter = createModuleRouter('ai', {
  existingUi: ['AI 对话页面', '模型状态卡片', 'RAG 引用提示'],
  plannedEntities: ['llm_chat_log', 'tool_call_log', 'knowledge_chunk', 'knowledge_index'],
  nextMilestones: ['RAG 检索接口', '工具编排层', '写操作确认链路', '需求预测接口'],
});

registerAiMiscRoutes(aiRouter);
registerAiRagRoutes(aiRouter);
registerAiMemoryRoutes(aiRouter);
registerAiChatRoutes(aiRouter);
registerAiActionRoutes(aiRouter);
