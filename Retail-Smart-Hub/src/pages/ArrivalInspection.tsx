import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { ArrowRight, CheckCircle2, Eye, Filter, LoaderCircle, PackageCheck, RefreshCw, Search } from 'lucide-react';
import { advanceArrival, fetchArrivalDetail, fetchArrivals } from '@/services/api/arrival';
import type { ArrivalDetailRecord, ArrivalRecord } from '@/types/arrival';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function badgeVariant(status: string) {
  if (status === '待验收') return 'warning';
  if (status === '已验收待入库') return 'default';
  if (status === '部分到货') return 'secondary';
  return 'success';
}

export function ArrivalInspection() {
  const { hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const canManageArrival = hasPermission('procurement.manage');
  const [arrivals, setArrivals] = useState<ArrivalRecord[]>([]);
  const [selectedArrival, setSelectedArrival] = useState<ArrivalDetailRecord | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [activeId, setActiveId] = useState('');

  const filteredArrivals = useMemo(
    () =>
      arrivals.filter((item) => {
        const matchesSearch =
          !searchTerm ||
          item.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.poId.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.supplier.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = !statusFilter || item.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [arrivals, searchTerm, statusFilter],
  );

  const loadArrivals = async () => {
    setIsLoading(true);
    setPageError('');
    try {
      const response = await fetchArrivals();
      setArrivals(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadArrivals();
  }, []);

  const handleViewDetail = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchArrivalDetail(id);
      setSelectedArrival(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleAdvance = async (id: string) => {
    if (!canManageArrival) {
      setPageError('当前角色没有到货处理权限。');
      return;
    }
    if (!(await confirm('确认推进当前到货记录状态？'))) {
      return;
    }

    setActiveId(id);
    setActionMessage('');
    setPageError('');
    try {
      const response = await advanceArrival(id);
      setActionMessage(response.message || '到货记录已推进。');
      if (selectedArrival?.id === id) {
        await handleViewDetail(id);
      }
      await loadArrivals();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleFilterSupplier = (supplier: string) => {
    setSearchTerm(supplier);
    setActionMessage(`已按供应商 ${supplier} 筛选到货列表。`);
  };

  const handleFilterStatus = (status: string) => {
    setStatusFilter(status);
    setActionMessage(`已按状态 ${status} 筛选到货列表。`);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">到货验收与入库</h2>
          <p className="text-sm text-gray-500 mt-1">到货验收已接入真实后端数据，可查看收货详情并推进验收状态。</p>
        </div>
        <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadArrivals()} disabled={isLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新列表
        </Button>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">到货数据处理失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      {(selectedArrival || isDetailLoading) && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <CardTitle className="text-lg font-semibold text-gray-800 flex items-center justify-between gap-3">
              <span>到货详情</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedArrival(null)}>
                关闭
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载到货详情...</div> : null}
            {selectedArrival ? (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">收货单 / 采购单</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedArrival.id}</div><div className="mt-1 text-xs text-gray-500">{selectedArrival.poId}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">供应商</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedArrival.supplier}</div><div className="mt-1 text-xs text-gray-500">到货日期：{selectedArrival.arrivedAt}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">数量概览</div><div className="mt-1 text-sm font-semibold text-gray-900">实到 {selectedArrival.arrivedQty} / 应到 {selectedArrival.expectedQty}</div><div className="mt-1 text-xs text-gray-500">合格 {selectedArrival.qualifiedQty} / 异常 {selectedArrival.defectQty}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">当前状态</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedArrival.status}</div><div className="mt-1 text-xs text-gray-500">明细行数：{selectedArrival.items.length}</div></div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">收货明细</h3>
                  {selectedArrival.items.map((item) => (
                    <div key={item.id} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{item.productName}</div>
                          <div className="mt-1 text-xs text-gray-500">{item.sku}</div>
                        </div>
                        <div className="text-right text-sm text-gray-700">
                          <div>应到 {item.expectedQty} / 实到 {item.arrivedQty}</div>
                          <div className="mt-1 text-xs text-gray-500">合格 {item.qualifiedQty} / 异常 {item.defectQty}</div>
                        </div>
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
          <div className="flex flex-col items-center"><div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 border-2 border-blue-200"><PackageCheck className="h-6 w-6" /></div><span className="text-sm font-medium mt-2 text-blue-900">1. 确认到货</span></div>
          <div className="h-1 w-16 bg-blue-100 rounded"></div>
          <div className="flex flex-col items-center"><div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 border-2 border-blue-200"><CheckCircle2 className="h-6 w-6" /></div><span className="text-sm font-medium mt-2 text-blue-900">2. 质量验收</span></div>
          <div className="h-1 w-16 bg-blue-100 rounded"></div>
          <div className="flex flex-col items-center"><div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 border-2 border-blue-200"><ArrowRight className="h-6 w-6" /></div><span className="text-sm font-medium mt-2 text-blue-900">3. 待入库</span></div>
        </div>
      </div>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" /><Input placeholder="搜索收货单号、采购单号、供应商..." className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">所有状态</option>
                <option value="待验收">待验收</option>
                <option value="已验收待入库">已验收待入库</option>
                <option value="部分到货">部分到货</option>
                <option value="已入库">已入库</option>
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">收货单号</TableHead><TableHead className="font-semibold text-gray-900">关联采购单</TableHead><TableHead className="font-semibold text-gray-900">供应商</TableHead><TableHead className="font-semibold text-gray-900 text-right">应到数量</TableHead><TableHead className="font-semibold text-gray-900 text-right">实到数量</TableHead><TableHead className="font-semibold text-gray-900 text-right">合格数量</TableHead><TableHead className="font-semibold text-gray-900 text-right">异常数量</TableHead><TableHead className="font-semibold text-gray-900 text-center">状态</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={9} className="h-24 text-center text-sm text-gray-500">正在加载到货数据...</TableCell></TableRow>}
              {!isLoading && filteredArrivals.length === 0 && <TableRow><TableCell colSpan={9} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有到货记录。</TableCell></TableRow>}
              {!isLoading && filteredArrivals.map((arrival) => (
                <TableRow key={arrival.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{arrival.id}</TableCell>
                  <TableCell className="text-gray-500">{arrival.poId}</TableCell>
                  <TableCell className="text-gray-900">{arrival.supplier}</TableCell>
                  <TableCell className="text-right text-gray-500">{arrival.expectedQty}</TableCell>
                  <TableCell className="text-right font-medium text-gray-900">{arrival.arrivedQty}</TableCell>
                  <TableCell className="text-right font-medium text-green-600">{arrival.qualifiedQty}</TableCell>
                  <TableCell className={`text-right font-medium ${arrival.defectQty > 0 ? 'text-red-600' : 'text-gray-400'}`}>{arrival.defectQty}</TableCell>
                  <TableCell className="text-center"><Badge variant={badgeVariant(arrival.status)}>{arrival.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewDetail(arrival.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'detail', label: '查看详情', icon: Eye, onSelect: () => void handleViewDetail(arrival.id) },
                          { id: 'filter-supplier', label: '按同供应商筛选', icon: Filter, onSelect: () => handleFilterSupplier(arrival.supplier) },
                          { id: 'filter-status', label: '按同状态筛选', icon: Filter, onSelect: () => handleFilterStatus(arrival.status) },
                          {
                            id: 'advance',
                            label: arrival.status === '待验收' ? '推进验收' : '继续收货',
                            icon: ArrowRight,
                            onSelect: () => void handleAdvance(arrival.id),
                            disabled: !(arrival.status === '待验收' || arrival.status === '部分到货') || activeId === arrival.id || !canManageArrival,
                          },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/30 rounded-b-xl"><div className="text-sm text-gray-500">当前显示 {filteredArrivals.length} 条到货记录</div>{isLoading && <LoaderCircle className="h-4 w-4 animate-spin text-gray-400" />}</div>
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  );
}
