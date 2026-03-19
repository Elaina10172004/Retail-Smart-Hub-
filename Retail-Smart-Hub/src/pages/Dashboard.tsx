import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchDashboardOverview } from '@/services/api/dashboard';
import { formatCurrency } from '@/lib/format';
import type { DashboardOverview } from '@/types/dashboard';
import { ShoppingCart, Package, AlertTriangle, DollarSign, Bot, LoaderCircle, RefreshCw } from 'lucide-react';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export function Dashboard() {
  const [dashboard, setDashboard] = useState<DashboardOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState('');

  const loadDashboard = async () => {
    setIsLoading(true);
    setPageError('');

    try {
      const response = await fetchDashboardOverview();
      setDashboard(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">经营仪表盘</h2>
          <p className="text-sm text-gray-500 mt-1">仪表盘已接入真实业务聚合数据。</p>
        </div>
        <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadDashboard()} disabled={isLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新看板
        </Button>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">仪表盘加载失败：{pageError}</div>}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">今日订单数</CardTitle>
            <ShoppingCart className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{dashboard?.stats.todayOrderCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">当前库存总量</CardTitle>
            <Package className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{dashboard?.stats.inventoryUnits ?? 0}</div>
            <p className="text-xs text-gray-500 mt-1">件</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">低库存预警数</CardTitle>
            <AlertTriangle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{dashboard?.stats.lowStockCount ?? 0}</div>
            <p className="text-xs text-red-500 mt-1">待补货采购 {dashboard?.stats.pendingProcurementCount ?? 0} 单</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">本月销售额</CardTitle>
            <DollarSign className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{formatCurrency(dashboard?.stats.monthlySales ?? 0)}</div>
            <p className="text-xs text-gray-500 mt-1">待回款 {formatCurrency(dashboard?.stats.pendingReceivable ?? 0)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-7">
        <Card className="md:col-span-4">
          <CardHeader>
            <CardTitle>最近 7 天销售趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {isLoading ? (
                <div className="h-full flex items-center justify-center text-sm text-gray-500">
                  <LoaderCircle className="h-4 w-4 animate-spin mr-2" /> 正在加载趋势数据...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dashboard?.salesTrend ?? []} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} dx={-10} />
                    <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Area type="monotone" dataKey="sales" stroke="#2563eb" strokeWidth={3} fillOpacity={1} fill="url(#colorSales)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-3">
          <CardHeader>
            <CardTitle>库存预警</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(dashboard?.inventoryAlerts ?? []).map((alert) => (
                <div key={alert.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                  <div className="flex flex-col">
                    <span className="font-medium text-sm text-gray-900">{alert.name}</span>
                    <span className="text-xs text-gray-500">{alert.id}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-sm font-bold text-gray-900">{alert.stock} <span className="text-xs font-normal text-gray-500">/ {alert.safeStock}</span></div>
                    </div>
                    <Badge variant={alert.status === '缺货' ? 'destructive' : 'warning'}>{alert.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">待处理采购单</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(dashboard?.pendingProcurements ?? []).map((po) => (
                <div key={po.id} className="flex justify-between items-center border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{po.supplier}</p>
                    <p className="text-xs text-gray-500">{po.id}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-900">{po.amount}</p>
                    <p className="text-xs text-gray-500">{po.date}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">待发货订单</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(dashboard?.pendingShipments ?? []).map((so) => (
                <div key={so.id} className="flex justify-between items-center border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{so.customer}</p>
                    <p className="text-xs text-gray-500">{so.items} 件商品</p>
                  </div>
                  <Badge variant={so.status === '库存充足' ? 'success' : 'warning'}>{so.status}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-100">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center text-blue-800">
              <Bot className="h-5 w-5 mr-2 text-blue-600" />
              AI 补货建议摘要
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 mt-2">
              <p className="text-sm text-gray-700 leading-relaxed">{dashboard?.aiSuggestion.message || '正在生成建议...'}</p>
              <ul className="space-y-2">
                {(dashboard?.aiSuggestion.recommendedSkus ?? []).map((sku) => (
                  <li key={sku} className="text-sm flex justify-between items-center bg-white p-2 rounded shadow-sm border border-blue-100">
                    <span className="font-medium text-gray-800">{sku}</span>
                    <span className="text-blue-600 font-bold">建议补货</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
