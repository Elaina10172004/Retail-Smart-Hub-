import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { formatCurrency } from '@/lib/format';
import { Bot, Eye, Filter, LoaderCircle, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react';
import {
  deleteProcurementOrder,
  fetchProcurementOrderDetail,
  fetchProcurementOrders,
  fetchProcurementSuggestions,
  generateSuggestedPurchaseOrders,
  updateProcurementStatus,
} from '@/services/api/procurement';
import type { ProcurementOrder, ProcurementOrderDetail, ProcurementSuggestionSummary } from '@/types/procurement';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function badgeVariant(status: string) {
  if (status === '待审核') {
    return 'warning';
  }

  if (status === '采购中') {
    return 'default';
  }

  if (status === '部分到货') {
    return 'secondary';
  }

  return 'success';
}

const PROCUREMENT_FORCE_STATUS_OPTIONS = ['待审核', '采购中', '部分到货', '已完成', '已取消'] as const;
type ProcurementForceStatus = (typeof PROCUREMENT_FORCE_STATUS_OPTIONS)[number];

export function ProcurementManagement() {
  const { user, hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const canManageProcurement = hasPermission('procurement.manage');
  const [orders, setOrders] = useState<ProcurementOrder[]>([]);
  const [suggestion, setSuggestion] = useState<ProcurementSuggestionSummary | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<ProcurementOrderDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [forceStatusDraft, setForceStatusDraft] = useState<{
    orderId: string;
    supplier: string;
    currentStatus: string;
    nextStatus: ProcurementForceStatus;
  } | null>(null);

  const filteredOrders = useMemo(() => {
    return orders.filter((item) => {
      const matchesSearch = !searchTerm || item.id.toLowerCase().includes(searchTerm.toLowerCase()) || item.supplier.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = !statusFilter || item.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [orders, searchTerm, statusFilter]);

  const loadProcurement = async () => {
    setIsLoading(true);
    setPageError('');

    try {
      const [ordersResponse, suggestionResponse] = await Promise.all([
        fetchProcurementOrders(),
        fetchProcurementSuggestions(),
      ]);
      setOrders(ordersResponse.data);
      setSuggestion(suggestionResponse.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadProcurement();
  }, []);

  const handleGenerateOrders = async () => {
    if (!canManageProcurement) {
      setPageError('当前角色没有采购写入权限。');
      return;
    }

    if (!(await confirm('确认按当前低库存建议自动生成采购单？'))) {
      return;
    }

    setIsGenerating(true);
    setActionMessage('');
    setPageError('');

    try {
      const response = await generateSuggestedPurchaseOrders();
      setActionMessage(response.message || '建议采购单已生成。');
      await loadProcurement();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleViewDetail = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');

    try {
      const response = await fetchProcurementOrderDetail(id);
      setSelectedOrder(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleFilterSupplier = (supplier: string) => {
    setSearchTerm(supplier);
    setActionMessage(`已按供应商 ${supplier} 筛选采购列表。`);
  };

  const handleFilterStatus = (status: string) => {
    setStatusFilter(status);
    setActionMessage(`已按状态 ${status} 筛选采购列表。`);
  };

  const handleForceUpdateStatus = async (order: ProcurementOrder) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可强制修改采购单状态。');
      return;
    }

    const normalizedStatus = PROCUREMENT_FORCE_STATUS_OPTIONS.includes(order.status as ProcurementForceStatus)
      ? (order.status as ProcurementForceStatus)
      : '待审核';

    setForceStatusDraft({
      orderId: order.id,
      supplier: order.supplier,
      currentStatus: order.status,
      nextStatus: normalizedStatus,
    });
  };

  const handleSubmitForceStatus = async () => {
    if (!forceStatusDraft) {
      return;
    }

    const nextStatus = forceStatusDraft.nextStatus;
    if (!(await confirm(`确认将采购单 ${forceStatusDraft.orderId} 状态改为 ${nextStatus}？`))) {
      return;
    }

    setIsGenerating(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await updateProcurementStatus(forceStatusDraft.orderId, { status: nextStatus });
      setActionMessage(response.message || `采购单 ${forceStatusDraft.orderId} 状态已更新。`);
      if (selectedOrder?.id === forceStatusDraft.orderId) {
        await handleViewDetail(forceStatusDraft.orderId);
      }
      setForceStatusDraft(null);
      await loadProcurement();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDeleteOrder = async (order: ProcurementOrder) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可删除采购单。');
      return;
    }

    if (
      !(await confirm(
        `确认删除采购单 ${order.id}？\n将级联清理关联入库与应付并回滚库存。`,
      ))
    ) {
      return;
    }

    setIsGenerating(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteProcurementOrder(order.id, { aggressive: true });
      setActionMessage(response.message || `采购单 ${order.id} 已删除。`);
      if (selectedOrder?.id === order.id) {
        setSelectedOrder(null);
      }
      await loadProcurement();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">采购管理</h2>
          <p className="text-sm text-gray-500 mt-1">采购列表和低库存自动补货建议已接入真实后端数据。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadProcurement()} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新列表
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleGenerateOrders()} disabled={isGenerating || !canManageProcurement} title={!canManageProcurement ? '当前角色没有采购写入权限' : undefined}>
            {isGenerating ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
            生成建议采购单
          </Button>
        </div>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">采购数据处理失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      {(selectedOrder || isDetailLoading) && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <CardTitle className="text-lg font-semibold text-gray-800 flex items-center justify-between gap-3">
              <span>采购单详情</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedOrder(null)}>
                关闭
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载采购单详情...</div> : null}
            {selectedOrder ? (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">供应商</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedOrder.supplier}</div>
                    <div className="mt-1 text-xs text-gray-500">{selectedOrder.id}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">采购状态</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedOrder.status}</div>
                    <div className="mt-1 text-xs text-gray-500">来源：{selectedOrder.source}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">金额与件数</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedOrder.amount}</div>
                    <div className="mt-1 text-xs text-gray-500">共 {selectedOrder.itemCount} 件</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">时间</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedOrder.expectedDate}</div>
                    <div className="mt-1 text-xs text-gray-500">创建：{selectedOrder.createDate}</div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">采购明细</h3>
                  {selectedOrder.items.map((item) => (
                    <div key={item.id} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{item.productName}</div>
                          <div className="mt-1 text-xs text-gray-500">{item.sku}</div>
                        </div>
                        <div className="text-right text-sm text-gray-700">
                          <div>订购 {item.orderedQty} / 到货 {item.arrivedQty}</div>
                          <div className="mt-1 font-semibold text-gray-900">{formatCurrency(item.lineAmount)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {selectedOrder.remark ? (
                    <div className="rounded-lg border border-gray-200 p-4 text-sm text-gray-700">
                      <div className="mb-2 font-semibold text-gray-900">备注</div>
                      {selectedOrder.remark}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card className="border-blue-200 shadow-sm bg-gradient-to-r from-blue-50 to-indigo-50/50">
        <CardContent className="p-4 flex items-center justify-between gap-4 flex-col md:flex-row">
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <h3 className="font-semibold text-blue-900 flex items-center">智能采购建议 <Sparkles className="h-4 w-4 ml-1 text-blue-500" /></h3>
              <p className="text-sm text-blue-700/80 mt-1">{suggestion?.message || '正在计算补货建议...'}</p>
            </div>
          </div>
          <div className="text-sm text-blue-900 font-medium">低库存商品 {suggestion?.lowStockItemCount ?? 0} 个 / 推荐采购单 {suggestion?.recommendedOrderCount ?? 0} 张</div>
        </CardContent>
      </Card>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                <Input placeholder="搜索采购单号、供应商..." className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
              </div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">所有状态</option>
                <option value="待审核">待审核</option>
                <option value="采购中">采购中</option>
                <option value="部分到货">部分到货</option>
                <option value="已完成">已完成</option>
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50/50 hover:bg-gray-50/50">
                <TableHead className="font-semibold text-gray-900">采购单号</TableHead>
                <TableHead className="font-semibold text-gray-900">供应商</TableHead>
                <TableHead className="font-semibold text-gray-900">创建日期</TableHead>
                <TableHead className="font-semibold text-gray-900">预计到货日期</TableHead>
                <TableHead className="font-semibold text-gray-900">来源</TableHead>
                <TableHead className="font-semibold text-gray-900">金额</TableHead>
                <TableHead className="font-semibold text-gray-900">状态</TableHead>
                <TableHead className="text-right font-semibold text-gray-900">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载采购单列表...</TableCell>
                </TableRow>
              )}
              {!isLoading && filteredOrders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有采购单记录。</TableCell>
                </TableRow>
              )}
              {!isLoading &&
                filteredOrders.map((po) => (
                  <TableRow key={po.id} className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-blue-600">{po.id}</TableCell>
                    <TableCell className="text-gray-900">{po.supplier}</TableCell>
                    <TableCell className="text-gray-500">{po.createDate}</TableCell>
                    <TableCell className="text-gray-500">{po.expectedDate}</TableCell>
                    <TableCell className="text-gray-500">{po.source}</TableCell>
                    <TableCell className="font-semibold text-gray-900">{po.amount}</TableCell>
                    <TableCell><Badge variant={badgeVariant(po.status)}>{po.status}</Badge></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewDetail(po.id)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <RowActionMenu
                          items={[
                            {
                              id: 'view-detail',
                              label: '查看详情',
                              icon: Eye,
                              onSelect: () => void handleViewDetail(po.id),
                            },
                            {
                              id: 'filter-supplier',
                              label: '按同供应商筛选',
                              icon: Filter,
                              onSelect: () => handleFilterSupplier(po.supplier),
                            },
                            {
                              id: 'filter-status',
                              label: '按同状态筛选',
                              icon: Filter,
                              onSelect: () => handleFilterStatus(po.status),
                            },
                            {
                              id: 'force-status',
                              label: '强制改状态',
                              icon: Sparkles,
                              onSelect: () => void handleForceUpdateStatus(po),
                              disabled: !isSuperAdmin,
                            },
                            {
                              id: 'delete-po',
                              label: '删除采购单',
                              icon: Trash2,
                              onSelect: () => void handleDeleteOrder(po),
                              disabled: !isSuperAdmin,
                              tone: 'danger',
                            },
                          ]}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/30 rounded-b-xl">
            <div className="text-sm text-gray-500">当前显示 {filteredOrders.length} 条采购单记录</div>
            {isLoading && <LoaderCircle className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
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
                采购单：{forceStatusDraft.orderId} / {forceStatusDraft.supplier}
              </div>
              <div className="space-y-2">
                <div className="text-xs text-slate-500">当前状态：{forceStatusDraft.currentStatus}</div>
                <select
                  value={forceStatusDraft.nextStatus}
                  onChange={(event) => {
                    const value = event.target.value as ProcurementForceStatus;
                    setForceStatusDraft((current) => (current ? { ...current, nextStatus: value } : current));
                  }}
                  className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {PROCUREMENT_FORCE_STATUS_OPTIONS.map((status) => (
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
                <Button onClick={() => void handleSubmitForceStatus()} disabled={isGenerating}>
                  {isGenerating ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
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
