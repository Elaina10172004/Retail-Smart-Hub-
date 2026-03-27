import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Eye, Filter, LoaderCircle, PackageCheck, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { DocumentPreviewModal } from '@/components/documents/DocumentPreviewModal';
import { useAuth } from '@/auth/AuthContext';
import { buildInboundDocument } from '@/lib/documents';
import { advanceArrival, fetchArrivals } from '@/services/api/arrival';
import { confirmInbound, deleteInbound, fetchInboundDetail, fetchInbounds, saveInboundDraft, updateInboundStatus } from '@/services/api/inbound';
import type { DocumentPreviewRecord } from '@/types/documents';
import type { ArrivalRecord } from '@/types/arrival';
import type { InboundDetailRecord, InboundDetailItem, InboundRecord, SaveInboundDraftPayload, UpdateInboundStatusPayload } from '@/types/inbound';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

const INBOUND_FORCE_STATUS_OPTIONS = ['待入库', '已入库'] as const;
type InboundForceStatus = (typeof INBOUND_FORCE_STATUS_OPTIONS)[number];

interface InboundDraftItemState {
  itemId: string;
  qualifiedQty: string;
  inboundQty: string;
  shelfId: string;
}

function createDraftItems(detail: InboundDetailRecord): InboundDraftItemState[] {
  return detail.itemsDetail.map((item) => ({
    itemId: item.id,
    qualifiedQty: String(item.qualifiedQty),
    inboundQty: String(item.inboundQty),
    shelfId: item.shelfId || item.suggestedShelfId || '',
  }));
}

export function InboundManagement() {
  const { user, hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const canConfirmInbound = hasPermission('procurement.manage');
  const [arrivals, setArrivals] = useState<ArrivalRecord[]>([]);
  const [inbounds, setInbounds] = useState<InboundRecord[]>([]);
  const [selectedInbound, setSelectedInbound] = useState<InboundDetailRecord | null>(null);
  const [draftItems, setDraftItems] = useState<InboundDraftItemState[]>([]);
  const [previewDocuments, setPreviewDocuments] = useState<DocumentPreviewRecord[]>([]);
  const [previewInitialId, setPreviewInitialId] = useState('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [forceStatusDraft, setForceStatusDraft] = useState<{
    inboundId: string;
    rcvId: string;
    supplier: string;
    currentStatus: InboundForceStatus;
    nextStatus: InboundForceStatus;
  } | null>(null);

  const filteredInbounds = useMemo(
    () =>
      inbounds.filter((item) => {
        const keyword = searchTerm.trim().toLowerCase();
        const matchesSearch =
          !keyword ||
          item.id.toLowerCase().includes(keyword) ||
          item.rcvId.toLowerCase().includes(keyword) ||
          item.supplier.toLowerCase().includes(keyword) ||
          item.warehouse.toLowerCase().includes(keyword);
        const matchesStatus = !statusFilter || item.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [inbounds, searchTerm, statusFilter],
  );

  const filteredArrivals = useMemo(
    () =>
      arrivals.filter((item) => {
        const keyword = searchTerm.trim().toLowerCase();
        return (
          !keyword ||
          item.id.toLowerCase().includes(keyword) ||
          item.poId.toLowerCase().includes(keyword) ||
          item.supplier.toLowerCase().includes(keyword)
        );
      }),
    [arrivals, searchTerm],
  );

  const loadInboundHub = async (keepSelectedId?: string) => {
    setIsLoading(true);
    setPageError('');
    try {
      const [inboundResponse, arrivalResponse] = await Promise.all([fetchInbounds(), fetchArrivals()]);
      setInbounds(inboundResponse.data);
      setArrivals(arrivalResponse.data);

      if (keepSelectedId) {
        const detailResponse = await fetchInboundDetail(keepSelectedId);
        setSelectedInbound(detailResponse.data);
        setDraftItems(createDraftItems(detailResponse.data));
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadInboundHub();
  }, []);

  const openPreview = (documents: DocumentPreviewRecord[], activeDocumentId?: string) => {
    if (documents.length === 0) {
      return;
    }
    setPreviewDocuments(documents);
    setPreviewInitialId(activeDocumentId || documents[0]?.id || '');
    setIsPreviewOpen(true);
  };

  const handleOpenInboundWorkspace = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchInboundDetail(id);
      setSelectedInbound(response.data);
      setDraftItems(createDraftItems(response.data));
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const buildDraftPayload = (): SaveInboundDraftPayload | null => {
    if (!selectedInbound) {
      setPageError('请先打开一张入库单。');
      return null;
    }

    const itemMap = new Map(selectedInbound.itemsDetail.map((item) => [item.id, item]));
    const payloadItems = draftItems.map((draftItem) => {
      const sourceItem = itemMap.get(draftItem.itemId);
      if (!sourceItem) {
        throw new Error('入库明细不存在。');
      }

      const qualifiedQty = Number(draftItem.qualifiedQty);
      const inboundQty = Number(draftItem.inboundQty);
      if (!Number.isInteger(qualifiedQty) || qualifiedQty < 0 || qualifiedQty > sourceItem.arrivedQty) {
        throw new Error(`${sourceItem.sku} 的合格数量不合法。`);
      }
      if (!Number.isInteger(inboundQty) || inboundQty < 0 || inboundQty > qualifiedQty) {
        throw new Error(`${sourceItem.sku} 的入库数量不合法。`);
      }
      if (inboundQty > 0 && !draftItem.shelfId) {
        throw new Error(`${sourceItem.sku} 需要选择入库货架。`);
      }

      return {
        itemId: draftItem.itemId,
        qualifiedQty,
        inboundQty,
        shelfId: draftItem.shelfId,
      };
    });

    return { items: payloadItems };
  };

  const buildPreviewDetail = (): InboundDetailRecord | null => {
    if (!selectedInbound) {
      return null;
    }

    const shelfMap = new Map(selectedInbound.shelfOptions.map((item) => [item.id, item]));
    const draftMap = new Map(draftItems.map((item) => [item.itemId, item]));
    const nextItems: InboundDetailItem[] = selectedInbound.itemsDetail.map((item) => {
      const draftItem = draftMap.get(item.id);
      const shelf = draftItem?.shelfId ? shelfMap.get(draftItem.shelfId) : undefined;
      const qualifiedQty = draftItem ? Number(draftItem.qualifiedQty) : item.qualifiedQty;
      const inboundQty = draftItem ? Number(draftItem.inboundQty) : item.inboundQty;
      return {
        ...item,
        qualifiedQty: Number.isFinite(qualifiedQty) ? qualifiedQty : item.qualifiedQty,
        defectQty: Math.max(item.arrivedQty - (Number.isFinite(qualifiedQty) ? qualifiedQty : item.qualifiedQty), 0),
        inboundQty: Number.isFinite(inboundQty) ? inboundQty : item.inboundQty,
        shelfId: draftItem?.shelfId || undefined,
        shelfCode: shelf?.shelfCode || item.shelfCode,
        shelfName: shelf?.shelfName || item.shelfName,
      };
    });

    return {
      ...selectedInbound,
      items: nextItems.reduce((sum, item) => sum + item.inboundQty, 0),
      itemsDetail: nextItems,
    };
  };

  const handlePreviewInboundDocument = async (id?: string) => {
    setPageError('');
    try {
      if (id) {
        const response = await fetchInboundDetail(id);
        openPreview([buildInboundDocument(response.data)], response.data.id);
        return;
      }

      const previewDetail = buildPreviewDetail();
      if (!previewDetail) {
        setPageError('请先打开一张入库单。');
        return;
      }
      openPreview([buildInboundDocument(previewDetail)], previewDetail.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  };

  const handleSaveInboundDraft = async () => {
    if (!selectedInbound) {
      setPageError('请先打开一张入库单。');
      return;
    }
    if (!canConfirmInbound) {
      setPageError('当前角色没有入库确认权限。');
      return;
    }

    setPageError('');
    setActionMessage('');
    setIsSavingDraft(true);
    try {
      const payload = buildDraftPayload();
      if (!payload) {
        return;
      }
      const response = await saveInboundDraft(selectedInbound.id, payload);
      setSelectedInbound(response.data);
      setDraftItems(createDraftItems(response.data));
      setActionMessage(`入库单 ${response.data.id} 草稿已保存。`);
      await loadInboundHub(response.data.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleConfirmInboundOrder = async () => {
    if (!selectedInbound) {
      setPageError('请先打开一张入库单。');
      return;
    }
    if (!canConfirmInbound) {
      setPageError('当前角色没有入库确认权限。');
      return;
    }
    if (!(await confirm(`确认入库单 ${selectedInbound.id} 吗？系统将按明细货架写入库存。`))) {
      return;
    }

    setActiveId(selectedInbound.id);
    setPageError('');
    setActionMessage('');
    try {
      const payload = buildDraftPayload();
      if (!payload) {
        return;
      }
      const response = await confirmInbound(selectedInbound.id, payload);
      const detailResponse = await fetchInboundDetail(selectedInbound.id);
      setSelectedInbound(detailResponse.data);
      setDraftItems(createDraftItems(detailResponse.data));
      openPreview([buildInboundDocument(detailResponse.data)], detailResponse.data.id);
      setActionMessage(response.message || '入库已确认。');
      await loadInboundHub(selectedInbound.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleAdvanceArrival = async (arrival: ArrivalRecord) => {
    if (!canConfirmInbound) {
      setPageError('当前角色没有到货推进权限。');
      return;
    }
    if (!(await confirm(`确认推进到货单 ${arrival.id} 的状态？`))) {
      return;
    }

    setActiveId(arrival.id);
    setPageError('');
    setActionMessage('');
    try {
      const response = await advanceArrival(arrival.id);
      setActionMessage(response.message || `到货单 ${arrival.id} 状态已推进。`);
      await loadInboundHub(selectedInbound?.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleForceInboundStatus = async (inbound: InboundRecord) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可强制修改入库单状态。');
      return;
    }

    const normalizedStatus: InboundForceStatus = inbound.status === '已入库' ? '已入库' : '待入库';
    setForceStatusDraft({
      inboundId: inbound.id,
      rcvId: inbound.rcvId,
      supplier: inbound.supplier,
      currentStatus: normalizedStatus,
      nextStatus: normalizedStatus,
    });
  };

  const handleSubmitForceInboundStatus = async () => {
    if (!forceStatusDraft) {
      return;
    }

    if (!(await confirm(`确认将入库单 ${forceStatusDraft.inboundId} 状态改为 ${forceStatusDraft.nextStatus}？`))) {
      return;
    }

    setActiveId(forceStatusDraft.inboundId);
    setPageError('');
    setActionMessage('');
    try {
      const response = await updateInboundStatus(forceStatusDraft.inboundId, { status: forceStatusDraft.nextStatus } as UpdateInboundStatusPayload);
      setActionMessage(response.message || `入库单 ${forceStatusDraft.inboundId} 状态已更新。`);
      setForceStatusDraft(null);
      await loadInboundHub(selectedInbound?.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleDeleteInbound = async (inbound: InboundRecord) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可删除入库单。');
      return;
    }
    if (!(await confirm(`确认删除入库单 ${inbound.id}？若已入库将自动回滚库存后删除。`))) {
      return;
    }

    setActiveId(inbound.id);
    setPageError('');
    setActionMessage('');
    try {
      const response = await deleteInbound(inbound.id, { aggressive: true });
      setActionMessage(response.message || `入库单 ${inbound.id} 已删除。`);
      if (selectedInbound?.id === inbound.id) {
        setSelectedInbound(null);
        setDraftItems([]);
      }
      await loadInboundHub();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const updateDraftItem = (itemId: string, key: keyof InboundDraftItemState, value: string) => {
    setDraftItems((current) =>
      current.map((item) => (item.itemId === itemId ? { ...item, [key]: value } : item)),
    );
  };

  const totalDraftQualified = draftItems.reduce((sum, item) => sum + (Number(item.qualifiedQty) || 0), 0);
  const totalDraftInbound = draftItems.reduce((sum, item) => sum + (Number(item.inboundQty) || 0), 0);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">到货与入库</h2>
          <p className="mt-1 text-sm text-gray-500">点击单据进入入库工作区，逐行填写合格数量、入库数量和货架后再确认入库。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadInboundHub(selectedInbound?.id)} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            刷新列表
          </Button>
        </div>
      </div>

      {pageError ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">入库数据处理失败：{pageError}</div> : null}
      {actionMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div> : null}

      {selectedInbound || isDetailLoading ? (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
            <CardTitle className="flex items-center justify-between gap-3 text-lg font-semibold text-gray-800">
              <span>入库单据工作区</span>
              <Button variant="ghost" size="sm" onClick={() => { setSelectedInbound(null); setDraftItems([]); }}>关闭</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载入库单详情...</div> : null}

            {selectedInbound ? (
              <div className="space-y-6">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-gray-500">Inbound Workspace</div>
                    <div className="mt-2 text-xl font-semibold text-gray-900">{selectedInbound.id}</div>
                    <div className="mt-1 text-sm text-gray-500">
                      收货单 {selectedInbound.rcvId} · 采购单 {selectedInbound.poId} · {selectedInbound.supplier}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => void handlePreviewInboundDocument()}>
                      <Eye className="mr-2 h-4 w-4" /> 预览入库单
                    </Button>
                    <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => void handleSaveInboundDraft()} disabled={isSavingDraft || !canConfirmInbound}>
                      {isSavingDraft ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} 保存草稿
                    </Button>
                    <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleConfirmInboundOrder()} disabled={!canConfirmInbound || activeId === selectedInbound.id || selectedInbound.status === '已入库'}>
                      {activeId === selectedInbound.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-2 h-4 w-4" />} 确认入库
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">入库状态</div><div className="mt-2"><Badge variant={selectedInbound.status === '已入库' ? 'success' : 'warning'}>{selectedInbound.status}</Badge></div><div className="mt-2 text-xs text-gray-500">仓库 {selectedInbound.warehouse}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">商品行数</div><div className="mt-1 text-lg font-semibold text-gray-900">{selectedInbound.itemsDetail.length}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">合格总数</div><div className="mt-1 text-lg font-semibold text-gray-900">{totalDraftQualified}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">入库总数</div><div className="mt-1 text-lg font-semibold text-blue-600">{totalDraftInbound}</div></div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50/80">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">SKU / 商品</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-900">应到</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-900">实到</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-900">合格数量</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-900">入库数量</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">入库货架</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">推荐货架</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {selectedInbound.itemsDetail.map((item) => {
                        const draftItem = draftItems.find((draft) => draft.itemId === item.id);
                        const selectedShelf = selectedInbound.shelfOptions.find((shelf) => shelf.id === draftItem?.shelfId);
                        return (
                          <tr key={item.id}>
                            <td className="px-4 py-4 align-top">
                              <div className="font-medium text-gray-900">{item.sku}</div>
                              <div className="mt-1 text-xs text-gray-500">{item.productName}</div>
                            </td>
                            <td className="px-4 py-4 text-right text-gray-600">{item.expectedQty}</td>
                            <td className="px-4 py-4 text-right text-gray-900">{item.arrivedQty}</td>
                            <td className="px-4 py-4">
                              <Input type="number" min="0" max={item.arrivedQty} value={draftItem?.qualifiedQty || '0'} onChange={(event) => updateDraftItem(item.id, 'qualifiedQty', event.target.value)} className="w-24 text-right" />
                            </td>
                            <td className="px-4 py-4">
                              <Input type="number" min="0" max={draftItem?.qualifiedQty || item.arrivedQty} value={draftItem?.inboundQty || '0'} onChange={(event) => updateDraftItem(item.id, 'inboundQty', event.target.value)} className="w-24 text-right" />
                            </td>
                            <td className="px-4 py-4">
                              <select className="h-10 min-w-64 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={draftItem?.shelfId || ''} onChange={(event) => updateDraftItem(item.id, 'shelfId', event.target.value)}>
                                <option value="">选择货架</option>
                                {selectedInbound.shelfOptions.map((shelf) => (
                                  <option key={shelf.id} value={shelf.id}>
                                    {shelf.shelfCode} · 剩余 {shelf.remainingCapacity} · {shelf.tags.join('/')}
                                  </option>
                                ))}
                              </select>
                              <div className="mt-1 text-xs text-gray-500">
                                {selectedShelf ? `${selectedShelf.shelfName}，容量 ${selectedShelf.usedQuantity}/${selectedShelf.capacity}` : '未选择货架'}
                              </div>
                            </td>
                            <td className="px-4 py-4 align-top">
                              <div className="flex items-center gap-2 text-sm text-gray-900">
                                <Sparkles className="h-4 w-4 text-amber-500" />
                                {item.suggestedShelfCode || '暂无推荐'}
                              </div>
                              <div className="mt-1 text-xs text-gray-500">系统会结合货架标签与当前商品分布推荐库位。</div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-4 xl:grid-cols-3">
                  {selectedInbound.shelfOptions.map((shelf) => (
                    <div key={shelf.id} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{shelf.shelfCode}</div>
                          <div className="mt-1 text-xs text-gray-500">{shelf.shelfName}</div>
                        </div>
                        <Badge variant={shelf.remainingCapacity === 0 ? 'destructive' : shelf.remainingCapacity / Math.max(shelf.capacity, 1) < 0.2 ? 'warning' : 'outline'}>
                          剩余 {shelf.remainingCapacity}
                        </Badge>
                      </div>
                      <div className="mt-3 text-xs text-gray-500">标签：{shelf.tags.join(' / ') || '未设置'}</div>
                      <div className="mt-1 text-xs text-gray-500">容量：{shelf.usedQuantity} / {shelf.capacity}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {forceStatusDraft ? (
        <Card className="border-amber-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-amber-100 bg-amber-50/60 pb-3">
            <CardTitle className="text-lg font-semibold text-amber-900">管理员状态修正</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="text-sm text-amber-900">
              入库单 {forceStatusDraft.inboundId} · 收货单 {forceStatusDraft.rcvId} · {forceStatusDraft.supplier}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-600">当前状态</span>
              <Badge variant={forceStatusDraft.currentStatus === '已入库' ? 'success' : 'warning'}>{forceStatusDraft.currentStatus}</Badge>
              <ArrowRight className="h-4 w-4 text-gray-400" />
              <select className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={forceStatusDraft.nextStatus} onChange={(event) => setForceStatusDraft((current) => current ? { ...current, nextStatus: event.target.value as InboundForceStatus } : current)}>
                {INBOUND_FORCE_STATUS_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmitForceInboundStatus()} disabled={activeId === forceStatusDraft.inboundId}>
                {activeId === forceStatusDraft.inboundId ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                保存状态
              </Button>
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => setForceStatusDraft(null)}>取消</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <CardTitle className="text-lg font-semibold text-gray-800">到货验收列表</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">到货单号</TableHead><TableHead className="font-semibold text-gray-900">采购单号</TableHead><TableHead className="font-semibold text-gray-900">供应商</TableHead><TableHead className="font-semibold text-gray-900 text-right">实到/应到</TableHead><TableHead className="font-semibold text-gray-900 text-center">状态</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={6} className="h-20 text-center text-sm text-gray-500">正在加载到货数据...</TableCell></TableRow> : null}
              {!isLoading && filteredArrivals.length === 0 ? <TableRow><TableCell colSpan={6} className="h-20 text-center text-sm text-gray-500">当前筛选条件下没有到货记录。</TableCell></TableRow> : null}
              {!isLoading && filteredArrivals.map((arrival) => (
                <TableRow key={arrival.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{arrival.id}</TableCell>
                  <TableCell className="text-gray-500">{arrival.poId}</TableCell>
                  <TableCell className="text-gray-900">{arrival.supplier}</TableCell>
                  <TableCell className="text-right text-gray-700">{arrival.arrivedQty} / {arrival.expectedQty}</TableCell>
                  <TableCell className="text-center"><Badge variant={arrival.status === '待验收' ? 'warning' : arrival.status === '部分到货' ? 'secondary' : 'default'}>{arrival.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <RowActionMenu
                      items={[
                        { id: 'arrival-filter', label: '按同供应商筛选', icon: Filter, onSelect: () => setSearchTerm(arrival.supplier) },
                        { id: 'arrival-advance', label: '推进到货状态', icon: ArrowRight, onSelect: () => void handleAdvanceArrival(arrival), disabled: !(arrival.status === '待验收' || arrival.status === '部分到货') || activeId === arrival.id || !canConfirmInbound },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72"><Input placeholder="搜索入库单号、收货单号、供应商、库位..." className="bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">所有状态</option><option value="待入库">待入库</option><option value="已入库">已入库</option></select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">入库单号</TableHead><TableHead className="font-semibold text-gray-900">收货单号</TableHead><TableHead className="font-semibold text-gray-900">供应商</TableHead><TableHead className="font-semibold text-gray-900 text-right">入库数量</TableHead><TableHead className="font-semibold text-gray-900">仓库</TableHead><TableHead className="font-semibold text-gray-900 text-center">状态</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">正在加载入库数据...</TableCell></TableRow> : null}
              {!isLoading && filteredInbounds.length === 0 ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有入库记录。</TableCell></TableRow> : null}
              {!isLoading && filteredInbounds.map((inbound) => (
                <TableRow key={inbound.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{inbound.id}</TableCell>
                  <TableCell className="text-gray-500">{inbound.rcvId}</TableCell>
                  <TableCell className="text-gray-900">{inbound.supplier}</TableCell>
                  <TableCell className="text-right text-gray-900">{inbound.items}</TableCell>
                  <TableCell className="text-gray-500">{inbound.warehouse}</TableCell>
                  <TableCell className="text-center"><Badge variant={inbound.status === '已入库' ? 'success' : 'warning'}>{inbound.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-blue-50 hover:text-blue-600" onClick={() => void handleOpenInboundWorkspace(inbound.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'inbound-open', label: '进入单据页', icon: Eye, onSelect: () => void handleOpenInboundWorkspace(inbound.id) },
                          { id: 'inbound-preview', label: '打印入库单', icon: PackageCheck, onSelect: () => void handlePreviewInboundDocument(inbound.id) },
                          { id: 'inbound-force-status', label: '强制修改状态', icon: Sparkles, onSelect: () => void handleForceInboundStatus(inbound), disabled: !isSuperAdmin },
                          { id: 'inbound-delete', label: '删除入库单', icon: Trash2, onSelect: () => void handleDeleteInbound(inbound), disabled: !isSuperAdmin || activeId === inbound.id, tone: 'danger' },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <DocumentPreviewModal documents={previewDocuments} isOpen={isPreviewOpen} initialActiveId={previewInitialId} onClose={() => setIsPreviewOpen(false)} />
      {confirmDialog}
    </div>
  );
}
