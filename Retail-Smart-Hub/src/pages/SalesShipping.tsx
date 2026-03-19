import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { downloadCsv, downloadTextFile } from '@/lib/export';
import { AlertCircle, Eye, LoaderCircle, Package, RefreshCw, Search, Truck } from 'lucide-react';
import { dispatchShipment, fetchShipmentDetail, fetchShipments } from '@/services/api/shipping';
import type { ShipmentStockStatus, ShippingDetailRecord, ShippingRecord } from '@/types/shipping';

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

export function SalesShipping() {
  const { hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const canDispatchShipment = hasPermission('shipping.dispatch');
  const [shipments, setShipments] = useState<ShippingRecord[]>([]);
  const [selectedShipment, setSelectedShipment] = useState<ShippingDetailRecord | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [activeId, setActiveId] = useState('');
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  const filteredShipments = useMemo(
    () =>
      shipments.filter((shipment) => {
        const matchesSearch =
          !searchTerm ||
          shipment.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          shipment.orderId.toLowerCase().includes(searchTerm.toLowerCase()) ||
          shipment.customer.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = !statusFilter || shipment.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [shipments, searchTerm, statusFilter],
  );

  const dispatchableShipments = useMemo(
    () => filteredShipments.filter((shipment) => shipment.status === '待发货' && shipment.stockStatus === '库存充足'),
    [filteredShipments],
  );

  const loadShipments = async () => {
    setIsLoading(true);
    setPageError('');
    try {
      const response = await fetchShipments();
      setShipments(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadShipments();
  }, []);

  const handleViewDetail = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchShipmentDetail(id);
      setSelectedShipment(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleDispatch = async (id: string) => {
    if (!canDispatchShipment) {
      setPageError('当前角色没有发货权限。');
      return;
    }
    if (!(await confirm('确认发货并扣减库存？'))) return;

    setActiveId(id);
    setActionMessage('');
    setPageError('');
    try {
      const response = await dispatchShipment(id);
      setActionMessage(response.message || '发货已完成。');
      if (selectedShipment?.id === id) {
        await handleViewDetail(id);
      }
      await loadShipments();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleBatchDispatch = async () => {
    if (!canDispatchShipment) {
      setPageError('当前角色没有发货权限。');
      return;
    }
    if (dispatchableShipments.length === 0) {
      setPageError('当前没有可批量发货的记录。');
      return;
    }
    if (!(await confirm(`确认批量发货当前筛选结果中的 ${dispatchableShipments.length} 条记录吗？`))) return;

    setIsBatchRunning(true);
    setPageError('');
    setActionMessage('');
    try {
      for (const shipment of dispatchableShipments) {
        await dispatchShipment(shipment.id);
      }
      setActionMessage(`已完成 ${dispatchableShipments.length} 条发货单的批量发货。`);
      await loadShipments();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsBatchRunning(false);
    }
  };

  const handleBatchPrint = () => {
    const content = filteredShipments
      .map((shipment) =>
        [
          `发货单号：${shipment.id}`,
          `关联订单：${shipment.orderId}`,
          `客户：${shipment.customer}`,
          `件数：${shipment.items}`,
          `状态：${shipment.status}`,
          `物流：${shipment.courier}`,
          `运单号：${shipment.trackingNo}`,
          '---',
        ].join('\n'),
      )
      .join('\n');

    downloadTextFile('shipping-batch-print.txt', content || '当前没有发货单数据。');
    downloadCsv(
      'shipping-list.csv',
      [
        { header: '发货单号', value: (item) => item.id },
        { header: '关联订单', value: (item) => item.orderId },
        { header: '客户', value: (item) => item.customer },
        { header: '件数', value: (item) => item.items },
        { header: '发货状态', value: (item) => item.status },
        { header: '库存状态', value: (item) => item.stockStatus },
        { header: '物流公司', value: (item) => item.courier },
        { header: '运单号', value: (item) => item.trackingNo },
      ],
      filteredShipments,
    );
    setActionMessage(`已导出 ${filteredShipments.length} 条发货记录。`);
  };

  const handleViewLogistics = async (shipment: ShippingRecord) => {
    const info = `物流公司：${shipment.courier}\n运单号：${shipment.trackingNo}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(info);
        setActionMessage(`已复制 ${shipment.id} 的物流信息。`);
        return;
      }
    } catch {
      // ignore clipboard failures and fall back to alert
    }

    window.alert(info);
  };

  const handleFilterCustomer = (customer: string) => {
    setSearchTerm(customer);
    setActionMessage(`已按客户 ${customer} 筛选发货列表。`);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">销售发货</h2>
          <p className="text-sm text-gray-500 mt-1">发货单列表已接入真实后端数据，支持批量打单、批量发货和查看发货详情。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadShipments()} disabled={isLoading}><RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新列表</Button>
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={handleBatchPrint} disabled={filteredShipments.length === 0}><Package className="mr-2 h-4 w-4" /> 批量打单</Button>
          <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleBatchDispatch()} disabled={isBatchRunning || dispatchableShipments.length === 0 || !canDispatchShipment} title={!canDispatchShipment ? '当前角色没有发货权限' : undefined}>{isBatchRunning ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />} 批量发货</Button>
        </div>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">发货数据处理失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      {(selectedShipment || isDetailLoading) && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <CardTitle className="text-lg font-semibold text-gray-800 flex items-center justify-between gap-3">
              <span>发货详情</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedShipment(null)}>关闭</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载发货详情...</div> : null}
            {selectedShipment ? (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">发货单 / 订单</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedShipment.id}</div><div className="mt-1 text-xs text-gray-500">{selectedShipment.orderId}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">客户 / 渠道</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedShipment.customer}</div><div className="mt-1 text-xs text-gray-500">{selectedShipment.orderChannel}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">物流信息</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedShipment.courier}</div><div className="mt-1 text-xs text-gray-500">{selectedShipment.trackingNo}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">状态</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedShipment.status}</div><div className="mt-1 text-xs text-gray-500">发货时间：{selectedShipment.shippedAt || '-'}</div></div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">发货明细</h3>
                  {selectedShipment.itemsDetail.map((item) => (
                    <div key={`${selectedShipment.id}-${item.sku}`} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{item.productName}</div>
                          <div className="mt-1 text-xs text-gray-500">{item.sku}</div>
                        </div>
                        <div className="text-right text-sm font-medium text-gray-900">发货 {item.quantity}</div>
                      </div>
                    </div>
                  ))}
                  {selectedShipment.remark ? <div className="rounded-lg border border-gray-200 p-4 text-sm text-gray-700"><div className="mb-2 font-semibold text-gray-900">备注</div>{selectedShipment.remark}</div> : null}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" /><Input placeholder="搜索发货单号、订单号、客户..." className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">所有状态</option><option value="待发货">待发货</option><option value="已发货">已发货</option></select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">发货单号</TableHead><TableHead className="font-semibold text-gray-900">关联订单</TableHead><TableHead className="font-semibold text-gray-900">客户名称</TableHead><TableHead className="font-semibold text-gray-900 text-right">商品数量</TableHead><TableHead className="font-semibold text-gray-900 text-center">发货状态</TableHead><TableHead className="font-semibold text-gray-900 text-center">库存状态</TableHead><TableHead className="font-semibold text-gray-900">物流信息</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载发货单列表...</TableCell></TableRow>}
              {!isLoading && filteredShipments.length === 0 && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有发货单记录。</TableCell></TableRow>}
              {!isLoading && filteredShipments.map((shipment) => (
                <TableRow key={shipment.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{shipment.id}</TableCell>
                  <TableCell className="text-gray-500">{shipment.orderId}</TableCell>
                  <TableCell className="text-gray-900">{shipment.customer}</TableCell>
                  <TableCell className="text-right font-medium text-gray-900">{shipment.items}</TableCell>
                  <TableCell className="text-center"><Badge variant={statusVariant(shipment.status)}>{shipment.status}</Badge></TableCell>
                  <TableCell className="text-center">{shipment.stockStatus !== '-' ? <Badge variant={stockVariant(shipment.stockStatus)} className={shipment.stockStatus === '库存充足' ? 'text-green-600 border-green-200 bg-green-50' : ''}>{shipment.stockStatus === '待补货' && <AlertCircle className="h-3 w-3 mr-1 inline" />}{shipment.stockStatus}</Badge> : <span className="text-gray-400">-</span>}</TableCell>
                  <TableCell>{shipment.courier !== '-' ? <div className="flex flex-col"><span className="text-sm font-medium text-gray-900">{shipment.courier}</span><span className="text-xs text-gray-500">{shipment.trackingNo}</span></div> : <span className="text-gray-400">-</span>}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewDetail(shipment.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'detail', label: '查看详情', icon: Eye, onSelect: () => void handleViewDetail(shipment.id) },
                          { id: 'filter-customer', label: '按客户筛选', icon: Search, onSelect: () => handleFilterCustomer(shipment.customer) },
                          { id: 'view-logistics', label: '查看物流', icon: Truck, onSelect: () => void handleViewLogistics(shipment), disabled: shipment.courier === '-' },
                          { id: 'dispatch', label: '确认发货', icon: Truck, onSelect: () => void handleDispatch(shipment.id), disabled: shipment.status !== '待发货' || shipment.stockStatus !== '库存充足' || activeId === shipment.id || !canDispatchShipment },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/30 rounded-b-xl"><div className="text-sm text-gray-500">当前显示 {filteredShipments.length} 条发货单记录，可批量发货 {dispatchableShipments.length} 条</div>{isLoading && <LoaderCircle className="h-4 w-4 animate-spin text-gray-400" />}</div>
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  );
}
