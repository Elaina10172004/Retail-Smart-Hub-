import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { Archive, ArrowRight, CheckCircle2, Eye, Filter, LoaderCircle, PackageCheck, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react';
import { advanceArrival, fetchArrivals } from '@/services/api/arrival';
import { confirmInbound, deleteInbound, fetchInboundDetail, fetchInbounds, updateInboundStatus } from '@/services/api/inbound';
import type { ArrivalRecord } from '@/types/arrival';
import type { InboundDetailRecord, InboundRecord, UpdateInboundStatusPayload } from '@/types/inbound';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

const INBOUND_FORCE_STATUS_OPTIONS = ['待入库', '已入库'] as const;
type InboundForceStatus = (typeof INBOUND_FORCE_STATUS_OPTIONS)[number];

export function InboundManagement() {
  const { user, hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const canConfirmInbound = hasPermission('procurement.manage');
  const [arrivals, setArrivals] = useState<ArrivalRecord[]>([]);
  const [inbounds, setInbounds] = useState<InboundRecord[]>([]);
  const [selectedInbound, setSelectedInbound] = useState<InboundDetailRecord | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [activeId, setActiveId] = useState('');
  const [isBatchRunning, setIsBatchRunning] = useState(false);
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
        const matchesSearch =
          !searchTerm ||
          item.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.rcvId.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.supplier.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.warehouse.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = !statusFilter || item.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [inbounds, searchTerm, statusFilter],
  );
  const filteredArrivals = useMemo(
    () =>
      arrivals.filter((item) => {
        const matchesSearch =
          !searchTerm ||
          item.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.poId.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.supplier.toLowerCase().includes(searchTerm.toLowerCase());
        return matchesSearch;
      }),
    [arrivals, searchTerm],
  );

  const pendingInbounds = useMemo(() => filteredInbounds.filter((item) => item.status === '待入库'), [filteredInbounds]);

  const loadInboundHub = async () => {
    setIsLoading(true);
    setPageError('');
    try {
      const [inboundResponse, arrivalResponse] = await Promise.all([fetchInbounds(), fetchArrivals()]);
      setInbounds(inboundResponse.data);
      setArrivals(arrivalResponse.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadInboundHub();
  }, []);

  const handleViewDetail = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchInboundDetail(id);
      setSelectedInbound(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleConfirm = async (id: string) => {
    if (!canConfirmInbound) {
      setPageError('当前角色没有入库确认权限。');
      return;
    }
    if (!(await confirm('确认入库并同步增加库存？'))) return;

    setActiveId(id);
    setActionMessage('');
    setPageError('');
    try {
      const response = await confirmInbound(id);
      setActionMessage(response.message || '入库已确认。');
      if (selectedInbound?.id === id) {
        await handleViewDetail(id);
      }
      await loadInboundHub();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleBatchConfirm = async () => {
    if (!canConfirmInbound) {
      setPageError('当前角色没有入库确认权限。');
      return;
    }
    if (pendingInbounds.length === 0) {
      setPageError('当前没有可批量入库的记录。');
      return;
    }
    if (!(await confirm(`确认批量入库当前筛选结果中的 ${pendingInbounds.length} 条记录吗？`))) return;

    setIsBatchRunning(true);
    setPageError('');
    setActionMessage('');
    try {
      for (const inbound of pendingInbounds) {
        await confirmInbound(inbound.id);
      }
      setActionMessage(`已完成 ${pendingInbounds.length} 条入库单的批量入库。`);
      await loadInboundHub();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsBatchRunning(false);
    }
  };

  const handleFilterWarehouse = (warehouse: string) => {
    setSearchTerm(warehouse);
    setActionMessage(`已按库位 ${warehouse} 筛选入库列表。`);
  };

  const handleFilterStatus = (status: string) => {
    setStatusFilter(status);
    setActionMessage(`已按状态 ${status} 筛选入库列表。`);
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
      await loadInboundHub();
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

    const nextStatus = forceStatusDraft.nextStatus;
    if (!(await confirm(`确认将入库单 ${forceStatusDraft.inboundId} 状态改为 ${nextStatus}？`))) {
      return;
    }

    setActiveId(forceStatusDraft.inboundId);
    setPageError('');
    setActionMessage('');
    try {
      const response = await updateInboundStatus(forceStatusDraft.inboundId, { status: nextStatus } as UpdateInboundStatusPayload);
      setActionMessage(response.message || `入库单 ${forceStatusDraft.inboundId} 状态已更新。`);
      if (selectedInbound?.id === forceStatusDraft.inboundId) {
        await handleViewDetail(forceStatusDraft.inboundId);
      }
      setForceStatusDraft(null);
      await loadInboundHub();
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
    if (
      !(await confirm(
        `确认删除入库单 ${inbound.id}？\n若已入库将自动回滚库存后删除。`,
      ))
    ) {
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
      }
      await loadInboundHub();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">到货与入库</h2>
          <p className="text-sm text-gray-500 mt-1">到货推进与入库确认已合并在同一页面，支持一体化处理。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadInboundHub()} disabled={isLoading}><RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新列表</Button>
          <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleBatchConfirm()} disabled={isBatchRunning || pendingInbounds.length === 0 || !canConfirmInbound} title={!canConfirmInbound ? '当前角色没有入库确认权限' : undefined}>
            {isBatchRunning ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Archive className="mr-2 h-4 w-4" />} 批量入库
          </Button>
        </div>
      </div>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <CardTitle className="text-lg font-semibold text-gray-800">到货验收列表</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">到货单号</TableHead><TableHead className="font-semibold text-gray-900">采购单号</TableHead><TableHead className="font-semibold text-gray-900">供应商</TableHead><TableHead className="font-semibold text-gray-900 text-right">实到/应到</TableHead><TableHead className="font-semibold text-gray-900 text-center">状态</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={6} className="h-20 text-center text-sm text-gray-500">正在加载到货数据...</TableCell></TableRow>}
              {!isLoading && filteredArrivals.length === 0 && <TableRow><TableCell colSpan={6} className="h-20 text-center text-sm text-gray-500">当前筛选条件下没有到货记录。</TableCell></TableRow>}
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
                        { id: 'arrival-filter-supplier', label: '按同供应商筛选', icon: Filter, onSelect: () => setSearchTerm(arrival.supplier) },
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

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">入库数据处理失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      {(selectedInbound || isDetailLoading) && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <CardTitle className="text-lg font-semibold text-gray-800 flex items-center justify-between gap-3">
              <span>入库详情</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedInbound(null)}>关闭</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载入库详情...</div> : null}
            {selectedInbound ? (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">入库单 / 收货单</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedInbound.id}</div><div className="mt-1 text-xs text-gray-500">{selectedInbound.rcvId}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">供应商 / 采购单</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedInbound.supplier}</div><div className="mt-1 text-xs text-gray-500">{selectedInbound.poId}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">库位与件数</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedInbound.warehouse}</div><div className="mt-1 text-xs text-gray-500">共 {selectedInbound.items} 件</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">状态</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedInbound.status}</div><div className="mt-1 text-xs text-gray-500">完成时间：{selectedInbound.completedAt || '-'}</div></div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">入库明细</h3>
                  {selectedInbound.itemsDetail.map((item) => (
                    <div key={`${selectedInbound.id}-${item.sku}`} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{item.productName}</div>
                          <div className="mt-1 text-xs text-gray-500">{item.sku}</div>
                        </div>
                        <div className="text-right text-sm font-medium text-gray-900">入库 {item.qualifiedQty}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-center py-6 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center"><div className="h-12 w-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 border-2 border-gray-200"><PackageCheck className="h-6 w-6" /></div><span className="text-sm font-medium mt-2 text-gray-500">1. 确认到货</span></div>
          <div className="h-1 w-16 bg-gray-100 rounded"></div>
          <div className="flex flex-col items-center"><div className="h-12 w-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 border-2 border-gray-200"><CheckCircle2 className="h-6 w-6" /></div><span className="text-sm font-medium mt-2 text-gray-500">2. 质量验收</span></div>
          <div className="h-1 w-16 bg-blue-100 rounded"></div>
          <div className="flex flex-col items-center"><div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 border-2 border-blue-200"><ArrowRight className="h-6 w-6" /></div><span className="text-sm font-medium mt-2 text-blue-900">3. 验收入库</span></div>
        </div>
      </div>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" /><Input placeholder="搜索入库单号、收货单号、供应商、库位..." className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">所有状态</option><option value="待入库">待入库</option><option value="已入库">已入库</option></select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">入库单号</TableHead><TableHead className="font-semibold text-gray-900">关联收货单</TableHead><TableHead className="font-semibold text-gray-900">供应商</TableHead><TableHead className="font-semibold text-gray-900 text-right">入库数量</TableHead><TableHead className="font-semibold text-gray-900">推荐库位</TableHead><TableHead className="font-semibold text-gray-900 text-center">状态</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">正在加载入库数据...</TableCell></TableRow>}
              {!isLoading && filteredInbounds.length === 0 && <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有入库记录。</TableCell></TableRow>}
              {!isLoading && filteredInbounds.map((inbound) => (
                <TableRow key={inbound.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{inbound.id}</TableCell>
                  <TableCell className="text-gray-500">{inbound.rcvId}</TableCell>
                  <TableCell className="text-gray-900">{inbound.supplier}</TableCell>
                  <TableCell className="text-right font-medium text-gray-900">{inbound.items}</TableCell>
                  <TableCell className="text-gray-600">{inbound.warehouse}</TableCell>
                  <TableCell className="text-center"><Badge variant={inbound.status === '待入库' ? 'warning' : 'success'}>{inbound.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewDetail(inbound.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'detail', label: '查看详情', icon: Eye, onSelect: () => void handleViewDetail(inbound.id) },
                          { id: 'filter-warehouse', label: '按库位筛选', icon: Filter, onSelect: () => handleFilterWarehouse(inbound.warehouse) },
                          { id: 'filter-status', label: '按同状态筛选', icon: Filter, onSelect: () => handleFilterStatus(inbound.status) },
                          { id: 'confirm', label: '确认入库', icon: Archive, onSelect: () => void handleConfirm(inbound.id), disabled: inbound.status !== '待入库' || activeId === inbound.id || !canConfirmInbound },
                          { id: 'force-status', label: '强制改状态', icon: Sparkles, onSelect: () => void handleForceInboundStatus(inbound), disabled: !isSuperAdmin || activeId === inbound.id },
                          { id: 'delete-inbound', label: '删除入库单', icon: Trash2, onSelect: () => void handleDeleteInbound(inbound), disabled: !isSuperAdmin || activeId === inbound.id, tone: 'danger' },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/30 rounded-b-xl"><div className="text-sm text-gray-500">当前显示 {filteredInbounds.length} 条入库记录，待入库 {pendingInbounds.length} 条</div>{isLoading && <LoaderCircle className="h-4 w-4 animate-spin text-gray-400" />}</div>
        </CardContent>
      </Card>
      {forceStatusDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-[1px]">
          <Card className="w-full max-w-md border-slate-200 shadow-xl">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="text-base text-slate-900">强制改状态</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4 text-sm text-slate-700">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                入库单：{forceStatusDraft.inboundId} / 收货单：{forceStatusDraft.rcvId}
              </div>
              <div className="text-xs text-slate-500">供应商：{forceStatusDraft.supplier}</div>
              <div className="space-y-2">
                <div className="text-xs text-slate-500">当前状态：{forceStatusDraft.currentStatus}</div>
                <select
                  value={forceStatusDraft.nextStatus}
                  onChange={(event) => {
                    const value = event.target.value as InboundForceStatus;
                    setForceStatusDraft((current) => (current ? { ...current, nextStatus: value } : current));
                  }}
                  className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {INBOUND_FORCE_STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setForceStatusDraft(null)}>
                  取消
                </Button>
                <Button onClick={() => void handleSubmitForceInboundStatus()} disabled={activeId === forceStatusDraft.inboundId}>
                  {activeId === forceStatusDraft.inboundId ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                  确认修改
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
      {confirmDialog}
    </div>
  );
}
