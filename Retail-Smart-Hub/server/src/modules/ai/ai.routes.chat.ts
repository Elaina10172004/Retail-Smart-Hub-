import type { Router } from 'express';
import { generateAiReplyWithRuntime, streamAiReplyWithRuntime } from './ai.service';
import { parseAiChatBody } from './ai.validators';
import { isApiError } from '../../shared/api-error';
import { fail, ok } from '../../shared/response';
import { ensurePythonRuntime } from './ai.runtime-facade';
import {
  buildAiChatRuntimeRequest,
  finalizeAiChatSideEffects,
  metaToEnvelope,
  resolveTenantId,
  writeSseEvent,
} from './ai.routes.shared';

export function registerAiChatRoutes(aiRouter: Router) {
  aiRouter.post('/chat', async (req, res) => {
    try {
      const { prompt, conversationId, attachments, history } = parseAiChatBody(req.body);

      if (!prompt && attachments.length === 0) {
        return fail(res, 400, 'Prompt or attachments is required');
      }

      const runtimeRequest = buildAiChatRuntimeRequest({
        prompt,
        conversationId,
        attachments,
        history,
        req,
      });
      const execution = await generateAiReplyWithRuntime(runtimeRequest);
      const result = execution.data;

      const finalized = finalizeAiChatSideEffects({
        authUserId: req.auth?.id || 'anonymous',
        authUsername: req.auth?.username || 'unknown',
        tenantId: resolveTenantId(req.auth?.department),
        prompt,
        conversationId,
        attachments,
        result,
        runtimeUsed: execution.runtime,
      });
      result.memoryCapture = finalized.memoryCapture;

      return ok(res, result);
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 500,
        error instanceof Error ? error.message : 'AI chat failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.post('/chat/stream', async (req, res) => {
    let prompt = '';
    let conversationId = '';
    let attachments: ReturnType<typeof parseAiChatBody>['attachments'] = [];
    let history: ReturnType<typeof parseAiChatBody>['history'] = [];
    try {
      const parsed = parseAiChatBody(req.body);
      prompt = parsed.prompt;
      conversationId = parsed.conversationId;
      attachments = parsed.attachments;
      history = parsed.history;
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Invalid chat stream request',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }

    if (!prompt && attachments.length === 0) {
      return fail(res, 400, 'Prompt or attachments is required');
    }

    try {
      await ensurePythonRuntime('chat/stream');
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 503,
        error instanceof Error ? error.message : 'Python runtime is required for chat stream',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    let streamClosed = false;
    const closeStream = () => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      try {
        if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // ignore close errors
      }
    };

    const heartbeat = setInterval(() => {
      if (streamClosed) {
        return;
      }
      writeSseEvent(res, 'keepalive', { ts: new Date().toISOString() });
    }, 10000);

    const markClosed = () => {
      streamClosed = true;
      clearInterval(heartbeat);
    };
    res.on('close', markClosed);
    req.on('aborted', markClosed);

    try {
      const runtimeRequest = buildAiChatRuntimeRequest({
        prompt,
        conversationId,
        attachments,
        history,
        req,
      });

      const execution = await streamAiReplyWithRuntime(runtimeRequest, {
        onMeta: (meta) => {
          if (streamClosed) {
            return;
          }
          writeSseEvent(res, 'meta', metaToEnvelope(meta));
        },
        onDelta: (delta) => {
          if (streamClosed) {
            return;
          }
          writeSseEvent(res, 'delta', {
            replyDelta: delta.replyDelta || '',
            reasoningDelta: delta.reasoningDelta || '',
          });
        },
      });
      const result = execution.data;

      if (streamClosed) {
        clearInterval(heartbeat);
        return;
      }

      const finalized = finalizeAiChatSideEffects({
        authUserId: req.auth?.id || 'anonymous',
        authUsername: req.auth?.username || 'unknown',
        tenantId: resolveTenantId(req.auth?.department),
        prompt,
        conversationId,
        attachments,
        result,
        runtimeUsed: execution.runtime,
      });
      result.memoryCapture = finalized.memoryCapture;

      if (!streamClosed) {
        writeSseEvent(res, 'done', result);
      }
    } catch (error) {
      if (!streamClosed) {
        writeSseEvent(res, 'error', {
          message: error instanceof Error ? error.message : 'AI stream failed',
        });
      }
    } finally {
      clearInterval(heartbeat);
      res.off('close', markClosed);
      req.off('aborted', markClosed);
      closeStream();
    }
  });
}
