import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { DocumentPreviewModal } from '@/components/documents/DocumentPreviewModal';
import { useAuth } from '@/auth/AuthContext';
import { buildOrderDocument } from '@/lib/documents';
import { formatCurrency } from '@/lib/format';
import {
  CheckCircle2,
  CopyPlus,
  Eye,
  Filter,
  LoaderCircle,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  createOrder,
  deleteOrder,
  fetchOrderDetail,
  fetchOrderFormOptions,
  fetchOrders,
  updateOrderStatus,
} from '@/services/api/orders';
import type { DocumentPreviewRecord } from '@/types/documents';
import type {
  CreateOrderPayload,
  OrderFormOptions,
  OrderItemDraft,
  OrderRecord,
} from '@/types/orders';

const pageSize = 8;

function createEmptyItem(seed = Date.now()): OrderItemDraft {
  return {
    id: `item-${seed}`,
    productId: '',
    quantity: '',
    unitPrice: '',
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function productOptionLabel(name: string, sku: string, stock: number) {
  return `${name} / ${sku} / 库存 ${stock}`;
}

export function OrderManagement() {
  const { user, hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const canCreateOrders = hasPermission('orders.create');
  const canDeleteOrders = isSuperAdmin;
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [formOptions, setFormOptions] = useState<OrderFormOptions>({ customers: [], products: [] });
  const [previewDocuments, setPreviewDocuments] = useState<DocumentPreviewRecord[]>([]);
  const [previewInitialId, setPreviewInitialId] = useState('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [orderDateFilter, setOrderDateFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
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

  const customerMap = useMemo(
    () => new Map(formOptions.customers.map((customer) => [customer.id, customer])),
    [formOptions.customers],
  );
  const productMap = useMemo(
    () => new Map(formOptions.products.map((product) => [product.productId, product])),
    [formOptions.products],
  );
  const selectedCustomer = useMemo(
    () => customerMap.get(customerId) || null,
    [customerId, customerMap],
  );
  const customerOptions = useMemo(
    () =>
      formOptions.customers.map((customer) => ({
        value: customer.id,
        label: customer.name,
        keywords: [customer.name, customer.channelPreference],
        description: customer.channelPreference ? `渠道：${customer.channelPreference}` : undefined,
      })),
    [formOptions.customers],
  );

  const totalAmount = useMemo(
    () => items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0),
    [items],
  );
  const totalQuantity = useMemo(
    () => items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    [items],
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

  const loadFormOptions = async () => {
    if (!canCreateOrders) {
      setFormOptions({ customers: [], products: [] });
      return { customers: [], products: [] } satisfies OrderFormOptions;
    }

    const response = await fetchOrderFormOptions();
    setFormOptions(response.data);
    return response.data;
  };

  const loadOrders = async () => {
    if (canCreateOrders) {
      const [ordersResponse] = await Promise.all([fetchOrders(), loadFormOptions()]);
      setOrders(ordersResponse.data);
      return;
    }

    const response = await fetchOrders();
    setOrders(response.data);
  };

  const loadPageData = async () => {
    setIsLoading(true);
    setPageError('');

    try {
      await loadOrders();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadPageData();
  }, [canCreateOrders]);

  const openPreview = (documents: DocumentPreviewRecord[], activeId?: string) => {
    if (documents.length === 0) {
      return;
    }

    setPreviewDocuments(documents);
    setPreviewInitialId(activeId || documents[0]?.id || '');
    setIsPreviewOpen(true);
  };

  const resetForm = () => {
    setCustomerId('');
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
    setItems((current) =>
      current.map((item) => {
        if (item.id !== id) {
          return item;
        }

        if (field === 'productId') {
          const product = productMap.get(value);
          return {
            ...item,
            productId: value,
            unitPrice: product ? String(product.salePrice) : '',
          };
        }

        return { ...item, [field]: value };
      }),
    );
  };

  const getSelectableProducts = (draft: OrderItemDraft) => {
    const selectedProductIds = new Set(
      items.filter((item) => item.id !== draft.id).map((item) => item.productId).filter(Boolean),
    );
    return formOptions.products.filter((product) => !selectedProductIds.has(product.productId) || product.productId === draft.productId);
  };

  const handleResetFilters = () => {
    setSearchTerm('');
    setStatusFilter('');
    setOrderDateFilter('');
    setCurrentPage(1);
  };

  const handleReloadOrders = async () => {
    setActionMessage('');
    await loadPageData();
  };

  const handleViewDetail = async (id: string) => {
    try {
      const response = await fetchOrderDetail(id);
      openPreview([buildOrderDocument(response.data)], response.data.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  };

  const handlePrepareDuplicate = async (id: string) => {
    setBusyActionId(id);
    setPageError('');
    setFormError('');

    try {
      const [detailResponse, options] = await Promise.all([
        fetchOrderDetail(id),
        canCreateOrders ? loadFormOptions() : Promise.resolve(formOptions),
      ]);
      const detail = detailResponse.data;
      const customer = options.customers.find((item) => item.name === detail.customerName);
      if (!customer) {
        throw new Error(`客户 ${detail.customerName} 已不在可选客户列表中，无法直接复制。`);
      }

      const missingProducts: string[] = [];
      const nextItems = detail.items.reduce<OrderItemDraft[]>((result, item, index) => {
        const matchedProduct = options.products.find((product) => product.sku === item.sku);
        if (!matchedProduct) {
          missingProducts.push(item.sku);
          return result;
        }

        result.push({
          id: `duplicate-${detail.id}-${index}`,
          productId: matchedProduct.productId,
          quantity: String(item.quantity),
          unitPrice: String(item.unitPrice),
        });
        return result;
      }, []);

      if (missingProducts.length > 0 || nextItems.length === 0) {
        throw new Error(`以下商品已不在可选库存列表中：${missingProducts.join('、')}`);
      }

      setCustomerId(customer.id);
      setExpectedDeliveryDate(detail.expectedDeliveryDate);
      setRemark(detail.remark || '');
      setItems(nextItems);
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
      await loadPageData();
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

    if (!customerId) {
      setFormError('请先从客户列表中选择客户。');
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
      return !item.productId || Number(item.quantity) <= 0 || !Number.isInteger(Number(item.quantity)) || Number(item.unitPrice) <= 0;
    });
    if (hasInvalidItem) {
      setFormError('请完整填写每条商品明细，且数量为正整数、单价必须大于 0。');
      return;
    }

    const uniqueProductIds = new Set(items.map((item) => item.productId));
    if (uniqueProductIds.size !== items.length) {
      setFormError('同一张销售订单中不能重复选择相同商品。');
      return;
    }

    const payload: CreateOrderPayload = {
      customerId,
      expectedDeliveryDate,
      remark: remark.trim(),
      items: items.map((item) => ({
        productId: item.productId,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
      })),
    };

    if (!(await confirm(`确认创建订单并写入系统？\n客户：${selectedCustomer?.name || '-'}\n金额：${formatCurrency(totalAmount)}`))) {
      return;
    }

    setIsSubmitting(true);
    setFormError('');

    try {
      const response = await createOrder(payload);
      setOrders((current) => [response.data, ...current]);
      setFormSuccess(`订单 ${response.data.id} 已创建，并已写入后端订单列表。`);
      const detailResponse = await fetchOrderDetail(response.data.id);
      openPreview([buildOrderDocument(detailResponse.data)], detailResponse.data.id);
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

    if (!(await confirm(`确认删除订单 ${orderId}？\n将回滚库存并清理关联发货/收款记录。`))) {
      return;
    }

    setBusyActionId(orderId);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteOrder(orderId, { aggressive: true });
      setActionMessage(response.message || '订单已删除。');
      if (previewDocuments.some((item) => item.id === orderId)) {
        setIsPreviewOpen(false);
      }
      await loadPageData();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setBusyActionId('');
    }
  };

  const handleFilterCustomer = (customer: string) => {
    const normalizedCustomer = customer.split(' / ')[0]?.trim() || customer;
    setSearchTerm(normalizedCustomer);
    setCurrentPage(1);
    setActionMessage(`已按客户 ${normalizedCustomer} 筛选订单列表。`);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">客户订单管理</h2>
          <p className="mt-1 text-sm text-gray-500">订单列表、真实单据预览和选择式建单已经合并到同一页。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void handleReloadOrders()} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            刷新列表
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

      {pageError ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">订单列表加载失败：{pageError}</div> : null}
      {actionMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div> : null}
      {formSuccess ? <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{formSuccess}</div> : null}

      {isCreateOpen ? (
        <Card className="overflow-hidden border-blue-200 shadow-sm">
          <CardHeader className="border-b border-blue-100 bg-blue-50/60">
            <CardTitle className="flex items-center gap-2 text-blue-900">
              <PackagePlus className="h-5 w-5 text-blue-600" />
              新建销售订单表单
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 p-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">客户</label>
                <SearchableSelect
                  value={customerId}
                  onChange={setCustomerId}
                  options={customerOptions}
                  placeholder="请选择客户"
                  searchPlaceholder="输入客户名称或渠道检索"
                  emptyText="没有匹配的客户"
                />
                <select
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value)}
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <option value="">请选择客户</option>
                  {formOptions.customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">订单渠道</label>
                <div className="flex h-10 items-center rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-gray-600">
                  {selectedCustomer?.channelPreference || '选择客户后自动带出'}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">期望交付日期</label>
                <Input type="date" value={expectedDeliveryDate} onChange={(event) => setExpectedDeliveryDate(event.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">备注</label>
                <Input value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="可填写订单备注" />
              </div>
            </div>

            {canCreateOrders && (formOptions.customers.length === 0 || formOptions.products.length === 0) ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                当前可选客户或商品为空，请先检查基础资料和库存是否已准备完成。
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-900">商品明细</h3>
                <Button variant="outline" size="sm" className="border-blue-200 text-blue-700 hover:bg-blue-50" onClick={handleAddItem}>
                  <Plus className="mr-2 h-4 w-4" />
                  添加商品行
                </Button>
              </div>

              <div className="space-y-3">
                {items.map((item) => {
                  const selectedProduct = productMap.get(item.productId) || null;

                  return (
                    <div key={item.id} className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50/60 p-4 md:grid-cols-12">
                      <div className="space-y-2 md:col-span-5">
                        <label className="text-xs font-medium text-gray-600">商品名称</label>
                        <SearchableSelect
                          value={item.productId}
                          onChange={(value) => handleItemChange(item.id, 'productId', value)}
                          options={getSelectableProducts(item).map((product) => ({
                            value: product.productId,
                            label: product.name,
                            keywords: [product.name, product.sku, product.status, String(product.currentStock)],
                            description: productOptionLabel(product.name, product.sku, product.currentStock),
                          }))}
                          placeholder="请选择库存商品"
                          searchPlaceholder="输入商品名、SKU 或库存检索"
                          emptyText="没有匹配的库存商品"
                        />
                        <select
                          value={item.productId}
                          onChange={(event) => handleItemChange(item.id, 'productId', event.target.value)}
                          className="hidden"
                          tabIndex={-1}
                          aria-hidden="true"
                        >
                          <option value="">请选择库存商品</option>
                          {getSelectableProducts(item).map((product) => (
                            <option key={product.productId} value={product.productId}>
                              {productOptionLabel(product.name, product.sku, product.currentStock)}
                            </option>
                          ))}
                        </select>
                        <div className="text-xs text-gray-500">
                          {selectedProduct ? `当前库存 ${selectedProduct.currentStock} · 状态 ${selectedProduct.status}` : '选择商品后自动显示库存状态'}
                        </div>
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-xs font-medium text-gray-600">SKU 编码</label>
                        <div className="flex h-10 items-center rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700">
                          {selectedProduct?.sku || '自动补全'}
                        </div>
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-xs font-medium text-gray-600">数量</label>
                        <Input type="number" min="1" step="1" value={item.quantity} onChange={(event) => handleItemChange(item.id, 'quantity', event.target.value)} placeholder="0" />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-xs font-medium text-gray-600">销售单价</label>
                        <Input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(event) => handleItemChange(item.id, 'unitPrice', event.target.value)} placeholder="0.00" />
                      </div>
                      <div className="space-y-2 md:col-span-1">
                        <label className="text-xs font-medium text-gray-600">操作</label>
                        <Button type="button" variant="outline" className="w-full border-red-200 text-red-600 hover:bg-red-50" onClick={() => handleRemoveItem(item.id)} disabled={items.length === 1}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
              <div />
              <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
                <h4 className="font-semibold text-gray-900">提交前检查</h4>
                <div className="space-y-2 text-sm text-gray-600">
                  <div className="flex items-center justify-between"><span>客户</span><span className="font-medium text-gray-900">{selectedCustomer?.name || '未选择'}</span></div>
                  <div className="flex items-center justify-between"><span>订单渠道</span><span className="font-medium text-gray-900">{selectedCustomer?.channelPreference || '-'}</span></div>
                  <div className="flex items-center justify-between"><span>商品行数</span><span className="font-medium text-gray-900">{items.length}</span></div>
                  <div className="flex items-center justify-between"><span>总数量</span><span className="font-medium text-gray-900">{totalQuantity}</span></div>
                  <div className="flex items-center justify-between"><span>订单金额</span><span className="font-semibold text-blue-700">{formatCurrency(totalAmount || 0)}</span></div>
                  <div className="flex items-start justify-between gap-3"><span>备注</span><span className="text-right font-medium text-gray-900">{remark || '-'}</span></div>
                </div>
              </div>
            </div>

            {formError ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{formError}</div> : null}

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => { resetForm(); setIsCreateOpen(false); setFormSuccess(''); }}>
                取消
              </Button>
              <Button variant="outline" className="border-blue-200 text-blue-700 hover:bg-blue-50" onClick={resetForm} disabled={isSubmitting}>
                重置表单
              </Button>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmit()} disabled={isSubmitting || !canCreateOrders}>
                {isSubmitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                提交订单
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
          <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
            <div className="flex w-full flex-1 flex-wrap gap-4">
              <div className="relative w-full md:w-72">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                <Input placeholder="搜索订单编号、客户名称..." className="bg-white border-gray-300 pl-9 focus-visible:ring-blue-500" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
              </div>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">所有状态</option>
                <option value="待发货">待发货</option>
                <option value="部分发货">部分发货</option>
                <option value="已发货">已发货</option>
                <option value="已完成">已完成</option>
                <option value="已取消">已取消</option>
              </select>
              <Input type="date" value={orderDateFilter} onChange={(event) => setOrderDateFilter(event.target.value)} className="w-full md:w-auto bg-white border-gray-300 focus-visible:ring-blue-500" />
            </div>
            <Button variant="outline" className="w-full border-gray-300 text-gray-700 hover:bg-gray-50 md:w-auto" onClick={handleResetFilters}>
              重置筛选
            </Button>
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
                <TableHead className="text-right font-semibold text-gray-900">商品件数</TableHead>
                <TableHead className="text-right font-semibold text-gray-900">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载订单列表...</TableCell></TableRow> : null}
              {!isLoading && filteredOrders.length === 0 ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有订单记录。</TableCell></TableRow> : null}
              {!isLoading ? paginatedOrders.map((order) => (
                <TableRow key={order.id} className="transition-colors hover:bg-blue-50/30">
                  <TableCell className="font-medium text-blue-600">{order.id}</TableCell>
                  <TableCell className="text-gray-900">{order.customer}</TableCell>
                  <TableCell className="text-gray-500">{order.date}</TableCell>
                  <TableCell className="font-semibold text-gray-900">{order.amount}</TableCell>
                  <TableCell>
                    <Badge variant={order.status === '待发货' ? 'default' : order.status === '部分发货' ? 'warning' : order.status === '已发货' ? 'secondary' : order.status === '已完成' ? 'success' : 'outline'}>
                      {order.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {order.stockStatus !== '-' ? (
                      <Badge
                        variant={order.stockStatus === '部分缺货' ? 'destructive' : 'outline'}
                        className={order.stockStatus === '库存充足' ? 'border-green-200 bg-green-50 text-green-600' : order.stockStatus === '待校验' ? 'border-amber-200 bg-amber-50 text-amber-700' : ''}
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
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-blue-50 hover:text-blue-600" onClick={() => void handleViewDetail(order.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'view-detail', label: '查看单据', icon: Eye, onSelect: () => void handleViewDetail(order.id) },
                          { id: 'duplicate', label: busyActionId === order.id ? '正在载入...' : '复制建单', icon: CopyPlus, onSelect: () => void handlePrepareDuplicate(order.id), disabled: busyActionId === order.id || !canCreateOrders },
                          { id: 'filter-customer', label: '按该客户筛选', icon: Filter, onSelect: () => handleFilterCustomer(order.customer) },
                          { id: 'complete', label: '标记完成', icon: CheckCircle2, onSelect: () => void handleOrderStatusUpdate(order.id, '已完成'), disabled: order.status !== '已发货' || busyActionId === order.id || !canCreateOrders },
                          { id: 'cancel', label: '取消订单', icon: Trash2, onSelect: () => void handleOrderStatusUpdate(order.id, '已取消'), disabled: order.status !== '待发货' || busyActionId === order.id || !canCreateOrders, tone: 'danger' },
                          { id: 'delete-order', label: '删除订单', icon: X, onSelect: () => void handleDeleteOrder(order.id), disabled: busyActionId === order.id || !canDeleteOrders, tone: 'danger' },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              )) : null}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between rounded-b-xl border-t border-gray-100 bg-gray-50/30 px-6 py-4">
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

      <DocumentPreviewModal documents={previewDocuments} isOpen={isPreviewOpen} initialActiveId={previewInitialId} onClose={() => setIsPreviewOpen(false)} />
      {confirmDialog}
    </div>
  );
}
