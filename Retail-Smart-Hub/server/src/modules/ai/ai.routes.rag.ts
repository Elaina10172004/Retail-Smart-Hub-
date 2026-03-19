import type { Router } from 'express';
import { appendAuditLog } from '../../database/db';
import { isApiError } from '../../shared/api-error';
import { fail, ok } from '../../shared/response';
import { parseWithSchema } from '../../shared/validation';
import { runWithAiRuntime } from './ai.runtime-facade';
import { getPythonRagDiagnostics, getPythonRagStatus, rebuildPythonRag } from './python-agent.client';
import {
  deleteLocalKnowledgeDocumentByKey,
  getLocalKnowledgeDocumentByKey,
  listLocalKnowledgeDocuments,
  patchLocalKnowledgeDocumentByKey,
  uploadLocalKnowledgeDocument,
} from './knowledge-doc.service';
import {
  ragDocumentKeyParamsSchema,
  ragDocumentPatchSchema,
  ragDocumentUploadSchema,
  ragRebuildSchema,
} from './ai.validators';

function hasConfigPermission(permissions: string[]) {
  return permissions.includes('settings.access-control');
}

async function rebuildAfterKnowledgeMutation() {
  try {
    const resolved = await runWithAiRuntime('rag_rebuild', async () =>
      rebuildPythonRag({
        force: true,
        incremental: true,
      }),
    );
    return {
      ok: true,
      runtimeUsed: resolved.runtimeUsed,
      result: resolved.data,
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      runtimeUsed: 'python' as const,
      result: null,
      error: error instanceof Error ? error.message : 'RAG rebuild failed',
    };
  }
}

export function registerAiRagRoutes(aiRouter: Router) {
  aiRouter.get('/rag/status', async (_req, res) => {
    try {
      const resolved = await runWithAiRuntime('rag_status', async () => getPythonRagStatus());
      return ok(res, resolved.data);
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 500,
        error instanceof Error ? error.message : 'Get RAG status failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.get('/rag/diagnostics', async (req, res) => {
    const permissions = req.auth?.permissions || [];
    if (!hasConfigPermission(permissions)) {
      return fail(res, 403, 'Permission denied: settings.access-control');
    }
    try {
      const resolved = await runWithAiRuntime('rag_diagnostics', async () => getPythonRagDiagnostics());
      return ok(res, resolved.data);
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 500,
        error instanceof Error ? error.message : 'Get RAG diagnostics failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.post('/rag/rebuild', async (req, res) => {
    const permissions = req.auth?.permissions || [];
    if (!hasConfigPermission(permissions)) {
      return fail(res, 403, 'Permission denied: settings.access-control');
    }

    try {
      const payload = parseWithSchema(ragRebuildSchema, req.body, 'rag-rebuild');
      const force = payload.force;
      const incremental = payload.incremental;
      const resolved = await runWithAiRuntime('rag_rebuild', async () =>
        rebuildPythonRag({
          force,
          incremental,
        }),
      );
      const result = resolved.data as {
        chunkCount: number;
        lancedbEnabled: boolean;
        lancedbAvailable: boolean;
        lancedbError?: string;
        rebuiltAt?: string;
      };

      appendAuditLog('ai_rag_rebuild', 'ai', req.auth?.id || 'anonymous', {
        by: req.auth?.username || 'unknown',
        force,
        incremental,
        chunkCount: result.chunkCount,
        lancedbEnabled: result.lancedbEnabled,
        lancedbAvailable: result.lancedbAvailable,
        lancedbError: result.lancedbError,
        runtimeUsed: resolved.runtimeUsed,
      });

      return ok(res, result, 'RAG 索引重建完成。');
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'RAG rebuild failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.get('/rag/documents', async (req, res) => {
    const permissions = req.auth?.permissions || [];
    if (!hasConfigPermission(permissions)) {
      return fail(res, 403, 'Permission denied: settings.access-control');
    }

    try {
      const documents = listLocalKnowledgeDocuments();
      return ok(res, {
        count: documents.length,
        documents,
      });
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'List RAG documents failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.get('/rag/documents/:key', async (req, res) => {
    const permissions = req.auth?.permissions || [];
    if (!hasConfigPermission(permissions)) {
      return fail(res, 403, 'Permission denied: settings.access-control');
    }

    try {
      const params = parseWithSchema(ragDocumentKeyParamsSchema, req.params, 'rag-document-key');
      const detail = getLocalKnowledgeDocumentByKey(params.key);
      return ok(res, detail);
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Get RAG document failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.patch('/rag/documents/:key', async (req, res) => {
    const permissions = req.auth?.permissions || [];
    if (!hasConfigPermission(permissions)) {
      return fail(res, 403, 'Permission denied: settings.access-control');
    }

    try {
      const params = parseWithSchema(ragDocumentKeyParamsSchema, req.params, 'rag-document-key');
      const payload = parseWithSchema(ragDocumentPatchSchema, req.body, 'rag-document-patch');
      const result = patchLocalKnowledgeDocumentByKey(params.key, {
        content: payload.content,
        includeInAssistant: payload.includeInAssistant,
      });
      const rebuildState = await rebuildAfterKnowledgeMutation();

      appendAuditLog('ai_rag_document_update', 'ai', req.auth?.id || 'anonymous', {
        by: req.auth?.username || 'unknown',
        relativePath: result.document.relativePath,
        size: result.document.size,
        lineCount: result.lineCount,
        includeInAssistant: result.document.includeInAssistant,
        ragRebuildOk: rebuildState.ok,
        ragRebuildError: rebuildState.error,
      });

      return ok(
        res,
        {
          ...result,
          ragRebuild: rebuildState,
        },
        rebuildState.ok ? '知识文档已更新，并已触发 RAG 重建。' : `知识文档已更新，但 RAG 重建失败：${rebuildState.error}`,
      );
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Update RAG document failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.post('/rag/documents/upload', async (req, res) => {
    const permissions = req.auth?.permissions || [];
    if (!hasConfigPermission(permissions)) {
      return fail(res, 403, 'Permission denied: settings.access-control');
    }

    try {
      const payload = parseWithSchema(ragDocumentUploadSchema, req.body, 'rag-document-upload');
      const result = uploadLocalKnowledgeDocument({
        fileName: payload.fileName,
        content: payload.content,
        targetDir: payload.targetDir,
        overwrite: payload.overwrite,
        includeInAssistant: payload.includeInAssistant,
      });
      const rebuildState = await rebuildAfterKnowledgeMutation();

      appendAuditLog('ai_rag_document_upload', 'ai', req.auth?.id || 'anonymous', {
        by: req.auth?.username || 'unknown',
        relativePath: result.document.relativePath,
        size: result.document.size,
        lineCount: result.lineCount,
        overwrite: payload.overwrite,
        includeInAssistant: result.document.includeInAssistant,
        ragRebuildOk: rebuildState.ok,
        ragRebuildError: rebuildState.error,
      });

      return ok(
        res,
        {
          ...result,
          ragRebuild: rebuildState,
        },
        rebuildState.ok ? '知识文档已上传，并已触发 RAG 重建。' : `知识文档已上传，但 RAG 重建失败：${rebuildState.error}`,
      );
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Upload RAG document failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.delete('/rag/documents/:key', async (req, res) => {
    const permissions = req.auth?.permissions || [];
    if (!hasConfigPermission(permissions)) {
      return fail(res, 403, 'Permission denied: settings.access-control');
    }

    try {
      const params = parseWithSchema(ragDocumentKeyParamsSchema, req.params, 'rag-document-key');
      const result = deleteLocalKnowledgeDocumentByKey(params.key);
      const rebuildState = await rebuildAfterKnowledgeMutation();

      appendAuditLog('ai_rag_document_delete', 'ai', req.auth?.id || 'anonymous', {
        by: req.auth?.username || 'unknown',
        relativePath: result.relativePath,
        ragRebuildOk: rebuildState.ok,
        ragRebuildError: rebuildState.error,
      });

      return ok(
        res,
        {
          ...result,
          ragRebuild: rebuildState,
        },
        rebuildState.ok ? '知识文档已删除，并已触发 RAG 重建。' : `知识文档已删除，但 RAG 重建失败：${rebuildState.error}`,
      );
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Delete RAG document failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });
}
