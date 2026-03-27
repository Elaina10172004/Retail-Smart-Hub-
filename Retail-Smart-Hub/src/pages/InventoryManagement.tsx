import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Eye, LoaderCircle, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { adjustInventory, deleteInventory, fetchInventoryAlerts, fetchInventoryDetail, fetchInventoryList, fetchInventoryOverview, fetchInventoryShelves } from '@/services/api/inventory';
import type { InventoryAlert, InventoryDetailRecord, InventoryItem, InventoryOverview, InventoryShelfOverviewRecord, InventoryStatus } from '@/types/inventory';
import { downloadCsv } from '@/lib/export';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function formatCurrency(value: number) {
  return `¥${value.toLocaleString('zh-CN', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function badgeVariant(status: InventoryStatus) {
  if (status === '正常') return 'success';
  if (status === '预警') return 'warning';
  return 'destructive';
}

function shelfVariant(status: InventoryShelfOverviewRecord['status']) {
  if (status === '空闲') return 'outline';
  if (status === '可用') return 'success';
  if (status === '紧张') return 'warning';
  return 'destructive';
}

function capacityBarClass(usageRate: number) {
  if (usageRate >= 1) return 'bg-red-500';
  if (usageRate >= 0.8) return 'bg-amber-500';
  if (usageRate >= 0.5) return 'bg-blue-500';
  return 'bg-emerald-500';
}

export function InventoryManagement() {
  const { user } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
  const [shelves, setShelves] = useState<InventoryShelfOverviewRecord[]>([]);
  const [overview, setOverview] = useState<InventoryOverview | null>(null);
  const [selectedInventory, setSelectedInventory] = useState<InventoryDetailRecord | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [editingStock, setEditingStock] = useState<{ sku: string; name: string; targetStock: string } | null>(null);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const categories = useMemo(() => Array.from(new Set(inventory.map((item) => item.category))), [inventory]);

  const filteredInventory = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return inventory.filter((item) => {
      const matchesSearch =
        !keyword ||
        item.id.toLowerCase().includes(keyword) ||
        item.name.toLowerCase().includes(keyword) ||
        item.shelfSummary.toLowerCase().includes(keyword);
      const matchesCategory = !categoryFilter || item.category === categoryFilter;
      const matchesStatus = !statusFilter || item.status === statusFilter;
      return matchesSearch && matchesCategory && matchesStatus;
    });
  }, [categoryFilter, inventory, searchTerm, statusFilter]);

  const loadInventory = async (keepSelectedSku?: string) => {
    setIsLoading(true);
    setPageError('');
    try {
      const [inventoryResponse, alertsResponse, overviewResponse, shelvesResponse] = await Promise.all([
        fetchInventoryList(),
        fetchInventoryAlerts(),
        fetchInventoryOverview(),
        fetchInventoryShelves(),
      ]);
      setInventory(inventoryResponse.data);
      setAlerts(alertsResponse.data);
      setOverview(overviewResponse.data);
      setShelves(shelvesResponse.data);
      if (keepSelectedSku) {
        const detailResponse = await fetchInventoryDetail(keepSelectedSku);
        setSelectedInventory(detailResponse.data);
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadInventory();
  }, []);

  const handleViewDetail = async (sku: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchInventoryDetail(sku);
      setSelectedInventory(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleExportReport = () => {
    downloadCsv(
      'inventory-report.csv',
      [
        { header: 'SKU', value: (item) => item.id },
        { header: '商品名称', value: (item) => item.name },
        { header: '分类', value: (item) => item.category },
        { header: '当前库存', value: (item) => item.currentStock },
        { header: '安全库存', value: (item) => item.safeStock },
        { header: '在途库存', value: (item) => item.transitStock },
        { header: '货架', value: (item) => item.shelfSummary },
        { header: '状态', value: (item) => item.status },
      ],
      filteredInventory,
    );
    setActionMessage(`已导出 ${filteredInventory.length} 条库存记录。`);
  };

  const handleStocktake = async (targetSku?: string) => {
    const sku = targetSku?.trim() || window.prompt('请输入要盘点的 SKU', filteredInventory[0]?.id || '')?.trim() || '';
    if (!sku) return;

    const matchedItem = inventory.find((item) => item.id.toLowerCase() === sku.toLowerCase());
    if (!matchedItem) {
      setPageError(`未找到 SKU ${sku} 的库存记录。`);
      return;
    }

    setEditingStock({
      sku: matchedItem.id,
      name: matchedItem.name,
      targetStock: String(matchedItem.currentStock),
    });
  };

  const handleSubmitStockEdit = async () => {
    if (!editingStock) {
      return;
    }

    const targetStock = Number(editingStock.targetStock);
    if (!Number.isInteger(targetStock) || targetStock < 0) {
      setPageError('盘点库存必须是大于等于 0 的整数。');
      return;
    }

    if (!(await confirm(`确认将 ${editingStock.name} 的库存调整为 ${targetStock} 吗？`))) return;

    setIsAdjusting(true);
    setPageError('');
    setActionMessage('');
    try {
      const response = await adjustInventory({ sku: editingStock.sku, targetStock, reason: '前端盘点录入' });
      setActionMessage(response.message || '库存盘点结果已写入。');
      setEditingStock(null);
      await loadInventory(editingStock.sku);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsAdjusting(false);
    }
  };

  const handleDeleteInventory = async (sku: string, name: string) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可删除库存记录。');
      return;
    }

    if (!(await confirm(`确认删除 ${sku}（${name}）库存？将忽略库存余量直接删除货架库存。`))) {
      return;
    }

    setIsAdjusting(true);
    setPageError('');
    setActionMessage('');
    try {
      const response = await deleteInventory(sku, { aggressive: true });
      setActionMessage(response.message || `${sku} 库存记录已删除。`);
      if (selectedInventory?.id === sku) {
        setSelectedInventory(null);
      }
      await loadInventory();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsAdjusting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">库存管理</h2>
          <p className="mt-1 text-sm text-gray-500">库存明细现在会记录商品所在货架，并展示每个货架的容量和空位。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadInventory(selectedInventory?.id)} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新数据
          </Button>
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={handleExportReport} disabled={isLoading || filteredInventory.length === 0}>
            <ArrowDownToLine className="mr-2 h-4 w-4" /> 导出报表
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleStocktake()} disabled={isAdjusting || inventory.length === 0}>
            {isAdjusting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="mr-2 h-4 w-4" />} 盘点录入
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="text-xs text-gray-500">库存货值</div><div className="mt-1 text-xl font-semibold text-gray-900">{formatCurrency(overview?.totalInventoryValue || 0)}</div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="text-xs text-gray-500">缺货 SKU</div><div className="mt-1 text-xl font-semibold text-red-600">{overview?.shortageCount || 0}</div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="text-xs text-gray-500">预警 SKU</div><div className="mt-1 text-xl font-semibold text-amber-600">{overview?.warningCount || 0}</div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="text-xs text-gray-500">货架使用率</div><div className="mt-1 text-xl font-semibold text-blue-600">{formatPercent(overview?.capacityUsageRate || 0)}</div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="text-xs text-gray-500">空余货架</div><div className="mt-1 text-xl font-semibold text-gray-900">{overview?.availableShelfCount || 0} / {overview?.totalShelfCount || 0}</div></CardContent></Card>
      </div>

      {pageError ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">库存数据加载失败：{pageError}</div> : null}
      {actionMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div> : null}

      {editingStock ? (
        <Card className="border-blue-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-blue-100 bg-blue-50/60 pb-3">
            <CardTitle className="text-lg font-semibold text-blue-900">库存盘点录入</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="text-sm text-gray-600">{editingStock.sku} · {editingStock.name}</div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">盘点后库存</label>
                <Input type="number" min="0" value={editingStock.targetStock} onChange={(event) => setEditingStock((current) => current ? { ...current, targetStock: event.target.value } : current)} className="w-40" />
              </div>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmitStockEdit()} disabled={isAdjusting}>
                {isAdjusting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                提交盘点
              </Button>
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => setEditingStock(null)}>取消</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {(selectedInventory || isDetailLoading) ? (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
            <CardTitle className="flex items-center justify-between gap-3 text-lg font-semibold text-gray-800">
              <span>库存详情</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedInventory(null)}>关闭</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载库存详情...</div> : null}
            {selectedInventory ? (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">SKU / 商品</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedInventory.id}</div><div className="mt-1 text-xs text-gray-500">{selectedInventory.name}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">库存状态</div><div className="mt-1"><Badge variant={badgeVariant(selectedInventory.status)}>{selectedInventory.status}</Badge></div><div className="mt-1 text-xs text-gray-500">当前 {selectedInventory.currentStock} / 安全 {selectedInventory.safeStock}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">默认供应商</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedInventory.preferredSupplier}</div><div className="mt-1 text-xs text-gray-500">提前期 {selectedInventory.leadTimeDays} 天</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">销售价 / 成本价</div><div className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(selectedInventory.salePrice)}</div><div className="mt-1 text-xs text-gray-500">成本 {formatCurrency(selectedInventory.costPrice)} / 单位 {selectedInventory.unit}</div></div>
                </div>

                <div className="grid gap-6 xl:grid-cols-3">
                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-gray-900">仓库分布</div>
                    {selectedInventory.warehouses.map((warehouse) => (
                      <div key={warehouse.warehouseId} className="rounded-lg border border-gray-200 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div><div className="text-sm font-semibold text-gray-900">{warehouse.warehouseName}</div><div className="mt-1 text-xs text-gray-500">{warehouse.locationCode}</div></div>
                          <div className="text-right text-sm"><div className="font-semibold text-gray-900">现存 {warehouse.currentStock}</div><div className="text-xs text-gray-500">预留 {warehouse.reservedStock}</div></div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-gray-900">货架分布</div>
                    {selectedInventory.shelfPlacements.length > 0 ? selectedInventory.shelfPlacements.map((placement) => (
                      <div key={`${placement.shelfId}-${placement.quantity}`} className="rounded-lg border border-gray-200 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div><div className="text-sm font-semibold text-gray-900">{placement.shelfCode}</div><div className="mt-1 text-xs text-gray-500">{placement.shelfName} · {placement.warehouseName}</div><div className="mt-2 flex flex-wrap gap-2">{placement.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}</div></div>
                          <div className="text-right text-sm"><div className="font-semibold text-gray-900">数量 {placement.quantity}</div><div className="text-xs text-gray-500">容量 {placement.capacity} / 空位 {placement.remainingCapacity}</div></div>
                        </div>
                        <div className="mt-3">
                          <div className="h-2.5 overflow-hidden rounded-full bg-gray-100">
                            <div className={`h-full rounded-full ${capacityBarClass((placement.capacity - placement.remainingCapacity) / Math.max(placement.capacity, 1))}`} style={{ width: `${Math.min(((placement.capacity - placement.remainingCapacity) / Math.max(placement.capacity, 1)) * 100, 100)}%` }} />
                          </div>
                        </div>
                      </div>
                    )) : <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">当前商品还没有货架分布记录。</div>}
                  </div>
                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-gray-900">最近库存变动</div>
                    {selectedInventory.recentMovements.length > 0 ? selectedInventory.recentMovements.map((movement) => (
                      <div key={movement.id} className="rounded-lg border border-gray-200 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div><div className="text-sm font-semibold text-gray-900">{movement.type} / {movement.referenceId}</div><div className="mt-1 text-xs text-gray-500">{movement.summary}</div></div>
                          <div className="text-right text-sm"><div className={`font-semibold ${movement.quantity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{movement.quantity >= 0 ? '+' : ''}{movement.quantity}</div><div className="text-xs text-gray-500">{movement.occurredAt || '-'}</div></div>
                        </div>
                      </div>
                    )) : <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">最近没有库存变动记录。</div>}
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.8fr_1fr]">
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
              <div className="flex flex-1 gap-4 w-full flex-wrap">
                <div className="relative w-full md:w-80">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                  <Input placeholder="搜索商品名称、SKU、货架..." className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                </div>
                <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">全部分类</option>
                  {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">所有状态</option>
                  <option value="正常">正常</option>
                  <option value="预警">预警</option>
                  <option value="缺货">缺货</option>
                </select>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50/50 hover:bg-gray-50/50">
                  <TableHead className="font-semibold text-gray-900">商品编号</TableHead>
                  <TableHead className="font-semibold text-gray-900">商品名称</TableHead>
                  <TableHead className="font-semibold text-gray-900">分类</TableHead>
                  <TableHead className="font-semibold text-gray-900">存放货架</TableHead>
                  <TableHead className="font-semibold text-gray-900 text-right">当前库存</TableHead>
                  <TableHead className="font-semibold text-gray-900 text-right">安全库存</TableHead>
                  <TableHead className="font-semibold text-gray-900 text-right">在途库存</TableHead>
                  <TableHead className="font-semibold text-gray-900 text-center">状态</TableHead>
                  <TableHead className="text-right font-semibold text-gray-900">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? <TableRow><TableCell colSpan={9} className="h-24 text-center text-sm text-gray-500">正在加载库存数据...</TableCell></TableRow> : null}
                {!isLoading && filteredInventory.length === 0 ? <TableRow><TableCell colSpan={9} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有库存记录。</TableCell></TableRow> : null}
                {!isLoading && filteredInventory.map((item) => (
                  <TableRow key={item.id} className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-gray-500">{item.id}</TableCell>
                    <TableCell className="font-medium text-gray-900">{item.name}</TableCell>
                    <TableCell className="text-gray-500">{item.category}</TableCell>
                    <TableCell className="max-w-56 text-sm text-gray-600">{item.shelfSummary}</TableCell>
                    <TableCell className={`text-right font-bold ${item.currentStock < item.safeStock ? 'text-red-600' : 'text-gray-900'}`}>{item.currentStock}</TableCell>
                    <TableCell className="text-right text-gray-500">{item.safeStock}</TableCell>
                    <TableCell className="text-right text-blue-600 font-medium">{item.transitStock > 0 ? `+${item.transitStock}` : '-'}</TableCell>
                    <TableCell className="text-center"><Badge variant={badgeVariant(item.status)}>{item.status}</Badge></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-blue-50 hover:text-blue-600" onClick={() => void handleViewDetail(item.id)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <RowActionMenu
                          items={[
                            { id: 'inventory-view', label: '查看详情', icon: Eye, onSelect: () => void handleViewDetail(item.id) },
                            { id: 'inventory-stocktake', label: '盘点录入', icon: ArrowUpFromLine, onSelect: () => void handleStocktake(item.id) },
                            { id: 'inventory-delete', label: '删除库存记录', icon: Trash2, onSelect: () => void handleDeleteInventory(item.id, item.name), disabled: !isSuperAdmin || isAdjusting, tone: 'danger' },
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

        <div className="space-y-6">
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold text-gray-800">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                库存预警
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-6">
              {alerts.length > 0 ? alerts.slice(0, 8).map((alert) => (
                <button key={alert.sku} type="button" onClick={() => void handleViewDetail(alert.sku)} className="w-full rounded-lg border border-gray-200 p-4 text-left transition hover:border-blue-200 hover:bg-blue-50/40">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{alert.sku}</div>
                      <div className="mt-1 text-xs text-gray-500">{alert.name}</div>
                    </div>
                    <Badge variant={badgeVariant(alert.status)}>{alert.status}</Badge>
                  </div>
                  <div className="mt-3 text-xs text-gray-500">当前 {alert.currentStock} / 安全 {alert.safeStock} / 缺口 {alert.gap}</div>
                </button>
              )) : <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">当前没有库存预警。</div>}
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
              <CardTitle className="text-lg font-semibold text-gray-800">货架容量总览</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-6">
              {shelves.length > 0 ? shelves.map((shelf) => (
                <div key={shelf.shelfId} className="rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{shelf.shelfCode}</div>
                      <div className="mt-1 text-xs text-gray-500">{shelf.shelfName} · {shelf.warehouseName}</div>
                    </div>
                    <Badge variant={shelfVariant(shelf.status)}>{shelf.status}</Badge>
                  </div>
                  <div className="mt-3 text-xs text-gray-500">标签：{shelf.tags.join(' / ') || '未设置'}</div>
                  <div className="mt-1 text-xs text-gray-500">容量：{shelf.usedQuantity} / {shelf.capacity} · 空位 {shelf.remainingCapacity} · SKU {shelf.itemCount}</div>
                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between text-[11px] text-gray-500">
                      <span>容量占用图</span>
                      <span>{formatPercent(shelf.usedQuantity / Math.max(shelf.capacity, 1))}</span>
                    </div>
                    <div className="relative h-3 overflow-hidden rounded-full bg-gray-100">
                      <div className={`h-full rounded-full ${capacityBarClass(shelf.usedQuantity / Math.max(shelf.capacity, 1))}`} style={{ width: `${Math.min((shelf.usedQuantity / Math.max(shelf.capacity, 1)) * 100, 100)}%` }} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
                      <span>已用 {shelf.usedQuantity}</span>
                      <span>剩余 {shelf.remainingCapacity}</span>
                    </div>
                  </div>
                </div>
              )) : <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">当前没有货架数据。</div>}
            </CardContent>
          </Card>
        </div>
      </div>

      {confirmDialog}
    </div>
  );
}
