import React, { useEffect, useMemo, useState } from 'react';
import { Eye, LoaderCircle, Package, RefreshCw, Search, Sparkles, Truck } from 'lucide-react';
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
import { buildShippingDocument } from '@/lib/documents';
import { downloadCsv } from '@/lib/export';
import {
  createShipmentDocument,
  fetchShipmentDetail,
  fetchShipments,
  fetchShippingWorkbench,
} from '@/services/api/shipping';
import type { DocumentPreviewRecord } from '@/types/documents';
import type {
  CreateShipmentDocumentPayload,
  ShipmentStockStatus,
  ShippingDetailRecord,
  ShippingRecord,
  ShippingWorkbenchCustomer,
} from '@/types/shipping';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function statusVariant(status: string) {
  if (status === '待发货') return 'warning';
  if (status === '部分发货') return 'secondary';
  return 'success';
}

function stockVariant(status: ShipmentStockStatus) {
  if (status === '库存充足') return 'outline';
  if (status === '待补货') return 'destructive';
  return 'secondary';
}

function inferDraftCourier(orderChannels: string[]) {
  const unique = Array.from(new Set(orderChannels.filter(Boolean)));
  if (unique.length !== 1) {
    return '综合配送';
  }
  if (unique[0] === '线上商城') {
    return '顺丰速运';
  }
  if (unique[0] === '企业团购') {
    return '德邦物流';
  }
  return '门店配送';
}

export function SalesShipping() {
  const { hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const canDispatchShipment = hasPermission('shipping.dispatch');
  const [shipments, setShipments] = useState<ShippingRecord[]>([]);
  const [workbenchCustomers, setWorkbenchCustomers] = useState<ShippingWorkbenchCustomer[]>([]);
  const [selectedCustomerName, setSelectedCustomerName] = useState('');
  const [draftQuantities, setDraftQuantities] = useState<Record<string, string>>({});
  const [shipmentRemark, setShipmentRemark] = useState('');
  const [previewDocuments, setPreviewDocuments] = useState<DocumentPreviewRecord[]>([]);
  const [previewInitialId, setPreviewInitialId] = useState('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const customerOptions = useMemo(
    () =>
      workbenchCustomers.map((customer) => ({
        value: customer.customerName,
        label: customer.customerName,
        keywords: customer.orders.map((item) => item.orderId),
        description: `${customer.totalOrders} 张待发货订单 / ${customer.totalPendingQty} 件待出库`,
      })),
    [workbenchCustomers],
  );

  const selectedCustomer = useMemo(
    () => workbenchCustomers.find((item) => item.customerName === selectedCustomerName) || null,
    [selectedCustomerName, workbenchCustomers],
  );

  const filteredShipments = useMemo(
    () =>
      shipments.filter((shipment) => {
        const keyword = searchTerm.trim().toLowerCase();
        const matchesSearch =
          !keyword ||
          shipment.id.toLowerCase().includes(keyword) ||
          shipment.customer.toLowerCase().includes(keyword) ||
          shipment.orderIds.some((item) => item.toLowerCase().includes(keyword));
        const matchesStatus = !statusFilter || shipment.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [shipments, searchTerm, statusFilter],
  );

  const loadShippingHub = async (preferredCustomerName?: string) => {
    setIsLoading(true);
    setPageError('');
    try {
      const [shipmentsResponse, workbenchResponse] = await Promise.all([fetchShipments(), fetchShippingWorkbench()]);
      setShipments(shipmentsResponse.data);
      setWorkbenchCustomers(workbenchResponse.data);
      if (preferredCustomerName) {
        const exists = workbenchResponse.data.some((item) => item.customerName === preferredCustomerName);
        setSelectedCustomerName(exists ? preferredCustomerName : workbenchResponse.data[0]?.customerName || '');
      } else if (!selectedCustomerName) {
        setSelectedCustomerName(workbenchResponse.data[0]?.customerName || '');
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadShippingHub();
  }, []);

  useEffect(() => {
    if (!selectedCustomer) {
      setDraftQuantities({});
      setShipmentRemark('');
      return;
    }

    const nextDrafts: Record<string, string> = {};
    selectedCustomer.orders.forEach((order) => {
      order.items.forEach((item) => {
        nextDrafts[item.orderItemId] = item.suggestedShipQty > 0 ? String(item.suggestedShipQty) : '';
      });
    });
    setDraftQuantities(nextDrafts);
    setShipmentRemark('');
  }, [selectedCustomer]);

  const openPreview = (documents: DocumentPreviewRecord[], activeId?: string) => {
    if (documents.length === 0) {
      return;
    }
    setPreviewDocuments(documents);
    setPreviewInitialId(activeId || documents[0]?.id || '');
    setIsPreviewOpen(true);
  };

  const handleViewDetail = async (id: string) => {
    setPageError('');
    try {
      const response = await fetchShipmentDetail(id);
      openPreview([buildShippingDocument(response.data)], response.data.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  };

  const fillDraftQuantities = (mode: 'suggested' | 'full') => {
    if (!selectedCustomer) {
      return;
    }

    const nextDrafts: Record<string, string> = {};
    selectedCustomer.orders.forEach((order) => {
      order.items.forEach((item) => {
        const value = mode === 'full' ? item.remainingQty : item.suggestedShipQty;
        nextDrafts[item.orderItemId] = value > 0 ? String(value) : '';
      });
    });
    setDraftQuantities(nextDrafts);
  };

  const buildDraftPayload = (): CreateShipmentDocumentPayload | null => {
    if (!selectedCustomer) {
      setPageError('请先选择客户。');
      return null;
    }

    const orders = selectedCustomer.orders
      .map((order) => ({
        orderId: order.orderId,
        items: order.items
          .map((item) => ({
            orderItemId: item.orderItemId,
            quantity: Number(draftQuantities[item.orderItemId] || 0),
            remainingQty: item.remainingQty,
          }))
          .filter((item) => item.quantity > 0),
      }))
      .filter((order) => order.items.length > 0);

    if (orders.length === 0) {
      setPageError('请至少填写一条本次出库数量。');
      return null;
    }

    for (const order of orders) {
      for (const item of order.items) {
        if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > item.remainingQty) {
          setPageError('本次出库数量必须是大于 0 的整数，且不能超过待出库数量。');
          return null;
        }
      }
    }

    return {
      customerName: selectedCustomer.customerName,
      remark: shipmentRemark.trim() || undefined,
      orders: orders.map((order) => ({
        orderId: order.orderId,
        items: order.items.map((item) => ({
          orderItemId: item.orderItemId,
          quantity: item.quantity,
        })),
      })),
    };
  };

  const buildDraftPreview = (): ShippingDetailRecord | null => {
    const payload = buildDraftPayload();
    if (!payload || !selectedCustomer) {
      return null;
    }

    const itemsDetail = payload.orders.flatMap((order) => {
      const orderRecord = selectedCustomer.orders.find((item) => item.orderId === order.orderId);
      if (!orderRecord) {
        return [];
      }
      return order.items.map((payloadItem) => {
        const sourceItem = orderRecord.items.find((item) => item.orderItemId === payloadItem.orderItemId);
        if (!sourceItem) {
          return null;
        }
        return {
          orderId: order.orderId,
          sku: sourceItem.sku,
          productName: sourceItem.productName,
          quantity: payloadItem.quantity,
        };
      }).filter(Boolean) as ShippingDetailRecord['itemsDetail'];
    });

    const orderIds = payload.orders.map((item) => item.orderId);
    const orderChannels = Array.from(new Set(selectedCustomer.orders.map((item) => item.orderChannel)));
    return {
      id: 'DRAFT-SHIPMENT',
      orderId: orderIds.length === 1 ? orderIds[0] : `${orderIds.length} 张订单`,
      orderIds,
      orderCount: orderIds.length,
      documentScope: orderIds.length > 1 ? '合并发货' : '单订单',
      customer: selectedCustomer.customerName,
      items: itemsDetail.reduce((sum, item) => sum + item.quantity, 0),
      status: '待发货',
      stockStatus: '-',
      courier: inferDraftCourier(orderChannels),
      trackingNo: '-',
      createdAt: new Date().toISOString(),
      orderChannel: orderChannels.join(' / ') || '-',
      orderChannels,
      remark: shipmentRemark.trim() || undefined,
      itemsDetail,
    };
  };

  const handlePreviewDraft = () => {
    const draft = buildDraftPreview();
    if (!draft) {
      return;
    }
    openPreview([buildShippingDocument(draft)], draft.id);
  };

  const handleCreateShipmentDocument = async () => {
    if (!canDispatchShipment) {
      setPageError('当前角色没有发货权限。');
      return;
    }

    const payload = buildDraftPayload();
    if (!payload) {
      return;
    }
    if (!(await confirm(`确认按当前选择为客户 ${payload.customerName} 生成发货单并出库吗？`))) {
      return;
    }

    setIsSubmitting(true);
    setPageError('');
    setActionMessage('');
    try {
      const response = await createShipmentDocument(payload);
      const detailResponse = await fetchShipmentDetail(response.data.id);
      openPreview([buildShippingDocument(detailResponse.data)], detailResponse.data.id);
      setActionMessage(response.message || '发货单已生成并完成出库。');
      await loadShippingHub(payload.customerName);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExportCurrentList = () => {
    downloadCsv(
      'shipping-documents.csv',
      [
        { header: '发货单号', value: (item) => item.id },
        { header: '客户', value: (item) => item.customer },
        { header: '订单数量', value: (item) => item.orderCount },
        { header: '关联订单', value: (item) => item.orderIds.join(' / ') },
        { header: '发货范围', value: (item) => item.documentScope },
        { header: '商品件数', value: (item) => item.items },
        { header: '物流公司', value: (item) => item.courier },
        { header: '运单号', value: (item) => item.trackingNo },
      ],
      filteredShipments,
    );
    setActionMessage(`已导出 ${filteredShipments.length} 条发货单。`);
  };

  const totalDraftQty = selectedCustomer
    ? selectedCustomer.orders.reduce(
        (sum, order) =>
          sum + order.items.reduce((itemSum, item) => itemSum + Number(draftQuantities[item.orderItemId] || 0), 0),
        0,
      )
    : 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">销售发货</h2>
          <p className="text-sm text-gray-500 mt-1">同一客户可以多订单合并出库，同一订单也可以拆成多次发货，最终都会生成真实发货单。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadShippingHub(selectedCustomerName)} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新数据
          </Button>
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={handleExportCurrentList} disabled={filteredShipments.length === 0}>
            <Package className="mr-2 h-4 w-4" /> 导出发货单
          </Button>
        </div>
      </div>

      {pageError ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">发货数据处理失败：{pageError}</div> : null}
      {actionMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div> : null}

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
          <CardTitle className="text-lg font-semibold text-gray-800">客户发货工作台</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 pt-6">
          <div className="grid gap-4 xl:grid-cols-[1fr_auto_auto_auto] xl:items-end">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">选择客户</label>
              <SearchableSelect value={selectedCustomerName} options={customerOptions} placeholder="选择待发货客户" searchPlaceholder="按客户名或订单号检索" emptyText="没有待发货客户" onChange={setSelectedCustomerName} />
            </div>
            <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => fillDraftQuantities('suggested')} disabled={!selectedCustomer}>
              <Sparkles className="mr-2 h-4 w-4" /> 按推荐填充
            </Button>
            <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => fillDraftQuantities('full')} disabled={!selectedCustomer}>
              <Package className="mr-2 h-4 w-4" /> 全量填充
            </Button>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleCreateShipmentDocument()} disabled={!selectedCustomer || isSubmitting || !canDispatchShipment}>
              {isSubmitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />} 生成并出库
            </Button>
          </div>

          {selectedCustomer ? (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">客户</div><div className="mt-1 text-lg font-semibold text-gray-900">{selectedCustomer.customerName}</div></div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">待发货订单</div><div className="mt-1 text-lg font-semibold text-gray-900">{selectedCustomer.totalOrders}</div></div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">待出库总量</div><div className="mt-1 text-lg font-semibold text-gray-900">{selectedCustomer.totalPendingQty}</div></div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">本次出库总量</div><div className="mt-1 text-lg font-semibold text-blue-600">{totalDraftQty}</div></div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">发货备注</label>
                <textarea className="min-h-24 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-blue-500" value={shipmentRemark} onChange={(event) => setShipmentRemark(event.target.value)} placeholder="可填写合单说明、分批出库说明、司机信息等" />
              </div>

              <div className="flex justify-end">
                <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={handlePreviewDraft}>
                  <Eye className="mr-2 h-4 w-4" /> 预览本次发货单
                </Button>
              </div>

              <div className="space-y-4">
                {selectedCustomer.orders.map((order) => (
                  <div key={order.orderId} className="rounded-xl border border-gray-200">
                    <div className="flex flex-col gap-3 border-b border-gray-100 bg-gray-50/60 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">{order.orderId}</div>
                        <div className="mt-1 text-xs text-gray-500">{order.orderChannel} · 期望交付 {order.expectedDeliveryDate}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={statusVariant(order.status)}>{order.status}</Badge>
                        <Badge variant={stockVariant(order.stockStatus)}>{order.stockStatus}</Badge>
                        <span className="text-xs text-gray-500">剩余待出库 {order.remainingQty}</span>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200 text-sm">
                        <thead className="bg-white">
                          <tr>
                            <th className="px-4 py-3 text-left font-semibold text-gray-900">SKU / 商品</th>
                            <th className="px-4 py-3 text-right font-semibold text-gray-900">已订</th>
                            <th className="px-4 py-3 text-right font-semibold text-gray-900">已发</th>
                            <th className="px-4 py-3 text-right font-semibold text-gray-900">预留</th>
                            <th className="px-4 py-3 text-right font-semibold text-gray-900">待发</th>
                            <th className="px-4 py-3 text-right font-semibold text-gray-900">本次出库</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {order.items.map((item) => (
                            <tr key={item.orderItemId}>
                              <td className="px-4 py-4">
                                <div className="font-medium text-gray-900">{item.sku}</div>
                                <div className="mt-1 text-xs text-gray-500">{item.productName}</div>
                              </td>
                              <td className="px-4 py-4 text-right text-gray-700">{item.orderedQty}</td>
                              <td className="px-4 py-4 text-right text-gray-700">{item.shippedQty}</td>
                              <td className="px-4 py-4 text-right text-gray-700">{item.reservedQty}</td>
                              <td className="px-4 py-4 text-right font-semibold text-blue-600">{item.remainingQty}</td>
                              <td className="px-4 py-4">
                                <Input type="number" min="0" max={item.remainingQty} className="w-24 text-right" value={draftQuantities[item.orderItemId] || ''} onChange={(event) => setDraftQuantities((current) => ({ ...current, [item.orderItemId]: event.target.value }))} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-500">
              当前没有待发货客户，或请先从上方客户列表中选择一个客户。
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" /><Input placeholder="搜索发货单号、客户、订单号..." className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">所有状态</option><option value="部分发货">部分发货</option><option value="已发货">已发货</option></select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">发货单号</TableHead><TableHead className="font-semibold text-gray-900">客户</TableHead><TableHead className="font-semibold text-gray-900">关联订单</TableHead><TableHead className="font-semibold text-gray-900 text-center">单据范围</TableHead><TableHead className="font-semibold text-gray-900 text-right">商品数量</TableHead><TableHead className="font-semibold text-gray-900">物流信息</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">正在加载发货单列表...</TableCell></TableRow> : null}
              {!isLoading && filteredShipments.length === 0 ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有发货单记录。</TableCell></TableRow> : null}
              {!isLoading && filteredShipments.map((shipment) => (
                <TableRow key={shipment.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{shipment.id}</TableCell>
                  <TableCell className="text-gray-900">{shipment.customer}</TableCell>
                  <TableCell className="text-gray-500">{shipment.orderIds.join(' / ')}</TableCell>
                  <TableCell className="text-center"><Badge variant={shipment.documentScope === '合并发货' ? 'secondary' : 'outline'}>{shipment.documentScope}</Badge></TableCell>
                  <TableCell className="text-right font-medium text-gray-900">{shipment.items}</TableCell>
                  <TableCell>{shipment.courier !== '-' ? <div className="flex flex-col"><span className="text-sm font-medium text-gray-900">{shipment.courier}</span><span className="text-xs text-gray-500">{shipment.trackingNo}</span></div> : <span className="text-gray-400">-</span>}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewDetail(shipment.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'detail', label: '查看并打印', icon: Eye, onSelect: () => void handleViewDetail(shipment.id) },
                          { id: 'filter-customer', label: '切到该客户工作台', icon: Search, onSelect: () => setSelectedCustomerName(shipment.customer) },
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
