import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { downloadCsv } from '@/lib/export';
import { ArrowDownRight, ArrowUpRight, CreditCard, Eye, Filter, History, LoaderCircle, RefreshCw, Search, Wallet } from 'lucide-react';
import {
  fetchFinanceOverview,
  fetchPayableDetail,
  fetchPayables,
  fetchReceivableDetail,
  fetchReceivables,
  payPayable,
  receiveReceivable,
} from '@/services/api/finance';
import { formatCurrency } from '@/lib/format';
import type {
  FinanceOverview,
  PayableDetailRecord,
  PayableRecord,
  PayableStatus,
  ReceivableDetailRecord,
  ReceivableRecord,
  ReceivableStatus,
} from '@/types/finance';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function receivableVariant(status: ReceivableStatus) {
  if (status === '逾期') return 'destructive';
  if (status === '已收款') return 'success';
  if (status === '部分收款') return 'secondary';
  return 'warning';
}

function payableVariant(status: PayableStatus) {
  if (status === '逾期') return 'destructive';
  if (status === '已付款') return 'success';
  if (status === '部分付款') return 'secondary';
  return 'warning';
}

export function FinancialManagement() {
  const { hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const canReceive = hasPermission('finance.receivable');
  const canPay = hasPermission('finance.payable');
  const [activeTab, setActiveTab] = useState<'receivables' | 'payables'>('receivables');
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [receivables, setReceivables] = useState<ReceivableRecord[]>([]);
  const [payables, setPayables] = useState<PayableRecord[]>([]);
  const [selectedReceivable, setSelectedReceivable] = useState<ReceivableDetailRecord | null>(null);
  const [selectedPayable, setSelectedPayable] = useState<PayableDetailRecord | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const filteredReceivables = useMemo(
    () =>
      receivables.filter((item) => {
        const matchesSearch =
          !searchTerm ||
          item.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.orderId.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.customer.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = !statusFilter || item.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [receivables, searchTerm, statusFilter],
  );

  const filteredPayables = useMemo(
    () =>
      payables.filter((item) => {
        const matchesSearch =
          !searchTerm ||
          item.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.purchaseOrderId.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.supplier.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = !statusFilter || item.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [payables, searchTerm, statusFilter],
  );

  const loadFinance = async () => {
    setIsLoading(true);
    setPageError('');
    try {
      const [overviewResponse, receivableResponse, payableResponse] = await Promise.all([
        fetchFinanceOverview(),
        fetchReceivables(),
        fetchPayables(),
      ]);
      setOverview(overviewResponse.data);
      setReceivables(receivableResponse.data);
      setPayables(payableResponse.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadFinance();
  }, []);

  const handleViewReceivableDetail = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchReceivableDetail(id);
      setSelectedReceivable(response.data);
      setSelectedPayable(null);
      setActiveTab('receivables');
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleViewPayableDetail = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchPayableDetail(id);
      setSelectedPayable(response.data);
      setSelectedReceivable(null);
      setActiveTab('payables');
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleReceive = async (record: ReceivableRecord) => {
    if (!canReceive) {
      setPageError('当前角色没有收款登记权限。');
      return;
    }
    const amountText = window.prompt('请输入收款金额', String(record.remainingAmount));
    if (!amountText) return;
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPageError('收款金额必须为正数。');
      return;
    }
    if (!(await confirm(`确认登记收款 ${formatCurrency(amount)} ？`))) return;

    setActiveId(record.id);
    setActionMessage('');
    setPageError('');
    try {
      const response = await receiveReceivable(record.id, { amount, method: '银行转账' });
      setActionMessage(response.message || '收款已登记。');
      if (selectedReceivable?.id === record.id) {
        await handleViewReceivableDetail(record.id);
      }
      await loadFinance();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handlePay = async (record: PayableRecord) => {
    if (!canPay) {
      setPageError('当前角色没有付款登记权限。');
      return;
    }
    const amountText = window.prompt('请输入付款金额', String(record.remainingAmount));
    if (!amountText) return;
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPageError('付款金额必须为正数。');
      return;
    }
    if (!(await confirm(`确认登记付款 ${formatCurrency(amount)} ？`))) return;

    setActiveId(record.id);
    setActionMessage('');
    setPageError('');
    try {
      const response = await payPayable(record.id, { amount, method: '对公转账' });
      setActionMessage(response.message || '付款已登记。');
      if (selectedPayable?.id === record.id) {
        await handleViewPayableDetail(record.id);
      }
      await loadFinance();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleExportCurrentTab = () => {
    if (activeTab === 'receivables') {
      downloadCsv(
        'receivables.csv',
        [
          { header: '应收单号', value: (item) => item.id },
          { header: '关联订单', value: (item) => item.orderId },
          { header: '客户名称', value: (item) => item.customer },
          { header: '应收金额', value: (item) => item.amountDue },
          { header: '已收金额', value: (item) => item.amountPaid },
          { header: '待收金额', value: (item) => item.remainingAmount },
          { header: '到期日', value: (item) => item.dueDate },
          { header: '状态', value: (item) => item.status },
        ],
        filteredReceivables,
      );
      setActionMessage(`已导出 ${filteredReceivables.length} 条应收记录。`);
      return;
    }

    downloadCsv(
      'payables.csv',
      [
        { header: '应付单号', value: (item) => item.id },
        { header: '关联采购单', value: (item) => item.purchaseOrderId },
        { header: '供应商', value: (item) => item.supplier },
        { header: '应付金额', value: (item) => item.amountDue },
        { header: '已付金额', value: (item) => item.amountPaid },
        { header: '待付金额', value: (item) => item.remainingAmount },
        { header: '到期日', value: (item) => item.dueDate },
        { header: '状态', value: (item) => item.status },
      ],
      filteredPayables,
    );
    setActionMessage(`已导出 ${filteredPayables.length} 条应付记录。`);
  };

  const handleFilterKeyword = (keyword: string) => {
    setSearchTerm(keyword);
    setActionMessage(`已按 ${keyword} 筛选当前财务列表。`);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">财务管理</h2>
          <p className="text-sm text-gray-500 mt-1">财务页已接入真实应收、应付、收款、付款数据，并支持查看账单详情与收付款记录。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadFinance()} disabled={isLoading}><RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新数据</Button>
          <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={handleExportCurrentTab} disabled={(activeTab === 'receivables' ? filteredReceivables.length : filteredPayables.length) === 0}><CreditCard className="mr-2 h-4 w-4" /> 对账导出</Button>
        </div>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">财务数据处理失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      {(selectedReceivable || selectedPayable || isDetailLoading) && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <CardTitle className="text-lg font-semibold text-gray-800 flex items-center justify-between gap-3">
              <span>{activeTab === 'receivables' ? '应收详情' : '应付详情'}</span>
              <Button variant="ghost" size="sm" onClick={() => { setSelectedReceivable(null); setSelectedPayable(null); }}>关闭</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载账单详情...</div> : null}
            {selectedReceivable ? (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">应收单 / 订单</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedReceivable.id}</div><div className="mt-1 text-xs text-gray-500">{selectedReceivable.orderId}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">客户 / 渠道</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedReceivable.customerName}</div><div className="mt-1 text-xs text-gray-500">{selectedReceivable.orderChannel}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">金额概览</div><div className="mt-1 text-sm font-semibold text-gray-900">应收 {formatCurrency(selectedReceivable.amountDue)}</div><div className="mt-1 text-xs text-gray-500">已收 {formatCurrency(selectedReceivable.amountPaid)} / 余额 {formatCurrency(selectedReceivable.remainingAmount)}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">状态</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedReceivable.status}</div><div className="mt-1 text-xs text-gray-500">到期日：{selectedReceivable.dueDate}</div></div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">收款记录</h3>
                  {selectedReceivable.records.length > 0 ? selectedReceivable.records.map((record) => (
                    <div key={record.id} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{record.id}</div>
                          <div className="mt-1 text-xs text-gray-500">{record.method} · {record.receivedAt}</div>
                        </div>
                        <div className="text-right text-sm font-medium text-green-600">{formatCurrency(record.amount)}</div>
                      </div>
                      {record.remark ? <div className="mt-2 text-xs text-gray-500">{record.remark}</div> : null}
                    </div>
                  )) : <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">当前还没有收款记录。</div>}
                  {selectedReceivable.remark ? <div className="rounded-lg border border-gray-200 p-4 text-sm text-gray-700"><div className="mb-2 font-semibold text-gray-900">备注</div>{selectedReceivable.remark}</div> : null}
                </div>
              </div>
            ) : null}
            {selectedPayable ? (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">应付单 / 采购单</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedPayable.id}</div><div className="mt-1 text-xs text-gray-500">{selectedPayable.purchaseOrderId}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">供应商</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedPayable.supplier}</div><div className="mt-1 text-xs text-gray-500">到期日：{selectedPayable.dueDate}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">金额概览</div><div className="mt-1 text-sm font-semibold text-gray-900">应付 {formatCurrency(selectedPayable.amountDue)}</div><div className="mt-1 text-xs text-gray-500">已付 {formatCurrency(selectedPayable.amountPaid)} / 余额 {formatCurrency(selectedPayable.remainingAmount)}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">状态</div><div className="mt-1 text-sm font-semibold text-gray-900">{selectedPayable.status}</div><div className="mt-1 text-xs text-gray-500">最近付款：{selectedPayable.lastPaidAt || '-'}</div></div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">付款记录</h3>
                  {selectedPayable.records.length > 0 ? selectedPayable.records.map((record) => (
                    <div key={record.id} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{record.id}</div>
                          <div className="mt-1 text-xs text-gray-500">{record.method} · {record.paidAt}</div>
                        </div>
                        <div className="text-right text-sm font-medium text-red-600">{formatCurrency(record.amount)}</div>
                      </div>
                      {record.remark ? <div className="mt-2 text-xs text-gray-500">{record.remark}</div> : null}
                    </div>
                  )) : <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">当前还没有付款记录。</div>}
                  {selectedPayable.remark ? <div className="rounded-lg border border-gray-200 p-4 text-sm text-gray-700"><div className="mb-2 font-semibold text-gray-900">备注</div>{selectedPayable.remark}</div> : null}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-gray-500">待收应收</CardTitle><ArrowUpRight className="h-4 w-4 text-green-600" /></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{formatCurrency(overview?.totalReceivable ?? 0)}</div><p className="text-xs text-red-500 mt-1">逾期 {formatCurrency(overview?.overdueReceivable ?? 0)}</p></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-gray-500">待付应付</CardTitle><ArrowDownRight className="h-4 w-4 text-red-600" /></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{formatCurrency(overview?.totalPayable ?? 0)}</div><p className="text-xs text-gray-500 mt-1">本周需付 {formatCurrency(overview?.dueThisWeekPayable ?? 0)}</p></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-gray-500">本月已收款</CardTitle><Wallet className="h-4 w-4 text-blue-600" /></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{formatCurrency(overview?.monthlyReceived ?? 0)}</div><p className="text-xs text-green-600 mt-1">待处理 {overview?.pendingReceivableCount ?? 0} 笔应收</p></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-gray-500">本月已付款</CardTitle><CreditCard className="h-4 w-4 text-blue-600" /></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{formatCurrency(overview?.monthlyPaid ?? 0)}</div><p className="text-xs text-gray-500 mt-1">待处理 {overview?.pendingPayableCount ?? 0} 笔应付</p></CardContent></Card>
      </div>

      <Card className="border-gray-200 shadow-sm">
        <div className="border-b border-gray-200 bg-gray-50/50 rounded-t-xl px-6 pt-4">
          <div className="flex space-x-6">
            <button className={`pb-3 text-sm font-medium transition-colors relative ${activeTab === 'receivables' ? 'text-blue-600' : 'text-gray-500 hover:text-gray-900'}`} onClick={() => { setActiveTab('receivables'); setStatusFilter(''); }}>
              应收款列表
              {activeTab === 'receivables' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-t-full"></div>}
            </button>
            <button className={`pb-3 text-sm font-medium transition-colors relative ${activeTab === 'payables' ? 'text-blue-600' : 'text-gray-500 hover:text-gray-900'}`} onClick={() => { setActiveTab('payables'); setStatusFilter(''); }}>
              应付款列表
              {activeTab === 'payables' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-t-full"></div>}
            </button>
          </div>
        </div>
        <CardContent className="p-0">
          <div className="p-4 border-b border-gray-100 flex gap-4 flex-wrap">
            <div className="relative w-full md:w-72"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" /><Input placeholder={activeTab === 'receivables' ? '搜索客户、订单、应收单...' : '搜索供应商、采购单、应付单...'} className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">所有状态</option>
              {activeTab === 'receivables' ? <><option value="未收款">未收款</option><option value="部分收款">部分收款</option><option value="已收款">已收款</option><option value="逾期">逾期</option></> : <><option value="未付款">未付款</option><option value="部分付款">部分付款</option><option value="已付款">已付款</option><option value="逾期">逾期</option></>}
            </select>
          </div>

          {activeTab === 'receivables' ? (
            <Table>
              <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">应收单号</TableHead><TableHead className="font-semibold text-gray-900">关联订单</TableHead><TableHead className="font-semibold text-gray-900">客户名称</TableHead><TableHead className="font-semibold text-gray-900 text-right">应收金额</TableHead><TableHead className="font-semibold text-gray-900 text-right">已收金额</TableHead><TableHead className="font-semibold text-gray-900">到期日</TableHead><TableHead className="font-semibold text-gray-900 text-center">状态</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载应收数据...</TableCell></TableRow>}
                {!isLoading && filteredReceivables.length === 0 && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有应收记录。</TableCell></TableRow>}
                {!isLoading && filteredReceivables.map((item) => (
                  <TableRow key={item.id} className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-blue-600">{item.id}</TableCell>
                    <TableCell className="text-gray-500">{item.orderId}</TableCell>
                    <TableCell className="text-gray-900">{item.customer}</TableCell>
                    <TableCell className="text-right font-semibold text-gray-900">{formatCurrency(item.amountDue)}</TableCell>
                    <TableCell className="text-right text-green-600 font-medium">{formatCurrency(item.amountPaid)}</TableCell>
                    <TableCell className="text-gray-500">{item.dueDate}</TableCell>
                    <TableCell className="text-center"><Badge variant={receivableVariant(item.status)}>{item.status}{item.daysOverdue > 0 ? ` (${item.daysOverdue}天)` : ''}</Badge></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewReceivableDetail(item.id)}><Eye className="h-4 w-4" /></Button>
                        <RowActionMenu
                          items={[
                            { id: 'detail', label: '查看详情', icon: Eye, onSelect: () => void handleViewReceivableDetail(item.id) },
                            { id: 'records', label: '查看收款记录', icon: History, onSelect: () => void handleViewReceivableDetail(item.id) },
                            { id: 'filter', label: '按客户筛选', icon: Filter, onSelect: () => handleFilterKeyword(item.customer) },
                            { id: 'receive', label: '登记收款', icon: Wallet, onSelect: () => void handleReceive(item), disabled: item.status === '已收款' || activeId === item.id || !canReceive },
                          ]}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">应付单号</TableHead><TableHead className="font-semibold text-gray-900">关联采购单</TableHead><TableHead className="font-semibold text-gray-900">供应商</TableHead><TableHead className="font-semibold text-gray-900 text-right">应付金额</TableHead><TableHead className="font-semibold text-gray-900 text-right">已付金额</TableHead><TableHead className="font-semibold text-gray-900">到期日/付款日</TableHead><TableHead className="font-semibold text-gray-900 text-center">状态</TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载应付数据...</TableCell></TableRow>}
                {!isLoading && filteredPayables.length === 0 && <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有应付记录。</TableCell></TableRow>}
                {!isLoading && filteredPayables.map((item) => (
                  <TableRow key={item.id} className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-blue-600">{item.id}</TableCell>
                    <TableCell className="text-gray-500">{item.purchaseOrderId}</TableCell>
                    <TableCell className="text-gray-900">{item.supplier}</TableCell>
                    <TableCell className="text-right font-semibold text-gray-900">{formatCurrency(item.amountDue)}</TableCell>
                    <TableCell className="text-right text-red-600 font-medium">{formatCurrency(item.amountPaid)}</TableCell>
                    <TableCell className="text-gray-500">{item.lastPaidAt || item.dueDate}</TableCell>
                    <TableCell className="text-center"><Badge variant={payableVariant(item.status)}>{item.status}{item.daysOverdue > 0 ? ` (${item.daysOverdue}天)` : ''}</Badge></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewPayableDetail(item.id)}><Eye className="h-4 w-4" /></Button>
                        <RowActionMenu
                          items={[
                            { id: 'detail', label: '查看详情', icon: Eye, onSelect: () => void handleViewPayableDetail(item.id) },
                            { id: 'records', label: '查看付款记录', icon: History, onSelect: () => void handleViewPayableDetail(item.id) },
                            { id: 'filter', label: '按供应商筛选', icon: Filter, onSelect: () => handleFilterKeyword(item.supplier) },
                            { id: 'pay', label: '登记付款', icon: CreditCard, onSelect: () => void handlePay(item), disabled: item.status === '已付款' || activeId === item.id || !canPay },
                          ]}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/30 rounded-b-xl"><div className="text-sm text-gray-500">{activeTab === 'receivables' ? `当前显示 ${filteredReceivables.length} 条应收记录` : `当前显示 ${filteredPayables.length} 条应付记录`}</div>{isLoading && <LoaderCircle className="h-4 w-4 animate-spin text-gray-400" />}</div>
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  );
}
