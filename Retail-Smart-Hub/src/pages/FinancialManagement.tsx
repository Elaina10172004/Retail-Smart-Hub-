import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, CreditCard, Eye, History, LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import {
  EMPTY_RANGE_FILTER,
  MultiSelectColumnFilter,
  RangeColumnFilter,
  buildColumnFilterOptions,
  isRangeFilterActive,
  type RangeFilterValue,
} from '@/components/ui/table-column-filter';
import { RowActionMenu } from '@/components/RowActionMenu';
import { DocumentPreviewModal } from '@/components/documents/DocumentPreviewModal';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { useAuth } from '@/auth/AuthContext';
import { buildReceivableDocument, buildReceiptDocument } from '@/lib/documents';
import { downloadCsv } from '@/lib/export';
import { formatCurrency } from '@/lib/format';
import {
  fetchFinanceOverview,
  fetchPayableDetail,
  fetchPayablesPaginated,
  fetchReceivableDetail,
  fetchReceivablesPaginated,
  payPayable,
  receiveReceivable,
} from '@/services/api/finance';
import type { PaginatedData } from '@/types/api';
import type { DocumentPreviewRecord } from '@/types/documents';
import type {
  FinanceOverview,
  PayableDetailRecord,
  PayableRecord,
  PayableStatus,
  ReceiptRecord,
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

interface ReceiptDraft {
  amount: string;
  method: string;
  remark: string;
}

const RECEIPT_METHOD_OPTIONS = ['银行转账', '微信支付', '支付宝', '现金', '刷卡'] as const;

function createReceiptDraft(detail?: ReceivableDetailRecord): ReceiptDraft {
  return {
    amount: detail && detail.remainingAmount > 0 ? String(detail.remainingAmount) : '',
    method: '银行转账',
    remark: '',
  };
}

function formatDateLabel(value?: string) {
  return value || '-';
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

const PAGE_SIZE = 20;
const RECEIVABLE_STATUS_OPTIONS: ReceivableStatus[] = ['未收款', '部分收款', '已收款', '逾期'];
const PAYABLE_STATUS_OPTIONS: PayableStatus[] = ['未付款', '部分付款', '已付款', '逾期'];

export function FinancialManagement() {
  const { hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const canReceive = hasPermission('finance.receivable');
  const canPay = hasPermission('finance.payable');
  const [activeTab, setActiveTab] = useState<'receivables' | 'payables'>('receivables');
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [receivablesData, setReceivablesData] = useState<PaginatedData<ReceivableRecord> | null>(null);
  const [payablesData, setPayablesData] = useState<PaginatedData<PayableRecord> | null>(null);
  const [selectedReceivable, setSelectedReceivable] = useState<ReceivableDetailRecord | null>(null);
  const [selectedPayable, setSelectedPayable] = useState<PayableDetailRecord | null>(null);
  const [receiptDraft, setReceiptDraft] = useState<ReceiptDraft>(createReceiptDraft());
  const [receiptDraftNo, setReceiptDraftNo] = useState('');
  const [receiptDraftAt, setReceiptDraftAt] = useState('');
  const [paymentDraftNo, setPaymentDraftNo] = useState('');
  const [paymentDraftAt, setPaymentDraftAt] = useState('');
  const [previewDocuments, setPreviewDocuments] = useState<DocumentPreviewRecord[]>([]);
  const [previewInitialId, setPreviewInitialId] = useState('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [partyFilter, setPartyFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [dueDateFilter, setDueDateFilter] = useState<RangeFilterValue>(EMPTY_RANGE_FILTER);
  const [amountFilter, setAmountFilter] = useState<RangeFilterValue>(EMPTY_RANGE_FILTER);
  const [remainingFilter, setRemainingFilter] = useState<RangeFilterValue>(EMPTY_RANGE_FILTER);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const receivables = receivablesData?.items ?? [];
  const payables = payablesData?.items ?? [];
  const activePageData = activeTab === 'receivables' ? receivablesData : payablesData;

  const filteredReceivables = receivables;
  const filteredPayables = payables;
  const partyFilterOptions = useMemo(
    () => buildColumnFilterOptions(activeTab === 'receivables' ? receivables.map((item) => item.customer) : payables.map((item) => item.supplier)),
    [activeTab, payables, receivables],
  );
  const statusFilterOptions = useMemo(
    () => (activeTab === 'receivables' ? RECEIVABLE_STATUS_OPTIONS : PAYABLE_STATUS_OPTIONS).map((status) => ({ value: status, label: status })),
    [activeTab],
  );
  const hasColumnFilters =
    partyFilter.length > 0 ||
    statusFilter.length > 0 ||
    isRangeFilterActive(dueDateFilter) ||
    isRangeFilterActive(amountFilter) ||
    isRangeFilterActive(remainingFilter);

  const pendingReceivables = useMemo(
    () => receivables.filter((item) => item.remainingAmount > 0),
    [receivables],
  );

  const pendingPayables = useMemo(
    () => payables.filter((item) => item.remainingAmount > 0),
    [payables],
  );

  const loadFinance = async (options?: { keepReceivableId?: string; keepPayableId?: string }) => {
    setIsLoading(true);
    setPageError('');
    try {
      const rangeParams = {
        dueDateFrom: dueDateFilter.min,
        dueDateTo: dueDateFilter.max,
        amountMin: amountFilter.min,
        amountMax: amountFilter.max,
        remainingMin: remainingFilter.min,
        remainingMax: remainingFilter.max,
      };
      const [overviewResponse, receivableResponse, payableResponse] = await Promise.all([
        fetchFinanceOverview(),
        fetchReceivablesPaginated({
          page: currentPage,
          pageSize: PAGE_SIZE,
          search: searchTerm,
          ...rangeParams,
          customer: activeTab === 'receivables' ? partyFilter.join(',') || undefined : undefined,
          status: activeTab === 'receivables' ? statusFilter.join(',') || undefined : undefined,
        }),
        fetchPayablesPaginated({
          page: currentPage,
          pageSize: PAGE_SIZE,
          search: searchTerm,
          ...rangeParams,
          supplier: activeTab === 'payables' ? partyFilter.join(',') || undefined : undefined,
          status: activeTab === 'payables' ? statusFilter.join(',') || undefined : undefined,
        }),
      ]);
      setOverview(overviewResponse.data);
      setReceivablesData(receivableResponse.data);
      setPayablesData(payableResponse.data);

      if (options?.keepReceivableId) {
        const detailResponse = await fetchReceivableDetail(options.keepReceivableId);
        setSelectedReceivable(detailResponse.data);
      }
      if (options?.keepPayableId) {
        const detailResponse = await fetchPayableDetail(options.keepPayableId);
        setSelectedPayable(detailResponse.data);
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchTerm, partyFilter, statusFilter, dueDateFilter, amountFilter, remainingFilter]);

  useEffect(() => {
    void loadFinance();
  }, [currentPage, activeTab, searchTerm, partyFilter, statusFilter, dueDateFilter, amountFilter, remainingFilter]);

  const openPreview = (documents: DocumentPreviewRecord[], activeDocumentId?: string) => {
    if (documents.length === 0) {
      return;
    }

    setPreviewDocuments(documents);
    setPreviewInitialId(activeDocumentId || documents[0]?.id || '');
    setIsPreviewOpen(true);
  };

  const handleViewReceivableDetail = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchReceivableDetail(id);
      setSelectedReceivable(response.data);
      setSelectedPayable(null);
      setReceiptDraft(createReceiptDraft(response.data));
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

  const handleCreateReceipt = async () => {
    const target = pendingReceivables[0];
    if (!target) {
      setPageError('当前没有可收款的应收单。');
      return;
    }
    setReceiptDraftNo(buildDraftDocumentNo('RCT'));
    setReceiptDraftAt(formatDraftDateTime());
    setActiveTab('receivables');
    await handleViewReceivableDetail(target.id);
  };

  const handleCreatePayment = async () => {
    const target = pendingPayables[0];
    if (!target) {
      setPageError('当前没有可付款的应付单。');
      return;
    }
    setPaymentDraftNo(buildDraftDocumentNo('PAY'));
    setPaymentDraftAt(formatDraftDateTime());
    setActiveTab('payables');
    await handleViewPayableDetail(target.id);
  };

  const handleOpenReceivableDocument = async (recordOrId: ReceivableRecord | ReceivableDetailRecord | string) => {
    setPageError('');
    try {
      const id = typeof recordOrId === 'string' ? recordOrId : recordOrId.id;
      const detail =
        typeof recordOrId === 'string' || !('records' in recordOrId)
          ? (await fetchReceivableDetail(id)).data
          : recordOrId;
      setSelectedReceivable(detail);
      setReceiptDraft(createReceiptDraft(detail));
      openPreview([buildReceivableDocument(detail)], detail.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  };

  const handleOpenReceiptDocument = async (recordOrId: ReceivableDetailRecord | string, receipt?: ReceiptRecord) => {
    setPageError('');
    try {
      const detail = typeof recordOrId === 'string' ? (await fetchReceivableDetail(recordOrId)).data : recordOrId;
      const targetReceipt = receipt || detail.records[0];
      if (!targetReceipt) {
        setPageError('当前应收单还没有收款记录。');
        return;
      }
      setSelectedReceivable(detail);
      setReceiptDraft(createReceiptDraft(detail));
      openPreview([buildReceiptDocument(detail, targetReceipt)], targetReceipt.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  };

  const handleSubmitReceipt = async (mode: 'custom' | 'full') => {
    if (!selectedReceivable) {
      setPageError('请先选择一条应收单。');
      return;
    }
    if (!canReceive) {
      setPageError('当前角色没有收款登记权限。');
      return;
    }

    const amount = mode === 'full' ? selectedReceivable.remainingAmount : Number(receiptDraft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPageError('收款金额必须为正数。');
      return;
    }
    if (amount > selectedReceivable.remainingAmount) {
      setPageError('收款金额不能大于待收金额。');
      return;
    }
    if (!(await confirm(`确认登记收款 ${formatCurrency(amount)} ？`))) {
      return;
    }

    const method = receiptDraft.method || '银行转账';
    const remark = receiptDraft.remark.trim() || undefined;

    setActiveId(selectedReceivable.id);
    setActionMessage('');
    setPageError('');
    try {
      const response = await receiveReceivable(selectedReceivable.id, { amount, method, remark });
      const detailResponse = await fetchReceivableDetail(selectedReceivable.id);
      const refreshedDetail = detailResponse.data;
      const latestReceipt =
        refreshedDetail.records.find((item) => item.id === response.data.latestReceiptId) || refreshedDetail.records[0];

      setSelectedReceivable(refreshedDetail);
      setReceiptDraft(createReceiptDraft(refreshedDetail));
      setActionMessage(response.message || '收款已登记。');
      await loadFinance({ keepReceivableId: selectedReceivable.id });

      if (latestReceipt) {
        openPreview([buildReceiptDocument(refreshedDetail, latestReceipt)], latestReceipt.id);
      }
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
      await loadFinance({ keepPayableId: selectedPayable?.id === record.id ? record.id : undefined });
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const resetFinanceColumnFilters = () => {
    setSearchTerm('');
    setPartyFilter([]);
    setStatusFilter([]);
    setDueDateFilter(EMPTY_RANGE_FILTER);
    setAmountFilter(EMPTY_RANGE_FILTER);
    setRemainingFilter(EMPTY_RANGE_FILTER);
    setCurrentPage(1);
  };

  const handleSwitchTab = (tab: 'receivables' | 'payables') => {
    setActiveTab(tab);
    setPartyFilter([]);
    setStatusFilter([]);
    setDueDateFilter(EMPTY_RANGE_FILTER);
    setAmountFilter(EMPTY_RANGE_FILTER);
    setRemainingFilter(EMPTY_RANGE_FILTER);
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

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900">财务管理</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm"
            onClick={() => void loadFinance({ keepReceivableId: selectedReceivable?.id, keepPayableId: selectedPayable?.id })}
            disabled={isLoading}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            刷新数据
          </Button>
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={handleExportCurrentTab}>
            <History className="mr-2 h-4 w-4" />
            导出当前列表
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleCreateReceipt()} disabled={!canReceive}>
            <Wallet className="mr-2 h-4 w-4" />
            创建收款单
          </Button>
          <Button className="bg-slate-800 hover:bg-slate-900" onClick={() => void handleCreatePayment()} disabled={!canPay}>
            <CreditCard className="mr-2 h-4 w-4" />
            创建付款单
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-gray-500">待收总额</div><div className="mt-1 text-xl font-semibold text-gray-900">{formatCurrency(overview?.totalReceivable || 0)}</div></div><div className="rounded-full bg-emerald-50 p-3 text-emerald-600"><ArrowDownRight className="h-5 w-5" /></div></div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-gray-500">逾期应收</div><div className="mt-1 text-xl font-semibold text-gray-900">{formatCurrency(overview?.overdueReceivable || 0)}</div></div><div className="rounded-full bg-red-50 p-3 text-red-600"><Wallet className="h-5 w-5" /></div></div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-gray-500">本月收款</div><div className="mt-1 text-xl font-semibold text-gray-900">{formatCurrency(overview?.monthlyReceived || 0)}</div></div><div className="rounded-full bg-blue-50 p-3 text-blue-600"><CreditCard className="h-5 w-5" /></div></div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-gray-500">待付总额</div><div className="mt-1 text-xl font-semibold text-gray-900">{formatCurrency(overview?.totalPayable || 0)}</div></div><div className="rounded-full bg-amber-50 p-3 text-amber-600"><ArrowUpRight className="h-5 w-5" /></div></div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-gray-500">本周应付</div><div className="mt-1 text-xl font-semibold text-gray-900">{formatCurrency(overview?.dueThisWeekPayable || 0)}</div></div><div className="rounded-full bg-orange-50 p-3 text-orange-600"><CreditCard className="h-5 w-5" /></div></div></CardContent></Card>
        <Card className="border-gray-200 shadow-sm"><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-gray-500">未完成账单</div><div className="mt-1 text-xl font-semibold text-gray-900">{(overview?.pendingReceivableCount || 0) + (overview?.pendingPayableCount || 0)}</div></div><div className="rounded-full bg-slate-100 p-3 text-slate-600"><History className="h-5 w-5" /></div></div></CardContent></Card>
      </div>

      {pageError ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">财务数据处理失败：{pageError}</div> : null}
      {actionMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div> : null}

      {(selectedReceivable || selectedPayable || isDetailLoading) ? (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
            <CardTitle className="flex items-center justify-between gap-3 text-lg font-semibold text-gray-800">
              <span>{activeTab === 'receivables' ? '应收单据工作区' : '应付单详情'}</span>
              <Button variant="ghost" size="sm" onClick={() => { setSelectedReceivable(null); setSelectedPayable(null); }}>关闭</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载账单详情...</div> : null}

            {selectedReceivable ? (
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[11px] leading-5 text-slate-500 shadow-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="whitespace-nowrap"><span className="text-slate-500">单号：</span><span className="font-semibold text-slate-900">{receiptDraftNo || 'RCT-DRAFT'}</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">时间：</span><span className="text-slate-700">{receiptDraftAt || formatDraftDateTime()}</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">状态：</span><span className="font-semibold text-slate-900">草稿</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">关联订单：</span><span className="text-slate-700">{selectedReceivable.orderId}</span></span>
                </div>
              </div>
            ) : null}

            {selectedPayable ? (
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[11px] leading-5 text-slate-500 shadow-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="whitespace-nowrap"><span className="text-slate-500">单号：</span><span className="font-semibold text-slate-900">{paymentDraftNo || 'PAY-DRAFT'}</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">时间：</span><span className="text-slate-700">{paymentDraftAt || formatDraftDateTime()}</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">状态：</span><span className="font-semibold text-slate-900">草稿</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">关联采购：</span><span className="text-slate-700">{selectedPayable.purchaseOrderId}</span></span>
                </div>
              </div>
            ) : null}

            {selectedReceivable ? (
              <div className="space-y-6">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-gray-500">Receivable Workspace</div>
                    <div className="mt-2 text-xl font-semibold text-gray-900">{selectedReceivable.id}</div>
                    <div className="mt-1 text-sm text-gray-500">订单 {selectedReceivable.orderId} · {selectedReceivable.customerName} · {selectedReceivable.orderChannel}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => void handleOpenReceivableDocument(selectedReceivable)}>
                      <Eye className="mr-2 h-4 w-4" /> 预览应收单
                    </Button>
                    <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmitReceipt('full')} disabled={!canReceive || selectedReceivable.remainingAmount <= 0 || activeId === selectedReceivable.id}>
                      {activeId === selectedReceivable.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Wallet className="mr-2 h-4 w-4" />} 一键全额收款
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">账款状态</div><div className="mt-2"><Badge variant={receivableVariant(selectedReceivable.status)}>{selectedReceivable.status}</Badge></div><div className="mt-2 text-xs text-gray-500">到期日 {formatDateLabel(selectedReceivable.dueDate)}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">应收金额</div><div className="mt-1 text-lg font-semibold text-gray-900">{formatCurrency(selectedReceivable.amountDue)}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">已收金额</div><div className="mt-1 text-lg font-semibold text-emerald-600">{formatCurrency(selectedReceivable.amountPaid)}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">待收金额</div><div className="mt-1 text-lg font-semibold text-blue-600">{formatCurrency(selectedReceivable.remainingAmount)}</div></div>
                </div>

                <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
                  <div className="rounded-xl border border-gray-200 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">收款登记</div>
                        <div className="mt-1 text-xs text-gray-500">支持全额收款或自定义本次收款金额。</div>
                      </div>
                      <Badge variant="outline">单据打印后自动留痕</Badge>
                    </div>
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700">本次收款金额</label>
                        <Input type="number" min="0" step="0.01" value={receiptDraft.amount} onChange={(event) => setReceiptDraft((current) => ({ ...current, amount: event.target.value }))} placeholder="输入本次收款金额" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700">收款方式</label>
                        <select className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={receiptDraft.method} onChange={(event) => setReceiptDraft((current) => ({ ...current, method: event.target.value }))}>
                          {RECEIPT_METHOD_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="mt-4 space-y-2">
                      <label className="text-sm font-medium text-gray-700">收款备注</label>
                      <textarea className="min-h-24 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-blue-500" value={receiptDraft.remark} onChange={(event) => setReceiptDraft((current) => ({ ...current, remark: event.target.value }))} placeholder="填写本次收款说明、凭证号、摘要等" />
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmitReceipt('custom')} disabled={!canReceive || selectedReceivable.remainingAmount <= 0 || activeId === selectedReceivable.id}>
                        {activeId === selectedReceivable.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />} 登记本次收款
                      </Button>
                      <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => setReceiptDraft(createReceiptDraft(selectedReceivable))}>重置为待收金额</Button>
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 p-5">
                    <div className="text-sm font-semibold text-gray-900">最近收款记录</div>
                    <div className="mt-1 text-xs text-gray-500">每一笔收款都可以单独打开收款单并打印。</div>
                    <div className="mt-4 space-y-3">
                      {selectedReceivable.records.length > 0 ? selectedReceivable.records.map((record) => (
                        <div key={record.id} className="rounded-lg border border-gray-200 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-gray-900">{record.id}</div>
                              <div className="mt-1 text-xs text-gray-500">{record.receivedAt} · {record.method}</div>
                              <div className="mt-2 text-base font-semibold text-emerald-600">{formatCurrency(record.amount)}</div>
                              <div className="mt-1 text-xs text-gray-500">{record.remark || '无备注'}</div>
                            </div>
                            <Button variant="outline" size="sm" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => void handleOpenReceiptDocument(selectedReceivable, record)}>
                              <Eye className="mr-2 h-4 w-4" /> 打开收款单
                            </Button>
                          </div>
                        </div>
                      )) : <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">这条应收单还没有收款记录。</div>}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {selectedPayable ? (
              <div className="space-y-6">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-gray-500">Payable Detail</div>
                    <div className="mt-2 text-xl font-semibold text-gray-900">{selectedPayable.id}</div>
                    <div className="mt-1 text-sm text-gray-500">采购单 {selectedPayable.purchaseOrderId} · {selectedPayable.supplier}</div>
                  </div>
                  <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handlePay(selectedPayable)} disabled={!canPay || selectedPayable.remainingAmount <= 0 || activeId === selectedPayable.id}>
                    {activeId === selectedPayable.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Wallet className="mr-2 h-4 w-4" />} 登记付款
                  </Button>
                </div>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">账款状态</div><div className="mt-2"><Badge variant={payableVariant(selectedPayable.status)}>{selectedPayable.status}</Badge></div><div className="mt-2 text-xs text-gray-500">到期日 {formatDateLabel(selectedPayable.dueDate)}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">应付金额</div><div className="mt-1 text-lg font-semibold text-gray-900">{formatCurrency(selectedPayable.amountDue)}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">已付金额</div><div className="mt-1 text-lg font-semibold text-emerald-600">{formatCurrency(selectedPayable.amountPaid)}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">待付金额</div><div className="mt-1 text-lg font-semibold text-blue-600">{formatCurrency(selectedPayable.remainingAmount)}</div></div>
                </div>
                <div className="rounded-xl border border-gray-200 p-5">
                  <div className="text-sm font-semibold text-gray-900">付款记录</div>
                  <div className="mt-4 space-y-3">
                    {selectedPayable.records.length > 0 ? selectedPayable.records.map((record) => (
                      <div key={record.id} className="rounded-lg border border-gray-200 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div><div className="text-sm font-semibold text-gray-900">{record.id}</div><div className="mt-1 text-xs text-gray-500">{record.paidAt} · {record.method}</div><div className="mt-1 text-xs text-gray-500">{record.remark || '无备注'}</div></div>
                          <div className="text-sm font-semibold text-amber-600">{formatCurrency(record.amount)}</div>
                        </div>
                      </div>
                    )) : <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">这条应付单还没有付款记录。</div>}
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button variant={activeTab === 'receivables' ? 'default' : 'outline'} onClick={() => handleSwitchTab('receivables')}>
                应收列表
              </Button>
              <Button variant={activeTab === 'payables' ? 'default' : 'outline'} onClick={() => handleSwitchTab('payables')}>
                应付列表
              </Button>
            </div>
            <div className="flex w-full flex-1 flex-wrap gap-3 xl:justify-end">
              <div className="relative w-full xl:w-80">
                <Input
                  placeholder={activeTab === 'receivables' ? '搜索应收单号、订单号、客户...' : '搜索应付单号、采购单号、供应商...'}
                  className="bg-white border-gray-300 focus-visible:ring-blue-500"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </div>
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={resetFinanceColumnFilters} disabled={!searchTerm && !hasColumnFilters}>
                重置筛选
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {activeTab === 'receivables' ? (
            <Table>
              <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">应收单号</TableHead><TableHead className="font-semibold text-gray-900">关联订单</TableHead><TableHead className="font-semibold text-gray-900"><MultiSelectColumnFilter label="客户" options={partyFilterOptions} selectedValues={partyFilter} onChange={setPartyFilter} /></TableHead><TableHead className="font-semibold text-gray-900 text-right"><RangeColumnFilter label="应收金额" value={amountFilter} onChange={setAmountFilter} minPlaceholder="最小金额" maxPlaceholder="最大金额" /></TableHead><TableHead className="font-semibold text-gray-900 text-right"><RangeColumnFilter label="待收金额" value={remainingFilter} onChange={setRemainingFilter} minPlaceholder="最小金额" maxPlaceholder="最大金额" /></TableHead><TableHead className="font-semibold text-gray-900"><RangeColumnFilter label="到期日" inputType="date" value={dueDateFilter} onChange={setDueDateFilter} minPlaceholder="开始日期" maxPlaceholder="结束日期" /></TableHead><TableHead className="font-semibold text-gray-900 text-center"><MultiSelectColumnFilter label="状态" options={statusFilterOptions} selectedValues={statusFilter} onChange={setStatusFilter} /></TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {isLoading ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载应收数据...</TableCell></TableRow> : null}
                {!isLoading && filteredReceivables.length === 0 ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有应收记录。</TableCell></TableRow> : null}
                {!isLoading && filteredReceivables.map((item) => (
                  <TableRow key={item.id} className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-blue-600">{item.id}</TableCell>
                    <TableCell className="text-gray-500">{item.orderId}</TableCell>
                    <TableCell className="text-gray-900">{item.customer}</TableCell>
                    <TableCell className="text-right font-medium text-gray-900">{formatCurrency(item.amountDue)}</TableCell>
                    <TableCell className="text-right font-semibold text-blue-600">{formatCurrency(item.remainingAmount)}</TableCell>
                    <TableCell className="text-gray-500">{item.dueDate}</TableCell>
                    <TableCell className="text-center"><Badge variant={receivableVariant(item.status)}>{item.status}</Badge></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-blue-50 hover:text-blue-600" onClick={() => void handleViewReceivableDetail(item.id)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <RowActionMenu
                          items={[
                            { id: 'receivable-detail', label: '进入单据页', icon: Eye, onSelect: () => void handleViewReceivableDetail(item.id) },
                            { id: 'receivable-preview', label: '预览应收单', icon: History, onSelect: () => void handleOpenReceivableDocument(item.id) },
                            { id: 'receivable-receive', label: '登记收款', icon: Wallet, onSelect: () => void handleViewReceivableDetail(item.id), disabled: item.remainingAmount <= 0 || !canReceive },
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
              <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">应付单号</TableHead><TableHead className="font-semibold text-gray-900">关联采购单</TableHead><TableHead className="font-semibold text-gray-900"><MultiSelectColumnFilter label="供应商" options={partyFilterOptions} selectedValues={partyFilter} onChange={setPartyFilter} /></TableHead><TableHead className="font-semibold text-gray-900 text-right"><RangeColumnFilter label="应付金额" value={amountFilter} onChange={setAmountFilter} minPlaceholder="最小金额" maxPlaceholder="最大金额" /></TableHead><TableHead className="font-semibold text-gray-900 text-right"><RangeColumnFilter label="待付金额" value={remainingFilter} onChange={setRemainingFilter} minPlaceholder="最小金额" maxPlaceholder="最大金额" /></TableHead><TableHead className="font-semibold text-gray-900"><RangeColumnFilter label="到期日" inputType="date" value={dueDateFilter} onChange={setDueDateFilter} minPlaceholder="开始日期" maxPlaceholder="结束日期" /></TableHead><TableHead className="font-semibold text-gray-900 text-center"><MultiSelectColumnFilter label="状态" options={statusFilterOptions} selectedValues={statusFilter} onChange={setStatusFilter} /></TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {isLoading ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载应付数据...</TableCell></TableRow> : null}
                {!isLoading && filteredPayables.length === 0 ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有应付记录。</TableCell></TableRow> : null}
                {!isLoading && filteredPayables.map((item) => (
                  <TableRow key={item.id} className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-blue-600">{item.id}</TableCell>
                    <TableCell className="text-gray-500">{item.purchaseOrderId}</TableCell>
                    <TableCell className="text-gray-900">{item.supplier}</TableCell>
                    <TableCell className="text-right font-medium text-gray-900">{formatCurrency(item.amountDue)}</TableCell>
                    <TableCell className="text-right font-semibold text-blue-600">{formatCurrency(item.remainingAmount)}</TableCell>
                    <TableCell className="text-gray-500">{item.dueDate}</TableCell>
                    <TableCell className="text-center"><Badge variant={payableVariant(item.status)}>{item.status}</Badge></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-blue-50 hover:text-blue-600" onClick={() => void handleViewPayableDetail(item.id)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <RowActionMenu
                          items={[
                            { id: 'payable-detail', label: '查看详情', icon: Eye, onSelect: () => void handleViewPayableDetail(item.id) },
                            { id: 'payable-pay', label: '登记付款', icon: Wallet, onSelect: () => void handlePay(item), disabled: item.remainingAmount <= 0 || !canPay || activeId === item.id },
                          ]}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {activePageData ? (
            <div className="border-t border-gray-100 px-4">
              <Pagination
                page={activePageData.page}
                totalPages={activePageData.totalPages}
                total={activePageData.total}
                pageSize={activePageData.pageSize}
                onPageChange={setCurrentPage}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <DocumentPreviewModal documents={previewDocuments} isOpen={isPreviewOpen} initialActiveId={previewInitialId} onClose={() => setIsPreviewOpen(false)} />
      {confirmDialog}
    </div>
  );
}
