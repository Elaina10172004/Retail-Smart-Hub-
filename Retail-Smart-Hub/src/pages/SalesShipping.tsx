import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, Hourglass, LoaderCircle, Package, RefreshCw, Search, Truck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Pagination } from '@/components/ui/pagination';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { DocumentPreviewModal } from '@/components/documents/DocumentPreviewModal';
import { DocumentKpiCard } from '@/components/documents/DocumentKpiCard';
import { DocumentRecordTable } from '@/components/documents/DocumentRecordTable';
import { DocumentSectionCard } from '@/components/documents/DocumentSectionCard';
import { DocumentWorkspaceShell } from '@/components/documents/DocumentWorkspaceShell';
import { useAuth } from '@/auth/AuthContext';
import { buildShippingDocument } from '@/lib/documents';
import { downloadCsv } from '@/lib/export';
import { matchesSearchQuery } from '@/lib/search';
import { createShipmentDocument, fetchShipmentDetail, fetchShipmentsPaginated, fetchShippingWorkbench } from '@/services/api/shipping';
import type { DocumentPreviewRecord } from '@/types/documents';
import type { PaginatedData } from '@/types/api';
import type { CreateShipmentDocumentPayload, ShipmentStockStatus, ShippingDetailRecord, ShippingRecord, ShippingWorkbenchCustomer, ShippingWorkbenchItem, ShippingWorkbenchOrder } from '@/types/shipping';

const PAGE_SIZE = 20;

type SelectedRow = ShippingWorkbenchItem & {
  orderId: string;
  customer: string;
  orderChannel: string;
};

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
  if (unique.length !== 1) return '综合配送';
  if (unique[0] === '线上商城') return '顺丰速运';
  if (unique[0] === '企业团购') return '德邦物流';
  return '门店配送';
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function formatDraftDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function buildDraftDocumentNo(prefix: string) {
  const now = new Date();
  return `${prefix}-DRAFT-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

export function SalesShipping() {
  const { hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const canDispatchShipment = hasPermission('shipping.dispatch');
  const [shipmentsData, setShipmentsData] = useState<PaginatedData<ShippingRecord> | null>(null);
  const [workbenchCustomers, setWorkbenchCustomers] = useState<ShippingWorkbenchCustomer[]>([]);
  const [customerFilter, setCustomerFilter] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [isCustomerFilterVisible, setIsCustomerFilterVisible] = useState(false);
  const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([]);
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [draftQuantities, setDraftQuantities] = useState<Record<string, string>>({});
  const [shipmentRemark, setShipmentRemark] = useState('');
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(false);
  const [shippingDraftNo, setShippingDraftNo] = useState('');
  const [shippingDraftAt, setShippingDraftAt] = useState('');
  const [previewDocuments, setPreviewDocuments] = useState<DocumentPreviewRecord[]>([]);
  const [previewInitialId, setPreviewInitialId] = useState('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const shipments = shipmentsData?.items ?? [];

  const workbenchOrders = useMemo(() => workbenchCustomers.flatMap((customer) => customer.orders), [workbenchCustomers]);
  const itemMap = useMemo(
    () => new Map(workbenchOrders.flatMap((order) => order.items.map((item) => [item.orderItemId, { ...item, orderId: order.orderId, customer: order.customer, orderChannel: order.orderChannel }]))),
    [workbenchOrders],
  );
  const customerOptions = useMemo(
    () => [{ value: '', label: '全部客户', keywords: [], description: `${workbenchOrders.length} 张待发货订单` }, ...workbenchCustomers.map((customer) => ({ value: customer.customerName, label: customer.customerName, keywords: customer.orders.map((order) => order.orderId), description: `${customer.totalOrders} 张待发货订单 / ${customer.totalPendingQty} 件待出库` }))],
    [workbenchCustomers, workbenchOrders.length],
  );
  const filteredWorkbenchOrders = useMemo(() => {
    return workbenchOrders.filter((order) => {
      const matchesCustomer = !customerFilter || order.customer === customerFilter;
      const matchesSearch = matchesSearchQuery(orderSearch, [
        order.orderId,
        order.customer,
        ...order.items.flatMap((item) => [item.sku, item.productName]),
      ]);
      return matchesCustomer && matchesSearch;
    });
  }, [customerFilter, orderSearch, workbenchOrders]);
  const filteredShipments = shipments;
  const visibleItemIds = useMemo(() => filteredWorkbenchOrders.flatMap((order) => order.items.map((item) => item.orderItemId)), [filteredWorkbenchOrders]);
  const selectedItemIds = useMemo(() => Object.entries(selectedItems).filter(([id, checked]) => checked && itemMap.has(id)).map(([id]) => id), [itemMap, selectedItems]);
  const selectedCustomerNames = useMemo(() => Array.from(new Set(selectedItemIds.map((id) => itemMap.get(id)?.customer).filter(Boolean) as string[])), [itemMap, selectedItemIds]);
  const selectedCustomerLock = selectedCustomerNames[0] || '';
  const visibleCustomerNames = useMemo(() => Array.from(new Set(filteredWorkbenchOrders.map((order) => order.customer))), [filteredWorkbenchOrders]);
  const totalSelectedQty = useMemo(() => selectedItemIds.reduce((sum, id) => sum + Number(draftQuantities[id] || 0), 0), [draftQuantities, selectedItemIds]);
  const areAllVisibleSelected = useMemo(() => visibleItemIds.length > 0 && visibleItemIds.every((id) => selectedItems[id]), [selectedItems, visibleItemIds]);
  const canBulkSelectVisible = useMemo(() => visibleCustomerNames.length === 1 && (!selectedCustomerLock || selectedCustomerLock === visibleCustomerNames[0]), [selectedCustomerLock, visibleCustomerNames]);
  const showCustomerFilter = isCustomerFilterVisible || Boolean(customerFilter);

  const loadShippingHub = async () => {
    setIsLoading(true);
    setPageError('');
    try {
      const [shipmentsResponse, workbenchResponse] = await Promise.all([
        fetchShipmentsPaginated({ page: historyPage, pageSize: PAGE_SIZE, search: historySearch, status: statusFilter }),
        fetchShippingWorkbench(),
      ]);
      setShipmentsData(shipmentsResponse.data);
      setWorkbenchCustomers(workbenchResponse.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setHistoryPage(1);
  }, [historySearch, statusFilter]);

  useEffect(() => { void loadShippingHub(); }, [historyPage, historySearch, statusFilter]);

  const openPreview = (documents: DocumentPreviewRecord[], activeId?: string) => {
    if (documents.length === 0) return;
    setPreviewDocuments(documents);
    setPreviewInitialId(activeId || documents[0]?.id || '');
    setIsPreviewOpen(true);
  };

  const toggleOrderExpanded = (orderId: string) => setExpandedOrderIds((current) => current.includes(orderId) ? current.filter((item) => item !== orderId) : [...current, orderId]);

  const setOrderSelection = (order: ShippingWorkbenchOrder, checked: boolean) => {
    if (checked && selectedCustomerLock && selectedCustomerLock !== order.customer) {
      setPageError(`一次发货只能选择同一客户的订单，当前已锁定客户为 ${selectedCustomerLock}。`);
      return;
    }
    const nextSelected = { ...selectedItems };
    const nextQuantities = { ...draftQuantities };
    order.items.forEach((item) => {
      nextSelected[item.orderItemId] = checked;
      nextQuantities[item.orderItemId] = checked ? nextQuantities[item.orderItemId] || String(item.remainingQty) : '';
    });
    setPageError('');
    setSelectedItems(nextSelected);
    setDraftQuantities(nextQuantities);
  };

  const setItemSelection = (item: ShippingWorkbenchItem, order: ShippingWorkbenchOrder, checked: boolean) => {
    if (checked && selectedCustomerLock && selectedCustomerLock !== order.customer) {
      setPageError(`一次发货只能选择同一客户的订单，当前已锁定客户为 ${selectedCustomerLock}。`);
      return;
    }
    setPageError('');
    setSelectedItems((current) => ({ ...current, [item.orderItemId]: checked }));
    setDraftQuantities((current) => ({ ...current, [item.orderItemId]: checked ? current[item.orderItemId] || String(item.remainingQty) : '' }));
    if (checked) setExpandedOrderIds((current) => current.includes(order.orderId) ? current : [...current, order.orderId]);
  };

  const toggleSelectAllVisible = () => {
    if (!areAllVisibleSelected && !canBulkSelectVisible) {
      setPageError('请先筛选到单个客户后再全选。');
      return;
    }
    const nextSelected = { ...selectedItems };
    const nextQuantities = { ...draftQuantities };
    filteredWorkbenchOrders.forEach((order) => order.items.forEach((item) => {
      nextSelected[item.orderItemId] = !areAllVisibleSelected;
      nextQuantities[item.orderItemId] = !areAllVisibleSelected ? nextQuantities[item.orderItemId] || String(item.remainingQty) : '';
    }));
    setPageError('');
    setSelectedItems(nextSelected);
    setDraftQuantities(nextQuantities);
  };

  const clearSelection = () => {
    setPageError('');
    setSelectedItems({});
    setDraftQuantities({});
    setShipmentRemark('');
  };

  const handleQuantityChange = (item: ShippingWorkbenchItem, order: ShippingWorkbenchOrder, rawValue: string) => {
    if (rawValue === '') {
      setDraftQuantities((current) => ({ ...current, [item.orderItemId]: '' }));
      setSelectedItems((current) => ({ ...current, [item.orderItemId]: false }));
      return;
    }
    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) return;
    if (numericValue > 0 && selectedCustomerLock && selectedCustomerLock !== order.customer) {
      setPageError(`一次发货只能选择同一客户的订单，当前已锁定客户为 ${selectedCustomerLock}。`);
      return;
    }
    const normalizedValue = Math.max(0, Math.min(item.remainingQty, Math.floor(numericValue)));
    setPageError('');
    setDraftQuantities((current) => ({ ...current, [item.orderItemId]: normalizedValue > 0 ? String(normalizedValue) : '' }));
    setSelectedItems((current) => ({ ...current, [item.orderItemId]: normalizedValue > 0 }));
    if (normalizedValue > 0) setExpandedOrderIds((current) => current.includes(order.orderId) ? current : [...current, order.orderId]);
  };

  const isOrderFullySelected = (order: ShippingWorkbenchOrder) => order.items.length > 0 && order.items.every((item) => selectedItems[item.orderItemId]);
  const getSelectedItemCount = (order: ShippingWorkbenchOrder) => order.items.filter((item) => selectedItems[item.orderItemId]).length;
  const getSelectedQtyForOrder = (order: ShippingWorkbenchOrder) => order.items.reduce((sum, item) => sum + Number(draftQuantities[item.orderItemId] || 0), 0);

  const buildSelectedRows = (): SelectedRow[] => selectedItemIds.map((id) => itemMap.get(id)).filter(Boolean).map((item) => item as SelectedRow).filter((item) => Number(draftQuantities[item.orderItemId] || 0) > 0);

  const buildDraftPayload = (): CreateShipmentDocumentPayload | null => {
    const selectedRows = buildSelectedRows();
    if (selectedRows.length === 0) {
      setPageError('请至少勾选一条商品并填写本次出库数量。');
      return null;
    }
    const customers = Array.from(new Set(selectedRows.map((item) => item.customer)));
    if (customers.length !== 1) {
      setPageError('一次发货只能生成同一客户的发货单。');
      return null;
    }
    const orders = new Map<string, Array<{ orderItemId: string; quantity: number }>>();
    for (const row of selectedRows) {
      const quantity = Number(draftQuantities[row.orderItemId] || 0);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > row.remainingQty) {
        setPageError('本次出库数量必须是大于 0 的整数，且不能超过待出库数量。');
        return null;
      }
      const current = orders.get(row.orderId) || [];
      current.push({ orderItemId: row.orderItemId, quantity });
      orders.set(row.orderId, current);
    }
    return { customerName: customers[0], remark: shipmentRemark.trim() || undefined, orders: Array.from(orders.entries()).map(([orderId, items]) => ({ orderId, items })) };
  };

  const buildDraftPreview = (): ShippingDetailRecord | null => {
    const payload = buildDraftPayload();
    if (!payload) return null;
    const rows = buildSelectedRows();
    const orderIds = Array.from(new Set(rows.map((item) => item.orderId)));
    const orderChannels = Array.from(new Set(rows.map((item) => item.orderChannel)));
    return { id: 'DRAFT-SHIPMENT', orderId: orderIds[0] || '-', orderIds, orderCount: orderIds.length, documentScope: orderIds.length > 1 ? '合并发货' : '单订单', customer: payload.customerName, items: rows.reduce((sum, item) => sum + Number(draftQuantities[item.orderItemId] || 0), 0), status: '待发货', stockStatus: '-', courier: inferDraftCourier(orderChannels), trackingNo: '-', createdAt: new Date().toISOString(), shippedAt: new Date().toISOString(), orderChannel: orderChannels.join(' / ') || '-', orderChannels, remark: shipmentRemark.trim() || undefined, itemsDetail: rows.map((item) => ({ orderId: item.orderId, sku: item.sku, productName: item.productName, quantity: Number(draftQuantities[item.orderItemId] || 0) })) };
  };

  const handlePreviewDraft = () => {
    const draft = buildDraftPreview();
    if (draft) openPreview([buildShippingDocument(draft)], draft.id);
  };

  const handleCreateShipmentDocument = async () => {
    if (!canDispatchShipment) {
      setPageError('当前角色没有发货权限。');
      return;
    }
    const payload = buildDraftPayload();
    if (!payload) return;
    if (!(await confirm(`确认按当前选择为客户 ${payload.customerName} 生成发货单并出库吗？`))) return;
    setIsSubmitting(true);
    setPageError('');
    setActionMessage('');
    try {
      const response = await createShipmentDocument(payload);
      const detailResponse = await fetchShipmentDetail(response.data.id);
      openPreview([buildShippingDocument(detailResponse.data)], detailResponse.data.id);
      setActionMessage(response.message || '发货单已生成并完成出库。');
      clearSelection();
      await loadShippingHub();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
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

  const handleExportCurrentList = () => {
    downloadCsv('shipping-documents.csv', [
      { header: '发货单号', value: (item) => item.id },
      { header: '客户', value: (item) => item.customer },
      { header: '订单数量', value: (item) => item.orderCount },
      { header: '关联订单', value: (item) => item.orderIds.join(' / ') },
      { header: '发货范围', value: (item) => item.documentScope },
      { header: '商品件数', value: (item) => item.items },
      { header: '物流公司', value: (item) => item.courier },
      { header: '运单号', value: (item) => item.trackingNo },
    ], filteredShipments);
    setActionMessage(`已导出 ${filteredShipments.length} 条发货单。`);
  };
  return (
    <DocumentWorkspaceShell
      title="销售发货"
      actions={
        <>
          <Button variant="outline" className="border-gray-300 text-gray-700 shadow-sm hover:bg-gray-50" onClick={() => void loadShippingHub()} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />刷新数据
          </Button>
          <Button variant="outline" className="border-gray-300 text-gray-700 shadow-sm hover:bg-gray-50" onClick={handleExportCurrentList} disabled={filteredShipments.length === 0}>
            <Package className="mr-2 h-4 w-4" />导出发货单
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => { setShippingDraftNo(buildDraftDocumentNo('SHP')); setShippingDraftAt(formatDraftDateTime()); setIsWorkbenchOpen(true); }}>
            <Truck className="mr-2 h-4 w-4" />创建发货单
          </Button>
        </>
      }
      pageError={pageError ? `发货数据处理失败：${pageError}` : ''}
      actionMessage={actionMessage}
      workspaceHeaderFields={
        isWorkbenchOpen
          ? [
              { label: '单号', value: shippingDraftNo || 'SHP-DRAFT', emphasize: true },
              { label: '时间', value: shippingDraftAt || formatDraftDateTime() },
              { label: '状态', value: '草稿', emphasize: true },
              { label: '客户', value: selectedCustomerLock || '未选择' },
            ]
          : undefined
      }
    >
      {isWorkbenchOpen ? (
      <DocumentSectionCard
        title={
          <div className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-blue-600" />
            发货工作台
          </div>
        }
        actions={
          <>
            <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => setIsWorkbenchOpen(false)}>
              关闭工作区
            </Button>
            <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={toggleSelectAllVisible} disabled={filteredWorkbenchOrders.length === 0 || (!areAllVisibleSelected && !canBulkSelectVisible)} title={!areAllVisibleSelected && !canBulkSelectVisible ? '请先筛选到单个客户后再全选' : undefined}>{areAllVisibleSelected ? '取消全选当前结果' : '全选当前结果'}</Button>
            <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={clearSelection} disabled={selectedItemIds.length === 0 && !shipmentRemark}>清空勾选</Button>
            <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={handlePreviewDraft} disabled={selectedItemIds.length === 0}><Eye className="mr-2 h-4 w-4" />预览发货单</Button>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleCreateShipmentDocument()} disabled={!canDispatchShipment || isSubmitting || selectedItemIds.length === 0}>{isSubmitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}生成并出库</Button>
          </>
        }
        bodyClassName="space-y-4 p-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Button type="button" variant="outline" className={`h-10 w-10 border-gray-300 p-0 text-gray-700 hover:bg-gray-50 ${showCustomerFilter ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100' : ''}`} title="按客户筛选" onClick={() => setIsCustomerFilterVisible((current) => !current)}>
            <Hourglass className="h-4 w-4" />
          </Button>
          {showCustomerFilter ? <div className="min-w-[260px] flex-1 xl:max-w-[320px]"><SearchableSelect value={customerFilter} options={customerOptions} placeholder="筛选单个客户" searchPlaceholder="按客户名或订单号检索" emptyText="没有待发货客户" onChange={(value) => setCustomerFilter(value)} /></div> : null}
          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input value={orderSearch} onChange={(event) => setOrderSearch(event.target.value)} placeholder="按订单号、SKU、商品名检索" className="pl-9" />
          </div>
          {customerFilter ? <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">当前客户：{customerFilter}</div> : null}
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <DocumentKpiCard label="当前可见订单" value={filteredWorkbenchOrders.length} />
          <DocumentKpiCard label="当前可见商品行" value={visibleItemIds.length} />
          <DocumentKpiCard label="已选订单" value={Array.from(new Set(selectedItemIds.map((id) => itemMap.get(id)?.orderId).filter(Boolean))).length} />
          <DocumentKpiCard label="已选商品行" value={selectedItemIds.length} />
          <DocumentKpiCard label="本次出库总量" value={totalSelectedQty} />
        </div>

        {selectedCustomerLock ? <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">当前勾选已锁定客户：{selectedCustomerLock}</div> : null}
        <div className="space-y-2"><label className="text-sm font-medium text-gray-700">发货备注</label><textarea className="min-h-20 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-blue-500" value={shipmentRemark} onChange={(event) => setShipmentRemark(event.target.value)} placeholder="可填写合单说明、分批出库说明、司机信息等" /></div>
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <Table>
              <TableHeader><TableRow className="bg-gray-50/70 hover:bg-gray-50/70"><TableHead className="w-16 text-center font-semibold text-gray-900">勾选</TableHead><TableHead className="font-semibold text-gray-900">订单号</TableHead><TableHead className="font-semibold text-gray-900">客户</TableHead><TableHead className="font-semibold text-gray-900">渠道</TableHead><TableHead className="font-semibold text-gray-900">期望交付</TableHead><TableHead className="text-center font-semibold text-gray-900">订单状态</TableHead><TableHead className="text-center font-semibold text-gray-900">库存状态</TableHead><TableHead className="text-right font-semibold text-gray-900">待发数量</TableHead><TableHead className="font-semibold text-gray-900">本次勾选</TableHead><TableHead className="w-12 text-center font-semibold text-gray-900">展开</TableHead></TableRow></TableHeader>
              <TableBody>
                {isLoading ? <TableRow><TableCell colSpan={10} className="h-24 text-center text-sm text-gray-500">正在加载待发货订单...</TableCell></TableRow> : null}
                {!isLoading && filteredWorkbenchOrders.length === 0 ? <TableRow><TableCell colSpan={10} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有待发货订单。</TableCell></TableRow> : null}
                {!isLoading && filteredWorkbenchOrders.map((order) => {
                  const isExpanded = expandedOrderIds.includes(order.orderId);
                  const selectedCount = getSelectedItemCount(order);
                  const selectedQty = getSelectedQtyForOrder(order);
                  return <React.Fragment key={order.orderId}>
                    <TableRow className={(selectedCustomerLock && selectedCustomerLock !== order.customer) ? 'cursor-not-allowed opacity-50 bg-gray-50/30 hover:bg-gray-50/30' : selectedCount > 0 ? 'bg-blue-50/40 hover:bg-blue-50/50' : 'hover:bg-gray-50/80'}>
                      <TableCell className="text-center"><input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" checked={isOrderFullySelected(order)} onChange={(event) => setOrderSelection(order, event.target.checked)} disabled={!!(selectedCustomerLock && selectedCustomerLock !== order.customer)} aria-label={`勾选订单 ${order.orderId}`} /></TableCell>
                      <TableCell className="font-medium text-blue-600">{order.orderId}</TableCell>
                      <TableCell className="text-gray-900">{order.customer}</TableCell>
                      <TableCell className="text-gray-600">{order.orderChannel}</TableCell>
                      <TableCell className="text-gray-600">{order.expectedDeliveryDate}</TableCell>
                      <TableCell className="text-center"><Badge variant={statusVariant(order.status)}>{order.status}</Badge></TableCell>
                      <TableCell className="text-center"><Badge variant={stockVariant(order.stockStatus)}>{order.stockStatus}</Badge></TableCell>
                      <TableCell className="text-right font-medium text-gray-900">{order.remainingQty}</TableCell>
                      <TableCell><div className="text-sm font-medium text-gray-900">{selectedCount}/{order.items.length} 项</div><div className="text-xs text-gray-500">{selectedQty} 件</div></TableCell>
                      <TableCell className="px-2 text-center"><button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900" onClick={() => toggleOrderExpanded(order.orderId)} aria-label={isExpanded ? `收起订单 ${order.orderId}` : `展开订单 ${order.orderId}`}>{isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></TableCell>
                    </TableRow>
                    {isExpanded ? <TableRow className="bg-gray-50/60 hover:bg-gray-50/60"><TableCell colSpan={10} className="p-0"><div className="border-t border-gray-200 bg-white"><div className="overflow-x-auto"><table className="min-w-full border-collapse text-sm"><thead className="bg-gray-50"><tr><th className="w-16 px-4 py-3 text-center text-xs font-semibold text-gray-600">勾选</th><th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">商品</th><th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">已订</th><th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">已发</th><th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">预留</th><th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">待发</th><th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">本次出库</th></tr></thead><tbody>{order.items.map((item) => { const isSelected = Boolean(selectedItems[item.orderItemId]); return <tr key={item.orderItemId} className={isSelected ? 'bg-blue-50/40' : (selectedCustomerLock && selectedCustomerLock !== order.customer) ? 'border-t border-gray-100 opacity-50' : 'border-t border-gray-100'}><td className="px-4 py-3 text-center"><input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" checked={isSelected} onChange={(event) => setItemSelection(item, order, event.target.checked)} disabled={!!(selectedCustomerLock && selectedCustomerLock !== order.customer)} aria-label={`勾选商品 ${item.productName}`} /></td><td className="px-4 py-3"><div className="font-medium text-gray-900">{item.productName}</div><div className="mt-1 text-xs text-gray-500">{item.sku}</div></td><td className="px-4 py-3 text-right text-gray-700">{item.orderedQty}</td><td className="px-4 py-3 text-right text-gray-700">{item.shippedQty}</td><td className="px-4 py-3 text-right text-gray-700">{item.reservedQty}</td><td className="px-4 py-3 text-right font-medium text-blue-700">{item.remainingQty}</td><td className="px-4 py-3"><div className="ml-auto w-24"><Input type="number" min="0" max={item.remainingQty} value={draftQuantities[item.orderItemId] || ''} className="h-9 text-right" onChange={(event) => handleQuantityChange(item, order, event.target.value)} /></div></td></tr>; })}</tbody></table></div></div></TableCell></TableRow> : null}
                  </React.Fragment>;
                })}
              </TableBody>
            </Table>
          </div>
      </DocumentSectionCard>
      ) : null}

      <DocumentRecordTable
        title="发货单记录"
        filters={
          <>
            <div className="relative min-w-[260px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="搜索发货单号、客户、订单号" className="pl-9" />
            </div>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-10 min-w-[140px] rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"><option value="">所有状态</option><option value="部分发货">部分发货</option><option value="已发货">已发货</option></select>
          </>
        }
      >
          <Table>
            <TableHeader><TableRow className="bg-gray-50/70 hover:bg-gray-50/70"><TableHead className="font-semibold text-gray-900">发货单号</TableHead><TableHead className="font-semibold text-gray-900">客户</TableHead><TableHead className="font-semibold text-gray-900">关联订单</TableHead><TableHead className="text-center font-semibold text-gray-900">范围</TableHead><TableHead className="text-center font-semibold text-gray-900">状态</TableHead><TableHead className="text-right font-semibold text-gray-900">商品件数</TableHead><TableHead className="font-semibold text-gray-900">创建时间</TableHead><TableHead className="font-semibold text-gray-900">物流信息</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={9} className="h-24 text-center text-sm text-gray-500">正在加载发货单列表...</TableCell></TableRow> : null}
              {!isLoading && filteredShipments.length === 0 ? <TableRow><TableCell colSpan={9} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有发货单记录。</TableCell></TableRow> : null}
              {!isLoading && filteredShipments.map((shipment) => <TableRow key={shipment.id} className="transition-colors hover:bg-blue-50/30"><TableCell className="font-medium text-blue-600">{shipment.id}</TableCell><TableCell className="text-gray-900">{shipment.customer}</TableCell><TableCell className="text-gray-500">{shipment.orderIds.join(' / ')}</TableCell><TableCell className="text-center"><Badge variant={shipment.documentScope === '合并发货' ? 'secondary' : 'outline'}>{shipment.documentScope}</Badge></TableCell><TableCell className="text-center"><Badge variant={statusVariant(shipment.status)}>{shipment.status}</Badge></TableCell><TableCell className="text-right font-medium text-gray-900">{shipment.items}</TableCell><TableCell className="text-gray-500">{shipment.createdAt || '-'}</TableCell><TableCell>{shipment.courier !== '-' ? <div className="flex flex-col"><span className="text-sm font-medium text-gray-900">{shipment.courier}</span><span className="text-xs text-gray-500">{shipment.trackingNo}</span></div> : <span className="text-gray-400">-</span>}</TableCell><TableCell className="text-right"><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => void handleViewDetail(shipment.id)}><Eye className="mr-1 h-4 w-4" />查看</Button></div></TableCell></TableRow>)}
            </TableBody>
          </Table>
          {shipmentsData ? (
            <div className="border-t border-gray-100 px-4">
              <Pagination
                page={shipmentsData.page}
                totalPages={shipmentsData.totalPages}
                total={shipmentsData.total}
                pageSize={shipmentsData.pageSize}
                onPageChange={setHistoryPage}
              />
            </div>
          ) : null}
      </DocumentRecordTable>

      <DocumentPreviewModal documents={previewDocuments} isOpen={isPreviewOpen} initialActiveId={previewInitialId} onClose={() => setIsPreviewOpen(false)} />
      {confirmDialog}
    </DocumentWorkspaceShell>
  );
}
