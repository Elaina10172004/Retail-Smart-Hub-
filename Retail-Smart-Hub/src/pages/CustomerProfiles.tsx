import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { RowActionMenu } from '@/components/RowActionMenu';
import { useAuth } from '@/auth/AuthContext';
import { formatCurrency } from '@/lib/format';
import { parseImportFile } from '@/lib/import';
import {
  createCustomer,
  deleteCustomer,
  fetchCustomerDetail,
  fetchCustomers,
  fetchCustomerSummary,
  importCustomers as importCustomersBatch,
  toggleCustomerStatus,
  updateCustomer,
} from '@/services/api/customers';
import type { CreateCustomerPayload, CustomerDetailRecord, CustomerRecord, CustomerSummary, UpdateCustomerPayload } from '@/types/customers';
import type { ImportBatchResult } from '@/types/import';
import { Eye, Filter, LoaderCircle, Pencil, Plus, Power, RefreshCw, Search, Trash2, Upload, Users, X } from 'lucide-react';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

const defaultForm: UpdateCustomerPayload = {
  name: '',
  channelPreference: '门店补货',
  contactName: '',
  phone: '',
};

export function CustomerProfiles() {
  const { hasPermission } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const canManageCustomers = hasPermission('settings.master-data');
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [form, setForm] = useState<UpdateCustomerPayload>(defaultForm);
  const [editingCustomerId, setEditingCustomerId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetailRecord | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportBatchResult | null>(null);
  const [importFileName, setImportFileName] = useState('' );
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const isEditing = Boolean(editingCustomerId);

  const filteredCustomers = useMemo(() => {
    return customers.filter((item) => {
      const matchesSearch =
        !searchTerm ||
        item.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.channelPreference.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.contactName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.phone.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = !statusFilter || item.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [customers, searchTerm, statusFilter]);

  const resetForm = () => {
    setForm(defaultForm);
    setEditingCustomerId(null);
  };

  const loadCustomers = async () => {
    setIsLoading(true);
    setPageError('');

    try {
      const [summaryResponse, customersResponse] = await Promise.all([fetchCustomerSummary(), fetchCustomers()]);
      setSummary(summaryResponse.data);
      setCustomers(customersResponse.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadCustomers();
  }, []);

  const handleSubmitCustomer = async () => {
    if (!canManageCustomers) {
      setPageError('当前角色没有客户档案维护权限。');
      return;
    }

    if (!form.name.trim()) {
      setPageError('请先填写客户名称。');
      return;
    }

    const normalizedPayload: CreateCustomerPayload = {
      ...form,
      name: form.name.trim(),
      channelPreference: form.channelPreference.trim(),
      contactName: form.contactName?.trim() || '',
      phone: form.phone?.trim() || '',
    };

    const confirmText = isEditing
      ? `确认更新客户档案？\n客户：${normalizedPayload.name}`
      : `确认创建客户档案？\n客户：${normalizedPayload.name}`;
    if (!(await confirm(confirmText))) {
      return;
    }

    setIsSubmitting(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = editingCustomerId
        ? await updateCustomer(editingCustomerId, normalizedPayload)
        : await createCustomer(normalizedPayload);
      setActionMessage(response.message || (editingCustomerId ? '客户档案已更新。' : '客户档案已创建。'));
      resetForm();
      await loadCustomers();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditCustomer = (customer: CustomerRecord) => {
    setEditingCustomerId(customer.id);
    setForm({
      name: customer.name,
      channelPreference: customer.channelPreference,
      contactName: customer.contactName,
      phone: customer.phone,
    });
    setPageError('');
    setActionMessage(`已载入客户 ${customer.id}，可直接修改资料。`);
  };

  const handleViewCustomer = async (customerId: string) => {
    setIsDetailLoading(true);
    setPageError('');

    try {
      const response = await fetchCustomerDetail(customerId);
      setSelectedCustomer(response.data);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleFilterChannel = (channelPreference: string) => {
    setSearchTerm(channelPreference);
    setActionMessage(`已按渠道 ${channelPreference} 筛选客户列表。`);
  };

  const handleToggleStatus = async (customer: CustomerRecord) => {
    if (!canManageCustomers) {
      setPageError('当前角色没有客户档案维护权限。');
      return;
    }

    const actionLabel = customer.status === 'active' ? '停用' : '启用';
    if (!(await confirm(`确认${actionLabel}客户档案？\n客户：${customer.name}`))) {
      return;
    }

    setIsSubmitting(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await toggleCustomerStatus(customer.id);
      setActionMessage(response.message || `客户已${response.data.status === 'active' ? '启用' : '停用'}。`);
      if (selectedCustomer?.id === customer.id) {
        setSelectedCustomer(response.data);
      }
      if (editingCustomerId === customer.id && response.data.status !== 'active') {
        resetForm();
      }
      await loadCustomers();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteCustomer = async (customer: CustomerRecord) => {
    if (!canManageCustomers) {
      setPageError('当前角色没有客户档案维护权限。');
      return;
    }

    if (!(await confirm(`确认删除客户档案？\n客户：${customer.name}\n删除后将从客户列表中移除。`))) {
      return;
    }

    setIsSubmitting(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteCustomer(customer.id);
      setActionMessage(response.message || '客户档案已删除。');
      if (editingCustomerId === customer.id) {
        resetForm();
      }
      await loadCustomers();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleImportCustomers = async (file: File | null) => {
    if (!file) {
      return;
    }

    if (!canManageCustomers) {
      setPageError('当前角色没有客户档案维护权限。');
      return;
    }

    setIsImporting(true);
    setPageError('');
    setActionMessage('');

    try {
      const rows = await parseImportFile(file);
      const response = await importCustomersBatch(rows);
      setImportResult(response.data);
      setImportFileName(file.name);
      setActionMessage(response.message || '客户批量导入已完成。');
      await loadCustomers();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsImporting(false);
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">客户档案</h2>
          <p className="text-sm text-gray-500 mt-1">客户主数据会随订单自动沉淀，也支持手工新增、修改和删除。</p>
        </div>
        <Button
          variant="outline"
          className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm"
          onClick={() => void loadCustomers()}
          disabled={isLoading}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新客户
        </Button>
      </div>

      {pageError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          客户数据处理失败：{pageError}
        </div>
      )}
      {actionMessage && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {actionMessage}
        </div>
      )}

      {(selectedCustomer || isDetailLoading) && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
            <CardTitle className="text-lg font-semibold text-gray-800 flex items-center justify-between gap-3">
              <span>客户详情</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedCustomer(null)}>
                关闭
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isDetailLoading ? <div className="text-sm text-gray-500">正在加载客户详情...</div> : null}
            {selectedCustomer ? (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">客户名称</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedCustomer.name}</div>
                    <div className="mt-1 text-xs text-gray-500">{selectedCustomer.id}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">联系方式</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedCustomer.contactName || '-'}</div>
                    <div className="mt-1 text-xs text-gray-500">{selectedCustomer.phone || '-'}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">经营数据</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedCustomer.totalOrders} 单</div>
                    <div className="mt-1 text-xs text-gray-500">累计销售 {formatCurrency(selectedCustomer.totalSales)}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs text-gray-500">档案状态</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{selectedCustomer.status}</div>
                    <div className="mt-1 text-xs text-gray-500">最近下单：{selectedCustomer.lastOrderDate}</div>
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">客户总数</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{summary?.customerCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">活跃客户</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{summary?.activeCustomerCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">客户累计销售额</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{formatCurrency(summary?.totalSales ?? 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">本月活跃客户</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{summary?.thisMonthActiveCount ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <CardTitle className="text-lg font-semibold text-gray-800 flex items-center justify-between gap-3">
            <span className="flex items-center">
              <Users className="mr-2 h-5 w-5 text-blue-600" />
              {isEditing ? '编辑客户档案' : '新增客户档案'}
            </span>
            {isEditing && (
              <Button variant="outline" size="sm" className="border-gray-300 text-gray-700" onClick={resetForm}>
                <X className="mr-2 h-4 w-4" /> 取消编辑
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="客户名称"
              className="border-gray-300 focus-visible:ring-blue-500"
            />
            <select
              value={form.channelPreference}
              onChange={(e) => setForm({ ...form, channelPreference: e.target.value })}
              className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="门店补货">门店补货</option>
              <option value="线上商城">线上商城</option>
              <option value="企业团购">企业团购</option>
            </select>
            <Input
              value={form.contactName || ''}
              onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              placeholder="联系人"
              className="border-gray-300 focus-visible:ring-blue-500"
            />
            <Input
              value={form.phone || ''}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="联系电话"
              className="border-gray-300 focus-visible:ring-blue-500"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-gray-500">
              {canManageCustomers ? '提交后会写入客户主数据，并进入审计日志。' : '当前账号没有客户档案维护权限，仅可查看数据。'}
            </div>
            <Button
              className="bg-blue-600 hover:bg-blue-700 shadow-sm"
              onClick={() => void handleSubmitCustomer()}
              disabled={!canManageCustomers || isSubmitting}
              title={!canManageCustomers ? '当前角色没有客户档案维护权限' : undefined}
            >
              {isSubmitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : isEditing ? <Pencil className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
              {isEditing ? '保存修改' : '新增客户'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <CardTitle className="text-lg font-semibold text-gray-800">批量导入客户</CardTitle>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <p className="text-sm text-gray-500">支持 txt、csv、xls、xlsx。首行请提供表头，可识别：客户名称、渠道、联系人、电话。</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={importInputRef}
              type="file"
              accept=".txt,.csv,.xls,.xlsx"
              className="hidden"
              onChange={(event) => void handleImportCustomers(event.target.files?.[0] || null)}
            />
            <Button
              variant="outline"
              className="border-gray-300 text-gray-700 hover:bg-gray-50"
              onClick={() => importInputRef.current?.click()}
              disabled={!canManageCustomers || isImporting}
              title={!canManageCustomers ? '当前角色没有客户档案维护权限' : '导入客户列表'}
            >
              {isImporting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              选择文件导入
            </Button>
            <span className="text-sm text-gray-500">{importFileName || '尚未选择文件'}</span>
          </div>
          {importResult ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-2 text-sm text-gray-700">
              <div className="font-medium text-gray-900">最近一次导入结果</div>
              <div>总行数 {importResult.totalCount}，新增 {importResult.createdCount}，跳过 {importResult.skippedCount}，失败 {importResult.errorCount}</div>
              {importResult.errors.length > 0 ? (
                <div className="space-y-1">
                  {importResult.errors.slice(0, 5).map((item) => (
                    <div key={`${item.rowNumber}-${item.identifier}`} className="text-red-600">
                      第 {item.rowNumber} 行 / {item.identifier}：{item.reason}
                    </div>
                  ))}
                  {importResult.errors.length > 5 ? <div className="text-gray-500">其余 {importResult.errors.length - 5} 条失败记录已省略。</div> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 gap-4 w-full flex-wrap">
              <div className="relative w-full md:w-72">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="搜索客户编号、名称、联系人..."
                  className="pl-9 bg-white border-gray-300 focus-visible:ring-blue-500"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">所有状态</option>
                <option value="active">active</option>
                <option value="inactive">inactive</option>
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50/50 hover:bg-gray-50/50">
                <TableHead className="font-semibold text-gray-900">客户编号</TableHead>
                <TableHead className="font-semibold text-gray-900">客户名称</TableHead>
                <TableHead className="font-semibold text-gray-900">联系人</TableHead>
                <TableHead className="font-semibold text-gray-900">联系电话</TableHead>
                <TableHead className="font-semibold text-gray-900">偏好渠道</TableHead>
                <TableHead className="font-semibold text-gray-900">等级</TableHead>
                <TableHead className="font-semibold text-gray-900 text-right">订单数</TableHead>
                <TableHead className="font-semibold text-gray-900">最近下单</TableHead>
                <TableHead className="font-semibold text-gray-900 text-right">累计销售额</TableHead>
                <TableHead className="font-semibold text-gray-900">状态</TableHead>
                <TableHead className="text-right font-semibold text-gray-900">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={11} className="h-24 text-center text-sm text-gray-500">
                    正在加载客户档案...
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && filteredCustomers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="h-24 text-center text-sm text-gray-500">
                    当前筛选条件下没有客户记录。
                  </TableCell>
                </TableRow>
              )}
              {!isLoading &&
                filteredCustomers.map((customer) => (
                  <TableRow key={customer.id} className="hover:bg-blue-50/30 transition-colors">
                    <TableCell className="font-medium text-blue-600">{customer.id}</TableCell>
                    <TableCell className="text-gray-900">{customer.name}</TableCell>
                    <TableCell className="text-gray-600">{customer.contactName || '-'}</TableCell>
                    <TableCell className="text-gray-600">{customer.phone || '-'}</TableCell>
                    <TableCell className="text-gray-600">{customer.channelPreference}</TableCell>
                    <TableCell>
                      <Badge variant={customer.level === 'A' ? 'success' : customer.level === 'B' ? 'default' : 'secondary'}>
                        {customer.level}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-gray-700">{customer.totalOrders}</TableCell>
                    <TableCell className="text-gray-600">{customer.lastOrderDate}</TableCell>
                    <TableCell className="text-right font-medium text-gray-900">{formatCurrency(customer.totalSales)}</TableCell>
                    <TableCell>
                      <Badge variant={customer.status === 'active' ? 'success' : 'secondary'}>{customer.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="icon" className="text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={() => void handleViewCustomer(customer.id)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <RowActionMenu
                          items={[
                            {
                              id: 'detail',
                              label: '查看详情',
                              icon: Eye,
                              onSelect: () => void handleViewCustomer(customer.id),
                            },
                            {
                              id: 'edit',
                              label: '编辑资料',
                              icon: Pencil,
                              onSelect: () => handleEditCustomer(customer),
                              disabled: customer.status !== 'active',
                            },
                            {
                              id: 'filter-channel',
                              label: '按同渠道筛选',
                              icon: Filter,
                              onSelect: () => handleFilterChannel(customer.channelPreference),
                            },
                            {
                              id: 'toggle-status',
                              label: customer.status === 'active' ? '停用客户' : '启用客户',
                              icon: Power,
                              onSelect: () => void handleToggleStatus(customer),
                              disabled: isSubmitting,
                            },
                            {
                              id: 'delete',
                              label: '删除客户',
                              icon: Trash2,
                              onSelect: () => void handleDeleteCustomer(customer),
                              disabled: isSubmitting || customer.status !== 'inactive',
                              tone: 'danger',
                            },
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
      {confirmDialog}
    </div>
  );
}




