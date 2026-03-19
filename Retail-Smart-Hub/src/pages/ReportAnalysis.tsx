import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Activity, BarChart3, Download, Filter, LoaderCircle, PieChart, RefreshCw, TrendingUp } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart as RePieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchReportOverview } from '@/services/api/reports';
import { downloadCsv } from '@/lib/export';
import { formatCurrency } from '@/lib/format';
import type { ReportOverview } from '@/types/reports';

const COLORS = ['#2563eb', '#10b981', '#f59e0b', '#f97316', '#0ea5e9', '#14b8a6'];
const focusOptions = ['all', 'sales', 'inventory', 'finance'] as const;
type FocusArea = (typeof focusOptions)[number];

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function nextFocusArea(current: FocusArea): FocusArea {
  const currentIndex = focusOptions.indexOf(current);
  return focusOptions[(currentIndex + 1) % focusOptions.length];
}

function focusLabel(focusArea: FocusArea) {
  if (focusArea === 'sales') return '销售';
  if (focusArea === 'inventory') return '库存';
  if (focusArea === 'finance') return '资金';
  return '全部';
}

export function ReportAnalysis() {
  const [report, setReport] = useState<ReportOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [focusArea, setFocusArea] = useState<FocusArea>('all');

  const showSales = focusArea === 'all' || focusArea === 'sales';
  const showInventory = focusArea === 'all' || focusArea === 'inventory';
  const showFinance = focusArea === 'all' || focusArea === 'finance';

  const summaryRows = useMemo(() => {
    if (!report) return [];
    return [
      { name: '累计销售额', value: formatCurrency(report.summary.totalSales) },
      { name: '累计毛利润', value: formatCurrency(report.summary.totalProfit) },
      { name: '已发货订单', value: report.summary.shippedOrders },
      { name: '低库存商品数', value: report.summary.lowStockCount },
      { name: '待回款余额', value: formatCurrency(report.summary.pendingReceivable) },
      { name: '库存货值', value: formatCurrency(report.summary.inventoryValue) },
    ];
  }, [report]);

  const loadReports = async () => {
    setIsLoading(true);
    setPageError('');
    try {
      const response = await fetchReportOverview();
      setReport(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadReports();
  }, []);

  const handleExport = () => {
    if (!report) return;

    downloadCsv('report-summary.csv', [
      { header: '指标', value: (item) => item.name },
      { header: '数值', value: (item) => item.value },
    ], summaryRows);

    if (report.agingAnalysis.length > 0) {
      downloadCsv('report-aging.csv', [
        { header: '账龄区间', value: (item) => item.bucket },
        { header: '应收', value: (item) => item.receivable },
        { header: '应付', value: (item) => item.payable },
        { header: '净额', value: (item) => item.net },
      ], report.agingAnalysis);
    }

    setActionMessage('报表摘要与账龄分析已导出。');
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">报表分析</h2>
          <p className="text-sm text-gray-500 mt-1">报表页已接入真实销售、库存和资金统计，并支持导出。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadReports()} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新报表
          </Button>
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => setFocusArea((current) => nextFocusArea(current))}>
            <Filter className="mr-2 h-4 w-4" /> 经营口径：{focusLabel(focusArea)}
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={handleExport} disabled={!report}>
            <Download className="mr-2 h-4 w-4" /> 导出报表
          </Button>
        </div>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">报表加载失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-gray-500">累计销售额</CardTitle><TrendingUp className="h-4 w-4 text-blue-600" /></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{formatCurrency(report?.summary.totalSales ?? 0)}</div><p className="text-xs text-gray-500 mt-1">已发货 / 已完成订单 {report?.summary.shippedOrders ?? 0} 单</p></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-gray-500">累计毛利润</CardTitle><BarChart3 className="h-4 w-4 text-green-600" /></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{formatCurrency(report?.summary.totalProfit ?? 0)}</div><p className="text-xs text-green-600 mt-1">库存货值 {formatCurrency(report?.summary.inventoryValue ?? 0)}</p></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-gray-500">待回款余额</CardTitle><PieChart className="h-4 w-4 text-orange-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{formatCurrency(report?.summary.pendingReceivable ?? 0)}</div><p className="text-xs text-gray-500 mt-1">经营现金流需要持续跟踪</p></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-gray-500">低库存商品</CardTitle><Activity className="h-4 w-4 text-red-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{report?.summary.lowStockCount ?? 0}</div><p className="text-xs text-red-500 mt-1">建议联动采购模块处理补货</p></CardContent></Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {showSales && (
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-lg font-semibold text-gray-800 flex items-center"><TrendingUp className="mr-2 h-5 w-5 text-blue-600" />销售与利润趋势</CardTitle></CardHeader>
            <CardContent>
              <div className="h-[300px] w-full mt-4">
                {isLoading ? <div className="h-full flex items-center justify-center text-sm text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin mr-2" /> 正在加载趋势数据...</div> : <ResponsiveContainer width="100%" height="100%"><BarChart data={report?.salesTrend ?? []} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#6b7280' }} dy={10} /><YAxis yAxisId="left" orientation="left" stroke="#2563eb" axisLine={false} tickLine={false} tick={{ fill: '#6b7280' }} dx={-10} /><YAxis yAxisId="right" orientation="right" stroke="#10b981" axisLine={false} tickLine={false} tick={{ fill: '#6b7280' }} dx={10} /><Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} /><Legend wrapperStyle={{ paddingTop: '20px' }} /><Bar yAxisId="left" dataKey="sales" name="销售额" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={32} /><Bar yAxisId="right" dataKey="profit" name="毛利润" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={32} /></BarChart></ResponsiveContainer>}
              </div>
            </CardContent>
          </Card>
        )}

        {showSales && (
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-lg font-semibold text-gray-800 flex items-center"><PieChart className="mr-2 h-5 w-5 text-blue-600" />各品类销售占比</CardTitle></CardHeader>
            <CardContent>
              <div className="h-[300px] w-full mt-4">
                {isLoading ? <div className="h-full flex items-center justify-center text-sm text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin mr-2" /> 正在加载品类数据...</div> : report && report.categoryDistribution.length > 0 ? <ResponsiveContainer width="100%" height="100%"><RePieChart><Pie data={report.categoryDistribution} cx="50%" cy="50%" labelLine={false} outerRadius={100} innerRadius={60} dataKey="value" label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>{report.categoryDistribution.map((entry, index) => <Cell key={`${entry.name}-${index}`} fill={COLORS[index % COLORS.length]} />)}</Pie><Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} /><Legend wrapperStyle={{ paddingTop: '20px' }} /></RePieChart></ResponsiveContainer> : <div className="h-full flex items-center justify-center text-sm text-gray-500">暂无品类销售数据。</div>}
              </div>
            </CardContent>
          </Card>
        )}

        {showInventory && (
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-lg font-semibold text-gray-800 flex items-center"><Activity className="mr-2 h-5 w-5 text-blue-600" />核心商品库存周转率</CardTitle></CardHeader>
            <CardContent>
              <div className="h-[300px] w-full mt-4">
                {isLoading ? <div className="h-full flex items-center justify-center text-sm text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin mr-2" /> 正在加载周转数据...</div> : <ResponsiveContainer width="100%" height="100%"><LineChart data={report?.inventoryTurnover ?? []} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#6b7280' }} dy={10} /><YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280' }} dx={-10} /><Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} /><Line type="monotone" dataKey="turnover" name="周转率" stroke="#f59e0b" strokeWidth={3} dot={{ r: 6, fill: '#f59e0b', strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 8 }} /></LineChart></ResponsiveContainer>}
              </div>
            </CardContent>
          </Card>
        )}

        {showFinance && (
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-lg font-semibold text-gray-800 flex items-center"><BarChart3 className="mr-2 h-5 w-5 text-blue-600" />应收应付账龄分析</CardTitle></CardHeader>
            <CardContent>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-gray-500 uppercase bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 rounded-tl-lg">账龄区间</th>
                      <th className="px-4 py-3 text-right">应收账款</th>
                      <th className="px-4 py-3 text-right">应付账款</th>
                      <th className="px-4 py-3 text-right rounded-tr-lg">净额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading && <tr><td colSpan={4} className="px-4 py-10 text-center text-gray-500">正在加载账龄分析...</td></tr>}
                    {!isLoading && (report?.agingAnalysis ?? []).map((item) => <tr key={item.bucket} className="border-b border-gray-100"><td className={`px-4 py-3 font-medium ${item.bucket === '90天以上' ? 'text-red-500' : 'text-gray-900'}`}>{item.bucket}</td><td className="px-4 py-3 text-right text-green-600">{formatCurrency(item.receivable)}</td><td className="px-4 py-3 text-right text-red-600">{formatCurrency(item.payable)}</td><td className={`px-4 py-3 text-right font-bold ${item.net >= 0 ? 'text-gray-900' : 'text-red-600'}`}>{formatCurrency(item.net)}</td></tr>)}
                  </tbody>
                  <tfoot className="bg-gray-50 font-bold">
                    <tr>
                      <td className="px-4 py-3 rounded-bl-lg">总计</td>
                      <td className="px-4 py-3 text-right text-green-700">{formatCurrency((report?.agingAnalysis ?? []).reduce((sum, item) => sum + item.receivable, 0))}</td>
                      <td className="px-4 py-3 text-right text-red-700">{formatCurrency((report?.agingAnalysis ?? []).reduce((sum, item) => sum + item.payable, 0))}</td>
                      <td className="px-4 py-3 text-right text-blue-700 rounded-br-lg">{formatCurrency((report?.agingAnalysis ?? []).reduce((sum, item) => sum + item.net, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
