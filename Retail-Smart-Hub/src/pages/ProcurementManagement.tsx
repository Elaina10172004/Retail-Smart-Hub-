import React, { useEffect, useMemo, useState } from 'react';
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
import { buildProcurementDocument } from '@/lib/documents';
import { formatCurrency } from '@/lib/format';
import { Bot, Eye, Filter, LoaderCircle, PackagePlus, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import {
  createProcurementOrder,
  deleteProcurementOrder,
  fetchProcurementArrivalWorkspace,
  fetchProcurementFormOptions,
  fetchProcurementOrderDetail,
  fetchProcurementOrders,
  fetchProcurementSuggestions,
  generateSuggestedPurchaseOrders,
  registerProcurementArrival,
  updateProcurementStatus,
} from '@/services/api/procurement';
import type { DocumentPreviewRecord } from '@/types/documents';
import type {
  CreateProcurementOrderPayload,
  ProcurementFormOptions,
  ProcurementFormProductOption,
  ProcurementOrder,
  ProcurementSuggestionSummary,
} from '@/types/procurement';

type ProcurementDraftMode = 'existing' | 'new';

interface ProcurementNewProductDraft {
  name: string;
  sku: string;
  salePrice: string;
  category: string;
  unit: string;
  safeStock: string;
}

interface ProcurementItemDraft {
  id: string;
  mode: ProcurementDraftMode;
  supplierId: string;
  productId: string;
  quantity: string;
  unitCost: string;
  newProduct: ProcurementNewProductDraft;
}

const PROCUREMENT_FORCE_STATUS_OPTIONS = ['待审核', '采购中', '部分到货', '已完成', '已取消'] as const;
type ProcurementForceStatus = (typeof PROCUREMENT_FORCE_STATUS_OPTIONS)[number];

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function badgeVariant(status: string) {
  if (status === '待审核') return 'warning';
  if (status === '采购中') return 'default';
  if (status === '部分到货') return 'secondary';
  if (status === '已取消') return 'outline';
  return 'success';
}

function deriveExpectedDate(leadTimeDays = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + leadTimeDays);
  return date.toISOString().slice(0, 10);
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

function createDefaultNewProductDraft(): ProcurementNewProductDraft {
  return {
    name: '',
    sku: '',
    salePrice: '',
    category: '采购新增',
    unit: '件',
    safeStock: '0',
  };
}

function createEmptyItem(mode: ProcurementDraftMode = 'existing', seed = Date.now(), supplierId = ''): ProcurementItemDraft {
  return {
    id: `procurement-item-${seed}`,
    mode,
    supplierId,
    productId: '',
    quantity: '',
    unitCost: '',
    newProduct: createDefaultNewProductDraft(),
  };
}

function renderProductLabel(product: ProcurementFormProductOption) {
  return `${product.sku} / ${product.name}`;
}

function getNextProcurementAction(order: ProcurementOrder) {
  if (order.status === '待审核') {
    return { label: '推进到采购中', targetStatus: '采购中' as const };
  }
  if (order.status === '采购中') {
    return { label: '推进到到货', targetStatus: '到货' as const };
  }
  return null;
}

export function ProcurementManagement() {
  const { user, hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const canManageProcurement = hasPermission('procurement.manage');
  const [orders, setOrders] = useState<ProcurementOrder[]>([]);
  const [suggestion, setSuggestion] = useState<ProcurementSuggestionSummary | null>(null);
  const [formOptions, setFormOptions] = useState<ProcurementFormOptions>({ suppliers: [], products: [] });
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [remark, setRemark] = useState('');
  const [draftItems, setDraftItems] = useState<ProcurementItemDraft[]>([createEmptyItem()]);
  const [createDraftNo, setCreateDraftNo] = useState('');
  const [createDraftAt, setCreateDraftAt] = useState('');
  const [previewDocuments, setPreviewDocuments] = useState<DocumentPreviewRecord[]>([]);
  const [previewInitialId, setPreviewInitialId] = useState('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [forceStatusDraft, setForceStatusDraft] = useState<{
    orderId: string;
    supplier: string;
    currentStatus: string;
    nextStatus: ProcurementForceStatus;
  } | null>(null);

  const filteredOrders = useMemo(() => {
    return orders.filter((item) => {
      const matchesSearch =
        !searchTerm ||
        item.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.supplier.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = !statusFilter || item.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [orders, searchTerm, statusFilter]);

  const selectedSupplier = useMemo(
    () => formOptions.suppliers.find((item) => item.id === supplierId) || null,
    [formOptions.suppliers, supplierId],
  );
  const supplierOptions = useMemo(
    () =>
      formOptions.suppliers.map((supplier) => ({
        value: supplier.id,
        label: supplier.name,
        keywords: [supplier.name, `${supplier.leadTimeDays}`],
        description: `提前期 ${supplier.leadTimeDays} 天`,
      })),
    [formOptions.suppliers],
  );
  const supplierMap = useMemo(
    () => new Map(formOptions.suppliers.map((supplier) => [supplier.id, supplier])),
    [formOptions.suppliers],
  );
  const supplierProducts = useMemo(() => formOptions.products, [formOptions.products]);
  const currentSupplierProducts = useMemo(
    () => formOptions.products.filter((item) => item.preferredSupplierId === supplierId),
    [formOptions.products, supplierId],
  );
  const productMap = useMemo(
    () => new Map(formOptions.products.map((product) => [product.id, product])),
    [formOptions.products],
  );
  const draftSupplierLabel = useMemo(() => {
    const resolvedSupplierIds = new Set<string>();
    draftItems.forEach((item) => {
      const resolvedSupplierId = item.supplierId || supplierId;
      if (resolvedSupplierId) {
        resolvedSupplierIds.add(resolvedSupplierId);
      }
    });

    if (resolvedSupplierIds.size > 1) {
      return '多供应商';
    }

    if (resolvedSupplierIds.size === 1) {
      const resolvedSupplierId = Array.from(resolvedSupplierIds)[0];
      return supplierMap.get(resolvedSupplierId)?.name || selectedSupplier?.name || '多供应商';
    }

    return selectedSupplier?.name || '多供应商';
  }, [draftItems, selectedSupplier?.name, supplierId, supplierMap]);
  const totalDraftAmount = useMemo(
    () => draftItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0),
    [draftItems],
  );
  const totalDraftQuantity = useMemo(
    () => draftItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    [draftItems],
  );

  const loadProcurement = async () => {
    setIsLoading(true);
    setPageError('');

    try {
      const [ordersResponse, suggestionResponse, formOptionsResponse] = await Promise.all([
        fetchProcurementOrders(),
        fetchProcurementSuggestions(),
        fetchProcurementFormOptions(),
      ]);
      setOrders(ordersResponse.data);
      setSuggestion(suggestionResponse.data);
      setFormOptions(formOptionsResponse.data);

      const initialSupplierId = supplierId || formOptionsResponse.data.suppliers[0]?.id || '';
      const initialSupplier =
        formOptionsResponse.data.suppliers.find((item) => item.id === initialSupplierId) || null;
      setSupplierId(initialSupplierId);
      setExpectedDate((current) => current || deriveExpectedDate(initialSupplier?.leadTimeDays ?? 0));
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadProcurement();
  }, []);

  const openPreview = (documents: DocumentPreviewRecord[], activeId?: string) => {
    if (documents.length === 0) {
      return;
    }

    setPreviewDocuments(documents);
    setPreviewInitialId(activeId || documents[0]?.id || '');
    setIsPreviewOpen(true);
  };

  const resetCreateForm = (nextSupplierId?: string) => {
    const fallbackSupplierId = nextSupplierId || formOptions.suppliers[0]?.id || '';
    const fallbackSupplier = formOptions.suppliers.find((item) => item.id === fallbackSupplierId) || null;
    setSupplierId(fallbackSupplierId);
    setExpectedDate(deriveExpectedDate(fallbackSupplier?.leadTimeDays ?? 0));
    setRemark('');
    setDraftItems([createEmptyItem('existing', Date.now(), fallbackSupplierId)]);
    setCreateDraftNo(buildDraftDocumentNo('PO'));
    setCreateDraftAt(formatDraftDateTime());
    setFormError('');
  };

  const handleToggleCreateForm = () => {
    if (isCreateOpen) {
      setIsCreateOpen(false);
      setFormError('');
      return;
    }

    if ((!supplierId || !draftItems[0]?.supplierId) && formOptions.suppliers.length > 0) {
      resetCreateForm(supplierId || formOptions.suppliers[0]?.id);
    }

    setCreateDraftNo(buildDraftDocumentNo('PO'));
    setCreateDraftAt(formatDraftDateTime());

    setFormError('');
    setIsCreateOpen(true);
  };

  const handleGenerateOrders = async () => {
    if (!canManageProcurement) {
      setPageError('当前角色没有采购写入权限。');
      return;
    }
    if (!(await confirm('确认按当前低库存建议自动生成采购单？'))) {
      return;
    }

    setIsGenerating(true);
    setActionMessage('');
    setPageError('');

    try {
      const response = await generateSuggestedPurchaseOrders();
      setActionMessage(response.message || '建议采购单已生成。');
      await loadProcurement();

      if (response.data.length > 0) {
        const detailResponses = await Promise.all(response.data.map((item) => fetchProcurementOrderDetail(item.id)));
        openPreview(detailResponses.map((item) => buildProcurementDocument(item.data)), detailResponses[0]?.data.id);
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleViewDetail = async (id: string) => {
    setPageError('');
    try {
      const response = await fetchProcurementOrderDetail(id);
      openPreview([buildProcurementDocument(response.data)], response.data.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  };

  const handleFilterSupplier = (supplier: string) => {
    setSearchTerm(supplier);
    setActionMessage(`已按供应商 ${supplier} 筛选采购列表。`);
  };

  const handleFilterStatus = (status: string) => {
    setStatusFilter(status);
    setActionMessage(`已按状态 ${status} 筛选采购列表。`);
  };

  const handleForceUpdateStatus = async (order: ProcurementOrder) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可强制修改采购单状态。');
      return;
    }

    const normalizedStatus = PROCUREMENT_FORCE_STATUS_OPTIONS.includes(order.status as ProcurementForceStatus)
      ? (order.status as ProcurementForceStatus)
      : '待审核';

    setForceStatusDraft({
      orderId: order.id,
      supplier: order.supplier,
      currentStatus: order.status,
      nextStatus: normalizedStatus,
    });
  };

  const handleSubmitForceStatus = async () => {
    if (!forceStatusDraft) {
      return;
    }

    if (!(await confirm(`确认将采购单 ${forceStatusDraft.orderId} 状态改为 ${forceStatusDraft.nextStatus}？`))) {
      return;
    }

    setIsGenerating(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await updateProcurementStatus(forceStatusDraft.orderId, { status: forceStatusDraft.nextStatus });
      setActionMessage(response.message || `采购单 ${forceStatusDraft.orderId} 状态已更新。`);
      setForceStatusDraft(null);
      await loadProcurement();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDeleteOrder = async (order: ProcurementOrder) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可删除采购单。');
      return;
    }
    if (!(await confirm(`确认删除采购单 ${order.id}？\n将级联清理关联入库与应付并回滚库存。`))) {
      return;
    }

    setIsGenerating(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteProcurementOrder(order.id, { aggressive: true });
      setActionMessage(response.message || `采购单 ${order.id} 已删除。`);
      if (previewDocuments.some((item) => item.id === order.id)) {
        setIsPreviewOpen(false);
      }
      await loadProcurement();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSupplierChange = (nextSupplierId: string) => {
    const supplier = formOptions.suppliers.find((item) => item.id === nextSupplierId) || null;
    setSupplierId(nextSupplierId);
    setExpectedDate((current) => {
      const hasDraftContent = draftItems.some(
        (item) => item.productId || item.quantity || item.unitCost || item.newProduct.name.trim() || item.newProduct.sku.trim(),
      );
      if (current && hasDraftContent) {
        return current;
      }
      return deriveExpectedDate(supplier?.leadTimeDays ?? 0);
    });
    setFormError('');
  };

  const handleAdvanceProcurementStatus = async (order: ProcurementOrder) => {
    if (!canManageProcurement) {
      setPageError('当前角色没有采购写入权限。');
      return;
    }

    const nextAction = getNextProcurementAction(order);
    if (!nextAction) {
      setPageError(`采购单 ${order.id} 当前状态无需继续推进。`);
      return;
    }

    setIsGenerating(true);
    setPageError('');
    setActionMessage('');

    try {
      if (nextAction.targetStatus === '采购中') {
        if (!(await confirm(`确认将采购单 ${order.id} 从“待审核”推进到“采购中”？`))) {
          setIsGenerating(false);
          return;
        }
        const response = await updateProcurementStatus(order.id, { status: '采购中' });
        setActionMessage(response.message || `采购单 ${order.id} 已推进到采购中。`);
      } else {
        const workspaceResponse = await fetchProcurementArrivalWorkspace(order.id);
        const remainingItems = workspaceResponse.data.items
          .filter((item) => item.remainingQty > 0)
          .map((item) => ({ itemId: item.itemId, arrivedQty: item.remainingQty }));

        if (remainingItems.length === 0) {
          setActionMessage(`采购单 ${order.id} 当前没有可登记到货的剩余商品。`);
          await loadProcurement();
          return;
        }

        if (!(await confirm(`确认将采购单 ${order.id} 推进到“到货”？\n系统会按当前剩余数量一次性登记到货，并进入验收入库流程。`))) {
          setIsGenerating(false);
          return;
        }

        const response = await registerProcurementArrival(order.id, { items: remainingItems });
        setActionMessage(response.message || `采购单 ${order.id} 已到货，已进入验收入库流程。`);
      }

      await loadProcurement();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddItem = (mode: ProcurementDraftMode = 'existing') => {
    setDraftItems((current) => [...current, createEmptyItem(mode, Date.now() + current.length, supplierId)]);
  };

  const handleRemoveItem = (id: string) => {
    setDraftItems((current) => current.filter((item) => item.id !== id));
  };

  const handleModeChange = (id: string, mode: ProcurementDraftMode) => {
    setDraftItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, mode, productId: '', unitCost: '', newProduct: createDefaultNewProductDraft() } : item,
      ),
    );
  };

  const handleDraftSupplierChange = (id: string, nextSupplierId: string) => {
    setDraftItems((current) =>
      current.map((item) => {
        if (item.id !== id) {
          return item;
        }

        if (item.mode === 'existing') {
          return {
            ...item,
            supplierId: nextSupplierId,
            productId: '',
            unitCost: '',
          };
        }

        return {
          ...item,
          supplierId: nextSupplierId,
        };
      }),
    );
  };

  const handleDraftChange = (id: string, field: 'productId' | 'quantity' | 'unitCost', value: string) => {
    setDraftItems((current) =>
      current.map((item) => {
        if (item.id !== id) {
          return item;
        }

        if (field === 'productId') {
          const product = supplierProducts.find((candidate) => candidate.id === value) || null;
          return { ...item, productId: value, unitCost: product ? String(product.costPrice) : '' };
        }

        if (field === 'unitCost' && item.mode === 'new' && !item.newProduct.salePrice) {
          return { ...item, unitCost: value, newProduct: { ...item.newProduct, salePrice: value } };
        }

        return { ...item, [field]: value };
      }),
    );
  };

  const handleNewProductChange = (id: string, field: keyof ProcurementNewProductDraft, value: string) => {
    setDraftItems((current) =>
      current.map((item) => (item.id === id ? { ...item, newProduct: { ...item.newProduct, [field]: value } } : item)),
    );
  };

  const getSelectableProducts = (draft: ProcurementItemDraft) => {
    const selectedProductIds = new Set(
      draftItems.filter((item) => item.id !== draft.id && item.mode === 'existing').map((item) => item.productId).filter(Boolean),
    );

    const resolvedSupplierId = draft.supplierId || supplierId;
    return supplierProducts.filter(
      (product) =>
        product.preferredSupplierId === resolvedSupplierId && (!selectedProductIds.has(product.id) || product.id === draft.productId),
    );
  };

  const handleSubmitCreateOrder = async () => {
    setFormError('');
    setPageError('');
    setActionMessage('');

    if (!canManageProcurement) {
      setFormError('当前角色没有采购写入权限。');
      return;
    }
    if (!supplierId) {
      setFormError('请先选择供应商。');
      return;
    }
    if (!expectedDate) {
      setFormError('请选择预计到货日期。');
      return;
    }
    if (draftItems.length === 0) {
      setFormError('请至少添加一条采购明细。');
      return;
    }

    const uniqueExistingIds = new Set<string>();
    for (const item of draftItems) {
      const resolvedSupplierId = item.supplierId || supplierId;
      if (!resolvedSupplierId) {
        setFormError('请先为每一行选择供应商。');
        return;
      }
      if (Number(item.quantity) <= 0 || !Number.isInteger(Number(item.quantity)) || Number(item.unitCost) <= 0) {
        setFormError('请完整填写每条明细，且数量为正整数、采购单价必须大于 0。');
        return;
      }

      if (item.mode === 'existing') {
        if (!item.productId) {
          setFormError('已有商品模式下必须选择商品。');
          return;
        }
        const product = productMap.get(item.productId);
        if (!product) {
          setFormError('所选商品不存在或不可用。');
          return;
        }
        if (product.preferredSupplierId !== resolvedSupplierId) {
          setFormError('当前行商品必须属于该行选择的供应商。');
          return;
        }
        if (uniqueExistingIds.has(item.productId)) {
          setFormError('同一张采购单中不能重复选择相同商品。');
          return;
        }
        uniqueExistingIds.add(item.productId);
      }

      if (item.mode === 'new') {
        if (!item.newProduct.name.trim()) {
          setFormError('新增商品模式下必须填写商品名称。');
          return;
        }
        if (item.newProduct.salePrice && Number(item.newProduct.salePrice) <= 0) {
          setFormError('新增商品的销售价必须大于 0。');
          return;
        }
        if (item.newProduct.safeStock !== '' && (!Number.isInteger(Number(item.newProduct.safeStock)) || Number(item.newProduct.safeStock) < 0)) {
          setFormError('新增商品的安全库存必须是大于等于 0 的整数。');
          return;
        }
      }
    }

    const payload: CreateProcurementOrderPayload = {
      supplierId,
      expectedDate,
      remark: remark.trim(),
      items: draftItems.map((item) => {
        const resolvedSupplierId = item.supplierId || supplierId;
        if (item.mode === 'existing') {
          return {
            mode: 'existing',
            supplierId: resolvedSupplierId,
            productId: item.productId,
            quantity: Number(item.quantity),
            unitCost: Number(item.unitCost),
          };
        }

        return {
          mode: 'new',
          supplierId: resolvedSupplierId,
          quantity: Number(item.quantity),
          unitCost: Number(item.unitCost),
          newProduct: {
            name: item.newProduct.name.trim(),
            ...(item.newProduct.sku.trim() ? { sku: item.newProduct.sku.trim() } : {}),
            ...(item.newProduct.salePrice ? { salePrice: Number(item.newProduct.salePrice) } : {}),
            ...(item.newProduct.category.trim() ? { category: item.newProduct.category.trim() } : {}),
            ...(item.newProduct.unit.trim() ? { unit: item.newProduct.unit.trim() } : {}),
            ...(item.newProduct.safeStock !== '' ? { safeStock: Number(item.newProduct.safeStock) } : {}),
          },
        };
      }),
    };

    if (!(await confirm(`确认创建采购单并写入系统？\n供应商：${draftSupplierLabel}\n金额：${formatCurrency(totalDraftAmount)}`))) {
      return;
    }

    const submittedSupplierId = supplierId;
    setIsGenerating(true);

    try {
      const response = await createProcurementOrder(payload);
      setActionMessage(response.message || `采购单 ${response.data.id} 已创建。`);
      openPreview([buildProcurementDocument(response.data)], response.data.id);
      await loadProcurement();
      resetCreateForm(submittedSupplierId);
      setIsCreateOpen(false);
    } catch (error) {
      setFormError(getErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">采购管理</h2>
          <p className="mt-1 text-sm text-gray-500">支持低库存自动补货、采购内新增商品，以及统一的真实单据预览。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadProcurement()} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            刷新列表
          </Button>
          <Button variant="outline" className="border-blue-200 text-blue-700 hover:bg-blue-50 shadow-sm" onClick={handleToggleCreateForm} disabled={!canManageProcurement}>
            {isCreateOpen ? <X className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
            {isCreateOpen ? '收起表单' : '新建采购单'}
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleGenerateOrders()} disabled={isGenerating || !canManageProcurement}>
            {isGenerating ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
            生成建议采购单
          </Button>
        </div>
      </div>

      {pageError ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">采购数据处理失败：{pageError}</div> : null}
      {actionMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div> : null}

      {isCreateOpen ? (
        <Card className="overflow-hidden border-blue-200 shadow-sm">
          <CardHeader className="border-b border-blue-100 bg-blue-50/60">
            <CardTitle className="flex items-center gap-2 text-blue-900">
              <PackagePlus className="h-5 w-5 text-blue-600" />
              自定义采购单
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[11px] leading-5 text-slate-500 shadow-sm">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="whitespace-nowrap"><span className="text-slate-500">单号：</span><span className="font-semibold text-slate-900">{createDraftNo || 'PO-DRAFT'}</span></span>
                <span className="whitespace-nowrap"><span className="text-slate-500">时间：</span><span className="text-slate-700">{createDraftAt || formatDraftDateTime()}</span></span>
                <span className="whitespace-nowrap"><span className="text-slate-500">状态：</span><span className="font-semibold text-slate-900">草稿</span></span>
                <span className="whitespace-nowrap"><span className="text-slate-500">供应商：</span><span className="text-slate-700">{draftSupplierLabel}</span></span>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium leading-none text-gray-600">供应商</label>
                <SearchableSelect
                  value={supplierId}
                  onChange={handleSupplierChange}
                  options={supplierOptions}
                  placeholder="请选择供应商"
                  searchPlaceholder="输入供应商名称或提前期检索"
                  emptyText="没有匹配的供应商"
                  inputClassName="h-9"
                />
                <select value={supplierId} onChange={(event) => handleSupplierChange(event.target.value)} className="hidden" tabIndex={-1} aria-hidden="true">
                  <option value="">请选择供应商</option>
                  {formOptions.suppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium leading-none text-gray-600">预计到货日期</label>
                <Input type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium leading-none text-gray-600">供应商提前期</label>
                <div className="flex h-9 items-center rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-gray-600">
                  {selectedSupplier ? `${selectedSupplier.leadTimeDays} 天` : '选择供应商后自动带出'}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium leading-none text-gray-600">备注</label>
                <Input value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="可填写采购备注" className="h-9" />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-900">采购明细</h3>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="border-blue-200 text-blue-700 hover:bg-blue-50" onClick={() => handleAddItem('existing')} disabled={!supplierId}>
                    <Plus className="mr-2 h-4 w-4" />
                    添加已有商品
                  </Button>
                  <Button variant="outline" size="sm" className="border-amber-200 text-amber-700 hover:bg-amber-50" onClick={() => handleAddItem('new')} disabled={!supplierId}>
                    <Plus className="mr-2 h-4 w-4" />
                    添加新增商品
                  </Button>
                </div>
              </div>

              {!supplierId ? <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">请先选择供应商，再录入采购明细。</div> : null}
              {supplierId && currentSupplierProducts.length === 0 ? <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-4 py-6 text-center text-sm text-amber-700">当前供应商下暂无现有商品，可直接使用“新增商品”模式采购新品。</div> : null}

              <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50/60">
                <div className="grid grid-cols-[124px_110px_minmax(0,1fr)_104px_124px_84px] gap-2 border-b border-gray-200 bg-white/80 px-3 py-2 text-[11px] font-medium leading-none text-gray-600">
                  <div>供应商</div>
                  <div>模式</div>
                  <div>商品名称</div>
                  <div>数量</div>
                  <div>采购单价</div>
                  <div>操作</div>
                </div>
                <div className="space-y-0.5 p-1.5">
                  {draftItems.map((item) => {
                    const resolvedSupplierId = item.supplierId || supplierId;
                    const selectableProducts = getSelectableProducts(item);

                    return (
                      <div
                        key={item.id}
                        className="grid grid-cols-[124px_110px_minmax(0,1fr)_104px_124px_84px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-2 py-1.5"
                      >
                        <select
                          value={resolvedSupplierId}
                          onChange={(event) => handleDraftSupplierChange(item.id, event.target.value)}
                          className="h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">请选择供应商</option>
                          {formOptions.suppliers.map((supplier) => (
                            <option key={supplier.id} value={supplier.id}>
                              {supplier.name}
                            </option>
                          ))}
                        </select>

                        <select
                          value={item.mode}
                          onChange={(event) => handleModeChange(item.id, event.target.value as ProcurementDraftMode)}
                          className="h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="existing">已有商品</option>
                          <option value="new">新增商品</option>
                        </select>

                        {item.mode === 'existing' ? (
                          <div className="min-w-0">
                            <SearchableSelect
                              value={item.productId}
                              onChange={(value) => handleDraftChange(item.id, 'productId', value)}
                              options={selectableProducts.map((product) => ({
                                value: product.id,
                                label: product.name,
                                keywords: [product.name, product.sku, product.unit, product.preferredSupplier, String(product.costPrice)],
                                description: `${product.sku} / ${product.unit} / 成本 ${formatCurrency(product.costPrice)}`,
                              }))}
                              placeholder="请选择商品"
                              searchPlaceholder="输入商品名、SKU 或单位检索"
                              emptyText="没有匹配的商品"
                              disabled={!resolvedSupplierId || selectableProducts.length === 0}
                              inputClassName="h-9"
                            />
                            <select
                              value={item.productId}
                              onChange={(event) => handleDraftChange(item.id, 'productId', event.target.value)}
                              className="hidden"
                              disabled={!resolvedSupplierId || selectableProducts.length === 0}
                              tabIndex={-1}
                              aria-hidden="true"
                            >
                              <option value="">请选择商品</option>
                              {selectableProducts.map((product) => (
                                <option key={product.id} value={product.id}>
                                  {renderProductLabel(product)}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <div className="grid min-w-0 grid-cols-[minmax(0,1.2fr)_168px_128px] gap-1.5">
                            <Input
                              value={item.newProduct.name}
                              onChange={(event) => handleNewProductChange(item.id, 'name', event.target.value)}
                              placeholder="新品名称"
                              className="h-9"
                            />
                            <Input
                              value={item.newProduct.sku}
                              onChange={(event) => handleNewProductChange(item.id, 'sku', event.target.value)}
                              placeholder="留空自动生成 SKU"
                              className="h-9"
                            />
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.newProduct.salePrice}
                              onChange={(event) => handleNewProductChange(item.id, 'salePrice', event.target.value)}
                              placeholder="销售价"
                              className="h-9"
                            />
                          </div>
                        )}

                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={item.quantity}
                          onChange={(event) => handleDraftChange(item.id, 'quantity', event.target.value)}
                          placeholder="0"
                          className="h-9"
                        />
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={item.unitCost}
                          onChange={(event) => handleDraftChange(item.id, 'unitCost', event.target.value)}
                          placeholder="0.00"
                          className="h-9"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 w-full border-red-200 text-red-600 hover:bg-red-50"
                          onClick={() => handleRemoveItem(item.id)}
                          disabled={draftItems.length === 1}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          删除
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
              <div />
              <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
                <h4 className="font-semibold text-gray-900">提交前检查</h4>
                <div className="space-y-2 text-sm text-gray-600">
                  <div className="flex items-center justify-between"><span>供应商</span><span className="font-medium text-gray-900">{selectedSupplier?.name || '未选择'}</span></div>
                  <div className="flex items-center justify-between"><span>预计到货</span><span className="font-medium text-gray-900">{expectedDate || '未选择'}</span></div>
                  <div className="flex items-center justify-between"><span>商品行数</span><span className="font-medium text-gray-900">{draftItems.length}</span></div>
                  <div className="flex items-center justify-between"><span>采购件数</span><span className="font-medium text-gray-900">{totalDraftQuantity}</span></div>
                  <div className="flex items-center justify-between"><span>采购金额</span><span className="font-semibold text-blue-700">{formatCurrency(totalDraftAmount || 0)}</span></div>
                  <div className="flex items-start justify-between gap-3"><span>备注</span><span className="text-right font-medium text-gray-900">{remark || '-'}</span></div>
                </div>
              </div>
            </div>

            {formError ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{formError}</div> : null}

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => { setIsCreateOpen(false); setFormError(''); }}>
                取消
              </Button>
              <Button variant="outline" className="border-blue-200 text-blue-700 hover:bg-blue-50" onClick={() => resetCreateForm(supplierId)} disabled={isGenerating}>
                重置表单
              </Button>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmitCreateOrder()} disabled={isGenerating}>
                {isGenerating ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                提交采购单
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50/50 shadow-sm">
        <CardContent className="flex flex-col items-start justify-between gap-4 p-4 md:flex-row md:items-center">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-600">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <h3 className="flex items-center font-semibold text-blue-900">
                智能采购建议 <Sparkles className="ml-1 h-4 w-4 text-blue-500" />
              </h3>
              <p className="mt-1 text-sm text-blue-700/80">{suggestion?.message || '正在计算补货建议...'}</p>
            </div>
          </div>
          <div className="text-sm font-medium text-blue-900">低库存商品 {suggestion?.lowStockItemCount ?? 0} 个 / 推荐采购单 {suggestion?.recommendedOrderCount ?? 0} 张</div>
        </CardContent>
      </Card>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
          <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
            <div className="flex w-full flex-1 flex-wrap gap-4">
              <div className="relative w-full md:w-72">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                <Input placeholder="搜索采购单号、供应商..." className="bg-white border-gray-300 pl-9 focus-visible:ring-blue-500" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
              </div>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">所有状态</option>
                <option value="待审核">待审核</option>
                <option value="采购中">采购中</option>
                <option value="部分到货">部分到货</option>
                <option value="已完成">已完成</option>
                <option value="已取消">已取消</option>
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50/50 hover:bg-gray-50/50">
                <TableHead className="font-semibold text-gray-900">采购单号</TableHead>
                <TableHead className="font-semibold text-gray-900">供应商</TableHead>
                <TableHead className="font-semibold text-gray-900">创建日期</TableHead>
                <TableHead className="font-semibold text-gray-900">预计到货日期</TableHead>
                <TableHead className="font-semibold text-gray-900">来源</TableHead>
                <TableHead className="font-semibold text-gray-900">金额</TableHead>
                <TableHead className="font-semibold text-gray-900">状态</TableHead>
                <TableHead className="text-right font-semibold text-gray-900">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">正在加载采购单列表...</TableCell></TableRow> : null}
              {!isLoading && filteredOrders.length === 0 ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有采购单记录。</TableCell></TableRow> : null}
              {!isLoading ? filteredOrders.map((po) => (
                <TableRow key={po.id} className="transition-colors hover:bg-blue-50/30">
                  <TableCell className="font-medium text-blue-600">{po.id}</TableCell>
                  <TableCell className="text-gray-900">{po.supplier}</TableCell>
                  <TableCell className="text-gray-500">{po.createDate}</TableCell>
                  <TableCell className="text-gray-500">{po.expectedDate}</TableCell>
                  <TableCell className="text-gray-500">{po.source}</TableCell>
                  <TableCell className="font-semibold text-gray-900">{po.amount}</TableCell>
                  <TableCell><Badge variant={badgeVariant(po.status)}>{po.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-blue-50 hover:text-blue-600" onClick={() => void handleViewDetail(po.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'view-detail', label: '查看单据', icon: Eye, onSelect: () => void handleViewDetail(po.id) },
                          ...(getNextProcurementAction(po)
                            ? [
                                {
                                  id: 'advance-status',
                                  label: getNextProcurementAction(po)?.label || '推进状态',
                                  icon: PackagePlus,
                                  onSelect: () => void handleAdvanceProcurementStatus(po),
                                  disabled: !canManageProcurement,
                                },
                              ]
                            : []),
                          { id: 'filter-supplier', label: '按同供应商筛选', icon: Filter, onSelect: () => handleFilterSupplier(po.supplier) },
                          { id: 'filter-status', label: '按同状态筛选', icon: Filter, onSelect: () => handleFilterStatus(po.status) },
                          { id: 'force-status', label: '强制改状态', icon: Sparkles, onSelect: () => void handleForceUpdateStatus(po), disabled: !isSuperAdmin },
                          { id: 'delete-po', label: '删除采购单', icon: Trash2, onSelect: () => void handleDeleteOrder(po), disabled: !isSuperAdmin, tone: 'danger' },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              )) : null}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between rounded-b-xl border-t border-gray-100 bg-gray-50/30 px-6 py-4">
            <div className="text-sm text-gray-500">当前显示 {filteredOrders.length} 条采购单记录</div>
            {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin text-gray-400" /> : null}
          </div>
        </CardContent>
      </Card>

      {forceStatusDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-[1px]">
          <Card className="w-full max-w-md border-slate-200 shadow-xl">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="text-base text-slate-900">强制改状态</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4 text-sm text-slate-700">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">采购单：{forceStatusDraft.orderId} / {forceStatusDraft.supplier}</div>
              <div className="space-y-2">
                <div className="text-xs text-slate-500">当前状态：{forceStatusDraft.currentStatus}</div>
                <select value={forceStatusDraft.nextStatus} onChange={(event) => { const value = event.target.value as ProcurementForceStatus; setForceStatusDraft((current) => (current ? { ...current, nextStatus: value } : current)); }} className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {PROCUREMENT_FORCE_STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setForceStatusDraft(null)}>取消</Button>
                <Button onClick={() => void handleSubmitForceStatus()} disabled={isGenerating}>
                  {isGenerating ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                  确认修改
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <DocumentPreviewModal documents={previewDocuments} isOpen={isPreviewOpen} initialActiveId={previewInitialId} onClose={() => setIsPreviewOpen(false)} />
      {confirmDialog}
    </div>
  );
}
