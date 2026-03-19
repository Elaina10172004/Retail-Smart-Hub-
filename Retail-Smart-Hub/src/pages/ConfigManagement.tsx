import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, FileText, KeyRound, Loader2, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import {
  deleteAiKnowledgeDocumentByKey,
  deleteAiMemoryFact,
  fetchAiKnowledgeDocumentByKey,
  fetchAiKnowledgeDocuments,
  fetchAiMemoryFacts,
  fetchAiMemoryProfile,
  fetchAiRuntimeConfig,
  patchAiKnowledgeDocumentByKey,
  patchAiMemoryProfile,
  patchAiRuntimeConfig,
  uploadAiKnowledgeDocument,
} from '@/services/api/ai';
import type {
  AiKnowledgeDocumentSummary,
  AiMemoryFact,
  AiMemoryProfileResponse,
  AiProvider,
  AiRuntimeConfig,
} from '@/types/ai';

interface RuntimeProviderDraft {
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface TavilyDraft {
  baseUrl: string;
  apiKey: string;
  topic: 'general' | 'news';
  maxResults: number;
}

interface RuntimeConfigDraft {
  providerProfiles: Record<AiProvider, RuntimeProviderDraft>;
  smallProvider: AiProvider;
  largeProvider: AiProvider;
  tavily: TavilyDraft;
  layeredAgentEnabled: boolean;
}

interface MemoryDraft {
  assistantDisplayName: string;
  userPreferredName: string;
  language: string;
  assistantAliases: string;
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function parseAliases(rawValue: string) {
  return Array.from(
    new Set(
      rawValue
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, 10);
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function providerDefaultBaseUrl(provider: AiProvider) {
  if (provider === 'openai') {
    return 'https://api.openai.com/v1';
  }
  if (provider === 'gemini') {
    return 'https://generativelanguage.googleapis.com/v1beta';
  }
  return 'https://api.deepseek.com';
}

function providerDefaultModel(provider: AiProvider) {
  if (provider === 'openai') {
    return 'gpt-4o-mini';
  }
  if (provider === 'gemini') {
    return 'gemini-2.5-flash';
  }
  return 'deepseek-chat';
}

function providerLabel(provider: AiProvider) {
  if (provider === 'openai') {
    return 'OpenAI';
  }
  if (provider === 'gemini') {
    return 'Gemini';
  }
  return 'DeepSeek';
}

function buildProviderDraft(config: AiRuntimeConfig | null, provider: AiProvider): RuntimeProviderDraft {
  const profile = config?.providerProfiles?.[provider];
  if (profile) {
    return {
      baseUrl: profile.baseUrl || providerDefaultBaseUrl(provider),
      model: profile.model || providerDefaultModel(provider),
      apiKey: '',
    };
  }

  return {
    baseUrl:
      provider === 'openai'
        ? config?.openaiBaseUrl || providerDefaultBaseUrl(provider)
        : provider === 'gemini'
          ? config?.geminiBaseUrl || providerDefaultBaseUrl(provider)
          : config?.deepseekBaseUrl || providerDefaultBaseUrl(provider),
    model:
      provider === 'openai'
        ? config?.openaiModel || providerDefaultModel(provider)
        : provider === 'gemini'
          ? config?.geminiModel || providerDefaultModel(provider)
          : config?.deepseekModel || providerDefaultModel(provider),
    apiKey: '',
  };
}

function buildRuntimeDraft(config: AiRuntimeConfig | null): RuntimeConfigDraft {
  return {
    providerProfiles: {
      deepseek: buildProviderDraft(config, 'deepseek'),
      openai: buildProviderDraft(config, 'openai'),
      gemini: buildProviderDraft(config, 'gemini'),
    },
    smallProvider: config?.smallRoleProvider || config?.smallModelProfile.provider || config?.provider || 'deepseek',
    largeProvider: config?.largeRoleProvider || config?.largeModelProfile.provider || config?.provider || 'deepseek',
    tavily: {
      baseUrl: config?.tavilyProfile.baseUrl || config?.tavilyBaseUrl || 'https://api.tavily.com',
      apiKey: '',
      topic: config?.tavilyProfile.topic || config?.tavilyTopic || 'general',
      maxResults: config?.tavilyProfile.maxResults || config?.tavilyMaxResults || 5,
    },
    layeredAgentEnabled: config?.layeredAgentEnabled ?? true,
  };
}

function buildMemoryDraft(profile: AiMemoryProfileResponse | null): MemoryDraft {
  return {
    assistantDisplayName: profile?.profile.assistantDisplayName || '',
    userPreferredName: profile?.profile.userPreferredName || '',
    language: profile?.profile.language || '',
    assistantAliases: (profile?.profile.assistantAliases || []).join(', '),
  };
}

export function ConfigManagement() {
  const { confirm, confirmDialog } = useConfirmDialog();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [runtimeConfig, setRuntimeConfig] = useState<AiRuntimeConfig | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeConfigDraft>(buildRuntimeDraft(null));
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeNotice, setRuntimeNotice] = useState('');

  const [memoryProfile, setMemoryProfile] = useState<AiMemoryProfileResponse | null>(null);
  const [memoryFacts, setMemoryFacts] = useState<AiMemoryFact[]>([]);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>(buildMemoryDraft(null));
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryActionId, setMemoryActionId] = useState('');
  const [memoryError, setMemoryError] = useState('');
  const [memoryNotice, setMemoryNotice] = useState('');

  const [documents, setDocuments] = useState<AiKnowledgeDocumentSummary[]>([]);
  const [selectedDocumentKey, setSelectedDocumentKey] = useState('');
  const [selectedDocument, setSelectedDocument] = useState<AiKnowledgeDocumentSummary | null>(null);
  const [documentContent, setDocumentContent] = useState('');
  const [originalDocumentContent, setOriginalDocumentContent] = useState('');
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentDetailLoading, setDocumentDetailLoading] = useState(false);
  const [documentSaving, setDocumentSaving] = useState(false);
  const [documentUploading, setDocumentUploading] = useState(false);
  const [documentActionId, setDocumentActionId] = useState('');
  const [documentError, setDocumentError] = useState('');
  const [documentNotice, setDocumentNotice] = useState('');
  const [documentContextMenu, setDocumentContextMenu] = useState<{
    documentKey: string;
    x: number;
    y: number;
  } | null>(null);

  const loadRuntimeConfig = useCallback(async () => {
    setRuntimeLoading(true);
    setRuntimeError('');
    try {
      const response = await fetchAiRuntimeConfig();
      setRuntimeConfig(response.data);
      setRuntimeDraft(buildRuntimeDraft(response.data));
      setRuntimeNotice('');
    } catch (error) {
      setRuntimeError(getErrorMessage(error, '读取运行时配置失败'));
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  const loadMemoryOverview = useCallback(async () => {
    setMemoryLoading(true);
    setMemoryError('');
    try {
      const [profileResponse, factsResponse] = await Promise.all([
        fetchAiMemoryProfile({ scope: 'effective' }),
        fetchAiMemoryFacts({ scope: 'user', limit: 20 }),
      ]);
      setMemoryProfile(profileResponse.data);
      setMemoryFacts(factsResponse.data.facts);
      setMemoryDraft(buildMemoryDraft(profileResponse.data));
      setMemoryNotice('');
    } catch (error) {
      setMemoryError(getErrorMessage(error, '读取记忆失败'));
    } finally {
      setMemoryLoading(false);
    }
  }, []);

  const loadDocumentList = useCallback(async () => {
    setDocumentsLoading(true);
    setDocumentError('');
    try {
      const response = await fetchAiKnowledgeDocuments();
      const nextDocuments = response.data.documents;
      setDocuments(nextDocuments);
      if (nextDocuments.length === 0) {
        setSelectedDocumentKey('');
        setSelectedDocument(null);
        setDocumentContent('');
        setOriginalDocumentContent('');
        return;
      }
      const keepCurrent = nextDocuments.some((item) => item.key === selectedDocumentKey);
      setSelectedDocumentKey(keepCurrent ? selectedDocumentKey : nextDocuments[0].key);
    } catch (error) {
      setDocumentError(getErrorMessage(error, '读取知识文档列表失败'));
    } finally {
      setDocumentsLoading(false);
    }
  }, [selectedDocumentKey]);

  const loadDocumentDetail = useCallback(async (documentKey: string) => {
    if (!documentKey) {
      return;
    }
    setDocumentDetailLoading(true);
    setDocumentError('');
    try {
      const response = await fetchAiKnowledgeDocumentByKey(documentKey);
      setSelectedDocument(response.data.document);
      setDocumentContent(response.data.content);
      setOriginalDocumentContent(response.data.content);
      setDocumentNotice('');
    } catch (error) {
      setDocumentError(getErrorMessage(error, '读取知识文档详情失败'));
      setSelectedDocument(null);
      setDocumentContent('');
      setOriginalDocumentContent('');
    } finally {
      setDocumentDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuntimeConfig();
    void loadMemoryOverview();
    void loadDocumentList();
  }, [loadDocumentList, loadMemoryOverview, loadRuntimeConfig]);

  useEffect(() => {
    if (!selectedDocumentKey) {
      return;
    }
    void loadDocumentDetail(selectedDocumentKey);
  }, [loadDocumentDetail, selectedDocumentKey]);

  useEffect(() => {
    if (!documentContextMenu) {
      return;
    }

    const handleCloseMenu = () => {
      setDocumentContextMenu(null);
    };

    document.addEventListener('scroll', handleCloseMenu, true);
    document.addEventListener('click', handleCloseMenu);

    return () => {
      document.removeEventListener('scroll', handleCloseMenu, true);
      document.removeEventListener('click', handleCloseMenu);
    };
  }, [documentContextMenu]);

  const handleSaveRuntimeConfig = async () => {
    if (runtimeSaving) {
      return;
    }
    setRuntimeSaving(true);
    setRuntimeError('');
    setRuntimeNotice('');
    try {
      const response = await patchAiRuntimeConfig({
        provider: runtimeDraft.largeProvider,
        deepseekBaseUrl: runtimeDraft.providerProfiles.deepseek.baseUrl.trim(),
        deepseekModel: runtimeDraft.providerProfiles.deepseek.model.trim(),
        deepseekApiKey: runtimeDraft.providerProfiles.deepseek.apiKey.trim() || undefined,
        openaiBaseUrl: runtimeDraft.providerProfiles.openai.baseUrl.trim(),
        openaiModel: runtimeDraft.providerProfiles.openai.model.trim(),
        openaiApiKey: runtimeDraft.providerProfiles.openai.apiKey.trim() || undefined,
        geminiBaseUrl: runtimeDraft.providerProfiles.gemini.baseUrl.trim(),
        geminiModel: runtimeDraft.providerProfiles.gemini.model.trim(),
        geminiApiKey: runtimeDraft.providerProfiles.gemini.apiKey.trim() || undefined,
        tavilyBaseUrl: runtimeDraft.tavily.baseUrl.trim(),
        tavilyTopic: runtimeDraft.tavily.topic,
        tavilyMaxResults: Math.max(1, Math.min(8, Math.trunc(runtimeDraft.tavily.maxResults || 5))),
        tavilyApiKey: runtimeDraft.tavily.apiKey.trim() || undefined,
        smallProvider: runtimeDraft.smallProvider,
        smallBaseUrl: '',
        smallModel: '',
        smallApiKey: '',
        largeProvider: runtimeDraft.largeProvider,
        largeBaseUrl: '',
        largeModel: '',
        largeApiKey: '',
        layeredAgentEnabled: runtimeDraft.layeredAgentEnabled,
      });
      setRuntimeConfig(response.data);
      setRuntimeDraft(buildRuntimeDraft(response.data));
      setRuntimeNotice('Provider 档案、角色映射与 Tavily 配置已更新。');
    } catch (error) {
      setRuntimeError(getErrorMessage(error, '更新运行时配置失败'));
    } finally {
      setRuntimeSaving(false);
    }
  };

  const handleClearProviderApiKey = async (provider: AiProvider) => {
    if (runtimeSaving) {
      return;
    }
    setRuntimeSaving(true);
    setRuntimeError('');
    setRuntimeNotice('');
    try {
      const response = await patchAiRuntimeConfig(
        provider === 'openai'
          ? { openaiApiKey: '' }
          : provider === 'gemini'
            ? { geminiApiKey: '' }
            : { deepseekApiKey: '' },
      );
      setRuntimeConfig(response.data);
      setRuntimeDraft(buildRuntimeDraft(response.data));
      setRuntimeNotice(`${provider === 'openai' ? 'OpenAI' : provider === 'gemini' ? 'Gemini' : 'DeepSeek'} API Key 已清空。`);
    } catch (error) {
      setRuntimeError(getErrorMessage(error, '清空 API Key 失败'));
    } finally {
      setRuntimeSaving(false);
    }
  };

  const handleClearTavilyApiKey = async () => {
    if (runtimeSaving) {
      return;
    }
    setRuntimeSaving(true);
    setRuntimeError('');
    setRuntimeNotice('');
    try {
      const response = await patchAiRuntimeConfig({ tavilyApiKey: '' });
      setRuntimeConfig(response.data);
      setRuntimeDraft(buildRuntimeDraft(response.data));
      setRuntimeNotice('Tavily API Key 已清空。');
    } catch (error) {
      setRuntimeError(getErrorMessage(error, '清空 API Key 失败'));
    } finally {
      setRuntimeSaving(false);
    }
  };

  const handleSaveMemoryProfile = async () => {
    if (memorySaving) {
      return;
    }
    setMemorySaving(true);
    setMemoryError('');
    setMemoryNotice('');
    try {
      const aliases = parseAliases(memoryDraft.assistantAliases);
      await patchAiMemoryProfile({
        scope: 'user',
        patch: {
          assistantDisplayName: memoryDraft.assistantDisplayName.trim() || null,
          assistantAliases: aliases.length > 0 ? aliases : null,
          userPreferredName: memoryDraft.userPreferredName.trim() || null,
          language: memoryDraft.language.trim() || null,
        },
      });
      setMemoryNotice('记忆配置已更新。');
      await loadMemoryOverview();
    } catch (error) {
      setMemoryError(getErrorMessage(error, '更新记忆配置失败'));
    } finally {
      setMemorySaving(false);
    }
  };

  const handleDeleteMemoryFact = async (fact: AiMemoryFact) => {
    if (memoryActionId) {
      return;
    }
    const confirmed = await confirm({
      title: '删除记忆',
      message: `${fact.title}\n删除后将不再用于后续回答。`,
      confirmText: '删除',
      confirmVariant: 'destructive',
    });
    if (!confirmed) {
      return;
    }
    setMemoryActionId(fact.id);
    setMemoryError('');
    setMemoryNotice('');
    try {
      await deleteAiMemoryFact(fact.id, { scope: 'user' });
      setMemoryNotice('记忆已删除。');
      await loadMemoryOverview();
    } catch (error) {
      setMemoryError(getErrorMessage(error, '删除记忆失败'));
    } finally {
      setMemoryActionId('');
    }
  };

  const handleSaveKnowledgeDocument = async () => {
    if (!selectedDocument || documentSaving) {
      return;
    }
    setDocumentSaving(true);
    setDocumentError('');
    setDocumentNotice('');
    try {
      const response = await patchAiKnowledgeDocumentByKey(selectedDocument.key, {
        content: documentContent,
      });
      setSelectedDocument(response.data.document);
      setOriginalDocumentContent(documentContent);
      setDocumentNotice(`文档已保存：${response.data.document.relativePath}`);
      await loadDocumentList();
    } catch (error) {
      setDocumentError(getErrorMessage(error, '保存文档失败'));
    } finally {
      setDocumentSaving(false);
    }
  };

  const handleSetDocumentInclusion = async (document: AiKnowledgeDocumentSummary, includeInAssistant: boolean) => {
    if (documentSaving || documentDetailLoading) {
      return;
    }
    setDocumentSaving(true);
    setDocumentError('');
    setDocumentNotice('');
    try {
      const response = await patchAiKnowledgeDocumentByKey(document.key, {
        includeInAssistant,
      });
      if (selectedDocumentKey === document.key) {
        setSelectedDocument(response.data.document);
      }
      setDocumentNotice(
        includeInAssistant
          ? '该文档已纳入助手检索。请执行一次 RAG 重建以立即生效。'
          : '该文档已从助手检索中排除。请执行一次 RAG 重建以立即生效。',
      );
      setDocumentContextMenu(null);
      await loadDocumentList();
    } catch (error) {
      setDocumentError(getErrorMessage(error, '更新文档纳入状态失败'));
    } finally {
      setDocumentSaving(false);
    }
  };

  const handleToggleDocumentInclusion = async () => {
    if (!selectedDocument) {
      return;
    }
    await handleSetDocumentInclusion(selectedDocument, !selectedDocument.includeInAssistant);
  };

  const handleDeleteKnowledgeDocument = async () => {
    if (!selectedDocument || documentActionId || documentSaving) {
      return;
    }
    const confirmed = await confirm({
      title: '删除知识文档',
      message: `${selectedDocument.relativePath}\n删除后将从本地知识库移除。`,
      confirmText: '删除',
      confirmVariant: 'destructive',
    });
    if (!confirmed) {
      return;
    }
    setDocumentActionId(selectedDocument.key);
    setDocumentError('');
    setDocumentNotice('');
    try {
      await deleteAiKnowledgeDocumentByKey(selectedDocument.key);
      setDocumentNotice(`已删除：${selectedDocument.relativePath}`);
      await loadDocumentList();
    } catch (error) {
      setDocumentError(getErrorMessage(error, '删除文档失败'));
    } finally {
      setDocumentActionId('');
    }
  };

  const handleUploadKnowledgeFile = async (file: File) => {
    if (documentUploading) {
      return;
    }
    setDocumentUploading(true);
    setDocumentError('');
    setDocumentNotice('');
    try {
      const content = await file.text();
      const response = await uploadAiKnowledgeDocument({
        fileName: file.name,
        content,
        overwrite: true,
      });
      setDocumentNotice(`已上传：${response.data.document.relativePath}`);
      await loadDocumentList();
      setSelectedDocumentKey(response.data.document.key);
    } catch (error) {
      setDocumentError(getErrorMessage(error, '上传文档失败'));
    } finally {
      setDocumentUploading(false);
      if (uploadInputRef.current) {
        uploadInputRef.current.value = '';
      }
    }
  };

  const runtimeMeta = useMemo(() => {
    if (!runtimeConfig) {
      return '读取中';
    }
    return `${runtimeConfig.runtime} / layered=${runtimeConfig.layeredAgentEnabled ? 'on' : 'off'} / active=${runtimeConfig.largeRoleProvider}:${runtimeConfig.largeModelProfile.model}`;
  }, [runtimeConfig]);

  const hasDocumentChanges = useMemo(
    () => documentContent !== originalDocumentContent,
    [documentContent, originalDocumentContent],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">配置管理</h1>
        <p className="mt-1 text-sm text-slate-600">统一管理记忆、Small/Large 模型配置与知识文档纳入策略。</p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base text-slate-900">
                  <Database className="h-4 w-4 text-blue-600" />
                  记忆管理
                </CardTitle>
                <CardDescription>维护助手偏好与用户事实记忆。</CardDescription>
              </div>
              <Button variant="outline" size="sm" disabled={memoryLoading || memorySaving} onClick={() => void loadMemoryOverview()}>
                {memoryLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                刷新
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs text-slate-500">助手显示名</span>
                <Input value={memoryDraft.assistantDisplayName} onChange={(event) => setMemoryDraft((v) => ({ ...v, assistantDisplayName: event.target.value }))} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-slate-500">用户偏好称呼</span>
                <Input value={memoryDraft.userPreferredName} onChange={(event) => setMemoryDraft((v) => ({ ...v, userPreferredName: event.target.value }))} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-slate-500">语言</span>
                <Input value={memoryDraft.language} onChange={(event) => setMemoryDraft((v) => ({ ...v, language: event.target.value }))} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-slate-500">助手别名（逗号分隔）</span>
                <Input value={memoryDraft.assistantAliases} onChange={(event) => setMemoryDraft((v) => ({ ...v, assistantAliases: event.target.value }))} />
              </label>
            </div>

            <div className="flex items-center gap-2">
              <Button disabled={memorySaving || memoryLoading} onClick={() => void handleSaveMemoryProfile()}>
                {memorySaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                保存记忆配置
              </Button>
              <span className="text-xs text-slate-500">最近更新：{formatDateTime(memoryProfile?.updatedAt)}</span>
            </div>

            {memoryError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{memoryError}</div> : null}
            {memoryNotice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{memoryNotice}</div> : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-900">记忆事实</span>
                <Badge variant="outline">{memoryFacts.length} 条</Badge>
              </div>
              <div className="max-h-[280px] space-y-2 overflow-auto pr-1">
                {memoryFacts.map((fact) => (
                  <div key={fact.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-900">{fact.title}</div>
                        <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{fact.content}</div>
                      </div>
                      <Button size="icon" variant="ghost" disabled={memoryActionId === fact.id} onClick={() => void handleDeleteMemoryFact(fact)}>
                        {memoryActionId === fact.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                ))}
                {memoryFacts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">当前暂无可见记忆。</div>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base text-slate-900">
                  <KeyRound className="h-4 w-4 text-indigo-600" />
                  模型配置
                </CardTitle>
                <CardDescription>Small LLM 用于路由/规划，Large LLM 用于最终回答。</CardDescription>
              </div>
              <Button variant="outline" size="sm" disabled={runtimeLoading || runtimeSaving} onClick={() => void loadRuntimeConfig()}>
                {runtimeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                刷新
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">运行状态</span>
                <span className="text-right font-medium text-slate-900">{runtimeMeta}</span>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Small: {providerLabel(runtimeDraft.smallProvider)} | Large: {providerLabel(runtimeDraft.largeProvider)} | Tavily:{' '}
                {runtimeConfig?.tavilyProfile.enabled ? runtimeConfig.tavilyProfile.apiKeyMasked : '未配置'}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-3 rounded-lg border border-slate-200 p-3">
                <div>
                  <div className="text-sm font-medium text-slate-900">Small LLM 映射</div>
                  <div className="text-xs text-slate-500">用于 Router / Planner / Tool 执行轮次</div>
                </div>
                <label className="space-y-1">
                  <span className="text-xs text-slate-500">Provider</span>
                  <select
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    value={runtimeDraft.smallProvider}
                    onChange={(event) =>
                      setRuntimeDraft((value) => ({
                        ...value,
                        smallProvider:
                          event.target.value === 'openai'
                            ? 'openai'
                            : event.target.value === 'gemini'
                              ? 'gemini'
                              : 'deepseek',
                      }))
                    }
                    disabled={runtimeSaving}
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
                <div className="text-xs text-slate-500">
                  当前解析到：{runtimeConfig?.smallModelProfile.provider}:{runtimeConfig?.smallModelProfile.model || '-'}
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-slate-200 p-3">
                <div>
                  <div className="text-sm font-medium text-slate-900">Large LLM 映射</div>
                  <div className="text-xs text-slate-500">用于最终回答收敛（Answer 阶段）</div>
                </div>
                <label className="space-y-1">
                  <span className="text-xs text-slate-500">Provider</span>
                  <select
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    value={runtimeDraft.largeProvider}
                    onChange={(event) =>
                      setRuntimeDraft((value) => ({
                        ...value,
                        largeProvider:
                          event.target.value === 'openai'
                            ? 'openai'
                            : event.target.value === 'gemini'
                              ? 'gemini'
                              : 'deepseek',
                      }))
                    }
                    disabled={runtimeSaving}
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
                <div className="text-xs text-slate-500">
                  当前解析到：{runtimeConfig?.largeModelProfile.provider}:{runtimeConfig?.largeModelProfile.model || '-'}
                </div>
              </div>
            </div>

            {(['deepseek', 'openai', 'gemini'] as AiProvider[]).map((provider) => (
              <div key={provider} className="space-y-3 rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{providerLabel(provider)} Provider 档案</div>
                    <div className="text-xs text-slate-500">
                      已保存 Key：{runtimeConfig?.providerProfiles?.[provider]?.hasApiKey ? runtimeConfig?.providerProfiles?.[provider]?.apiKeyMasked : '未配置'}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={runtimeSaving || runtimeLoading}
                    onClick={() => void handleClearProviderApiKey(provider)}
                  >
                    清空 Key
                  </Button>
                </div>
                <Input
                  value={runtimeDraft.providerProfiles[provider].baseUrl}
                  placeholder={providerDefaultBaseUrl(provider)}
                  onChange={(event) =>
                    setRuntimeDraft((value) => ({
                      ...value,
                      providerProfiles: {
                        ...value.providerProfiles,
                        [provider]: {
                          ...value.providerProfiles[provider],
                          baseUrl: event.target.value,
                        },
                      },
                    }))
                  }
                />
                <Input
                  value={runtimeDraft.providerProfiles[provider].model}
                  placeholder={providerDefaultModel(provider)}
                  onChange={(event) =>
                    setRuntimeDraft((value) => ({
                      ...value,
                      providerProfiles: {
                        ...value.providerProfiles,
                        [provider]: {
                          ...value.providerProfiles[provider],
                          model: event.target.value,
                        },
                      },
                    }))
                  }
                />
                <Input
                  type="password"
                  value={runtimeDraft.providerProfiles[provider].apiKey}
                  placeholder={`${providerLabel(provider)} API Key（留空则保留已保存值）`}
                  onChange={(event) =>
                    setRuntimeDraft((value) => ({
                      ...value,
                      providerProfiles: {
                        ...value.providerProfiles,
                        [provider]: {
                          ...value.providerProfiles[provider],
                          apiKey: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </div>
            ))}

            <div className="space-y-3 rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-slate-900">Tavily 联网搜索</div>
                  <div className="text-xs text-slate-500">
                    已保存 Key：{runtimeConfig?.tavilyProfile.hasApiKey ? runtimeConfig.tavilyProfile.apiKeyMasked : '未配置'}
                  </div>
                </div>
                <Button variant="outline" size="sm" disabled={runtimeSaving || runtimeLoading} onClick={() => void handleClearTavilyApiKey()}>
                  清空 Key
                </Button>
              </div>
              <Input
                value={runtimeDraft.tavily.baseUrl}
                placeholder="https://api.tavily.com"
                onChange={(event) =>
                  setRuntimeDraft((value) => ({
                    ...value,
                    tavily: {
                      ...value.tavily,
                      baseUrl: event.target.value,
                    },
                  }))
                }
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs text-slate-500">Topic</span>
                  <select
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    value={runtimeDraft.tavily.topic}
                    onChange={(event) =>
                      setRuntimeDraft((value) => ({
                        ...value,
                        tavily: {
                          ...value.tavily,
                          topic: event.target.value === 'news' ? 'news' : 'general',
                        },
                      }))
                    }
                    disabled={runtimeSaving}
                  >
                    <option value="general">general</option>
                    <option value="news">news</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-slate-500">Max Results</span>
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    value={runtimeDraft.tavily.maxResults}
                    onChange={(event) =>
                      setRuntimeDraft((value) => ({
                        ...value,
                        tavily: {
                          ...value.tavily,
                          maxResults: Number(event.target.value) || 5,
                        },
                      }))
                    }
                  />
                </label>
              </div>
              <Input
                type="password"
                value={runtimeDraft.tavily.apiKey}
                placeholder="Tavily API Key（留空则保留已保存值）"
                onChange={(event) =>
                  setRuntimeDraft((value) => ({
                    ...value,
                    tavily: {
                      ...value.tavily,
                      apiKey: event.target.value,
                    },
                  }))
                }
              />
            </div>

            <div className="rounded-lg border border-slate-200 p-3">
              <label className="flex cursor-pointer items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900">启用分层 Agent（AI_LAYERED_AGENT_ENABLED）</div>
                  <div className="text-xs text-slate-500">
                    开启后使用 Router/Gate -&gt; Small Context -&gt; Evidence Pack -&gt; Planner/Executor 状态机。
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  checked={runtimeDraft.layeredAgentEnabled}
                  disabled={runtimeSaving || runtimeLoading}
                  onChange={(event) =>
                    setRuntimeDraft((value) => ({
                      ...value,
                      layeredAgentEnabled: event.target.checked,
                    }))
                  }
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={runtimeSaving || runtimeLoading} onClick={() => void handleSaveRuntimeConfig()}>
                {runtimeSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                保存运行时配置
              </Button>
            </div>

            {runtimeError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{runtimeError}</div> : null}
            {runtimeNotice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{runtimeNotice}</div> : null}
          </CardContent>
        </Card>
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base text-slate-900">
                <FileText className="h-4 w-4 text-cyan-600" />
                知识文档管理
              </CardTitle>
              <CardDescription>支持上传、编辑、删除，并控制是否纳入 AI 助手检索。</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={uploadInputRef}
                type="file"
                accept=".md,.txt,.json,.yml,.yaml,.csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleUploadKnowledgeFile(file);
                  }
                }}
              />
              <Button variant="outline" size="sm" disabled={documentUploading} onClick={() => uploadInputRef.current?.click()}>
                {documentUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                上传文档
              </Button>
              <Button variant="outline" size="sm" disabled={documentsLoading} onClick={() => void loadDocumentList()}>
                {documentsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                刷新列表
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-900">文档列表（右键可纳入/排除）</span>
                <Badge variant="outline">{documents.length} 项</Badge>
              </div>
              <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
                {documents.map((item) => {
                  const active = item.key === selectedDocumentKey;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`w-full rounded-lg border px-3 py-2 text-left transition ${active ? 'border-blue-300 bg-blue-50/70' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                      onClick={() => setSelectedDocumentKey(item.key)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSelectedDocumentKey(item.key);
                        setDocumentContextMenu({
                          documentKey: item.key,
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-medium text-slate-900">{item.fileName}</div>
                        <Badge variant={item.includeInAssistant ? 'default' : 'outline'} className={item.includeInAssistant ? 'bg-emerald-500 hover:bg-emerald-600' : ''}>
                          {item.includeInAssistant ? '已纳入' : '已排除'}
                        </Badge>
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">{item.relativePath}</div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        {formatFileSize(item.size)} / {formatDateTime(item.updatedAt)}
                      </div>
                    </button>
                  );
                })}
                {documents.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">当前没有可管理知识文档。</div>
                ) : null}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <div className="min-w-0 truncate">
                  {selectedDocument ? selectedDocument.relativePath : '请选择文档'}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={selectedDocument?.includeInAssistant ? 'default' : 'outline'} className={selectedDocument?.includeInAssistant ? 'bg-emerald-500 hover:bg-emerald-600' : ''}>
                    {selectedDocument?.includeInAssistant ? '已纳入助手' : '未纳入助手'}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selectedDocument || documentSaving || documentDetailLoading}
                    onClick={() => void handleToggleDocumentInclusion()}
                  >
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                    {selectedDocument?.includeInAssistant ? '从助手排除' : '纳入助手'}
                  </Button>
                </div>
              </div>

              <textarea
                className="h-[320px] w-full resize-y rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs leading-5 text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                value={documentContent}
                onChange={(event) => setDocumentContent(event.target.value)}
                disabled={!selectedDocument || documentDetailLoading}
                placeholder={documentDetailLoading ? '正在读取文档内容...' : '选择文档后编辑内容'}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!selectedDocument || !hasDocumentChanges || documentSaving || documentDetailLoading} onClick={() => void handleSaveKnowledgeDocument()}>
                  {documentSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  保存文档
                </Button>
                <Button variant="outline" disabled={!selectedDocument || Boolean(documentActionId) || documentSaving || documentDetailLoading} onClick={() => void handleDeleteKnowledgeDocument()}>
                  {documentActionId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                  删除文档
                </Button>
              </div>
            </div>
          </div>

          {documentError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{documentError}</div> : null}
          {documentNotice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{documentNotice}</div> : null}
        </CardContent>
      </Card>
      {documentContextMenu ? (
        <div
          className="fixed z-40 min-w-40 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"
          style={{ left: documentContextMenu.x, top: documentContextMenu.y }}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          {(() => {
            const targetDocument = documents.find((item) => item.key === documentContextMenu.documentKey);
            if (!targetDocument) {
              return null;
            }

            return (
              <>
                <button
                  type="button"
                  className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                  onClick={() => void handleSetDocumentInclusion(targetDocument, true)}
                >
                  纳入助手
                </button>
                <button
                  type="button"
                  className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                  onClick={() => void handleSetDocumentInclusion(targetDocument, false)}
                >
                  从助手排除
                </button>
              </>
            );
          })()}
        </div>
      ) : null}
      {confirmDialog}
    </div>
  );
}
