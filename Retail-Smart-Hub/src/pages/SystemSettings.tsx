import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createProduct, createSupplier, createUser, fetchAccessOverview, fetchMasterDataOverview, toggleUserStatus } from '@/services/api/settings';
import { formatCurrency } from '@/lib/format';
import type { AccessOverview, CreateProductPayload, CreateSupplierPayload, CreateUserPayload, MasterDataOverview, ProductRecord, UserRecord } from '@/types/settings';
import { Database, LoaderCircle, Package, RefreshCw, Shield, Store, User, Users } from 'lucide-react';
import {
  defaultProductForm,
  defaultSupplierForm,
  defaultUserForm,
  type SettingsSection,
} from './system-settings.constants';
import { getErrorMessage } from './system-page.utils';

export function SystemSettings() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('access');
  const [accessOverview, setAccessOverview] = useState<AccessOverview | null>(null);
  const [masterDataOverview, setMasterDataOverview] = useState<MasterDataOverview | null>(null);
  const [userForm, setUserForm] = useState<CreateUserPayload>(defaultUserForm);
  const [supplierForm, setSupplierForm] = useState<CreateSupplierPayload>(defaultSupplierForm);
  const [productForm, setProductForm] = useState<CreateProductPayload>(defaultProductForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmittingUser, setIsSubmittingUser] = useState(false);
  const [isSubmittingSupplier, setIsSubmittingSupplier] = useState(false);
  const [isSubmittingProduct, setIsSubmittingProduct] = useState(false);
  const [activeUserId, setActiveUserId] = useState('');
  const [pageError, setPageError] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const roleOptions = accessOverview?.roles ?? [];
  const supplierOptions = masterDataOverview?.suppliers ?? [];

  const topProducts = useMemo(() => {
    return masterDataOverview?.products.slice(0, 8) ?? [];
  }, [masterDataOverview]);

  const loadSettings = async () => {
    setIsLoading(true);
    setPageError('');

    try {
      const [accessResponse, masterDataResponse] = await Promise.all([
        fetchAccessOverview(),
        fetchMasterDataOverview(),
      ]);
      setAccessOverview(accessResponse.data);
      setMasterDataOverview(masterDataResponse.data);

      setUserForm((current) => ({
        ...current,
        roleId: current.roleId || accessResponse.data.roles[0]?.id || '',
      }));
      setProductForm((current) => ({
        ...current,
        preferredSupplierId: current.preferredSupplierId || masterDataResponse.data.suppliers[0]?.id || '',
      }));
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  const handleCreateUser = async () => {
    setIsSubmittingUser(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await createUser(userForm);
      setActionMessage(
        `${response.message || '用户已创建。'} 临时口令仅显示一次：${response.data.temporaryPassword}`
      );
      setUserForm((current) => ({
        ...defaultUserForm,
        department: current.department,
        roleId: current.roleId,
      }));
      await loadSettings();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmittingUser(false);
    }
  };

  const handleToggleUserStatus = async (user: UserRecord) => {
    setActiveUserId(user.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await toggleUserStatus(user.id);
      setActionMessage(response.message || '用户状态已更新。');
      await loadSettings();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveUserId('');
    }
  };

  const handleCreateSupplier = async () => {
    setIsSubmittingSupplier(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await createSupplier(supplierForm);
      setActionMessage(response.message || '供应商已创建。');
      setSupplierForm(defaultSupplierForm);
      await loadSettings();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmittingSupplier(false);
    }
  };

  const handleCreateProduct = async () => {
    setIsSubmittingProduct(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await createProduct(productForm);
      setActionMessage(response.message || '商品已创建。');
      setProductForm((current) => ({
        ...defaultProductForm,
        category: current.category,
        unit: current.unit,
        safeStock: current.safeStock,
        preferredSupplierId: current.preferredSupplierId,
      }));
      await loadSettings();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmittingProduct(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">系统设置</h2>
          <p className="text-sm text-gray-500 mt-1">系统设置页已切到真实权限和基础资料管理。</p>
        </div>
        <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadSettings()} disabled={isLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新设置
        </Button>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">设置数据处理失败：{pageError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      <div className="grid gap-6 md:grid-cols-4">
        <div className="md:col-span-1 space-y-2">
          <Button variant="ghost" className={`w-full justify-start font-medium ${activeSection === 'access' ? 'text-blue-600 bg-blue-50' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`} onClick={() => setActiveSection('access')}>
            <Shield className="mr-2 h-4 w-4" /> 权限与用户
          </Button>
          <Button variant="ghost" className={`w-full justify-start font-medium ${activeSection === 'suppliers' ? 'text-blue-600 bg-blue-50' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`} onClick={() => setActiveSection('suppliers')}>
            <Store className="mr-2 h-4 w-4" /> 供应商档案
          </Button>
          <Button variant="ghost" className={`w-full justify-start font-medium ${activeSection === 'products' ? 'text-blue-600 bg-blue-50' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`} onClick={() => setActiveSection('products')}>
            <Package className="mr-2 h-4 w-4" /> 商品档案
          </Button>
          <Button variant="ghost" className={`w-full justify-start font-medium ${activeSection === 'warehouses' ? 'text-blue-600 bg-blue-50' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`} onClick={() => setActiveSection('warehouses')}>
            <Database className="mr-2 h-4 w-4" /> 仓库概览
          </Button>
        </div>

        <div className="md:col-span-3 space-y-6">
          {activeSection === 'access' && (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500">用户总数</CardTitle>
                    <Users className="h-4 w-4 text-blue-600" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-gray-900">{accessOverview?.summary.userCount ?? 0}</div>
                    <p className="text-xs text-gray-500 mt-1">启用用户 {accessOverview?.summary.activeUserCount ?? 0}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500">角色数量</CardTitle>
                    <Shield className="h-4 w-4 text-green-600" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-gray-900">{accessOverview?.summary.roleCount ?? 0}</div>
                    <p className="text-xs text-gray-500 mt-1">权限节点 {accessOverview?.summary.permissionCount ?? 0}</p>
                  </CardContent>
                </Card>
                <Card className="md:col-span-2">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500">当前管理员</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {accessOverview?.summary.currentUser ? (
                      <div className="space-y-1">
                        <div className="text-lg font-semibold text-gray-900">{accessOverview.summary.currentUser.username}</div>
                        <div className="text-sm text-gray-500">{accessOverview.summary.currentUser.email} · {accessOverview.summary.currentUser.department}</div>
                        <div className="flex flex-wrap gap-2 pt-1">
                          {accessOverview.summary.currentUser.roles.map((role) => (
                            <Badge key={role} variant="outline" className="border-blue-200 text-blue-700 bg-blue-50">
                              {role}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-gray-500">暂无管理员信息</div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card className="border-gray-200 shadow-sm">
                <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                  <CardTitle className="text-lg font-semibold text-gray-800">新增用户</CardTitle>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">用户名</label>
                      <Input value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} placeholder="例如：store.ops" className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">邮箱</label>
                      <Input value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} placeholder="name@company.com" className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">手机号</label>
                      <Input value={userForm.phone || ''} onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })} placeholder="13800000000" className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">部门</label>
                      <select value={userForm.department} onChange={(e) => setUserForm({ ...userForm, department: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="管理部">管理部</option>
                        <option value="财务部">财务部</option>
                        <option value="仓储部">仓储部</option>
                        <option value="采购部">采购部</option>
                        <option value="运营部">运营部</option>
                      </select>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm font-medium text-gray-700">角色</label>
                      <select value={userForm.roleId} onChange={(e) => setUserForm({ ...userForm, roleId: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        {roleOptions.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name} · {role.scope}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleCreateUser()} disabled={isSubmittingUser || !userForm.roleId}>
                      {isSubmittingUser ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <User className="mr-2 h-4 w-4" />}
                      创建用户
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-gray-200 shadow-sm">
                <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                  <CardTitle className="text-lg font-semibold text-gray-800">用户与角色</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">用户</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">部门</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">角色</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">状态</th>
                          <th className="px-4 py-3 text-right font-semibold text-gray-900">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {isLoading && (
                          <tr>
                            <td colSpan={5} className="px-4 py-10 text-center text-gray-500">正在加载用户数据...</td>
                          </tr>
                        )}
                        {!isLoading &&
                          (accessOverview?.users ?? []).map((user) => (
                            <tr key={user.id} className="border-t border-gray-100">
                              <td className="px-4 py-3">
                                <div className="font-medium text-gray-900">{user.username}</div>
                                <div className="text-xs text-gray-500">{user.email} · {user.phone}</div>
                              </td>
                              <td className="px-4 py-3 text-gray-600">{user.department}</td>
                              <td className="px-4 py-3">
                                <div className="flex flex-wrap gap-2">
                                  {user.roles.map((role) => (
                                    <Badge key={role} variant="outline" className="border-blue-200 text-blue-700 bg-blue-50">
                                      {role}
                                    </Badge>
                                  ))}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                                  {user.status === 'active' ? '启用中' : '已停用'}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button variant="outline" size="sm" className="border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => void handleToggleUserStatus(user)} disabled={activeUserId === user.id}>
                                  {activeUserId === user.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                                  {user.status === 'active' ? '停用' : '启用'}
                                </Button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card className="border-gray-200 shadow-sm">
                  <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                    <CardTitle className="text-lg font-semibold text-gray-800">角色清单</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-6 space-y-3">
                    {(accessOverview?.roles ?? []).map((role) => (
                      <div key={role.id} className="rounded-lg border border-gray-200 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="font-semibold text-gray-900">{role.name}</div>
                            <div className="text-sm text-gray-500 mt-1">{role.description}</div>
                          </div>
                          <Badge variant="outline" className="border-gray-300 text-gray-700 bg-white">{role.scope}</Badge>
                        </div>
                        <div className="mt-3 text-xs text-gray-500">关联用户 {role.userCount} / 权限节点 {role.permissionCount}</div>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card className="border-gray-200 shadow-sm">
                  <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                    <CardTitle className="text-lg font-semibold text-gray-800">权限节点</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-6">
                    <div className="flex flex-wrap gap-2">
                      {(accessOverview?.permissions ?? []).map((permission) => (
                        <Badge key={permission.id} variant="outline" className="border-blue-100 bg-blue-50 text-blue-700">
                          {permission.moduleId} / {permission.label}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
          {activeSection === 'suppliers' && (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500">供应商数量</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-gray-900">{masterDataOverview?.summary.supplierCount ?? 0}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500">低库存商品</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-red-600">{masterDataOverview?.summary.lowStockProductCount ?? 0}</div>
                  </CardContent>
                </Card>
              </div>

              <Card className="border-gray-200 shadow-sm">
                <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                  <CardTitle className="text-lg font-semibold text-gray-800">新增供应商</CardTitle>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">供应商名称</label>
                      <Input value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">联系人</label>
                      <Input value={supplierForm.contactName || ''} onChange={(e) => setSupplierForm({ ...supplierForm, contactName: e.target.value })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">联系电话</label>
                      <Input value={supplierForm.phone || ''} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">账期/提前期（天）</label>
                      <Input type="number" value={supplierForm.leadTimeDays} onChange={(e) => setSupplierForm({ ...supplierForm, leadTimeDays: Number(e.target.value) || 0 })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleCreateSupplier()} disabled={isSubmittingSupplier}>
                      {isSubmittingSupplier ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Store className="mr-2 h-4 w-4" />}
                      创建供应商
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-gray-200 shadow-sm">
                <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                  <CardTitle className="text-lg font-semibold text-gray-800">供应商列表</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">供应商</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">联系人</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">电话</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">提前期</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {isLoading && (
                          <tr>
                            <td colSpan={5} className="px-4 py-10 text-center text-gray-500">正在加载供应商数据...</td>
                          </tr>
                        )}
                        {!isLoading &&
                          (masterDataOverview?.suppliers ?? []).map((supplier) => (
                            <tr key={supplier.id} className="border-t border-gray-100">
                              <td className="px-4 py-3 font-medium text-gray-900">{supplier.name}</td>
                              <td className="px-4 py-3 text-gray-600">{supplier.contactName || '-'}</td>
                              <td className="px-4 py-3 text-gray-600">{supplier.phone || '-'}</td>
                              <td className="px-4 py-3 text-gray-600">{supplier.leadTimeDays} 天</td>
                              <td className="px-4 py-3">
                                <Badge variant={supplier.status === 'active' ? 'success' : 'secondary'}>
                                  {supplier.status}
                                </Badge>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {activeSection === 'products' && (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500">商品数量</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-gray-900">{masterDataOverview?.summary.productCount ?? 0}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500">低库存商品</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-orange-600">{masterDataOverview?.summary.lowStockProductCount ?? 0}</div>
                  </CardContent>
                </Card>
              </div>

              <Card className="border-gray-200 shadow-sm">
                <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                  <CardTitle className="text-lg font-semibold text-gray-800">新增商品</CardTitle>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">SKU</label>
                      <Input value={productForm.sku} onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">商品名称</label>
                      <Input value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">品类</label>
                      <Input value={productForm.category} onChange={(e) => setProductForm({ ...productForm, category: e.target.value })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">单位</label>
                      <Input value={productForm.unit} onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">安全库存</label>
                      <Input type="number" value={productForm.safeStock} onChange={(e) => setProductForm({ ...productForm, safeStock: Number(e.target.value) || 0 })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">售价</label>
                      <Input type="number" value={productForm.salePrice} onChange={(e) => setProductForm({ ...productForm, salePrice: Number(e.target.value) || 0 })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">成本价</label>
                      <Input type="number" value={productForm.costPrice} onChange={(e) => setProductForm({ ...productForm, costPrice: Number(e.target.value) || 0 })} className="border-gray-300 focus-visible:ring-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">默认供应商</label>
                      <select value={productForm.preferredSupplierId} onChange={(e) => setProductForm({ ...productForm, preferredSupplierId: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        {supplierOptions.map((supplier) => (
                          <option key={supplier.id} value={supplier.id}>
                            {supplier.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button className="bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleCreateProduct()} disabled={isSubmittingProduct || !productForm.preferredSupplierId}>
                      {isSubmittingProduct ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Package className="mr-2 h-4 w-4" />}
                      创建商品
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-gray-200 shadow-sm">
                <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                  <CardTitle className="text-lg font-semibold text-gray-800">商品档案</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">SKU / 商品</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">品类</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">安全库存</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">售价 / 成本</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-900">默认供应商</th>
                        </tr>
                      </thead>
                      <tbody>
                        {isLoading && (
                          <tr>
                            <td colSpan={5} className="px-4 py-10 text-center text-gray-500">正在加载商品数据...</td>
                          </tr>
                        )}
                        {!isLoading &&
                          topProducts.map((product: ProductRecord) => (
                            <tr key={product.id} className="border-t border-gray-100">
                              <td className="px-4 py-3">
                                <div className="font-medium text-gray-900">{product.sku}</div>
                                <div className="text-xs text-gray-500">{product.name} · {product.unit}</div>
                              </td>
                              <td className="px-4 py-3 text-gray-600">{product.category}</td>
                              <td className="px-4 py-3 text-gray-600">{product.safeStock}</td>
                              <td className="px-4 py-3 text-gray-600">{formatCurrency(product.salePrice)} / {formatCurrency(product.costPrice)}</td>
                              <td className="px-4 py-3 text-gray-600">{product.preferredSupplier}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
          {activeSection === 'warehouses' && (
            <div className="grid gap-6 md:grid-cols-2">
              {(masterDataOverview?.warehouses ?? []).map((warehouse) => {
                const usageRate = warehouse.capacity > 0 ? Math.min((warehouse.currentStock / warehouse.capacity) * 100, 100) : 0;
                return (
                  <Card key={warehouse.id} className="border-gray-200 shadow-sm">
                    <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
                      <CardTitle className="text-lg font-semibold text-gray-800">{warehouse.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-6 space-y-4">
                      <div className="text-sm text-gray-500">库位编码：{warehouse.locationCode}</div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="rounded-lg bg-gray-50 p-4">
                          <div className="text-xs text-gray-500">当前库存量</div>
                          <div className="text-xl font-bold text-gray-900 mt-1">{warehouse.currentStock}</div>
                        </div>
                        <div className="rounded-lg bg-gray-50 p-4">
                          <div className="text-xs text-gray-500">仓容上限</div>
                          <div className="text-xl font-bold text-gray-900 mt-1">{warehouse.capacity}</div>
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between text-sm text-gray-600 mb-2">
                          <span>仓容使用率</span>
                          <span>{usageRate.toFixed(1)}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                          <div className={`h-full rounded-full ${usageRate > 80 ? 'bg-red-500' : usageRate > 60 ? 'bg-yellow-500' : 'bg-blue-600'}`} style={{ width: `${usageRate}%` }}></div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
