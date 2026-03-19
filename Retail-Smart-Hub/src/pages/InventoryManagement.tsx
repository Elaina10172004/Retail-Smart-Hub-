import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { adjustInventory, deleteInventory, fetchInventoryAlerts, fetchInventoryDetail, fetchInventoryList, fetchInventoryOverview } from '@/services/api/inventory';
import type { InventoryAlert, InventoryDetailRecord, InventoryItem, InventoryOverview, InventoryStatus } from '@/types/inventory';
import { downloadCsv } from '@/lib/export';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Eye, LoaderCircle, RefreshCw, Search, Trash2 } from 'lucide-react';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function formatCurrency(value: number) {
  return `¥${value.toLocaleString('zh-CN', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function badgeVariant(status: InventoryStatus) {
  if (status === '正常') return 'success';
  if (status === '预警') return 'warning';
  return 'destructive';
}

export function InventoryManagement() {
  const { user } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
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
    return inventory.filter((item) => {
      const matchesSearch = !searchTerm || item.id.toLowerCase().includes(searchTerm.toLowerCase()) || item.name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory = !categoryFilter || item.category === categoryFilter;
      const matchesStatus = !statusFilter || item.status === statusFilter;
      return matchesSearch && matchesCategory && matchesStatus;
    });
  }, [categoryFilter, inventory, searchTerm, statusFilter]);

  const loadInventory = async () => {
    setIsLoading(true);
    setPageError('');
    try {
      const [inventoryResponse, alertsResponse, overviewResponse] = await Promise.all([
        fetchInventoryList(),
        fetchInventoryAlerts(),
        fetchInventoryOverview(),
      ]);
      setInventory(inventoryResponse.data);
      setAlerts(alertsResponse.data);
      setOverview(overviewResponse.data);
      if (selectedInventory?.id) {
        const detailResponse = await fetchInventoryDetail(selectedInventory.id);
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

  const handleFilterCategory = (category: string) => {
    setCategoryFilter(category);
    setActionMessage(`已按分类 ${category} 筛选库存列表。`);
  };

  const handleFilterStatus = (status: InventoryStatus) => {
    setStatusFilter(status);
    setActionMessage(`已按状态 ${status} 筛选库存列表。`);
  };

  const handleExportReport = () => {
    downloadCsv('inventory-report.csv', [
      { header: 'SKU', value: (item) => item.id },
      { header: '商品名称', value: (item) => item.name },
      { header: '分类', value: (item) => item.category },
      { header: '当前库存', value: (item) => item.currentStock },
      { header: '安全库存', value: (item) => item.safeStock },
      { header: '在途库存', value: (item) => item.transitStock },
      { header: '状态', value: (item) => item.status },
    ], filteredInventory);
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
      await loadInventory();
      if (selectedInventory?.id === editingStock.sku) {
        await handleViewDetail(editingStock.sku);
      }
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

    if (
      !(await confirm(
        `确认删除 ${sku}（${name}）库存？\n将忽略库存余量直接删除仓位库存。`,
      ))
    ) {
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
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">库存管理</h2>
          <p className="text-sm text-gray-500 mt-1">库存台账、低库存预警和盘点录入都已可用。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadInventory()} disabled={isLoading}>
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

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">库存数据加载失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      {(selectedInventory || isDetailLoading) && (
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
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">SKU / 商品</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedInventory.id}</div>
                    <div className="mt-1 text-xs text-gray-500">{selectedInventory.name}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">库存状态</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedInventory.status}</div>
                    <div className="mt-1 text-xs text-gray-500">当前 {selectedInventory.currentStock} / 安全 {selectedInventory.safeStock} / 在途 {selectedInventory.transitStock}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">供应商 / 提前期</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedInventory.preferredSupplier}</div>
                    <div className="mt-1 text-xs text-gray-500">{selectedInventory.leadTimeDays} 天</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">销售价 / 成本价</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(selectedInventory.salePrice)}</div>
                    <div className="mt-1 text-xs text-gray-500">成本 {formatCurrency(selectedInventory.costPrice)} / 单位 {selectedInventory.unit}</div>
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-gray-900">仓库分布</div>
                    {selectedInventory.warehouses.map((warehouse) => (
                      <div key={warehouse.warehouseId} className="rounded-lg border border-gray-200 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="text-sm font-semibold text-gray-900">{warehouse.warehouseName}</div>
                            <div className="mt-1 text-xs text-gray-500">{warehouse.locationCode}</div>
                          </div>
                          <div className="text-right text-sm">
                            <div className="font-semibold text-gray-900">现存 {warehouse.currentStock}</div>
                            <div className="text-xs text-gray-500">预留 {warehouse.reservedStock}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-gray-900">最近库存变动</div>
                    {selectedInventory.recentMovements.length > 0 ? selectedInventory.recentMovements.map((movement) => (
                      <div key={movement.id} className="rounded-lg border border-gray-200 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="text-sm font-semibold text-gray-900">{movement.type} / {movement.referenceId}</div>
                            <div className="mt-1 text-xs text-gray-500">{movement.summary}</div>
                          </div>
                          <div className="text-right text-sm">
                            <div className={`font-semibold ${movement.quantity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                              {movement.quantity >= 0 ? '+' : ''}{movement.quantity}
                            </div>
                            <div className="text-xs text-gray-500">{movement.occurredAt || '-'}</div>
                          </div>
                        </div>
                      </div>
                    )) : <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">最近没有库存变动记录。</div>}
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-4">
        <Card className="md:col-span-3 border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
              <div className="flex flex-1 gap-4 w-full flex-wrap">
                <div className="relative w-full md:w-80">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                  <Input placeholder="搜索商品名称、编码..." className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
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
                  <TableHead className="font-semibold text-gray-900 text-right">当前库存</TableHead>
                  <TableHead className="font-semibold text-gray-900 text-right">安全库存</TableHead>
                  <TableHead className="font-semibold text-gray-900 text-right">在途库存</TableHead>
                  <TableHead className="font-semibold text-gray-900 text-center">状态</TableHead>
                  <TableHead className="text-right font-semibold text-gray-900">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载库存数据...</TableCell></TableRow>}
                {!isLoading && filteredInventory.length === 0 && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有库存记录。</TableCell></TableRow>}
                {!isLoading && filteredInventory.map((item) => (
                  <TableRow key={item.id} className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-gray-500">{item.id}</TableCell>
                    <TableCell className="font-medium text-gray-900">{item.name}</TableCell>
                    <TableCell className="text-gray-500">{item.category}</TableCell>
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
                            { id: 'detail', label: '查看详情', icon: Eye, onSelect: () => void handleViewDetail(item.id) },
                            { id: 'stocktake', label: isSuperAdmin ? '强制修改库存' : '盘点该商品', icon: ArrowUpFromLine, onSelect: () => void handleStocktake(item.id) },
                            { id: 'filter-category', label: '按同分类筛选', icon: Search, onSelect: () => handleFilterCategory(item.category) },
                            { id: 'filter-status', label: '按同状态筛选', icon: Search, onSelect: () => handleFilterStatus(item.status) },
                            { id: 'delete-stock', label: '删除库存记录', icon: Trash2, onSelect: () => void handleDeleteInventory(item.id, item.name), disabled: !isSuperAdmin, tone: 'danger' },
                          ]}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/30 rounded-b-xl">
              <div className="text-sm text-gray-500">当前显示 {filteredInventory.length} 条库存记录</div>
              {isLoading && <LoaderCircle className="h-4 w-4 animate-spin text-gray-400" />}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="border-red-200 shadow-sm bg-gradient-to-b from-red-50 to-white">
            <CardHeader className="pb-2"><CardTitle className="text-red-700 flex items-center text-base"><AlertTriangle className="mr-2 h-5 w-5" />低库存预警</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-4">
                {alerts.length === 0 && !isLoading && <p className="text-sm text-gray-500">当前没有低库存预警。</p>}
                {alerts.slice(0, 3).map((item) => (
                  <div key={item.sku} className="flex justify-between items-center border-b border-red-100 pb-2">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{item.name}</p>
                      <p className="text-xs text-red-500">缺口: {item.gap} 件</p>
                    </div>
                    <Badge variant={item.status === '缺货' ? 'destructive' : 'warning'}>{item.status}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-blue-200 shadow-sm bg-gradient-to-b from-blue-50 to-white">
            <CardHeader className="pb-2"><CardTitle className="text-blue-800 text-base">库存概览</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-1"><span className="text-gray-600">总库存金额</span><span className="font-bold text-gray-900">{formatCurrency(overview?.totalInventoryValue ?? 0)}</span></div>
                  <div className="w-full bg-gray-200 rounded-full h-2"><div className="bg-blue-600 h-2 rounded-full" style={{ width: `${Math.min(((overview?.totalInventoryValue ?? 0) / 200000) * 100, 100)}%` }}></div></div>
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1"><span className="text-gray-600">库容使用率</span><span className="font-bold text-gray-900">{(overview?.capacityUsageRate ?? 0).toFixed(1)}%</span></div>
                  <div className="w-full bg-gray-200 rounded-full h-2"><div className="bg-yellow-500 h-2 rounded-full" style={{ width: `${overview?.capacityUsageRate ?? 0}%` }}></div></div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg bg-white border border-blue-100 p-3"><div className="text-gray-500">缺货 SKU</div><div className="mt-1 text-lg font-bold text-red-600">{overview?.shortageCount ?? 0}</div></div>
                  <div className="rounded-lg bg-white border border-blue-100 p-3"><div className="text-gray-500">预警 SKU</div><div className="mt-1 text-lg font-bold text-yellow-600">{overview?.warningCount ?? 0}</div></div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      {editingStock ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-[1px]">
          <Card className="w-full max-w-md border-slate-200 shadow-xl">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="text-base text-slate-900">
                {isSuperAdmin ? '强制修改库存' : '盘点录入'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4 text-sm text-slate-700">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                SKU：{editingStock.sku} / {editingStock.name}
              </div>
              <Input
                type="number"
                min={0}
                value={editingStock.targetStock}
                onChange={(event) => {
                  setEditingStock((current) =>
                    current ? { ...current, targetStock: event.target.value } : current,
                  );
                }}
                placeholder="请输入目标库存（整数）"
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingStock(null);
                  }}
                >
                  取消
                </Button>
                <Button onClick={() => void handleSubmitStockEdit()} disabled={isAdjusting}>
                  {isAdjusting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
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
