import React, { Fragment, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { formatCurrency } from '@/lib/format';
import { CheckCircle2, CopyPlus, Eye, Filter, LoaderCircle, PackagePlus, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { createOrder, deleteOrder, fetchOrderDetail, fetchOrders, updateOrderStatus } from '@/services/api/orders';
import type { CreateOrderPayload, OrderDetailRecord, OrderItemDraft, OrderRecord } from '@/types/orders';

const pageSize = 8;

function createEmptyItem(seed = Date.now()): OrderItemDraft {
  return {
    id: `item-${seed}`,
    sku: '',
    productName: '',
    quantity: '',
    unitPrice: '',
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function formatOrderDateTime(value: string) {
  if (!value) {
    return '-';
  }

  const normalized = value.includes('T') ? value : `${value}T00:00:00`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function OrderManagement() {
  const { user, hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const canCreateOrders = hasPermission('orders.create');
  const canDeleteOrders = isSuperAdmin;
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<OrderDetailRecord | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [orderDateFilter, setOrderDateFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [orderChannel, setOrderChannel] = useState('门店补货');
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<OrderItemDraft[]>([createEmptyItem()]);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyActionId, setBusyActionId] = useState('');

  const totalAmount = useMemo(
    () => items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0),
    [items]
  );

  const totalQuantity = useMemo(
    () => items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    [items]
  );

  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      const matchesSearch =
        !searchTerm ||
        order.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.customer.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = !statusFilter || order.status === statusFilter;
      const matchesDate = !orderDateFilter || order.date === orderDateFilter;

      return matchesSearch && matchesStatus && matchesDate;
    });
  }, [orders, orderDateFilter, searchTerm, statusFilter]);

  const totalPages = Math.max(Math.ceil(filteredOrders.length / pageSize), 1);
  const paginatedOrders = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredOrders.slice(start, start + pageSize);
  }, [currentPage, filteredOrders]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, orderDateFilter]);

  const loadOrders = async () => {
    setIsLoading(true);
    setPageError('');

    try {
      const response = await fetchOrders();
      setOrders(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadOrders();
  }, []);

  const resetForm = () => {
    setCustomerName('');
    setOrderChannel('门店补货');
    setExpectedDeliveryDate('');
    setRemark('');
    setItems([createEmptyItem(Date.now())]);
    setFormError('');
  };

  const handleAddItem = () => {
    setItems((current) => [...current, createEmptyItem(Date.now() + current.length)]);
  };

  const handleRemoveItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  };

  const handleItemChange = (id: string, field: keyof Omit<OrderItemDraft, 'id'>, value: string) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  };

  const handleResetFilters = () => {
    setSearchTerm('');
    setStatusFilter('');
    setOrderDateFilter('');
    setCurrentPage(1);
  };

  const handleReloadOrders = async () => {
    setActionMessage('');
    await loadOrders();
  };

  const handleViewDetail = async (id: string) => {
    setIsDetailLoading(true);
    setDetailError('');

    try {
      const response = await fetchOrderDetail(id);
      setSelectedOrder(response.data);
    } catch (error) {
      setDetailError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handlePrepareDuplicate = async (id: string) => {
    setBusyActionId(id);
    setPageError('');
    setFormError('');

    try {
      const response = await fetchOrderDetail(id);
      const detail = response.data;
      setCustomerName(detail.customerName);
      setOrderChannel(detail.orderChannel);
      setExpectedDeliveryDate(detail.expectedDeliveryDate);
      setRemark(detail.remark || '');
      setItems(
        detail.items.map((item, index) => ({
          id: `duplicate-${detail.id}-${index}`,
          sku: item.sku,
          productName: item.productName,
          quantity: String(item.quantity),
          unitPrice: String(item.unitPrice),
        }))
      );
      setIsCreateOpen(true);
      setFormSuccess(`已载入订单 ${detail.id}，你可以修改后重新提交。`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setBusyActionId('');
    }
  };

  const handleOrderStatusUpdate = async (orderId: string, nextStatus: '已完成' | '已取消') => {
    const confirmText = nextStatus === '已取消' ? '确认取消该订单？' : '确认将订单标记为已完成？';
    if (!(await confirm(confirmText))) {
      return;
    }

    setBusyActionId(orderId);
    setPageError('');
    setActionMessage('');

    try {
      const response = await updateOrderStatus(orderId, { status: nextStatus });
      setActionMessage(response.message || '订单状态已更新。');
      setSelectedOrder(response.data);
      await loadOrders();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setBusyActionId('');
    }
  };

  const handleSubmit = async () => {
    setFormSuccess('');
    setActionMessage('');

    if (!canCreateOrders) {
      setFormError('当前角色没有创建订单权限。');
      return;
    }

    if (!customerName.trim()) {
      setFormError('请先填写客户或门店名称。');
      return;
    }

    if (!expectedDeliveryDate) {
      setFormError('请选择期望交付日期。');
      return;
    }

    if (items.length === 0) {
      setFormError('请至少添加一条商品明细。');
      return;
    }

    const hasInvalidItem = items.some((item) => {
      return !item.sku.trim() || !item.productName.trim() || Number(item.quantity) <= 0 || Number(item.unitPrice) <= 0;
    });

    if (hasInvalidItem) {
      setFormError('请完整填写每条商品明细，且数量和单价必须大于 0。');
      return;
    }

    const payload: CreateOrderPayload = {
      customerName: customerName.trim(),
      orderChannel,
      expectedDeliveryDate,
      remark: remark.trim(),
      items: items.map((item) => ({
        sku: item.sku.trim(),
        productName: item.productName.trim(),
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
      })),
    };

    if (!(await confirm(`确认创建订单并写入系统？\n客户：${payload.customerName}\n金额：${formatCurrency(totalAmount)}`))) {
      return;
    }

    setIsSubmitting(true);
    setFormError('');

    try {
      const response = await createOrder(payload);
      setOrders((current) => [response.data, ...current]);
      setFormSuccess(`订单 ${response.data.id} 已创建，并已写入后端订单列表。`);
      resetForm();
      setIsCreateOpen(false);
    } catch (error) {
      setFormError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteOrder = async (orderId: string) => {
    if (!canDeleteOrders) {
      setPageError('仅管理员可删除订单。');
      return;
    }

    if (
      !(await confirm(
        `确认删除订单 ${orderId}？\n将回滚库存并清理关联发货/收款记录。`,
      ))
    ) {
      return;
    }

    setBusyActionId(orderId);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteOrder(orderId, { aggressive: true });
      setActionMessage(response.message || '订单已删除。');
      if (selectedOrder?.id === orderId) {
        setSelectedOrder(null);
      }
      await loadOrders();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setBusyActionId('');
    }
  };

  const handleFilterCustomer = (customer: string) => {
    const customerName = customer.split(' / ')[0]?.trim() || customer;
    setSearchTerm(customerName);
    setCurrentPage(1);
    setActionMessage(`已按客户 ${customerName} 筛选订单列表。`);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">客户订单管理</h2>
          <p className="text-sm text-gray-500 mt-1">订单列表、详情、状态流转和复制建单都已接入真实接口。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void handleReloadOrders()} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新列表
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700 shadow-sm"
            onClick={() => {
              setIsCreateOpen((open) => !open);
              setFormError('');
              setFormSuccess('');
            }}
            disabled={!canCreateOrders}
            title={!canCreateOrders ? '当前角色没有创建订单权限' : undefined}
          >
            {isCreateOpen ? <X className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
            {isCreateOpen ? '收起表单' : '新建订单'}
          </Button>
        </div>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">订单列表加载失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}
      {formSuccess && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{formSuccess}</div>}

      {isCreateOpen && (
        <Card className="border-blue-200 shadow-sm overflow-hidden">
          <CardHeader className="border-b border-blue-100 bg-blue-50/60">
            <CardTitle className="flex items-center gap-2 text-blue-900">
              <PackagePlus className="h-5 w-5 text-blue-600" />
              新建销售订单表单
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">客户 / 门店名称</label>
                <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="例如：华东门店" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">订单渠道</label>
                <select value={orderChannel} onChange={(e) => setOrderChannel(e.target.value)} className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="门店补货">门店补货</option>
                  <option value="线上商城">线上商城</option>
                  <option value="企业团购">企业团购</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">期望交付日期</label>
                <Input type="date" value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">订单摘要</label>
                <div className="h-10 rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-gray-600 flex items-center">
                  {items.length} 条明细 / 共 {totalQuantity || 0} 件 / {formatCurrency(totalAmount || 0)}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-900">商品明细</h3>
                <Button variant="outline" size="sm" className="border-blue-200 text-blue-700 hover:bg-blue-50" onClick={handleAddItem}>
                  <Plus className="mr-2 h-4 w-4" /> 添加商品行
                </Button>
              </div>

              <div className="space-y-3">
                {items.length === 0 && <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-sm text-gray-500 text-center">当前没有商品明细，请先添加商品行。</div>}
                {items.map((item, index) => (
                  <div key={item.id} className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50/60 p-4 md:grid-cols-12">
                    <div className="md:col-span-2 space-y-2">
                      <label className="text-xs font-medium text-gray-600">SKU 编码</label>
                      <Input value={item.sku} onChange={(e) => handleItemChange(item.id, 'sku', e.target.value)} placeholder={`SKU-${index + 1001}`} />
                    </div>
                    <div className="md:col-span-4 space-y-2">
                      <label className="text-xs font-medium text-gray-600">商品名称</label>
                      <Input value={item.productName} onChange={(e) => handleItemChange(item.id, 'productName', e.target.value)} placeholder="例如：维达抽纸 24包" />
                    </div>
                    <div className="md:col-span-2 space-y-2">
                      <label className="text-xs font-medium text-gray-600">数量</label>
                      <Input type="number" min="1" value={item.quantity} onChange={(e) => handleItemChange(item.id, 'quantity', e.target.value)} placeholder="0" />
                    </div>
                    <div className="md:col-span-2 space-y-2">
                      <label className="text-xs font-medium text-gray-600">单价</label>
                      <Input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(e) => handleItemChange(item.id, 'unitPrice', e.target.value)} placeholder="0.00" />
                    </div>
                    <div className="md:col-span-2 space-y-2">
                      <label className="text-xs font-medium text-gray-600">操作</label>
                      <Button type="button" variant="outline" className="w-full border-red-200 text-red-600 hover:bg-red-50" onClick={() => handleRemoveItem(item.id)}>
                        <Trash2 className="mr-2 h-4 w-4" /> 删除
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">备注</label>
                <textarea value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="可填写促销活动、门店优先级、配送要求等备注信息。" className="min-h-28 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
                <h4 className="font-semibold text-gray-900">提交前检查</h4>
                <div className="text-sm text-gray-600 space-y-2">
                  <div className="flex items-center justify-between"><span>客户 / 门店</span><span className="font-medium text-gray-900">{customerName || '未填写'}</span></div>
                  <div className="flex items-center justify-between"><span>订单渠道</span><span className="font-medium text-gray-900">{orderChannel}</span></div>
                  <div className="flex items-center justify-between"><span>商品行数</span><span className="font-medium text-gray-900">{items.length}</span></div>
                  <div className="flex items-center justify-between"><span>总数量</span><span className="font-medium text-gray-900">{totalQuantity}</span></div>
                  <div className="flex items-center justify-between"><span>订单金额</span><span className="font-semibold text-blue-700">{formatCurrency(totalAmount || 0)}</span></div>
                </div>
              </div>
            </div>

            {formError && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{formError}</div>}

            <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => { resetForm(); setIsCreateOpen(false); setFormSuccess(''); }}>
                取消
              </Button>
              <Button variant="outline" className="border-blue-200 text-blue-700 hover:bg-blue-50" onClick={resetForm} disabled={isSubmitting}>
                重置表单
              </Button>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmit()} disabled={isSubmitting || !canCreateOrders} title={!canCreateOrders ? '当前角色没有创建订单权限' : undefined}>
                {isSubmitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                提交订单
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {(selectedOrder || isDetailLoading || detailError) && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="text-lg font-semibold text-gray-800">订单详情</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => { setSelectedOrder(null); setDetailError(''); }}>
                关闭
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {isDetailLoading && <div className="text-sm text-gray-500">正在加载订单详情...</div>}
            {detailError && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{detailError}</div>}
            {selectedOrder && !isDetailLoading && (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">客户</div><div className="text-sm font-semibold text-gray-900 mt-1">{selectedOrder.customerName}</div><div className="text-xs text-gray-500 mt-1">{selectedOrder.orderChannel}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">订单状态</div><div className="text-sm font-semibold text-gray-900 mt-1">{selectedOrder.status}</div><div className="text-xs text-gray-500 mt-1">库存：{selectedOrder.stockStatus}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">订单金额</div><div className="text-sm font-semibold text-gray-900 mt-1">{formatCurrency(selectedOrder.totalAmount)}</div><div className="text-xs text-gray-500 mt-1">{selectedOrder.itemCount} 件商品</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">交付日期</div><div className="text-sm font-semibold text-gray-900 mt-1">{selectedOrder.expectedDeliveryDate}</div><div className="text-xs text-gray-500 mt-1">下单时间：{formatOrderDateTime(selectedOrder.createdAt || selectedOrder.orderDate)}</div></div>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">商品明细</h3>
                    <div className="space-y-3">
                      {selectedOrder.items.map((item) => (
                        <div key={item.id} className="rounded-lg border border-gray-200 p-4">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <div className="text-sm font-semibold text-gray-900">{item.productName}</div>
                              <div className="text-xs text-gray-500 mt-1">{item.sku}</div>
                            </div>
                            <div className="text-right text-sm text-gray-700">
                              <div>{item.quantity} × {formatCurrency(item.unitPrice)}</div>
                              <div className="font-semibold text-gray-900 mt-1">{formatCurrency(item.lineAmount)}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-lg border border-gray-200 p-4">
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">发货信息</h3>
                      {selectedOrder.shipping ? (
                        <div className="space-y-2 text-sm text-gray-700">
                          <div>发货单：{selectedOrder.shipping.deliveryId}</div>
                          <div>状态：{selectedOrder.shipping.shipmentStatus}</div>
                          <div>物流：{selectedOrder.shipping.courier || '-'}</div>
                          <div>运单号：{selectedOrder.shipping.trackingNo || '-'}</div>
                        </div>
                      ) : (
                        <div className="text-sm text-gray-500">尚未生成发货记录。</div>
                      )}
                    </div>

                    <div className="rounded-lg border border-gray-200 p-4">
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">应收信息</h3>
                      {selectedOrder.receivable ? (
                        <div className="space-y-2 text-sm text-gray-700">
                          <div>应收单：{selectedOrder.receivable.receivableId}</div>
                          <div>应收金额：{formatCurrency(selectedOrder.receivable.amountDue)}</div>
                          <div>已收金额：{formatCurrency(selectedOrder.receivable.amountPaid)}</div>
                          <div>待收金额：{formatCurrency(selectedOrder.receivable.remainingAmount)}</div>
                          <div>到期日：{selectedOrder.receivable.dueDate}</div>
                        </div>
                      ) : (
                        <div className="text-sm text-gray-500">尚未生成应收记录。</div>
                      )}
                    </div>

                    {selectedOrder.remark && <div className="rounded-lg border border-gray-200 p-4"><h3 className="text-sm font-semibold text-gray-900 mb-2">备注</h3><div className="text-sm text-gray-700">{selectedOrder.remark}</div></div>}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                <Input placeholder="搜索订单编号、客户名称..." className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
              </div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">所有状态</option>
                <option value="待发货">待发货</option>
                <option value="已发货">已发货</option>
                <option value="已完成">已完成</option>
                <option value="已取消">已取消</option>
              </select>
              <Input type="date" value={orderDateFilter} onChange={(e) => setOrderDateFilter(e.target.value)} className="w-full md:w-auto bg-white border-gray-300 focus-visible:ring-blue-500" />
            </div>
            <Button variant="outline" className="w-full md:w-auto border-gray-300 text-gray-700 hover:bg-gray-50" onClick={handleResetFilters}>重置筛选</Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50/50 hover:bg-gray-50/50">
                <TableHead className="font-semibold text-gray-900">订单编号</TableHead>
                <TableHead className="font-semibold text-gray-900">客户名称</TableHead>
                <TableHead className="font-semibold text-gray-900">下单日期</TableHead>
                <TableHead className="font-semibold text-gray-900">订单金额</TableHead>
                <TableHead className="font-semibold text-gray-900">状态</TableHead>
                <TableHead className="font-semibold text-gray-900">库存状态</TableHead>
                <TableHead className="font-semibold text-gray-900 text-right">商品件数</TableHead>
                <TableHead className="text-right font-semibold text-gray-900">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载订单列表...</TableCell></TableRow>}
              {!isLoading && filteredOrders.length === 0 && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有订单记录。</TableCell></TableRow>}
              {!isLoading && paginatedOrders.map((order) => (
                <Fragment key={order.id}>
                  <TableRow className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-blue-600">{order.id}</TableCell>
                    <TableCell className="text-gray-900">{order.customer}</TableCell>
                    <TableCell className="text-gray-500">{order.date}</TableCell>
                    <TableCell className="font-semibold text-gray-900">{order.amount}</TableCell>
                    <TableCell>
                      <Badge variant={order.status === '待发货' ? 'default' : order.status === '已发货' ? 'secondary' : order.status === '已完成' ? 'success' : 'outline'}>
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {order.stockStatus !== '-' ? (
                        <Badge
                          variant={order.stockStatus === '部分缺货' ? 'destructive' : 'outline'}
                          className={order.stockStatus === '库存充足' ? 'text-green-600 border-green-200 bg-green-50' : order.stockStatus === '待校验' ? 'text-amber-700 border-amber-200 bg-amber-50' : ''}
                        >
                          {order.stockStatus}
                        </Badge>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium text-gray-700">{order.itemCount}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewDetail(order.id)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <RowActionMenu
                          items={[
                            {
                              id: 'view-detail',
                              label: '查看详情',
                              icon: Eye,
                              onSelect: () => void handleViewDetail(order.id),
                            },
                            {
                              id: 'duplicate',
                              label: busyActionId === order.id ? '正在载入...' : '复制建单',
                              icon: CopyPlus,
                              onSelect: () => void handlePrepareDuplicate(order.id),
                              disabled: busyActionId === order.id || !canCreateOrders,
                            },
                            {
                              id: 'filter-customer',
                              label: '按该客户筛选',
                              icon: Filter,
                              onSelect: () => handleFilterCustomer(order.customer),
                            },
                            {
                              id: 'complete',
                              label: '标记完成',
                              icon: CheckCircle2,
                              onSelect: () => void handleOrderStatusUpdate(order.id, '已完成'),
                              disabled: order.status !== '已发货' || busyActionId === order.id || !canCreateOrders,
                            },
                            {
                              id: 'cancel',
                              label: '取消订单',
                              icon: Trash2,
                              onSelect: () => void handleOrderStatusUpdate(order.id, '已取消'),
                              disabled: order.status !== '待发货' || busyActionId === order.id || !canCreateOrders,
                              tone: 'danger',
                            },
                            {
                              id: 'delete-order',
                              label: '删除订单',
                              icon: X,
                              onSelect: () => void handleDeleteOrder(order.id),
                              disabled: busyActionId === order.id || !canDeleteOrders,
                              tone: 'danger',
                            },
                          ]}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                </Fragment>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/30 rounded-b-xl">
            <div className="text-sm text-gray-500">当前显示第 {currentPage} / {totalPages} 页，共 {filteredOrders.length} 条订单记录</div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="border-gray-300 text-gray-700 hover:bg-gray-50" disabled={currentPage <= 1} onClick={() => setCurrentPage((page) => Math.max(page - 1, 1))}>
                上一页
              </Button>
              <Button variant="outline" size="sm" className="border-gray-300 text-gray-700 hover:bg-gray-50" disabled={currentPage >= totalPages} onClick={() => setCurrentPage((page) => Math.min(page + 1, totalPages))}>
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  );
}
