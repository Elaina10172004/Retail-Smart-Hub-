import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Eye, Filter, LoaderCircle, PackageCheck, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react';
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
import { GroupedDocumentTable } from '@/components/ui/grouped-document-table';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { DocumentPreviewModal } from '@/components/documents/DocumentPreviewModal';
import { useAuth } from '@/auth/AuthContext';
import { buildArrivalDocument, buildInboundDocument } from '@/lib/documents';
import { clearApiGetCache } from '@/services/api/client';
import { advanceArrival, createManualArrival, fetchArrivalDetail, fetchArrivalsPaginated, fetchManualArrivalCreateOptions, forceUpdateArrivalLines } from '@/services/api/arrival';
import { createManualInbound, fetchManualInboundCreateOptions } from '@/services/api/inbound';
import { confirmInbound, deleteInbound, fetchInboundDetail, fetchInboundsPaginated, forceUpdateInboundLines, saveInboundDraft, updateInboundStatus } from '@/services/api/inbound';
import type { PaginatedData } from '@/types/api';
import type { DocumentPreviewRecord } from '@/types/documents';
import type { ArrivalDetailRecord, ArrivalRecord, CreateManualArrivalItemPayload, ManualArrivalCandidateItem } from '@/types/arrival';
import type { CreateManualInboundItemPayload, InboundDetailRecord, InboundDetailItem, InboundRecord, ManualInboundCandidateItem, SaveInboundDraftPayload, UpdateInboundStatusPayload } from '@/types/inbound';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

const INBOUND_FORCE_STATUS_OPTIONS = ['待入库', '已入库'] as const;
type InboundForceStatus = (typeof INBOUND_FORCE_STATUS_OPTIONS)[number];
const ARRIVAL_FILTER_STATUS_OPTIONS = ['待验收', '部分到货'] as const;
const PAGE_SIZE = 20;

interface InboundDraftItemState {
  itemId: string;
  qualifiedQty: string;
  inboundQty: string;
  shelfId: string;
}

interface ArrivalForceLineDraftItem {
  itemId: string;
  sku: string;
  productName: string;
  expectedQty: string;
  arrivedQty: string;
  qualifiedQty: string;
  defectQty: string;
}

interface CreateGroup<TItem> {
  purchaseOrderId: string;
  supplier: string;
  expectedDate: string;
  items: TItem[];
}

function createDraftItems(detail: InboundDetailRecord): InboundDraftItemState[] {
  return detail.itemsDetail.map((item) => ({
    itemId: item.id,
    qualifiedQty: String(item.qualifiedQty),
    inboundQty: String(item.inboundQty),
    shelfId: item.shelfId || item.suggestedShelfId || '',
  }));
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

export function InboundManagement() {
  const { user, hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const isSuperAdmin = Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员')));
  const canConfirmInbound = hasPermission('procurement.manage');
  const [waitingArrivalsData, setWaitingArrivalsData] = useState<PaginatedData<ArrivalRecord> | null>(null);
  const [waitingInboundsData, setWaitingInboundsData] = useState<PaginatedData<InboundRecord> | null>(null);
  const [completedInboundsData, setCompletedInboundsData] = useState<PaginatedData<InboundRecord> | null>(null);
  const [arrivalCreateOptions, setArrivalCreateOptions] = useState<ManualArrivalCandidateItem[]>([]);
  const [inboundCreateOptions, setInboundCreateOptions] = useState<ManualInboundCandidateItem[]>([]);
  const [selectedInbound, setSelectedInbound] = useState<InboundDetailRecord | null>(null);
  const [draftItems, setDraftItems] = useState<InboundDraftItemState[]>([]);
  const [previewDocuments, setPreviewDocuments] = useState<DocumentPreviewRecord[]>([]);
  const [previewInitialId, setPreviewInitialId] = useState('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isArrivalCreateOpen, setIsArrivalCreateOpen] = useState(false);
  const [isInboundCreateOpen, setIsInboundCreateOpen] = useState(false);
  const [arrivalDraftNo, setArrivalDraftNo] = useState('');
  const [arrivalDraftAt, setArrivalDraftAt] = useState('');
  const [inboundDraftNo, setInboundDraftNo] = useState('');
  const [inboundDraftAt, setInboundDraftAt] = useState('');
  const [selectedArrivalItems, setSelectedArrivalItems] = useState<Record<string, boolean>>({});
  const [selectedInboundItems, setSelectedInboundItems] = useState<Record<string, boolean>>({});
  const [arrivalCreateQty, setArrivalCreateQty] = useState<Record<string, string>>({});
  const [inboundCreateQty, setInboundCreateQty] = useState<Record<string, string>>({});
  const [arrivalExpandedIds, setArrivalExpandedIds] = useState<string[]>([]);
  const [inboundExpandedIds, setInboundExpandedIds] = useState<string[]>([]);
  const [isCreatingArrival, setIsCreatingArrival] = useState(false);
  const [isCreatingInbound, setIsCreatingInbound] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [supplierFilter, setSupplierFilter] = useState<string[]>([]);
  const [arrivalStatusFilter, setArrivalStatusFilter] = useState<string[]>([]);
  const [inboundStatusFilter, setInboundStatusFilter] = useState<string[]>([]);
  const [warehouseFilter, setWarehouseFilter] = useState<string[]>([]);
  const [arrivalQtyFilter, setArrivalQtyFilter] = useState<RangeFilterValue>(EMPTY_RANGE_FILTER);
  const [inboundQtyFilter, setInboundQtyFilter] = useState<RangeFilterValue>(EMPTY_RANGE_FILTER);
  const [arrivalPage, setArrivalPage] = useState(1);
  const [waitingInboundPage, setWaitingInboundPage] = useState(1);
  const [completedInboundPage, setCompletedInboundPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [forceStatusDraft, setForceStatusDraft] = useState<{
    inboundId: string;
    rcvId: string;
    supplier: string;
    currentStatus: InboundForceStatus;
    nextStatus: InboundForceStatus;
  } | null>(null);
  const [forceArrivalDraft, setForceArrivalDraft] = useState<{
    arrivalId: string;
    poId: string;
    supplier: string;
    reason: string;
    items: ArrivalForceLineDraftItem[];
  } | null>(null);

  const showWaitingInbounds = inboundStatusFilter.length === 0 || inboundStatusFilter.includes('待入库');
  const showCompletedInbounds = inboundStatusFilter.length === 0 || inboundStatusFilter.includes('已入库');
  const waitingArrivalRecords = waitingArrivalsData?.items ?? [];
  const waitingInboundRecords = showWaitingInbounds ? waitingInboundsData?.items ?? [] : [];
  const completedInboundRecords = showCompletedInbounds ? completedInboundsData?.items ?? [] : [];
  const supplierFilterOptions = useMemo(
    () => buildColumnFilterOptions([
      ...supplierFilter,
      ...waitingArrivalRecords.map((item) => item.supplier),
      ...waitingInboundRecords.map((item) => item.supplier),
      ...completedInboundRecords.map((item) => item.supplier),
      ...arrivalCreateOptions.map((item) => item.supplier),
      ...inboundCreateOptions.map((item) => item.supplier),
    ]),
    [arrivalCreateOptions, completedInboundRecords, inboundCreateOptions, supplierFilter, waitingArrivalRecords, waitingInboundRecords],
  );
  const arrivalStatusFilterOptions = useMemo(
    () => ARRIVAL_FILTER_STATUS_OPTIONS.map((status) => ({ value: status, label: status })),
    [],
  );
  const inboundStatusFilterOptions = useMemo(
    () => INBOUND_FORCE_STATUS_OPTIONS.map((status) => ({ value: status, label: status })),
    [],
  );
  const warehouseFilterOptions = useMemo(
    () => buildColumnFilterOptions([
      ...warehouseFilter,
      ...waitingInboundRecords.map((item) => item.warehouse),
      ...completedInboundRecords.map((item) => item.warehouse),
    ]),
    [completedInboundRecords, waitingInboundRecords, warehouseFilter],
  );
  const hasInboundColumnFilters =
    supplierFilter.length > 0 ||
    arrivalStatusFilter.length > 0 ||
    inboundStatusFilter.length > 0 ||
    warehouseFilter.length > 0 ||
    isRangeFilterActive(arrivalQtyFilter) ||
    isRangeFilterActive(inboundQtyFilter);

  const loadInboundHub = async (keepSelectedId?: string) => {
    setIsLoading(true);
    setPageError('');
    try {
      const inboundQuery = {
        search: searchTerm,
        supplier: supplierFilter.join(',') || undefined,
        warehouse: warehouseFilter.join(',') || undefined,
        itemQtyMin: inboundQtyFilter.min,
        itemQtyMax: inboundQtyFilter.max,
      };
      const [waitingInboundResponse, completedInboundResponse, arrivalResponse, arrivalCreateResponse, inboundCreateResponse] = await Promise.all([
        fetchInboundsPaginated({ page: waitingInboundPage, pageSize: PAGE_SIZE, ...inboundQuery, status: '待入库' }),
        fetchInboundsPaginated({ page: completedInboundPage, pageSize: PAGE_SIZE, ...inboundQuery, status: '已入库' }),
        fetchArrivalsPaginated({
          page: arrivalPage,
          pageSize: PAGE_SIZE,
          search: searchTerm,
          supplier: supplierFilter.join(',') || undefined,
          status: arrivalStatusFilter.join(',') || '待验收,部分到货',
          arrivedQtyMin: arrivalQtyFilter.min,
          arrivedQtyMax: arrivalQtyFilter.max,
        }),
        fetchManualArrivalCreateOptions(),
        fetchManualInboundCreateOptions(),
      ]);
      setWaitingInboundsData(waitingInboundResponse.data);
      setCompletedInboundsData(completedInboundResponse.data);
      setWaitingArrivalsData(arrivalResponse.data);
      setArrivalCreateOptions(arrivalCreateResponse.data);
      setInboundCreateOptions(inboundCreateResponse.data);

      if (keepSelectedId) {
        const detailResponse = await fetchInboundDetail(keepSelectedId);
        setSelectedInbound(detailResponse.data);
        setDraftItems(createDraftItems(detailResponse.data));
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setArrivalPage(1);
    setWaitingInboundPage(1);
    setCompletedInboundPage(1);
  }, [searchTerm, supplierFilter, arrivalStatusFilter, inboundStatusFilter, warehouseFilter, arrivalQtyFilter, inboundQtyFilter]);

  useEffect(() => {
    void loadInboundHub();
  }, [arrivalPage, waitingInboundPage, completedInboundPage, searchTerm, supplierFilter, arrivalStatusFilter, inboundStatusFilter, warehouseFilter, arrivalQtyFilter, inboundQtyFilter]);

  const resetInboundColumnFilters = () => {
    setSearchTerm('');
    setSupplierFilter([]);
    setArrivalStatusFilter([]);
    setInboundStatusFilter([]);
    setWarehouseFilter([]);
    setArrivalQtyFilter(EMPTY_RANGE_FILTER);
    setInboundQtyFilter(EMPTY_RANGE_FILTER);
    setArrivalPage(1);
    setWaitingInboundPage(1);
    setCompletedInboundPage(1);
  };

  const openPreview = (documents: DocumentPreviewRecord[], activeDocumentId?: string) => {
    if (documents.length === 0) {
      return;
    }
    setPreviewDocuments(documents);
    setPreviewInitialId(activeDocumentId || documents[0]?.id || '');
    setIsPreviewOpen(true);
  };

  const handleOpenInboundWorkspace = async (id: string) => {
    setIsDetailLoading(true);
    setPageError('');
    try {
      const response = await fetchInboundDetail(id);
      setSelectedInbound(response.data);
      setDraftItems(createDraftItems(response.data));
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const getArrivalKey = (item: ManualArrivalCandidateItem) => `${item.purchaseOrderId}::${item.purchaseOrderItemId}`;
  const getInboundKey = (item: ManualInboundCandidateItem) => `${item.purchaseOrderId}::${item.purchaseOrderItemId}`;

  const arrivalCreateGroups = useMemo(() => {
    const groupMap = new Map<string, CreateGroup<ManualArrivalCandidateItem>>();
    arrivalCreateOptions.forEach((item) => {
      const group = groupMap.get(item.purchaseOrderId) ?? {
        purchaseOrderId: item.purchaseOrderId,
        supplier: item.supplier,
        expectedDate: item.expectedDate,
        items: [],
      };
      group.items.push(item);
      groupMap.set(item.purchaseOrderId, group);
    });
    return Array.from(groupMap.values());
  }, [arrivalCreateOptions]);

  const inboundCreateGroups = useMemo(() => {
    const groupMap = new Map<string, CreateGroup<ManualInboundCandidateItem>>();
    inboundCreateOptions.forEach((item) => {
      const group = groupMap.get(item.purchaseOrderId) ?? {
        purchaseOrderId: item.purchaseOrderId,
        supplier: item.supplier,
        expectedDate: item.expectedDate,
        items: [],
      };
      group.items.push(item);
      groupMap.set(item.purchaseOrderId, group);
    });
    return Array.from(groupMap.values());
  }, [inboundCreateOptions]);

  const selectedArrivalPayload = useMemo<CreateManualArrivalItemPayload[]>(() => {
    return arrivalCreateOptions
      .filter((item) => selectedArrivalItems[getArrivalKey(item)])
      .map((item) => ({
        purchaseOrderId: item.purchaseOrderId,
        purchaseOrderItemId: item.purchaseOrderItemId,
        arrivedQty: Number(arrivalCreateQty[getArrivalKey(item)] || item.remainingQty),
      }))
      .filter((item) => Number.isInteger(item.arrivedQty) && item.arrivedQty > 0);
  }, [arrivalCreateOptions, arrivalCreateQty, selectedArrivalItems]);

  const selectedInboundPayload = useMemo<CreateManualInboundItemPayload[]>(() => {
    return inboundCreateOptions
      .filter((item) => selectedInboundItems[getInboundKey(item)])
      .map((item) => ({
        purchaseOrderId: item.purchaseOrderId,
        purchaseOrderItemId: item.purchaseOrderItemId,
        arrivedQty: Number(inboundCreateQty[getInboundKey(item)] || item.remainingQty),
      }))
      .filter((item) => Number.isInteger(item.arrivedQty) && item.arrivedQty > 0);
  }, [inboundCreateOptions, inboundCreateQty, selectedInboundItems]);

  const toggleArrivalGroup = (group: CreateGroup<ManualArrivalCandidateItem>, checked: boolean) => {
    setSelectedArrivalItems((current) => {
      const next = { ...current };
      group.items.forEach((item) => {
        next[getArrivalKey(item)] = checked;
      });
      return next;
    });
    if (checked) {
      setArrivalExpandedIds((current) => (current.includes(group.purchaseOrderId) ? current : [...current, group.purchaseOrderId]));
    }
  };

  const toggleInboundGroup = (group: CreateGroup<ManualInboundCandidateItem>, checked: boolean) => {
    setSelectedInboundItems((current) => {
      const next = { ...current };
      group.items.forEach((item) => {
        next[getInboundKey(item)] = checked;
      });
      return next;
    });
    if (checked) {
      setInboundExpandedIds((current) => (current.includes(group.purchaseOrderId) ? current : [...current, group.purchaseOrderId]));
    }
  };

  const submitManualArrivalCreate = async () => {
    if (selectedArrivalPayload.length === 0) {
      setPageError('请选择至少一条待验收明细。');
      return;
    }
    setIsCreatingArrival(true);
    setPageError('');
    setActionMessage('');
    try {
      const response = await createManualArrival({ items: selectedArrivalPayload });
      setActionMessage(`已创建验收单：${response.data.arrivalIds.join(' / ')}`);
      const detailResponses = await Promise.all(response.data.arrivalIds.map((id) => fetchArrivalDetail(id)));
      openPreview(detailResponses.map((item) => buildArrivalDocument(item.data)), detailResponses[0]?.data.id);
      setIsArrivalCreateOpen(false);
      setSelectedArrivalItems({});
      setArrivalCreateQty({});
      setArrivalExpandedIds([]);
      await loadInboundHub(selectedInbound?.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsCreatingArrival(false);
    }
  };

  const submitManualInboundCreate = async () => {
    if (selectedInboundPayload.length === 0) {
      setPageError('请选择至少一条待入库明细。');
      return;
    }
    setIsCreatingInbound(true);
    setPageError('');
    setActionMessage('');
    try {
      const response = await createManualInbound({ items: selectedInboundPayload });
      setActionMessage(`已创建入库单：${response.data.inboundIds.join(' / ')}`);
      const detailResponses = await Promise.all(response.data.inboundIds.map((id) => fetchInboundDetail(id)));
      openPreview(detailResponses.map((item) => buildInboundDocument(item.data)), detailResponses[0]?.data.id);
      setIsInboundCreateOpen(false);
      setSelectedInboundItems({});
      setInboundCreateQty({});
      setInboundExpandedIds([]);
      await loadInboundHub(selectedInbound?.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsCreatingInbound(false);
    }
  };

  const buildDraftPayload = (): SaveInboundDraftPayload | null => {
    if (!selectedInbound) {
      setPageError('请先打开一张入库单。');
      return null;
    }

    const itemMap = new Map(selectedInbound.itemsDetail.map((item) => [item.id, item]));
    const payloadItems = draftItems.map((draftItem) => {
      const sourceItem = itemMap.get(draftItem.itemId);
      if (!sourceItem) {
        throw new Error('入库明细不存在。');
      }

      const qualifiedQty = Number(draftItem.qualifiedQty);
      const inboundQty = Number(draftItem.inboundQty);
      if (!Number.isInteger(qualifiedQty) || qualifiedQty < 0 || qualifiedQty > sourceItem.arrivedQty) {
        throw new Error(`${sourceItem.sku} 的合格数量不合法。`);
      }
      if (!Number.isInteger(inboundQty) || inboundQty < 0 || inboundQty > qualifiedQty) {
        throw new Error(`${sourceItem.sku} 的入库数量不合法。`);
      }
      if (inboundQty > 0 && !draftItem.shelfId) {
        throw new Error(`${sourceItem.sku} 需要选择入库货架。`);
      }

      return {
        itemId: draftItem.itemId,
        qualifiedQty,
        inboundQty,
        shelfId: draftItem.shelfId,
      };
    });

    return { items: payloadItems };
  };

  const buildPreviewDetail = (): InboundDetailRecord | null => {
    if (!selectedInbound) {
      return null;
    }

    const shelfMap = new Map(selectedInbound.shelfOptions.map((item) => [item.id, item]));
    const draftMap = new Map(draftItems.map((item) => [item.itemId, item]));
    const nextItems: InboundDetailItem[] = selectedInbound.itemsDetail.map((item) => {
      const draftItem = draftMap.get(item.id);
      const shelf = draftItem?.shelfId ? shelfMap.get(draftItem.shelfId) : undefined;
      const qualifiedQty = draftItem ? Number(draftItem.qualifiedQty) : item.qualifiedQty;
      const inboundQty = draftItem ? Number(draftItem.inboundQty) : item.inboundQty;
      return {
        ...item,
        qualifiedQty: Number.isFinite(qualifiedQty) ? qualifiedQty : item.qualifiedQty,
        defectQty: Math.max(item.arrivedQty - (Number.isFinite(qualifiedQty) ? qualifiedQty : item.qualifiedQty), 0),
        inboundQty: Number.isFinite(inboundQty) ? inboundQty : item.inboundQty,
        shelfId: draftItem?.shelfId || undefined,
        shelfCode: shelf?.shelfCode || item.shelfCode,
        shelfName: shelf?.shelfName || item.shelfName,
      };
    });

    return {
      ...selectedInbound,
      items: nextItems.reduce((sum, item) => sum + item.inboundQty, 0),
      itemsDetail: nextItems,
    };
  };

  const handlePreviewInboundDocument = async (id?: string) => {
    setPageError('');
    try {
      if (id) {
        const response = await fetchInboundDetail(id);
        openPreview([buildInboundDocument(response.data)], response.data.id);
        return;
      }

      const previewDetail = buildPreviewDetail();
      if (!previewDetail) {
        setPageError('请先打开一张入库单。');
        return;
      }
      openPreview([buildInboundDocument(previewDetail)], previewDetail.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  };

  const handleSaveInboundDraft = async () => {
    if (!selectedInbound) {
      setPageError('请先打开一张入库单。');
      return;
    }
    if (!canConfirmInbound) {
      setPageError('当前角色没有入库确认权限。');
      return;
    }

    setPageError('');
    setActionMessage('');
    setIsSavingDraft(true);
    try {
      const payload = buildDraftPayload();
      if (!payload) {
        return;
      }
      const response = await saveInboundDraft(selectedInbound.id, payload);
      setSelectedInbound(response.data);
      setDraftItems(createDraftItems(response.data));
      setActionMessage(`入库单 ${response.data.id} 草稿已保存。`);
      await loadInboundHub(response.data.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleConfirmInboundOrder = async () => {
    if (!selectedInbound) {
      setPageError('请先打开一张入库单。');
      return;
    }
    if (!canConfirmInbound) {
      setPageError('当前角色没有入库确认权限。');
      return;
    }
    if (!(await confirm(`确认入库单 ${selectedInbound.id} 吗？系统将按明细货架写入库存。`))) {
      return;
    }

    setActiveId(selectedInbound.id);
    setPageError('');
    setActionMessage('');
    try {
      const payload = buildDraftPayload();
      if (!payload) {
        return;
      }
      const response = await confirmInbound(selectedInbound.id, payload);
      const detailResponse = await fetchInboundDetail(selectedInbound.id);
      setSelectedInbound(detailResponse.data);
      setDraftItems(createDraftItems(detailResponse.data));
      openPreview([buildInboundDocument(detailResponse.data)], detailResponse.data.id);
      setActionMessage(response.message || '入库已确认。');
      await loadInboundHub(selectedInbound.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleAdvanceArrival = async (arrival: ArrivalRecord) => {
    if (!canConfirmInbound) {
      setPageError('当前角色没有到货推进权限。');
      return;
    }
    if (!(await confirm(`确认推进到货单 ${arrival.id} 的状态？`))) {
      return;
    }

    setActiveId(arrival.id);
    setPageError('');
    setActionMessage('');
    try {
      const response = await advanceArrival(arrival.id);
      setActionMessage(response.message || `到货单 ${arrival.id} 状态已推进。`);
      await loadInboundHub(selectedInbound?.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleOpenForceArrivalEditor = async (arrival: ArrivalRecord) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可强制修改验收单明细。');
      return;
    }

    setActiveId(arrival.id);
    setPageError('');
    try {
      const response = await fetchArrivalDetail(arrival.id);
      const detail: ArrivalDetailRecord = response.data;
      setForceArrivalDraft({
        arrivalId: detail.id,
        poId: detail.poId,
        supplier: detail.supplier,
        reason: '管理员演示修正',
        items: detail.items.map((item) => ({
          itemId: item.id,
          sku: item.sku,
          productName: item.productName,
          expectedQty: String(item.expectedQty),
          arrivedQty: String(item.arrivedQty),
          qualifiedQty: String(item.qualifiedQty),
          defectQty: String(item.defectQty),
        })),
      });
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const updateForceArrivalLineDraftItem = (itemId: string, field: keyof ArrivalForceLineDraftItem, value: string) => {
    setForceArrivalDraft((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => (item.itemId === itemId ? { ...item, [field]: value } : item)),
          }
        : current,
    );
  };

  const handleSubmitForceArrivalLines = async () => {
    if (!forceArrivalDraft) {
      return;
    }

    let payloadItems: Array<{ itemId: string; expectedQty: number; arrivedQty: number; qualifiedQty: number; defectQty: number }>;
    try {
      payloadItems = forceArrivalDraft.items.map((item) => {
        const expectedQty = Number(item.expectedQty);
        const arrivedQty = Number(item.arrivedQty);
        const qualifiedQty = Number(item.qualifiedQty);
        const defectQty = Number(item.defectQty);
        if (!Number.isInteger(expectedQty) || expectedQty < 0) {
          throw new Error(`${item.sku} 的应到数量必须是非负整数。`);
        }
        if (!Number.isInteger(arrivedQty) || arrivedQty < 0 || arrivedQty > expectedQty) {
          throw new Error(`${item.sku} 的实到数量必须在 0 到应到数量之间。`);
        }
        if (!Number.isInteger(qualifiedQty) || qualifiedQty < 0 || qualifiedQty > arrivedQty) {
          throw new Error(`${item.sku} 的合格数量必须在 0 到实到数量之间。`);
        }
        if (!Number.isInteger(defectQty) || defectQty < 0 || qualifiedQty + defectQty > arrivedQty) {
          throw new Error(`${item.sku} 的异常数量不合法。`);
        }
        return { itemId: item.itemId, expectedQty, arrivedQty, qualifiedQty, defectQty };
      });
    } catch (error) {
      setPageError(getErrorMessage(error));
      return;
    }

    if (!(await confirm(`确认强制修正验收单 ${forceArrivalDraft.arrivalId} 的明细数量？`))) {
      return;
    }

    setActiveId(forceArrivalDraft.arrivalId);
    setPageError('');
    setActionMessage('');
    try {
      const response = await forceUpdateArrivalLines(forceArrivalDraft.arrivalId, {
        reason: forceArrivalDraft.reason,
        items: payloadItems,
      });
      setActionMessage(response.message || `验收单 ${forceArrivalDraft.arrivalId} 明细已修正。`);
      openPreview([buildArrivalDocument(response.data)], response.data.id);
      setForceArrivalDraft(null);
      await loadInboundHub(selectedInbound?.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleForceSaveInboundLines = async () => {
    if (!selectedInbound) {
      setPageError('请先打开一张入库单。');
      return;
    }
    if (!isSuperAdmin) {
      setPageError('仅管理员可强制修改入库单明细。');
      return;
    }
    if (!(await confirm(`确认强制修正入库单 ${selectedInbound.id} 的合格数、入库数和货架？`))) {
      return;
    }

    setActiveId(selectedInbound.id);
    setPageError('');
    setActionMessage('');
    try {
      const payload = buildDraftPayload();
      if (!payload) {
        return;
      }
      const response = await forceUpdateInboundLines(selectedInbound.id, {
        ...payload,
        reason: '管理员强制修正入库明细',
      });
      setSelectedInbound(response.data);
      setDraftItems(createDraftItems(response.data));
      setActionMessage(response.message || `入库单 ${selectedInbound.id} 明细已修正。`);
      openPreview([buildInboundDocument(response.data)], response.data.id);
      await loadInboundHub(response.data.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleForceInboundStatus = async (inbound: InboundRecord) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可强制修改入库单状态。');
      return;
    }

    const normalizedStatus: InboundForceStatus = inbound.status === '已入库' ? '已入库' : '待入库';
    setForceStatusDraft({
      inboundId: inbound.id,
      rcvId: inbound.rcvId,
      supplier: inbound.supplier,
      currentStatus: normalizedStatus,
      nextStatus: normalizedStatus,
    });
  };

  const handleSubmitForceInboundStatus = async () => {
    if (!forceStatusDraft) {
      return;
    }

    if (!(await confirm(`确认将入库单 ${forceStatusDraft.inboundId} 状态改为 ${forceStatusDraft.nextStatus}？`))) {
      return;
    }

    setActiveId(forceStatusDraft.inboundId);
    setPageError('');
    setActionMessage('');
    try {
      const response = await updateInboundStatus(forceStatusDraft.inboundId, { status: forceStatusDraft.nextStatus } as UpdateInboundStatusPayload);
      setActionMessage(response.message || `入库单 ${forceStatusDraft.inboundId} 状态已更新。`);
      setForceStatusDraft(null);
      await loadInboundHub(selectedInbound?.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const handleDeleteInbound = async (inbound: InboundRecord) => {
    if (!isSuperAdmin) {
      setPageError('仅管理员可删除入库单。');
      return;
    }
    if (!(await confirm(`确认删除入库单 ${inbound.id}？若已入库将自动回滚库存后删除。`))) {
      return;
    }

    setActiveId(inbound.id);
    setPageError('');
    setActionMessage('');
    try {
      const response = await deleteInbound(inbound.id, { aggressive: true });
      setActionMessage(response.message || `入库单 ${inbound.id} 已删除。`);
      if (selectedInbound?.id === inbound.id) {
        setSelectedInbound(null);
        setDraftItems([]);
      }
      await loadInboundHub();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveId('');
    }
  };

  const updateDraftItem = (itemId: string, key: keyof InboundDraftItemState, value: string) => {
    setDraftItems((current) =>
      current.map((item) => (item.itemId === itemId ? { ...item, [key]: value } : item)),
    );
  };

  const totalDraftQualified = draftItems.reduce((sum, item) => sum + (Number(item.qualifiedQty) || 0), 0);
  const totalDraftInbound = draftItems.reduce((sum, item) => sum + (Number(item.inboundQty) || 0), 0);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">到货与入库</h2>
          <p className="mt-1 text-sm text-gray-500">点击单据进入入库工作区，逐行填写合格数量、入库数量和货架后再确认入库。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => {
            const nextOpen = !isArrivalCreateOpen;
            if (nextOpen) {
              setArrivalDraftNo(buildDraftDocumentNo('RCV'));
              setArrivalDraftAt(formatDraftDateTime());
            }
            setIsArrivalCreateOpen(nextOpen);
            setIsInboundCreateOpen(false);
          }}>
            创建验收单
          </Button>
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => {
            const nextOpen = !isInboundCreateOpen;
            if (nextOpen) {
              setInboundDraftNo(buildDraftDocumentNo('INB'));
              setInboundDraftAt(formatDraftDateTime());
            }
            setIsInboundCreateOpen(nextOpen);
            setIsArrivalCreateOpen(false);
          }}>
            创建入库单
          </Button>
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => { clearApiGetCache(); void loadInboundHub(selectedInbound?.id); }} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            刷新列表
          </Button>
        </div>
      </div>

      {pageError ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">入库数据处理失败：{pageError}</div> : null}
      {actionMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div> : null}

      {isArrivalCreateOpen ? (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
              <CardTitle className="text-lg font-semibold text-gray-800">创建验收单</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => setArrivalExpandedIds(arrivalCreateGroups.map((group) => group.purchaseOrderId))}>全部展开</Button>
                <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => { setSelectedArrivalItems({}); setArrivalCreateQty({}); }}>清空选择</Button>
                <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void submitManualArrivalCreate()} disabled={isCreatingArrival}>
                  {isCreatingArrival ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                  生成验收单
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 p-0">
            <div className="border-b border-gray-100 px-4 pt-4">
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[11px] leading-5 text-slate-500 shadow-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="whitespace-nowrap"><span className="text-slate-500">单号：</span><span className="font-semibold text-slate-900">{arrivalDraftNo || 'RCV-DRAFT'}</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">时间：</span><span className="text-slate-700">{arrivalDraftAt || formatDraftDateTime()}</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">状态：</span><span className="font-semibold text-slate-900">草稿</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">可选行数：</span><span className="text-slate-700">{arrivalCreateOptions.length}</span></span>
                </div>
              </div>
            </div>
            <GroupedDocumentTable
              groups={arrivalCreateGroups}
              columns={[
                { key: 'po', header: '采购单号', renderCell: (group) => group.purchaseOrderId },
                { key: 'supplier', header: '供应商', renderCell: (group) => group.supplier },
                { key: 'date', header: '预计到货', renderCell: (group) => group.expectedDate },
                { key: 'count', header: '可选行数', headerClassName: 'text-right', cellClassName: 'text-right', renderCell: (group) => group.items.length },
              ]}
              getGroupId={(group) => group.purchaseOrderId}
              expandedGroupIds={arrivalExpandedIds}
              onToggleGroup={(groupId) => setArrivalExpandedIds((current) => (current.includes(groupId) ? current.filter((item) => item !== groupId) : [...current, groupId]))}
              showSelectionCheckbox
              isGroupSelected={(group) => group.items.every((item) => Boolean(selectedArrivalItems[getArrivalKey(item)]))}
              isGroupIndeterminate={(group) => group.items.some((item) => Boolean(selectedArrivalItems[getArrivalKey(item)])) && !group.items.every((item) => Boolean(selectedArrivalItems[getArrivalKey(item)]))}
              onToggleGroupSelected={toggleArrivalGroup}
              renderExpandedContent={(group) => (
                <div className="overflow-x-auto border-t border-gray-200 bg-white">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50/80">
                      <tr>
                        <th className="w-10 px-2 py-2" />
                        <th className="px-2 py-2 text-left font-semibold text-gray-900">SKU</th>
                        <th className="px-2 py-2 text-left font-semibold text-gray-900">商品</th>
                        <th className="px-2 py-2 text-right font-semibold text-gray-900">未到</th>
                        <th className="px-2 py-2 text-right font-semibold text-gray-900">本次到货</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {group.items.map((item) => {
                        const key = getArrivalKey(item);
                        return (
                          <tr key={key}>
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                checked={Boolean(selectedArrivalItems[key])}
                                onChange={(event) => setSelectedArrivalItems((current) => ({ ...current, [key]: event.target.checked }))}
                              />
                            </td>
                            <td className="px-2 py-2 text-gray-700">{item.sku}</td>
                            <td className="px-2 py-2 text-gray-900">{item.productName}</td>
                            <td className="px-2 py-2 text-right text-gray-600">{item.remainingQty}</td>
                            <td className="px-2 py-2 text-right">
                              <Input
                                type="number"
                                min="1"
                                max={item.remainingQty}
                                value={arrivalCreateQty[key] || String(item.remainingQty)}
                                onChange={(event) => setArrivalCreateQty((current) => ({ ...current, [key]: event.target.value }))}
                                className="ml-auto w-28 text-right"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              loading={isLoading}
              loadingText="正在加载创建验收单候选数据..."
              emptyText="当前没有可创建验收单的采购明细。"
            />
          </CardContent>
        </Card>
      ) : null}

      {isInboundCreateOpen ? (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
              <CardTitle className="text-lg font-semibold text-gray-800">创建入库单</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="border-gray-300 text-gray-700 hover:bg-gray-50"
                  onClick={() => setInboundExpandedIds(inboundCreateGroups.map((group) => group.purchaseOrderId))}
                  disabled={inboundCreateGroups.length === 0}
                >
                  全部展开
                </Button>
                <Button
                  variant="outline"
                  className="border-gray-300 text-gray-700 hover:bg-gray-50"
                  onClick={() => { setSelectedInboundItems({}); setInboundCreateQty({}); }}
                  disabled={inboundCreateGroups.length === 0}
                >
                  清空选择
                </Button>
                <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void submitManualInboundCreate()} disabled={isCreatingInbound || inboundCreateGroups.length === 0}>
                  {isCreatingInbound ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                  生成入库单
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 p-0">
            <div className="border-b border-gray-100 px-4 pt-4">
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[11px] leading-5 text-slate-500 shadow-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="whitespace-nowrap"><span className="text-slate-500">单号：</span><span className="font-semibold text-slate-900">{inboundDraftNo || 'INB-DRAFT'}</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">时间：</span><span className="text-slate-700">{inboundDraftAt || formatDraftDateTime()}</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">状态：</span><span className="font-semibold text-slate-900">草稿</span></span>
                  <span className="whitespace-nowrap"><span className="text-slate-500">可选行数：</span><span className="text-slate-700">{inboundCreateOptions.length}</span></span>
                </div>
              </div>
            </div>
            {inboundCreateGroups.length > 0 ? (
              <GroupedDocumentTable
                groups={inboundCreateGroups}
                columns={[
                  { key: 'po', header: '采购单号', renderCell: (group) => group.purchaseOrderId },
                  { key: 'supplier', header: '供应商', renderCell: (group) => group.supplier },
                  { key: 'date', header: '预计到货', renderCell: (group) => group.expectedDate },
                  { key: 'count', header: '可选行数', headerClassName: 'text-right', cellClassName: 'text-right', renderCell: (group) => group.items.length },
                ]}
                getGroupId={(group) => group.purchaseOrderId}
                expandedGroupIds={inboundExpandedIds}
                onToggleGroup={(groupId) => setInboundExpandedIds((current) => (current.includes(groupId) ? current.filter((item) => item !== groupId) : [...current, groupId]))}
                showSelectionCheckbox
                isGroupSelected={(group) => group.items.every((item) => Boolean(selectedInboundItems[getInboundKey(item)]))}
                isGroupIndeterminate={(group) => group.items.some((item) => Boolean(selectedInboundItems[getInboundKey(item)])) && !group.items.every((item) => Boolean(selectedInboundItems[getInboundKey(item)]))}
                onToggleGroupSelected={toggleInboundGroup}
                renderExpandedContent={(group) => (
                  <div className="overflow-x-auto border-t border-gray-200 bg-white">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50/80">
                        <tr>
                          <th className="w-10 px-2 py-2" />
                          <th className="px-2 py-2 text-left font-semibold text-gray-900">SKU</th>
                          <th className="px-2 py-2 text-left font-semibold text-gray-900">商品</th>
                          <th className="px-2 py-2 text-right font-semibold text-gray-900">未入库</th>
                          <th className="px-2 py-2 text-right font-semibold text-gray-900">本次到货</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {group.items.map((item) => {
                          const key = getInboundKey(item);
                          return (
                            <tr key={key}>
                              <td className="px-2 py-2 text-center">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                  checked={Boolean(selectedInboundItems[key])}
                                  onChange={(event) => setSelectedInboundItems((current) => ({ ...current, [key]: event.target.checked }))}
                                />
                              </td>
                              <td className="px-2 py-2 text-gray-700">{item.sku}</td>
                              <td className="px-2 py-2 text-gray-900">{item.productName}</td>
                              <td className="px-2 py-2 text-right text-gray-600">{item.remainingQty}</td>
                              <td className="px-2 py-2 text-right">
                                <Input
                                  type="number"
                                  min="1"
                                  max={item.remainingQty}
                                  value={inboundCreateQty[key] || String(item.remainingQty)}
                                  onChange={(event) => setInboundCreateQty((current) => ({ ...current, [key]: event.target.value }))}
                                  className="ml-auto w-28 text-right"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                loading={isLoading}
                loadingText="正在加载创建入库单候选数据..."
                emptyText="当前没有可创建入库单的采购明细。"
              />
            ) : waitingInboundRecords.length > 0 ? (
              <div className="space-y-3 p-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  当前没有新的入库候选明细。下方已经存在待入库单据，直接进入这些单据继续处理即可。
                </div>
                <div className="overflow-x-auto rounded-xl border border-gray-200">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-gray-50/80 hover:bg-gray-50/80">
                        <TableHead className="font-semibold text-gray-900">入库单号</TableHead>
                        <TableHead className="font-semibold text-gray-900">收货单号</TableHead>
                        <TableHead className="font-semibold text-gray-900">供应商</TableHead>
                        <TableHead className="font-semibold text-gray-900 text-right">入库数量</TableHead>
                        <TableHead className="font-semibold text-gray-900 text-center">状态</TableHead>
                        <TableHead className="text-right font-semibold text-gray-900">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {waitingInboundRecords.slice(0, 5).map((inbound) => (
                        <TableRow key={inbound.id}>
                          <TableCell className="font-medium text-blue-600">{inbound.id}</TableCell>
                          <TableCell className="text-gray-500">{inbound.rcvId}</TableCell>
                          <TableCell className="text-gray-900">{inbound.supplier}</TableCell>
                          <TableCell className="text-right text-gray-900">{inbound.items}</TableCell>
                          <TableCell className="text-center">
                            <Badge variant={inbound.status === '已入库' ? 'success' : 'warning'}>{inbound.status}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => void handleOpenInboundWorkspace(inbound.id)}>
                              进入单据页
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : (
              <div className="px-6 py-10 text-center text-sm text-gray-500">当前没有可创建入库单的采购明细。</div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {selectedInbound || isDetailLoading ? (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 pb-3">
            <CardTitle className="flex items-center justify-between gap-3 text-lg font-semibold text-gray-800">
              <span>入库单据工作区</span>
              <Button variant="ghost" size="sm" onClick={() => { setSelectedInbound(null); setDraftItems([]); }}>关闭</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载入库单详情...</div> : null}

            {selectedInbound ? (
              <div className="space-y-6">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-gray-500">Inbound Workspace</div>
                    <div className="mt-2 text-xl font-semibold text-gray-900">{selectedInbound.id}</div>
                    <div className="mt-1 text-sm text-gray-500">
                      收货单 {selectedInbound.rcvId} · 采购单 {selectedInbound.poId} · {selectedInbound.supplier}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => void handlePreviewInboundDocument()}>
                      <Eye className="mr-2 h-4 w-4" /> 预览入库单
                    </Button>
                    <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => void handleSaveInboundDraft()} disabled={isSavingDraft || !canConfirmInbound}>
                      {isSavingDraft ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} 保存草稿
                    </Button>
                    {isSuperAdmin ? (
                      <Button variant="outline" className="border-amber-200 text-amber-700 hover:bg-amber-50" onClick={() => void handleForceSaveInboundLines()} disabled={activeId === selectedInbound.id}>
                        {activeId === selectedInbound.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />} 强制保存明细
                      </Button>
                    ) : null}
                    <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleConfirmInboundOrder()} disabled={!canConfirmInbound || activeId === selectedInbound.id || selectedInbound.status === '已入库'}>
                      {activeId === selectedInbound.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-2 h-4 w-4" />} 确认入库
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">入库状态</div><div className="mt-2"><Badge variant={selectedInbound.status === '已入库' ? 'success' : 'warning'}>{selectedInbound.status}</Badge></div><div className="mt-2 text-xs text-gray-500">仓库 {selectedInbound.warehouse}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">商品行数</div><div className="mt-1 text-lg font-semibold text-gray-900">{selectedInbound.itemsDetail.length}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">合格总数</div><div className="mt-1 text-lg font-semibold text-gray-900">{totalDraftQualified}</div></div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><div className="text-xs text-gray-500">入库总数</div><div className="mt-1 text-lg font-semibold text-blue-600">{totalDraftInbound}</div></div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50/80">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">SKU / 商品</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-900">应到</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-900">实到</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-900">合格数量</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-900">入库数量</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">入库货架</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">推荐货架</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {selectedInbound.itemsDetail.map((item) => {
                        const draftItem = draftItems.find((draft) => draft.itemId === item.id);
                        const selectedShelf = selectedInbound.shelfOptions.find((shelf) => shelf.id === draftItem?.shelfId);
                        return (
                          <tr key={item.id}>
                            <td className="px-4 py-4 align-top">
                              <div className="font-medium text-gray-900">{item.sku}</div>
                              <div className="mt-1 text-xs text-gray-500">{item.productName}</div>
                            </td>
                            <td className="px-4 py-4 text-right text-gray-600">{item.expectedQty}</td>
                            <td className="px-4 py-4 text-right text-gray-900">{item.arrivedQty}</td>
                            <td className="px-4 py-4">
                              <Input type="number" min="0" max={item.arrivedQty} value={draftItem?.qualifiedQty || '0'} onChange={(event) => updateDraftItem(item.id, 'qualifiedQty', event.target.value)} className="w-24 text-right" />
                            </td>
                            <td className="px-4 py-4">
                              <Input type="number" min="0" max={draftItem?.qualifiedQty || item.arrivedQty} value={draftItem?.inboundQty || '0'} onChange={(event) => updateDraftItem(item.id, 'inboundQty', event.target.value)} className="w-24 text-right" />
                            </td>
                            <td className="px-4 py-4">
                              <select className="h-10 min-w-64 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={draftItem?.shelfId || ''} onChange={(event) => updateDraftItem(item.id, 'shelfId', event.target.value)}>
                                <option value="">选择货架</option>
                                {selectedInbound.shelfOptions.map((shelf) => (
                                  <option key={shelf.id} value={shelf.id}>
                                    {shelf.shelfCode} · 剩余 {shelf.remainingCapacity} · {shelf.tags.join('/')}
                                  </option>
                                ))}
                              </select>
                              <div className="mt-1 text-xs text-gray-500">
                                {selectedShelf ? `${selectedShelf.shelfName}，容量 ${selectedShelf.usedQuantity}/${selectedShelf.capacity}` : '未选择货架'}
                              </div>
                            </td>
                            <td className="px-4 py-4 align-top">
                              <div className="flex items-center gap-2 text-sm text-gray-900">
                                <Sparkles className="h-4 w-4 text-amber-500" />
                                {item.suggestedShelfCode || '暂无推荐'}
                              </div>
                              <div className="mt-1 text-xs text-gray-500">系统会结合货架标签与当前商品分布推荐库位。</div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-4 xl:grid-cols-3">
                  {selectedInbound.shelfOptions.map((shelf) => (
                    <div key={shelf.id} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{shelf.shelfCode}</div>
                          <div className="mt-1 text-xs text-gray-500">{shelf.shelfName}</div>
                        </div>
                        <Badge variant={shelf.remainingCapacity === 0 ? 'destructive' : shelf.remainingCapacity / Math.max(shelf.capacity, 1) < 0.2 ? 'warning' : 'outline'}>
                          剩余 {shelf.remainingCapacity}
                        </Badge>
                      </div>
                      <div className="mt-3 text-xs text-gray-500">标签：{shelf.tags.join(' / ') || '未设置'}</div>
                      <div className="mt-1 text-xs text-gray-500">容量：{shelf.usedQuantity} / {shelf.capacity}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {forceStatusDraft ? (
        <Card className="border-amber-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-amber-100 bg-amber-50/60 pb-3">
            <CardTitle className="text-lg font-semibold text-amber-900">管理员状态修正</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="text-sm text-amber-900">
              入库单 {forceStatusDraft.inboundId} · 收货单 {forceStatusDraft.rcvId} · {forceStatusDraft.supplier}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-600">当前状态</span>
              <Badge variant={forceStatusDraft.currentStatus === '已入库' ? 'success' : 'warning'}>{forceStatusDraft.currentStatus}</Badge>
              <ArrowRight className="h-4 w-4 text-gray-400" />
              <select className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" value={forceStatusDraft.nextStatus} onChange={(event) => setForceStatusDraft((current) => current ? { ...current, nextStatus: event.target.value as InboundForceStatus } : current)}>
                {INBOUND_FORCE_STATUS_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmitForceInboundStatus()} disabled={activeId === forceStatusDraft.inboundId}>
                {activeId === forceStatusDraft.inboundId ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                保存状态
              </Button>
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => setForceStatusDraft(null)}>取消</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {forceArrivalDraft ? (
        <Card className="border-amber-200 shadow-sm">
          <CardHeader className="rounded-t-xl border-b border-amber-100 bg-amber-50/60 pb-3">
            <CardTitle className="text-lg font-semibold text-amber-900">管理员验收明细修正</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="text-sm text-amber-900">
              验收单 {forceArrivalDraft.arrivalId} · 采购单 {forceArrivalDraft.poId} · {forceArrivalDraft.supplier}
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50/80">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-900">SKU / 商品</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-900">应到</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-900">实到</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-900">合格</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-900">异常</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {forceArrivalDraft.items.map((item) => (
                    <tr key={item.itemId}>
                      <td className="px-3 py-3">
                        <div className="font-medium text-gray-900">{item.sku}</div>
                        <div className="mt-1 text-xs text-gray-500">{item.productName}</div>
                      </td>
                      <td className="px-3 py-3">
                        <Input type="number" min="0" step="1" value={item.expectedQty} onChange={(event) => updateForceArrivalLineDraftItem(item.itemId, 'expectedQty', event.target.value)} className="ml-auto w-24 text-right" />
                      </td>
                      <td className="px-3 py-3">
                        <Input type="number" min="0" step="1" value={item.arrivedQty} onChange={(event) => updateForceArrivalLineDraftItem(item.itemId, 'arrivedQty', event.target.value)} className="ml-auto w-24 text-right" />
                      </td>
                      <td className="px-3 py-3">
                        <Input type="number" min="0" step="1" value={item.qualifiedQty} onChange={(event) => updateForceArrivalLineDraftItem(item.itemId, 'qualifiedQty', event.target.value)} className="ml-auto w-24 text-right" />
                      </td>
                      <td className="px-3 py-3">
                        <Input type="number" min="0" step="1" value={item.defectQty} onChange={(event) => updateForceArrivalLineDraftItem(item.itemId, 'defectQty', event.target.value)} className="ml-auto w-24 text-right" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-600">修正原因</label>
              <Input value={forceArrivalDraft.reason} onChange={(event) => setForceArrivalDraft((current) => current ? { ...current, reason: event.target.value } : current)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => setForceArrivalDraft(null)}>取消</Button>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSubmitForceArrivalLines()} disabled={activeId === forceArrivalDraft.arrivalId}>
                {activeId === forceArrivalDraft.arrivalId ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                保存验收修正
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <CardTitle className="text-lg font-semibold text-gray-800">待验收 / 部分验收</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">到货单号</TableHead><TableHead className="font-semibold text-gray-900">采购单号</TableHead><TableHead className="font-semibold text-gray-900"><MultiSelectColumnFilter label="供应商" options={supplierFilterOptions} selectedValues={supplierFilter} onChange={setSupplierFilter} /></TableHead><TableHead className="font-semibold text-gray-900 text-right"><RangeColumnFilter label="实到数量" value={arrivalQtyFilter} onChange={setArrivalQtyFilter} minPlaceholder="最小数量" maxPlaceholder="最大数量" /></TableHead><TableHead className="font-semibold text-gray-900 text-center"><MultiSelectColumnFilter label="状态" options={arrivalStatusFilterOptions} selectedValues={arrivalStatusFilter} onChange={setArrivalStatusFilter} /></TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={6} className="h-20 text-center text-sm text-gray-500">正在加载到货数据...</TableCell></TableRow> : null}
              {!isLoading && waitingArrivalRecords.length === 0 ? <TableRow><TableCell colSpan={6} className="h-20 text-center text-sm text-gray-500">当前筛选条件下没有待验收记录。</TableCell></TableRow> : null}
              {!isLoading && waitingArrivalRecords.map((arrival) => (
                <TableRow key={arrival.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{arrival.id}</TableCell>
                  <TableCell className="text-gray-500">{arrival.poId}</TableCell>
                  <TableCell className="text-gray-900">{arrival.supplier}</TableCell>
                  <TableCell className="text-right text-gray-700">{arrival.arrivedQty} / {arrival.expectedQty}</TableCell>
                  <TableCell className="text-center"><Badge variant={arrival.status === '待验收' ? 'warning' : arrival.status === '部分到货' ? 'secondary' : 'default'}>{arrival.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <RowActionMenu
                      items={[
                        { id: 'arrival-filter', label: '按同供应商筛选', icon: Filter, onSelect: () => setSupplierFilter([arrival.supplier]) },
                        { id: 'arrival-force-lines', label: '强制改验收明细', icon: Sparkles, onSelect: () => void handleOpenForceArrivalEditor(arrival), disabled: !isSuperAdmin || activeId === arrival.id },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {waitingArrivalsData ? (
            <div className="border-t border-gray-100 px-4">
              <Pagination
                page={waitingArrivalsData.page}
                totalPages={waitingArrivalsData.totalPages}
                total={waitingArrivalsData.total}
                pageSize={waitingArrivalsData.pageSize}
                onPageChange={setArrivalPage}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <CardTitle className="text-lg font-semibold text-gray-800">待入库 / 部分入库</CardTitle>
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72"><Input placeholder="搜索入库单号、收货单号、供应商、库位..." className="bg-white border-gray-300 focus-visible:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
              <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={resetInboundColumnFilters} disabled={!searchTerm && !hasInboundColumnFilters}>重置筛选</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">入库单号</TableHead><TableHead className="font-semibold text-gray-900">收货单号</TableHead><TableHead className="font-semibold text-gray-900"><MultiSelectColumnFilter label="供应商" options={supplierFilterOptions} selectedValues={supplierFilter} onChange={setSupplierFilter} /></TableHead><TableHead className="font-semibold text-gray-900 text-right"><RangeColumnFilter label="入库数量" value={inboundQtyFilter} onChange={setInboundQtyFilter} minPlaceholder="最小数量" maxPlaceholder="最大数量" /></TableHead><TableHead className="font-semibold text-gray-900"><MultiSelectColumnFilter label="仓库" options={warehouseFilterOptions} selectedValues={warehouseFilter} onChange={setWarehouseFilter} /></TableHead><TableHead className="font-semibold text-gray-900 text-center"><MultiSelectColumnFilter label="状态" options={inboundStatusFilterOptions} selectedValues={inboundStatusFilter} onChange={setInboundStatusFilter} /></TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">正在加载入库数据...</TableCell></TableRow> : null}
              {!isLoading && waitingInboundRecords.length === 0 ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有待入库记录。</TableCell></TableRow> : null}
              {!isLoading && waitingInboundRecords.map((inbound) => (
                <TableRow key={inbound.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{inbound.id}</TableCell>
                  <TableCell className="text-gray-500">{inbound.rcvId}</TableCell>
                  <TableCell className="text-gray-900">{inbound.supplier}</TableCell>
                  <TableCell className="text-right text-gray-900">{inbound.items}</TableCell>
                  <TableCell className="text-gray-500">{inbound.warehouse}</TableCell>
                  <TableCell className="text-center"><Badge variant={inbound.status === '已入库' ? 'success' : 'warning'}>{inbound.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-blue-50 hover:text-blue-600" onClick={() => void handleOpenInboundWorkspace(inbound.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'inbound-open', label: '进入单据页', icon: Eye, onSelect: () => void handleOpenInboundWorkspace(inbound.id) },
                          { id: 'inbound-preview', label: '打印入库单', icon: PackageCheck, onSelect: () => void handlePreviewInboundDocument(inbound.id) },
                          { id: 'inbound-force-status', label: '强制修改状态', icon: Sparkles, onSelect: () => void handleForceInboundStatus(inbound), disabled: !isSuperAdmin },
                          { id: 'inbound-delete', label: '删除入库单', icon: Trash2, onSelect: () => void handleDeleteInbound(inbound), disabled: !isSuperAdmin || activeId === inbound.id, tone: 'danger' },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {waitingInboundsData && showWaitingInbounds ? (
            <div className="border-t border-gray-100 px-4">
              <Pagination
                page={waitingInboundsData.page}
                totalPages={waitingInboundsData.totalPages}
                total={waitingInboundsData.total}
                pageSize={waitingInboundsData.pageSize}
                onPageChange={setWaitingInboundPage}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <CardTitle className="text-lg font-semibold text-gray-800">已入库</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-gray-50/50 hover:bg-gray-50/50"><TableHead className="font-semibold text-gray-900">入库单号</TableHead><TableHead className="font-semibold text-gray-900">收货单号</TableHead><TableHead className="font-semibold text-gray-900"><MultiSelectColumnFilter label="供应商" options={supplierFilterOptions} selectedValues={supplierFilter} onChange={setSupplierFilter} /></TableHead><TableHead className="font-semibold text-gray-900 text-right"><RangeColumnFilter label="入库数量" value={inboundQtyFilter} onChange={setInboundQtyFilter} minPlaceholder="最小数量" maxPlaceholder="最大数量" /></TableHead><TableHead className="font-semibold text-gray-900"><MultiSelectColumnFilter label="仓库" options={warehouseFilterOptions} selectedValues={warehouseFilter} onChange={setWarehouseFilter} /></TableHead><TableHead className="font-semibold text-gray-900 text-center"><MultiSelectColumnFilter label="状态" options={inboundStatusFilterOptions} selectedValues={inboundStatusFilter} onChange={setInboundStatusFilter} /></TableHead><TableHead className="text-right font-semibold text-gray-900">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {isLoading ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">正在加载入库数据...</TableCell></TableRow> : null}
              {!isLoading && completedInboundRecords.length === 0 ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-sm text-gray-500">当前筛选条件下没有已入库记录。</TableCell></TableRow> : null}
              {!isLoading && completedInboundRecords.map((inbound) => (
                <TableRow key={inbound.id} className="hover:bg-blue-50/30 transition-colors">
                  <TableCell className="font-medium text-blue-600">{inbound.id}</TableCell>
                  <TableCell className="text-gray-500">{inbound.rcvId}</TableCell>
                  <TableCell className="text-gray-900">{inbound.supplier}</TableCell>
                  <TableCell className="text-right text-gray-900">{inbound.items}</TableCell>
                  <TableCell className="text-gray-500">{inbound.warehouse}</TableCell>
                  <TableCell className="text-center"><Badge variant={inbound.status === '已入库' ? 'success' : 'warning'}>{inbound.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-blue-50 hover:text-blue-600" onClick={() => void handlePreviewInboundDocument(inbound.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <RowActionMenu
                        items={[
                          { id: 'inbound-open', label: '进入单据页', icon: Eye, onSelect: () => void handleOpenInboundWorkspace(inbound.id) },
                          { id: 'inbound-preview', label: '查看入库单', icon: Eye, onSelect: () => void handlePreviewInboundDocument(inbound.id) },
                          { id: 'inbound-print', label: '打印入库单', icon: PackageCheck, onSelect: () => void handlePreviewInboundDocument(inbound.id) },
                          { id: 'inbound-force-status', label: '强制修改状态', icon: Sparkles, onSelect: () => void handleForceInboundStatus(inbound), disabled: !isSuperAdmin },
                          { id: 'inbound-delete', label: '删除入库单', icon: Trash2, onSelect: () => void handleDeleteInbound(inbound), disabled: !isSuperAdmin || activeId === inbound.id, tone: 'danger' },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {completedInboundsData && showCompletedInbounds ? (
            <div className="border-t border-gray-100 px-4">
              <Pagination
                page={completedInboundsData.page}
                totalPages={completedInboundsData.totalPages}
                total={completedInboundsData.total}
                pageSize={completedInboundsData.pageSize}
                onPageChange={setCompletedInboundPage}
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
