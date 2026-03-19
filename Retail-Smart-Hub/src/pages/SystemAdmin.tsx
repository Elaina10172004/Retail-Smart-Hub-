import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { useAuth } from '@/auth/AuthContext';
import {
  changePassword,
  fetchAuditLogs,
  fetchSessionManagement,
  revokeManagedSession,
  revokeOtherSessions,
  updateProfile,
} from '@/services/api/system';
import {
  createProduct,
  createRole,
  createSupplier,
  createUser,
  createWarehouse,
  deleteRole,
  deleteUser,
  deleteProduct,
  deleteSupplier,
  deleteWarehouse,
  fetchAccessOverview,
  fetchMasterDataOverview,
  resetManagedUserPassword,
  toggleProductStatus,
  toggleSupplierStatus,
  toggleUserStatus,
  updateProduct,
  updateRolePermissions,
  updateSupplier,
  updateUserRole,
  updateWarehouse,
  importProducts as importProductsBatch,
} from '@/services/api/settings';
import { formatCurrency } from '@/lib/format';
import { parseImportFile } from '@/lib/import';
import type { AuditLogRecord, AuthSessionRecord, PasswordPolicySummary, PasswordSecuritySummary } from '@/types/auth';
import type { ImportBatchResult } from '@/types/import';
import type {
  AccessOverview,
  CreateProductPayload,
  CreateRolePayload,
  CreateSupplierPayload,
  CreateUserPayload,
  CreateWarehousePayload,
  MasterDataOverview,
  ProductRecord,
  RoleRecord,
  SupplierRecord,
  UserRecord,
  WarehouseRecord,
} from '@/types/settings';
import {
  defaultProductForm,
  defaultRoleForm,
  defaultSupplierForm,
  defaultUserForm,
  defaultWarehouseForm,
  type SectionId,
} from './system-admin.constants';
import { formatDateTime, getErrorMessage, parseAuditPayload } from './system-page.utils';
import {
  Database,
  FileSearch,
  KeyRound,
  LoaderCircle,
  Package,
  Upload,
  RefreshCw,
  Shield,
  Store,
  User,
  Users,
  Warehouse,
} from 'lucide-react';

export function SystemAdmin() {
  const { user, hasPermission, refreshSession } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const canManageAccess = hasPermission('settings.access-control');
  const canManageMasterData = hasPermission('settings.master-data');
  const canViewLogs = hasPermission('settings.access-control');

  const sections = useMemo(() => {
    const next: Array<{ id: SectionId; label: string; icon: typeof Shield }> = [
      { id: 'account', label: '账号安全', icon: KeyRound },
    ];
    if (canManageAccess) next.push({ id: 'access', label: '权限与用户', icon: Shield });
    if (canManageMasterData) next.push({ id: 'master', label: '基础资料', icon: Database });
    if (canViewLogs) next.push({ id: 'logs', label: '审计日志', icon: FileSearch });
    return next;
  }, [canManageAccess, canManageMasterData, canViewLogs]);

  const [activeSection, setActiveSection] = useState<SectionId>('account');
  const [accessOverview, setAccessOverview] = useState<AccessOverview | null>(null);
  const [masterDataOverview, setMasterDataOverview] = useState<MasterDataOverview | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [auditEntityType, setAuditEntityType] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [userForm, setUserForm] = useState<CreateUserPayload>(defaultUserForm);
  const [supplierForm, setSupplierForm] = useState<CreateSupplierPayload>(defaultSupplierForm);
  const [productForm, setProductForm] = useState<CreateProductPayload>(defaultProductForm);
  const [roleForm, setRoleForm] = useState<CreateRolePayload>(defaultRoleForm);
  const [warehouseForm, setWarehouseForm] = useState<CreateWarehousePayload>(defaultWarehouseForm);
  const [profileForm, setProfileForm] = useState({
    email: user?.email || '',
    phone: user?.phone || '',
    department: user?.department || '运营部',
  });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [sessionRecords, setSessionRecords] = useState<AuthSessionRecord[]>([]);
  const [passwordPolicy, setPasswordPolicy] = useState<PasswordPolicySummary | null>(null);
  const [passwordSecurity, setPasswordSecurity] = useState<PasswordSecuritySummary | null>(null);
  const [pendingUserRoles, setPendingUserRoles] = useState<Record<string, string>>({});
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [rolePermissionDraft, setRolePermissionDraft] = useState<string[]>([]);
  const [editingSupplierId, setEditingSupplierId] = useState('');
  const [editingProductId, setEditingProductId] = useState('');
  const [editingWarehouseId, setEditingWarehouseId] = useState('');
  const [supplierStatusFilter, setSupplierStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [productStatusFilter, setProductStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isAuditLoading, setIsAuditLoading] = useState(false);
  const [isSubmittingUser, setIsSubmittingUser] = useState(false);
  const [isSubmittingRole, setIsSubmittingRole] = useState(false);
  const [isSubmittingSupplier, setIsSubmittingSupplier] = useState(false);
  const [isSubmittingProduct, setIsSubmittingProduct] = useState(false);
  const [isSubmittingWarehouse, setIsSubmittingWarehouse] = useState(false);
  const [isImportingProducts, setIsImportingProducts] = useState(false);
  const [productImportResult, setProductImportResult] = useState<ImportBatchResult | null>(null);
  const [productImportFileName, setProductImportFileName] = useState('' );
  const productImportInputRef = useRef<HTMLInputElement | null>(null);
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [isUpdatingRolePermissions, setIsUpdatingRolePermissions] = useState(false);
  const [isDeletingRole, setIsDeletingRole] = useState(false);
  const [activeUserId, setActiveUserId] = useState('');
  const [activeSessionToken, setActiveSessionToken] = useState('');
  const [activeMasterId, setActiveMasterId] = useState('');
  const [pageError, setPageError] = useState('');
  const [auditError, setAuditError] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const roleOptions = accessOverview?.roles ?? [];
  const permissionOptions = accessOverview?.permissions ?? [];
  const supplierOptions = masterDataOverview?.suppliers ?? [];
  const filteredSuppliers = useMemo(() => {
    return supplierOptions.filter((supplier) => supplierStatusFilter === 'all' || supplier.status === supplierStatusFilter);
  }, [supplierOptions, supplierStatusFilter]);
  const selectableSuppliers = useMemo(() => {
    return supplierOptions.filter(
      (supplier) => supplier.status === 'active' || supplier.id === productForm.preferredSupplierId
    );
  }, [productForm.preferredSupplierId, supplierOptions]);
  const filteredProducts = useMemo(() => {
    return (masterDataOverview?.products ?? []).filter(
      (product) => productStatusFilter === 'all' || product.status === productStatusFilter
    );
  }, [masterDataOverview?.products, productStatusFilter]);
  const selectedRole = useMemo(
    () => roleOptions.find((role) => role.id === selectedRoleId) ?? null,
    [roleOptions, selectedRoleId]
  );
  const permissionGroups = useMemo(() => {
    const groups = new Map<string, typeof permissionOptions>();
    permissionOptions.forEach((permission) => {
      const current = groups.get(permission.moduleId) ?? [];
      groups.set(permission.moduleId, [...current, permission]);
    });
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));
  }, [permissionOptions]);

  useEffect(() => {
    if (!sections.some((item) => item.id === activeSection) && sections[0]) {
      setActiveSection(sections[0].id);
    }
  }, [activeSection, sections]);

  const loadBaseData = async () => {
    if (!canManageAccess && !canManageMasterData) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setPageError('');

    try {
      if (canManageAccess) {
        const accessResponse = await fetchAccessOverview();
        setAccessOverview(accessResponse.data);
        setUserForm((current) => ({ ...current, roleId: current.roleId || accessResponse.data.roles[0]?.id || '' }));
        setRoleForm((current) => ({
          ...current,
          templateRoleId: current.templateRoleId || accessResponse.data.roles[0]?.id || '',
        }));
        setPendingUserRoles(
          Object.fromEntries(
            accessResponse.data.users.map((item) => [item.id, accessResponse.data.roles.find((role) => item.roles.includes(role.name))?.id || ''])
          )
        );
        if (!selectedRoleId || !accessResponse.data.roles.some((role) => role.id === selectedRoleId)) {
          setSelectedRoleId(accessResponse.data.roles[0]?.id || '');
        }
      }

      if (canManageMasterData) {
        const masterResponse = await fetchMasterDataOverview();
        setMasterDataOverview(masterResponse.data);
        setProductForm((current) => ({
          ...current,
          preferredSupplierId: current.preferredSupplierId || masterResponse.data.suppliers[0]?.id || '',
        }));
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const loadSessionManagementData = async () => {
    if (!user) {
      return;
    }

    setIsSessionLoading(true);
    setPageError('');
    try {
      const response = await fetchSessionManagement();
      setSessionRecords(response.data.sessions);
      setPasswordPolicy(response.data.policy);
      setPasswordSecurity(response.data.security);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSessionLoading(false);
    }
  };

  const promptSensitiveVerification = (actionLabel: string) => {
    const verifyPassword = window.prompt(`这是敏感操作：${actionLabel}\n请输入当前登录账号密码完成二次验证。`);
    if (verifyPassword === null) {
      return null;
    }

    if (!verifyPassword.trim()) {
      setPageError('需要输入当前登录密码才能完成二次验证。');
      return null;
    }

    return verifyPassword.trim();
  };

  const loadLogs = async (entityType = auditEntityType, action = auditAction) => {
    if (!canViewLogs) return;

    setIsAuditLoading(true);
    setAuditError('');

    try {
      const response = await fetchAuditLogs({ limit: 20, entityType: entityType || undefined, action: action || undefined });
      setAuditLogs(response.data);
    } catch (error) {
      setAuditError(getErrorMessage(error));
    } finally {
      setIsAuditLoading(false);
    }
  };

  useEffect(() => {
    void loadBaseData();
  }, [canManageAccess, canManageMasterData]);

  useEffect(() => {
    void loadSessionManagementData();
  }, [user?.id]);

  useEffect(() => {
    if (activeSection === 'logs' && canViewLogs) {
      void loadLogs();
    }
  }, [activeSection, canViewLogs]);

  useEffect(() => {
    if (selectedRole) {
      setRolePermissionDraft(selectedRole.permissionCodes);
    }
  }, [selectedRole]);

  useEffect(() => {
    setProfileForm({
      email: user?.email || '',
      phone: user?.phone || '',
      department: user?.department || '运营部',
    });
  }, [user?.department, user?.email, user?.phone]);

  const refreshAfterMutation = async () => {
    await loadBaseData();
    if (canViewLogs) {
      await loadLogs();
    }
  };

  const resetSupplierForm = () => {
    setSupplierForm(defaultSupplierForm);
    setEditingSupplierId('');
  };

  const resetProductForm = () => {
    setProductForm((current) => ({
      ...defaultProductForm,
      category: current.category || defaultProductForm.category,
      unit: current.unit || defaultProductForm.unit,
      safeStock: current.safeStock > 0 ? current.safeStock : defaultProductForm.safeStock,
      preferredSupplierId: masterDataOverview?.suppliers[0]?.id || '',
    }));
    setEditingProductId('');
  };

  const resetWarehouseForm = () => {
    setWarehouseForm(defaultWarehouseForm);
    setEditingWarehouseId('');
  };

  const handleChangePassword = async () => {
    setPageError('');
    setActionMessage('');

    if (!passwordForm.currentPassword || !passwordForm.newPassword) {
      setPageError('请填写当前密码和新密码。');
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPageError('两次输入的新密码不一致。');
      return;
    }
    if (passwordForm.newPassword.length < 8) {
      setPageError('新密码至少 8 位，并需满足复杂度要求。');
      return;
    }
    if (!(await confirm('确认修改当前登录账号的密码？'))) {
      return;
    }

    setIsChangingPassword(true);
    try {
      const response = await changePassword({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      setActionMessage(response.message || '密码已修改。');
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      await loadSessionManagementData();
      if (canViewLogs) {
        await loadLogs();
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleUpdateProfile = async () => {
    setPageError('');
    setActionMessage('');

    if (!profileForm.email.trim() || !profileForm.department.trim()) {
      setPageError('请填写邮箱和部门。');
      return;
    }
    if (!(await confirm('确认更新当前登录账号的个人资料？'))) {
      return;
    }

    setIsUpdatingProfile(true);
    try {
      const response = await updateProfile({
        email: profileForm.email.trim(),
        phone: profileForm.phone.trim(),
        department: profileForm.department.trim(),
      });
      await refreshSession();
      await loadBaseData();
      setActionMessage(response.message || '个人资料已更新。');
      if (canViewLogs) {
        await loadLogs();
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const handleCreateUser = async () => {
    if (!canManageAccess) {
      setPageError('当前角色没有角色权限维护能力。');
      return;
    }
    if (!userForm.username.trim() || !userForm.email.trim() || !userForm.roleId) {
      setPageError('请完整填写用户名、邮箱和角色。');
      return;
    }
    if (!(await confirm(`确认创建用户 ${userForm.username.trim()}？系统将生成一次性临时口令，并要求首次登录修改密码。`))) {
      return;
    }

    setIsSubmittingUser(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await createUser({ ...userForm, username: userForm.username.trim(), email: userForm.email.trim() });
      const tempPassword = response.data.temporaryPassword;
      setActionMessage(
        `${response.message || '用户已创建。'} 临时口令仅显示一次：${tempPassword}`
      );
      setUserForm((current) => ({ ...defaultUserForm, department: current.department, roleId: current.roleId }));
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmittingUser(false);
    }
  };

  const handleCreateRole = async () => {
    if (!canManageAccess) {
      setPageError('当前角色没有角色权限维护能力。');
      return;
    }
    if (!roleForm.name.trim() || !roleForm.scope.trim()) {
      setPageError('请完整填写角色名称和作用域。');
      return;
    }
    if (!(await confirm(`确认创建角色 ${roleForm.name.trim()}？`))) {
      return;
    }

    setIsSubmittingRole(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await createRole({
        name: roleForm.name.trim(),
        description: roleForm.description?.trim(),
        scope: roleForm.scope,
        templateRoleId: roleForm.templateRoleId?.trim() || undefined,
      });
      setActionMessage(response.message || '角色已创建。');
      setRoleForm((current) => ({
        ...defaultRoleForm,
        scope: current.scope,
        templateRoleId: current.templateRoleId,
      }));
      await refreshAfterMutation();
      setSelectedRoleId(response.data.id);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmittingRole(false);
    }
  };

  const handleToggleUserStatus = async (targetUser: UserRecord) => {
    const actionLabel = targetUser.status === 'active' ? '停用' : '启用';
    if (!(await confirm(`确认${actionLabel}用户 ${targetUser.username}？`))) {
      return;
    }

    setActiveUserId(targetUser.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await toggleUserStatus(targetUser.id);
      setActionMessage(response.message || '用户状态已更新。');
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveUserId('');
    }
  };

  const handleResetUserPassword = async (targetUser: UserRecord) => {
    const nextPassword = window.prompt(
      `请输入用户 ${targetUser.username} 的新密码（至少 8 位，并满足复杂度要求）`,
      ''
    );
    if (nextPassword === null) {
      return;
    }

    if (nextPassword.trim().length < 8) {
      setPageError('新密码至少 8 位，并需满足复杂度要求。');
      return;
    }

    if (!(await confirm(`确认重置用户 ${targetUser.username} 的密码？`))) {
      return;
    }
    const verifyPassword = promptSensitiveVerification(`重置用户 ${targetUser.username} 的密码`);
    if (!verifyPassword) {
      return;
    }

    setActiveUserId(targetUser.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await resetManagedUserPassword(targetUser.id, {
        newPassword: nextPassword.trim(),
        verifyPassword,
      });
      setActionMessage(response.message || '用户密码已重置。');
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveUserId('');
    }
  };

  const handleUpdateUserRole = async (targetUser: UserRecord) => {
    const roleId = pendingUserRoles[targetUser.id];
    if (!roleId) {
      setPageError('请先为用户选择目标角色。');
      return;
    }
    if (!(await confirm(`确认调整用户 ${targetUser.username} 的角色？`))) {
      return;
    }
    const verifyPassword = promptSensitiveVerification(`调整用户 ${targetUser.username} 的角色`);
    if (!verifyPassword) {
      return;
    }

    setActiveUserId(targetUser.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await updateUserRole(targetUser.id, { roleId, verifyPassword });
      setActionMessage(response.message || '用户角色已更新。');
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveUserId('');
    }
  };

  const handleRevokeOtherSessions = async () => {
    if (!(await confirm('确认移除当前账号在其他终端的所有会话？'))) {
      return;
    }
    const verifyPassword = promptSensitiveVerification('移除当前账号的其他会话');
    if (!verifyPassword) {
      return;
    }

    setIsSessionLoading(true);
    setPageError('');
    setActionMessage('');
    try {
      const response = await revokeOtherSessions(verifyPassword);
      setActionMessage(response.message || '其他会话已移除。');
      await loadSessionManagementData();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSessionLoading(false);
    }
  };

  const handleRevokeManagedSession = async (sessionId: string) => {
    if (!(await confirm('确认移除这个会话？'))) {
      return;
    }
    const verifyPassword = promptSensitiveVerification('移除指定会话');
    if (!verifyPassword) {
      return;
    }

    setActiveSessionToken(sessionId);
    setPageError('');
    setActionMessage('');
    try {
      const response = await revokeManagedSession(sessionId, verifyPassword);
      setActionMessage(response.message || '会话已移除。');
      await loadSessionManagementData();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveSessionToken('');
    }
  };

  const handleDeleteUser = async (targetUser: UserRecord) => {
    if (!(await confirm(`确认删除用户 ${targetUser.username}？`))) {
      return;
    }
    const verifyPassword = promptSensitiveVerification(`删除用户 ${targetUser.username}`);
    if (!verifyPassword) {
      return;
    }

    setActiveUserId(targetUser.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteUser(targetUser.id, { verifyPassword });
      setActionMessage(response.message || '用户已删除。');
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveUserId('');
    }
  };

  const handleCreateSupplier = async () => {
    if (!supplierForm.name.trim() || supplierForm.leadTimeDays <= 0) {
      setPageError('请完整填写供应商名称和提前期。');
      return;
    }
    const actionLabel = editingSupplierId ? '更新' : '创建';
    if (!(await confirm(`确认${actionLabel}供应商 ${supplierForm.name.trim()}？`))) {
      return;
    }

    setIsSubmittingSupplier(true);
    setPageError('');
    setActionMessage('');

    try {
      const payload = { ...supplierForm, name: supplierForm.name.trim() };
      const response = editingSupplierId
        ? await updateSupplier(editingSupplierId, payload)
        : await createSupplier(payload);
      setActionMessage(response.message || (editingSupplierId ? '供应商已更新。' : '供应商已创建。'));
      resetSupplierForm();
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmittingSupplier(false);
    }
  };

  const handleCreateProduct = async () => {
    if (!productForm.sku.trim() || !productForm.name.trim() || !productForm.preferredSupplierId) {
      setPageError('请完整填写商品 SKU、名称和默认供应商。');
      return;
    }
    if (productForm.salePrice <= 0 || productForm.costPrice <= 0) {
      setPageError('售价和成本价必须大于 0。');
      return;
    }
    const actionLabel = editingProductId ? '更新' : '创建';
    if (!(await confirm(`确认${actionLabel}商品 ${productForm.name.trim()}？`))) {
      return;
    }

    setIsSubmittingProduct(true);
    setPageError('');
    setActionMessage('');

    try {
      const payload = {
        ...productForm,
        sku: productForm.sku.trim(),
        name: productForm.name.trim(),
        category: productForm.category.trim(),
        unit: productForm.unit.trim(),
      };
      const response = editingProductId
        ? await updateProduct(editingProductId, payload)
        : await createProduct(payload);
      setActionMessage(response.message || (editingProductId ? '商品已更新。' : '商品已创建。'));
      resetProductForm();
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmittingProduct(false);
    }
  };

  const handleImportProducts = async (file: File | null) => {
    if (!file) {
      return;
    }

    if (!canManageMasterData) {
      setPageError('当前角色没有基础资料维护权限。');
      return;
    }

    setIsImportingProducts(true);
    setPageError('');
    setActionMessage('');

    try {
      const rows = await parseImportFile(file);
      const response = await importProductsBatch(rows);
      setProductImportResult(response.data);
      setProductImportFileName(file.name);
      setActionMessage(response.message || '商品批量导入已完成。');
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsImportingProducts(false);
      if (productImportInputRef.current) {
        productImportInputRef.current.value = '';
      }
    }
  };

  const handleCreateWarehouse = async () => {
    if (!warehouseForm.name.trim() || !warehouseForm.locationCode.trim()) {
      setPageError('请完整填写仓库名称和库位编码。');
      return;
    }
    if (warehouseForm.capacity <= 0) {
      setPageError('仓库容量必须大于 0。');
      return;
    }
    const actionLabel = editingWarehouseId ? '更新' : '创建';
    if (!(await confirm(`确认${actionLabel}仓库 ${warehouseForm.name.trim()}？`))) {
      return;
    }

    setIsSubmittingWarehouse(true);
    setPageError('');
    setActionMessage('');

    try {
      const payload = {
        name: warehouseForm.name.trim(),
        locationCode: warehouseForm.locationCode.trim(),
        capacity: warehouseForm.capacity,
      };
      const response = editingWarehouseId
        ? await updateWarehouse(editingWarehouseId, payload)
        : await createWarehouse(payload);
      setActionMessage(response.message || (editingWarehouseId ? '仓库已更新。' : '仓库已创建。'));
      resetWarehouseForm();
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmittingWarehouse(false);
    }
  };

  const handleEditSupplier = (supplier: SupplierRecord) => {
    setEditingSupplierId(supplier.id);
    setSupplierForm({
      name: supplier.name,
      contactName: supplier.contactName,
      phone: supplier.phone,
      leadTimeDays: supplier.leadTimeDays,
    });
  };

  const handleDeleteSupplier = async (supplier: SupplierRecord) => {
    if (!supplier.canDelete) {
      setPageError(supplier.status === 'active' ? '供应商需先停用，再删除。' : '供应商仍被商品或采购单引用，暂时不能删除。');
      return;
    }

    if (!(await confirm(`确认删除供应商 ${supplier.name}？`))) {
      return;
    }

    setActiveMasterId(supplier.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteSupplier(supplier.id);
      setActionMessage(response.message || '供应商已删除。');
      if (editingSupplierId === supplier.id) {
        resetSupplierForm();
      }
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveMasterId('');
    }
  };

  const handleToggleSupplierStatus = async (supplier: SupplierRecord) => {
    const actionLabel = supplier.status === 'active' ? '停用' : '启用';
    if (!(await confirm(`确认${actionLabel}供应商 ${supplier.name}？`))) {
      return;
    }

    setActiveMasterId(supplier.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await toggleSupplierStatus(supplier.id);
      setActionMessage(response.message || '供应商状态已更新。');
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveMasterId('');
    }
  };

  const handleEditProduct = (product: ProductRecord) => {
    setEditingProductId(product.id);
    setProductForm({
      sku: product.sku,
      name: product.name,
      category: product.category,
      unit: product.unit,
      safeStock: product.safeStock,
      salePrice: product.salePrice,
      costPrice: product.costPrice,
      preferredSupplierId: product.preferredSupplierId,
    });
  };

  const handleDeleteProduct = async (product: ProductRecord) => {
    if (!product.canDelete) {
      setPageError(product.status === 'active' ? '商品需先停用，再删除。' : '商品仍有库存或被业务单据引用，暂时不能删除。');
      return;
    }

    if (!(await confirm(`确认删除商品 ${product.sku} · ${product.name}？`))) {
      return;
    }

    setActiveMasterId(product.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteProduct(product.id);
      setActionMessage(response.message || '商品已删除。');
      if (editingProductId === product.id) {
        resetProductForm();
      }
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveMasterId('');
    }
  };

  const handleToggleProductStatus = async (product: ProductRecord) => {
    const actionLabel = product.status === 'active' ? '停用' : '启用';
    if (!(await confirm(`确认${actionLabel}商品 ${product.sku} · ${product.name}？`))) {
      return;
    }

    setActiveMasterId(product.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await toggleProductStatus(product.id);
      setActionMessage(response.message || '商品状态已更新。');
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveMasterId('');
    }
  };

  const handleEditWarehouse = (warehouse: WarehouseRecord) => {
    setEditingWarehouseId(warehouse.id);
    setWarehouseForm({
      name: warehouse.name,
      locationCode: warehouse.locationCode,
      capacity: warehouse.capacity,
    });
  };

  const handleDeleteWarehouse = async (warehouse: WarehouseRecord) => {
    if (!warehouse.canDelete) {
      setPageError('仓库仍有库存或业务引用，暂时不能删除。');
      return;
    }

    if (!(await confirm(`确认删除仓库 ${warehouse.name}？`))) {
      return;
    }

    setActiveMasterId(warehouse.id);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteWarehouse(warehouse.id);
      setActionMessage(response.message || '仓库已删除。');
      if (editingWarehouseId === warehouse.id) {
        resetWarehouseForm();
      }
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setActiveMasterId('');
    }
  };

  const handleToggleRolePermission = (permissionCode: string) => {
    setRolePermissionDraft((current) =>
      current.includes(permissionCode)
        ? current.filter((item) => item !== permissionCode)
        : [...current, permissionCode]
    );
  };

  const handleApplyAllPermissions = () => {
    setRolePermissionDraft(permissionOptions.map((permission) => permission.code));
  };

  const handleClearAllPermissions = () => {
    setRolePermissionDraft([]);
  };

  const handleRestoreRolePermissions = () => {
    setRolePermissionDraft(selectedRole?.permissionCodes ?? []);
  };

  const handleApplyModulePermissions = (moduleId: string, enabled: boolean) => {
    const moduleCodes = permissionOptions
      .filter((permission) => permission.moduleId === moduleId)
      .map((permission) => permission.code);

    setRolePermissionDraft((current) => {
      if (enabled) {
        return Array.from(new Set([...current, ...moduleCodes]));
      }

      return current.filter((code) => !moduleCodes.includes(code));
    });
  };

  const handleDeleteRole = async () => {
    if (!selectedRole) {
      setPageError('请先选择角色。');
      return;
    }

    if (!(await confirm(`确认删除角色 ${selectedRole.name}？`))) {
      return;
    }
    const verifyPassword = promptSensitiveVerification(`删除角色 ${selectedRole.name}`);
    if (!verifyPassword) {
      return;
    }

    setIsDeletingRole(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await deleteRole(selectedRole.id, { verifyPassword });
      setActionMessage(response.message || '角色已删除。');
      await refreshAfterMutation();
      setSelectedRoleId('');
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsDeletingRole(false);
    }
  };

  const handleSaveRolePermissions = async () => {
    if (!selectedRoleId) {
      setPageError('请先选择角色。');
      return;
    }
    if (!(await confirm(`确认更新角色 ${selectedRole?.name || selectedRoleId} 的权限配置？`))) {
      return;
    }
    const verifyPassword = promptSensitiveVerification(`更新角色 ${selectedRole?.name || selectedRoleId} 的权限配置`);
    if (!verifyPassword) {
      return;
    }

    setIsUpdatingRolePermissions(true);
    setPageError('');
    setActionMessage('');

    try {
      const response = await updateRolePermissions(selectedRoleId, {
        permissionCodes: rolePermissionDraft,
        verifyPassword,
      });
      setActionMessage(response.message || '角色权限已更新。');
      await refreshAfterMutation();
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsUpdatingRolePermissions(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">系统设置</h2>
          <p className="text-sm text-gray-500 mt-1">当前页用于管理账号安全、角色权限、基础资料和审计日志。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadBaseData()} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> 刷新设置
          </Button>
          {canViewLogs && (
            <Button variant="outline" className="border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm" onClick={() => void loadLogs()} disabled={isAuditLoading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isAuditLoading ? 'animate-spin' : ''}`} /> 刷新日志
            </Button>
          )}
        </div>
      </div>

      {pageError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">设置数据处理失败：{pageError}</div>}
      {auditError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">审计日志加载失败：{auditError}</div>}
      {actionMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{actionMessage}</div>}

      <div className="flex flex-wrap gap-2">
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <Button key={section.id} variant="ghost" className={activeSection === section.id ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'} onClick={() => setActiveSection(section.id)}>
              <Icon className="mr-2 h-4 w-4" /> {section.label}
            </Button>
          );
        })}
      </div>

      {activeSection === 'account' && (
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <Card className="border-gray-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-gray-800">个人资料与账号安全</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="text-sm text-gray-500">当前登录账号</div>
                <div className="mt-2 text-lg font-semibold text-gray-900">{user?.username}</div>
                <div className="text-sm text-gray-500 mt-1">{user?.email} · {user?.department}</div>
                <div className="text-sm text-gray-500 mt-1">手机号：{user?.phone || '-'}</div>
                <div className="flex flex-wrap gap-2 mt-3">{user?.roles.map((role) => <Badge key={role} variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">{role}</Badge>)}</div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Input value={profileForm.email} onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })} placeholder="邮箱" />
                <Input value={profileForm.phone} onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })} placeholder="手机号" />
                <div className="md:col-span-2">
                  <select value={profileForm.department} onChange={(e) => setProfileForm({ ...profileForm, department: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm">
                    <option value="管理部">管理部</option>
                    <option value="财务部">财务部</option>
                    <option value="仓储部">仓储部</option>
                    <option value="采购部">采购部</option>
                    <option value="运营部">运营部</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => void handleUpdateProfile()} disabled={isUpdatingProfile}>
                  {isUpdatingProfile ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Users className="mr-2 h-4 w-4" />}保存个人资料
                </Button>
              </div>
              <div className="h-px bg-gray-200" />
              <div className="grid gap-4 md:grid-cols-2">
                <Input type="password" value={passwordForm.currentPassword} onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })} placeholder="当前密码" />
                <Input type="password" value={passwordForm.newPassword} onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} placeholder="新密码（至少 8 位，需满足复杂度）" />
                <div className="md:col-span-2">
                  <Input type="password" value={passwordForm.confirmPassword} onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })} placeholder="确认新密码" />
                </div>
              </div>
              <div className="flex justify-end">
                <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleChangePassword()} disabled={isChangingPassword}>
                  {isChangingPassword ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}修改密码
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-gray-800">安全策略与当前会话</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 text-sm text-gray-600">
              <div className="space-y-3">
                <div>1. 当前登录账号支持维护邮箱、手机号和所属部门。</div>
                <div>2. 密码策略：{passwordPolicy?.message || '密码至少 8 位，且需包含大写字母、小写字母、数字、特殊字符中的至少 3 类。'}</div>
                <div>3. 连续登录失败 {passwordPolicy?.failureLimit || 5} 次会锁定账号 {passwordPolicy?.lockMinutes || 15} 分钟。</div>
                <div>4. 密码轮换周期 {passwordPolicy?.rotationIntervalDays || 90} 天，临近到期前 {passwordPolicy?.rotationWarningDays || 14} 天会提醒。</div>
                <div>5. 角色权限、用户口令、会话移除等敏感操作需要二次验证当前登录密码。</div>
              </div>
              {passwordSecurity && (
                <div className={`rounded-lg border px-4 py-3 ${passwordSecurity.needsRotation ? 'border-amber-300 bg-amber-50 text-amber-800' : passwordSecurity.shouldWarnRotation ? 'border-blue-200 bg-blue-50 text-blue-800' : 'border-gray-200 bg-gray-50 text-gray-600'}`}>
                  <div className="font-medium">
                    {passwordSecurity.needsRotation
                      ? '当前密码已达到轮换条件，建议立即修改。'
                      : passwordSecurity.shouldWarnRotation
                        ? `当前密码将在 ${passwordSecurity.daysUntilRotation ?? '-'} 天后达到轮换周期。`
                        : '当前密码状态正常。'}
                  </div>
                  <div className="mt-1 text-xs">
                    上次修改：{passwordSecurity.passwordUpdatedAt ? formatDateTime(passwordSecurity.passwordUpdatedAt) : '-'}
                    {' · '}密码龄期：{passwordSecurity.passwordAgeDays ?? '-'} 天
                    {' · '}首次登录改密：{passwordSecurity.mustChangePassword ? '是' : '否'}
                  </div>
                </div>
              )}
              <div className="space-y-3">
                <div>补充：密码修改、重置和找回后，系统会自动清理其他终端会话。</div>
              </div>
              <div className="h-px bg-gray-200" />
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-gray-900">当前活跃会话</div>
                    <div className="text-xs text-gray-500 mt-1">可查看当前账号的在线会话，并移除其他终端。</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => void loadSessionManagementData()} disabled={isSessionLoading}>
                      {isSessionLoading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}刷新
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void handleRevokeOtherSessions()} disabled={isSessionLoading || sessionRecords.filter((item) => !item.isCurrent).length === 0}>
                      移除其他会话
                    </Button>
                  </div>
                </div>
                <div className="space-y-3">
                  {sessionRecords.length > 0 ? sessionRecords.map((session) => (
                    <div key={session.sessionId} className="rounded-lg border border-gray-200 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <div className="font-medium text-gray-900">{session.userAgent || '未知终端'}</div>
                            {session.isCurrent ? <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">当前会话</Badge> : null}
                          </div>
                          <div className="text-xs text-gray-500">IP：{session.ipAddress || '-'}</div>
                          <div className="text-xs text-gray-500">创建：{formatDateTime(session.createdAt)}</div>
                          <div className="text-xs text-gray-500">最近活动：{formatDateTime(session.lastSeenAt)}</div>
                          <div className="text-xs text-gray-500">过期：{formatDateTime(session.expiresAt)}</div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRevokeManagedSession(session.sessionId)}
                          disabled={session.isCurrent || activeSessionToken === session.sessionId}
                          title={session.isCurrent ? '当前会话不能在这里移除' : undefined}
                        >
                          {activeSessionToken === session.sessionId ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                          移除
                        </Button>
                      </div>
                    </div>
                  )) : <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">当前没有可展示的活跃会话。</div>}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {activeSection === 'access' && canManageAccess && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">用户总数</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{accessOverview?.summary.userCount ?? 0}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">启用用户</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{accessOverview?.summary.activeUserCount ?? 0}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">角色 / 权限</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{accessOverview?.summary.roleCount ?? 0} / {accessOverview?.summary.permissionCount ?? 0}</div></CardContent></Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <Card className="border-gray-200 shadow-sm">
              <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">授权模板</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {(accessOverview?.roleTemplates ?? []).map((template) => (
                  <div key={template.id} className="rounded-lg border border-gray-200 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-gray-900">{template.name}</div>
                      <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">{template.securityLevel}</Badge>
                    </div>
                    <div className="mt-2 text-sm text-gray-600">{template.description}</div>
                    <div className="mt-2 text-xs text-gray-500">适用岗位：{template.recommendedFor}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {template.keyPermissions.map((permission) => (
                        <Badge key={`${template.id}-${permission}`} variant="outline" className="border-gray-300 text-gray-600">{permission}</Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="border-gray-200 shadow-sm">
              <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">安全分级</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {(accessOverview?.securityLevels ?? []).map((level) => (
                  <div key={level.level} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-gray-900">{level.level} · {level.title}</div>
                      <Badge variant="outline" className="border-amber-300 text-amber-700">{level.verification}</Badge>
                    </div>
                    <div className="mt-2 text-sm text-gray-600">{level.description}</div>
                    <div className="mt-2 text-xs text-gray-500">典型动作：{level.typicalActions.join('、')}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card className="border-gray-200 shadow-sm">
            <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">新增用户</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <Input value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} placeholder="用户名" />
              <Input value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} placeholder="邮箱" />
              <Input value={userForm.phone || ''} onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })} placeholder="手机号" />
              <select value={userForm.department} onChange={(e) => setUserForm({ ...userForm, department: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm">
                <option value="管理部">管理部</option><option value="财务部">财务部</option><option value="仓储部">仓储部</option><option value="采购部">采购部</option><option value="运营部">运营部</option>
              </select>
              <select value={userForm.roleId} onChange={(e) => setUserForm({ ...userForm, roleId: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm md:col-span-2">
                {roleOptions.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.scope}</option>)}
              </select>
              <div className="md:col-span-2 flex items-center justify-between gap-4">
                <div className="text-sm text-gray-500">新建用户将生成一次性临时口令，并强制首次登录改密。</div>
                <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleCreateUser()} disabled={isSubmittingUser || !userForm.roleId}>{isSubmittingUser ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <User className="mr-2 h-4 w-4" />}创建用户</Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-sm">
            <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">新增角色模板</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <Input value={roleForm.name} onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })} placeholder="角色名称" />
              <select value={roleForm.scope} onChange={(e) => setRoleForm({ ...roleForm, scope: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm">
                <option value="global">global</option>
                <option value="operations">operations</option>
                <option value="finance">finance</option>
                <option value="warehouse">warehouse</option>
                <option value="procurement">procurement</option>
              </select>
              <div className="md:col-span-2">
                <Input value={roleForm.description || ''} onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })} placeholder="角色说明" />
              </div>
              <div className="md:col-span-2">
                <select value={roleForm.templateRoleId || ''} onChange={(e) => setRoleForm({ ...roleForm, templateRoleId: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm">
                  <option value="">不复制现有角色权限</option>
                  {roleOptions.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.scope}</option>)}
                </select>
              </div>
              <div className="md:col-span-2 flex items-center justify-between gap-4">
                <div className="text-sm text-gray-500">可直接复制现有角色权限，创建后再进入右侧细调。</div>
                <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleCreateRole()} disabled={isSubmittingRole}>
                  {isSubmittingRole ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Shield className="mr-2 h-4 w-4" />}创建角色
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-sm">
            <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">用户与角色分配</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {(accessOverview?.users ?? []).map((targetUser) => (
                <div key={targetUser.id} className="rounded-lg border border-gray-200 p-4 flex flex-col gap-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="font-semibold text-gray-900">{targetUser.username}</div>
                      <div className="text-sm text-gray-500">{targetUser.email} · {targetUser.department}</div>
                      <div className="flex flex-wrap gap-2 mt-2">{targetUser.roles.map((role) => <Badge key={role} variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">{role}</Badge>)}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant={targetUser.status === 'active' ? 'success' : 'secondary'}>{targetUser.status === 'active' ? '启用中' : '已停用'}</Badge>
                      <Button variant="outline" size="sm" onClick={() => void handleResetUserPassword(targetUser)} disabled={activeUserId === targetUser.id}>
                        {activeUserId === targetUser.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}重置密码
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void handleToggleUserStatus(targetUser)} disabled={activeUserId === targetUser.id}>{activeUserId === targetUser.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}{targetUser.status === 'active' ? '停用' : '启用'}</Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDeleteUser(targetUser)}
                        disabled={activeUserId === targetUser.id || !targetUser.canDelete}
                        title={targetUser.canDelete ? undefined : targetUser.isProtected ? '系统管理员账号不可删除' : '请先停用用户后再删除'}
                      >
                        {activeUserId === targetUser.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}删除
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
                    <select value={pendingUserRoles[targetUser.id] || ''} onChange={(e) => setPendingUserRoles((current) => ({ ...current, [targetUser.id]: e.target.value }))} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm">
                      {roleOptions.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.scope}</option>)}
                    </select>
                    <Button variant="outline" onClick={() => void handleUpdateUserRole(targetUser)} disabled={activeUserId === targetUser.id || !pendingUserRoles[targetUser.id]}>保存角色</Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <Card className="border-gray-200 shadow-sm">
              <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">角色权限编辑</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <select value={selectedRoleId} onChange={(e) => setSelectedRoleId(e.target.value)} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm">
                  {roleOptions.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.scope}</option>)}
                </select>
                {selectedRole && (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="flex items-center gap-2">
                      <div className="font-semibold text-gray-900">{selectedRole.name}</div>
                      {selectedRole.isProtected ? <Badge variant="outline" className="border-gray-300 text-gray-600">系统预置</Badge> : null}
                    </div>
                    <div className="text-sm text-gray-500 mt-1">{selectedRole.description}</div>
                    <div className="text-xs text-gray-500 mt-2">关联用户 {selectedRole.userCount} / 当前权限 {selectedRole.permissionCount}</div>
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void handleDeleteRole()}
                    disabled={isDeletingRole || !selectedRoleId || !selectedRole?.canDelete}
                    title={selectedRole?.canDelete ? undefined : selectedRole?.isProtected ? '系统预置角色不可删除' : '角色仍有关联用户，不能删除'}
                  >
                    {isDeletingRole ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}删除角色
                  </Button>
                  <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void handleSaveRolePermissions()} disabled={isUpdatingRolePermissions || !selectedRoleId}>{isUpdatingRolePermissions ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Shield className="mr-2 h-4 w-4" />}保存角色权限</Button>
                </div>
              </CardContent>
            </Card>

            <Card className="border-gray-200 shadow-sm">
              <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">权限节点清单</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleApplyAllPermissions}>全选全部</Button>
                  <Button variant="outline" size="sm" onClick={handleClearAllPermissions}>清空全部</Button>
                  <Button variant="outline" size="sm" onClick={handleRestoreRolePermissions} disabled={!selectedRole}>恢复角色当前配置</Button>
                </div>
                {permissionGroups.map(([moduleId, permissions]) => (
                  <div key={moduleId} className="rounded-lg border border-gray-200 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium text-gray-900">{moduleId}</div>
                        <div className="text-xs text-gray-500 mt-1">{permissions.length} 个权限节点</div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleApplyModulePermissions(moduleId, true)}>全选模块</Button>
                        <Button variant="outline" size="sm" onClick={() => handleApplyModulePermissions(moduleId, false)}>清空模块</Button>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {permissions.map((permission) => (
                        <label key={permission.id} className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 cursor-pointer hover:bg-gray-50">
                          <input type="checkbox" className="mt-1 h-4 w-4" checked={rolePermissionDraft.includes(permission.code)} onChange={() => handleToggleRolePermission(permission.code)} />
                          <div>
                            <div className="font-medium text-gray-900">{permission.label}</div>
                            <div className="text-xs text-gray-500 mt-1">{permission.code}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {activeSection === 'master' && canManageMasterData && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">供应商数量</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{masterDataOverview?.summary.supplierCount ?? 0}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">商品数量</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{masterDataOverview?.summary.productCount ?? 0}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">仓库数量</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-gray-900">{masterDataOverview?.summary.warehouseCount ?? 0}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">低库存商品</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-red-600">{masterDataOverview?.summary.lowStockProductCount ?? 0}</div></CardContent></Card>
          </div>

          <Card className="border-gray-200 shadow-sm">
            <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">批量导入商品</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-500">支持 txt、csv、xls、xlsx。首行请提供表头，可识别：SKU、商品名称、品类、单位、安全库存、售价、成本价、供应商。</p>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={productImportInputRef}
                  type="file"
                  accept=".txt,.csv,.xls,.xlsx"
                  className="hidden"
                  onChange={(event) => void handleImportProducts(event.target.files?.[0] || null)}
                />
                <Button
                  variant="outline"
                  className="border-gray-300 text-gray-700 hover:bg-gray-50"
                  onClick={() => productImportInputRef.current?.click()}
                  disabled={!canManageMasterData || isImportingProducts}
                  title={!canManageMasterData ? '当前角色没有基础资料维护权限' : '导入商品列表'}
                >
                  {isImportingProducts ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  选择文件导入
                </Button>
                <span className="text-sm text-gray-500">{productImportFileName || '尚未选择文件'}</span>
              </div>
              {productImportResult ? (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-2 text-sm text-gray-700">
                  <div className="font-medium text-gray-900">最近一次导入结果</div>
                  <div>总行数 {productImportResult.totalCount}，新增 {productImportResult.createdCount}，跳过 {productImportResult.skippedCount}，失败 {productImportResult.errorCount}</div>
                  {productImportResult.errors.length > 0 ? (
                    <div className="space-y-1">
                      {productImportResult.errors.slice(0, 5).map((item) => (
                        <div key={`${item.rowNumber}-${item.identifier}`} className="text-red-600">
                          第 {item.rowNumber} 行 / {item.identifier}：{item.reason}
                        </div>
                      ))}
                      {productImportResult.errors.length > 5 ? <div className="text-gray-500">其余 {productImportResult.errors.length - 5} 条失败记录已省略。</div> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="border-gray-200 shadow-sm">
              <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">{editingSupplierId ? '编辑供应商' : '新增供应商'}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <Input value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} placeholder="供应商名称" />
                <Input value={supplierForm.contactName || ''} onChange={(e) => setSupplierForm({ ...supplierForm, contactName: e.target.value })} placeholder="联系人" />
                <Input value={supplierForm.phone || ''} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} placeholder="联系电话" />
                <Input type="number" value={supplierForm.leadTimeDays} onChange={(e) => setSupplierForm({ ...supplierForm, leadTimeDays: Number(e.target.value) || 0 })} placeholder="提前期（天）" />
                <div className="flex gap-2">
                  <Button className="bg-blue-600 hover:bg-blue-700 flex-1" onClick={() => void handleCreateSupplier()} disabled={isSubmittingSupplier}>
                    {isSubmittingSupplier ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Store className="mr-2 h-4 w-4" />}{editingSupplierId ? '保存供应商' : '创建供应商'}
                  </Button>
                  {editingSupplierId ? <Button variant="outline" onClick={resetSupplierForm}>取消</Button> : null}
                </div>
              </CardContent>
            </Card>

            <Card className="border-gray-200 shadow-sm">
              <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">{editingWarehouseId ? '编辑仓库' : '新增仓库'}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <Input value={warehouseForm.name} onChange={(e) => setWarehouseForm({ ...warehouseForm, name: e.target.value })} placeholder="仓库名称" />
                <Input value={warehouseForm.locationCode} onChange={(e) => setWarehouseForm({ ...warehouseForm, locationCode: e.target.value })} placeholder="库位编码，如 C区-08货架" />
                <Input type="number" value={warehouseForm.capacity} onChange={(e) => setWarehouseForm({ ...warehouseForm, capacity: Number(e.target.value) || 0 })} placeholder="容量" />
                <div className="flex gap-2">
                  <Button className="bg-blue-600 hover:bg-blue-700 flex-1" onClick={() => void handleCreateWarehouse()} disabled={isSubmittingWarehouse}>
                    {isSubmittingWarehouse ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Warehouse className="mr-2 h-4 w-4" />}{editingWarehouseId ? '保存仓库' : '创建仓库'}
                  </Button>
                  {editingWarehouseId ? <Button variant="outline" onClick={resetWarehouseForm}>取消</Button> : null}
                </div>
              </CardContent>
            </Card>

            <Card className="border-gray-200 shadow-sm">
              <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">{editingProductId ? '编辑商品' : '新增商品'}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <Input value={productForm.sku} onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })} placeholder="SKU" />
                <Input value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} placeholder="商品名称" />
                <Input value={productForm.category} onChange={(e) => setProductForm({ ...productForm, category: e.target.value })} placeholder="品类" />
                <div className="grid grid-cols-3 gap-3">
                  <Input value={productForm.unit} onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })} placeholder="单位" />
                  <Input type="number" value={productForm.safeStock} onChange={(e) => setProductForm({ ...productForm, safeStock: Number(e.target.value) || 0 })} placeholder="安全库存" />
                  <select value={productForm.preferredSupplierId} onChange={(e) => setProductForm({ ...productForm, preferredSupplierId: e.target.value })} className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm">
                    {selectableSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.status === 'inactive' ? '（已停用）' : ''}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input type="number" value={productForm.salePrice} onChange={(e) => setProductForm({ ...productForm, salePrice: Number(e.target.value) || 0 })} placeholder="售价" />
                  <Input type="number" value={productForm.costPrice} onChange={(e) => setProductForm({ ...productForm, costPrice: Number(e.target.value) || 0 })} placeholder="成本价" />
                </div>
                <div className="flex gap-2">
                  <Button className="bg-blue-600 hover:bg-blue-700 flex-1" onClick={() => void handleCreateProduct()} disabled={isSubmittingProduct || !productForm.preferredSupplierId}>
                    {isSubmittingProduct ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Package className="mr-2 h-4 w-4" />}{editingProductId ? '保存商品' : '创建商品'}
                  </Button>
                  {editingProductId ? <Button variant="outline" onClick={resetProductForm}>取消</Button> : null}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="border-gray-200 shadow-sm">
              <CardHeader className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-lg font-semibold text-gray-800">供应商列表</CardTitle>
                  <select
                    value={supplierStatusFilter}
                    onChange={(e) => setSupplierStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
                    className="flex h-9 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="all">全部状态</option>
                    <option value="active">仅启用</option>
                    <option value="inactive">仅停用</option>
                  </select>
                </div>
                <p className="text-sm text-gray-500">供应商删除前必须先停用，且不能仍被商品或采购单引用。</p>
              </CardHeader>
              <CardContent className="space-y-3">
                {filteredSuppliers.map((supplier) => (
                  <div key={supplier.id} className="rounded-lg border border-gray-200 p-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-gray-900">{supplier.name}</div>
                      <div className="text-sm text-gray-500">{supplier.contactName || '-'} · {supplier.phone || '-'}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={supplier.status === 'active' ? 'success' : 'secondary'}>{supplier.status === 'active' ? '启用中' : '已停用'}</Badge>
                      <span className="text-xs text-gray-500">{supplier.leadTimeDays} 天</span>
                      <Button variant="outline" size="sm" onClick={() => void handleToggleSupplierStatus(supplier)} disabled={activeMasterId === supplier.id}>
                        {activeMasterId === supplier.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}{supplier.status === 'active' ? '停用' : '启用'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleEditSupplier(supplier)} disabled={activeMasterId === supplier.id}>编辑</Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDeleteSupplier(supplier)}
                        disabled={activeMasterId === supplier.id || !supplier.canDelete}
                        title={supplier.canDelete ? '删除供应商' : supplier.status === 'active' ? '需先停用后删除' : '仍有关联商品或采购单'}
                      >
                        {activeMasterId === supplier.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}删除
                      </Button>
                    </div>
                  </div>
                ))}
                {filteredSuppliers.length === 0 ? <div className="text-sm text-gray-500">当前筛选条件下没有供应商。</div> : null}
              </CardContent>
            </Card>

            <Card className="border-gray-200 shadow-sm">
              <CardHeader className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-lg font-semibold text-gray-800">商品列表</CardTitle>
                  <select
                    value={productStatusFilter}
                    onChange={(e) => setProductStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
                    className="flex h-9 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="all">全部状态</option>
                    <option value="active">仅启用</option>
                    <option value="inactive">仅停用</option>
                  </select>
                </div>
                <p className="text-sm text-gray-500">商品删除前必须先停用，且不能仍有库存或业务单据引用。</p>
              </CardHeader>
              <CardContent className="space-y-4">
                {filteredProducts.map((product) => (
                  <div key={product.id} className="rounded-lg border border-gray-200 p-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-gray-900">{product.sku} · {product.name}</div>
                      <div className="text-sm text-gray-500">{product.category} · 安全库存 {product.safeStock} · {product.preferredSupplier}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={product.status === 'active' ? 'success' : 'secondary'}>{product.status === 'active' ? '启用中' : '已停用'}</Badge>
                      <div className="text-right text-sm text-gray-600">{formatCurrency(product.salePrice)} / {formatCurrency(product.costPrice)}</div>
                      <Button variant="outline" size="sm" onClick={() => void handleToggleProductStatus(product)} disabled={activeMasterId === product.id}>
                        {activeMasterId === product.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}{product.status === 'active' ? '停用' : '启用'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleEditProduct(product)} disabled={activeMasterId === product.id}>编辑</Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDeleteProduct(product)}
                        disabled={activeMasterId === product.id || !product.canDelete}
                        title={product.canDelete ? '删除商品' : product.status === 'active' ? '需先停用后删除' : '仍有库存或业务单据引用'}
                      >
                        {activeMasterId === product.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}删除
                      </Button>
                    </div>
                  </div>
                ))}
                {filteredProducts.length === 0 ? <div className="text-sm text-gray-500">当前筛选条件下没有商品。</div> : null}
              </CardContent>
            </Card>

            <Card className="border-gray-200 shadow-sm">
              <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">仓库列表</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {(masterDataOverview?.warehouses ?? []).map((warehouse) => (
                  <div key={warehouse.id} className="rounded-lg border border-gray-200 p-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-gray-900">{warehouse.name}</div>
                      <div className="text-sm text-gray-500 mt-1">{warehouse.locationCode}</div>
                      <div className="text-sm text-gray-700 mt-2">库存 {warehouse.currentStock} / 容量 {warehouse.capacity}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleEditWarehouse(warehouse)} disabled={activeMasterId === warehouse.id}>编辑</Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDeleteWarehouse(warehouse)}
                        disabled={activeMasterId === warehouse.id || !warehouse.canDelete}
                        title={warehouse.canDelete ? '删除仓库' : '仍有库存或业务引用'}
                      >
                        {activeMasterId === warehouse.id ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}删除
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {activeSection === 'logs' && canViewLogs && (
        <>
          <Card className="border-gray-200 shadow-sm">
            <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">审计日志筛选</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
              <Input value={auditEntityType} onChange={(e) => setAuditEntityType(e.target.value)} placeholder="实体类型，如 customer" />
              <Input value={auditAction} onChange={(e) => setAuditAction(e.target.value)} placeholder="动作，如 create_customer" />
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void loadLogs()} disabled={isAuditLoading}>{isAuditLoading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <FileSearch className="mr-2 h-4 w-4" />}查询日志</Button>
              <Button variant="outline" onClick={() => { setAuditEntityType(''); setAuditAction(''); void loadLogs('', ''); }}>重置筛选</Button>
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-sm">
            <CardHeader><CardTitle className="text-lg font-semibold text-gray-800">最近 20 条审计日志</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {isAuditLoading && <div className="text-sm text-gray-500">正在加载审计日志...</div>}
              {!isAuditLoading && auditLogs.length === 0 && <div className="text-sm text-gray-500">当前条件下没有审计日志。</div>}
              {!isAuditLoading && auditLogs.map((log) => (
                <div key={`${log.id}-${log.createdAt}`} className="rounded-lg border border-gray-200 p-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="border-blue-100 bg-blue-50 text-blue-700">{log.action}</Badge>
                      <span className="text-sm text-gray-700">{log.entityType}</span>
                      <span className="text-sm text-gray-500">{log.entityId}</span>
                    </div>
                    <div className="text-xs text-gray-500">{log.createdAt}</div>
                  </div>
                  <div className="text-sm text-gray-600 mt-3">{parseAuditPayload(log.payload)}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
      {confirmDialog}
    </div>
  );
}






