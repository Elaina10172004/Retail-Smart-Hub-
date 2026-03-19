import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CircleAlert,
  Info,
  LogOut,
  Package,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { appModules, filterModulesByPermissions, findModuleById, type AppModuleId } from '@/config/modules';
import { fetchNotifications } from '@/services/api/system';
import type { SystemNotificationRecord } from '@/types/auth';
import { cn } from '@/lib/utils';

interface LayoutProps {
  children: React.ReactNode;
  activeMenu: AppModuleId;
  setActiveMenu: (menu: AppModuleId) => void;
}

function getNotificationStorageKey(userId?: string) {
  return `retail-smart-hub-read-notifications:${userId || 'guest'}`;
}

function getDeletedNotificationStorageKey(userId?: string) {
  return `retail-smart-hub-hidden-notifications:${userId || 'guest'}`;
}

function formatNotificationDate(value: string) {
  if (!value) {
    return '-';
  }

  const normalized = value.includes('T') ? value : `${value}T00:00:00`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderNotificationIcon(level: SystemNotificationRecord['level']) {
  switch (level) {
    case 'critical':
      return <AlertTriangle className="h-4 w-4 text-red-500" />;
    case 'warning':
      return <CircleAlert className="h-4 w-4 text-amber-500" />;
    case 'success':
      return <CheckCheck className="h-4 w-4 text-emerald-500" />;
    default:
      return <Info className="h-4 w-4 text-sky-500" />;
  }
}

function hasAnyPermission(userPermissions: string[], requiredPermissions?: string[]) {
  if (!requiredPermissions || requiredPermissions.length === 0) {
    return true;
  }

  return requiredPermissions.some((permission) => userPermissions.includes(permission));
}

export function Layout({ children, activeMenu, setActiveMenu }: LayoutProps) {
  const { user, logout } = useAuth();
  const [notifications, setNotifications] = useState<SystemNotificationRecord[]>([]);
  const [readIds, setReadIds] = useState<string[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isNotificationsLoading, setIsNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState('');
  const [hasLoadedNotifications, setHasLoadedNotifications] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [notificationContextMenu, setNotificationContextMenu] = useState<{
    notificationId: string;
    x: number;
    y: number;
  } | null>(null);
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);
  const searchPanelRef = useRef<HTMLDivElement | null>(null);

  const visibleModules = useMemo(() => filterModulesByPermissions(user?.permissions ?? []), [user?.permissions]);
  const notificationStorageKey = useMemo(() => getNotificationStorageKey(user?.id), [user?.id]);
  const deletedNotificationStorageKey = useMemo(() => getDeletedNotificationStorageKey(user?.id), [user?.id]);

  const visibleNotifications = useMemo(
    () =>
      notifications.filter((item) => {
        const canSeeByPermission = hasAnyPermission(user?.permissions ?? [], item.requiredPermissions);
        const canSeeByModule = visibleModules.some((module) => module.id === item.moduleId) || item.moduleId === 'settings';
        return canSeeByPermission && canSeeByModule && !deletedIds.includes(item.id);
      }),
    [deletedIds, notifications, user?.permissions, visibleModules],
  );

  const visibleNotificationIds = useMemo(() => visibleNotifications.map((item) => item.id), [visibleNotifications]);
  const unreadCount = useMemo(
    () => visibleNotificationIds.filter((id) => !readIds.includes(id)).length,
    [readIds, visibleNotificationIds],
  );
  const readNotificationIds = useMemo(
    () => visibleNotificationIds.filter((id) => readIds.includes(id)),
    [readIds, visibleNotificationIds],
  );
  const searchResults = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    const matchedModules = visibleModules
      .filter((module) => !keyword || module.label.toLowerCase().includes(keyword) || module.id.toLowerCase().includes(keyword))
      .slice(0, keyword ? 6 : 4)
      .map((module) => ({
        key: `module:${module.id}`,
        type: 'module' as const,
        label: module.label,
        description: `打开 ${module.label}`,
        moduleId: module.id,
      }));
    const matchedNotifications = visibleNotifications
      .filter((notification) => {
        if (!keyword) {
          return !readIds.includes(notification.id);
        }

        const haystack = `${notification.title} ${notification.description} ${notification.moduleId}`.toLowerCase();
        return haystack.includes(keyword);
      })
      .slice(0, keyword ? 6 : 3)
      .map((notification) => ({
        key: `notification:${notification.id}`,
        type: 'notification' as const,
        label: notification.title,
        description: notification.description,
        moduleId: notification.moduleId,
        notification,
      }));

    return [...matchedModules, ...matchedNotifications];
  }, [readIds, searchQuery, visibleModules, visibleNotifications]);

  const loadNotifications = useCallback(
    async (silent = false) => {
      if (!silent) {
        setIsNotificationsLoading(true);
      }
      setNotificationsError('');

      try {
        const response = await fetchNotifications({ limit: 8 });
        setNotifications(response.data);
        setHasLoadedNotifications(true);
      } catch (error) {
        setNotificationsError(error instanceof Error ? error.message : '通知读取失败。');
        setHasLoadedNotifications(true);
      } finally {
        setIsNotificationsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.localStorage.getItem(notificationStorageKey);
      if (!raw) {
        setReadIds([]);
        return;
      }

      const parsed = JSON.parse(raw);
      setReadIds(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
    } catch {
      setReadIds([]);
    }
  }, [notificationStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(notificationStorageKey, JSON.stringify(readIds));
  }, [notificationStorageKey, readIds]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.localStorage.getItem(deletedNotificationStorageKey);
      if (!raw) {
        setDeletedIds([]);
        return;
      }

      const parsed = JSON.parse(raw);
      setDeletedIds(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
    } catch {
      setDeletedIds([]);
    }
  }, [deletedNotificationStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(deletedNotificationStorageKey, JSON.stringify(deletedIds));
  }, [deletedIds, deletedNotificationStorageKey]);

  useEffect(() => {
    void loadNotifications(true);
  }, [loadNotifications, user?.id]);

  useEffect(() => {
    if (typeof window === 'undefined' || !user?.id) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadNotifications(true);
    }, 45000);

    return () => window.clearInterval(intervalId);
  }, [loadNotifications, user?.id]);

  useEffect(() => {
    if (!hasLoadedNotifications) {
      return;
    }

    setReadIds((current) => current.filter((id) => visibleNotificationIds.includes(id)));
    setDeletedIds((current) => current.filter((id) => notifications.some((item) => item.id === id)));
  }, [hasLoadedNotifications, notifications, visibleNotificationIds]);

  useEffect(() => {
    if (!isNotificationsOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (notificationPanelRef.current && !notificationPanelRef.current.contains(event.target as Node)) {
        setIsNotificationsOpen(false);
        setNotificationContextMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isNotificationsOpen]);

  useEffect(() => {
    if (!notificationContextMenu) {
      return;
    }

    const handleCloseMenu = () => {
      setNotificationContextMenu(null);
    };

    document.addEventListener('scroll', handleCloseMenu, true);
    document.addEventListener('click', handleCloseMenu);

    return () => {
      document.removeEventListener('scroll', handleCloseMenu, true);
      document.removeEventListener('click', handleCloseMenu);
    };
  }, [notificationContextMenu]);

  useEffect(() => {
    if (!isSearchOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (searchPanelRef.current && !searchPanelRef.current.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isSearchOpen]);

  const toggleNotifications = async () => {
    const nextOpen = !isNotificationsOpen;
    setIsNotificationsOpen(nextOpen);

    if (nextOpen) {
      await loadNotifications(notifications.length > 0);
    }
  };

  const markAllAsRead = () => {
    setReadIds((current) => Array.from(new Set([...current, ...visibleNotificationIds])));
  };

  const deleteNotification = (notificationId: string) => {
    setDeletedIds((current) => (current.includes(notificationId) ? current : [...current, notificationId]));
    setReadIds((current) => current.filter((id) => id !== notificationId));
  };

  const deleteReadNotifications = () => {
    if (readNotificationIds.length === 0) {
      return;
    }

    setDeletedIds((current) => Array.from(new Set([...current, ...readNotificationIds])));
    setReadIds((current) => current.filter((id) => !readNotificationIds.includes(id)));
    setNotificationContextMenu(null);
  };

  const toggleNotificationReadState = (notificationId: string, shouldRead: boolean) => {
    setReadIds((current) => {
      if (shouldRead) {
        return current.includes(notificationId) ? current : [...current, notificationId];
      }

      return current.filter((id) => id !== notificationId);
    });
  };

  const handleNotificationClick = (notification: SystemNotificationRecord) => {
    toggleNotificationReadState(notification.id, true);
    setNotificationContextMenu(null);
    setIsNotificationsOpen(false);

    const module = findModuleById(notification.moduleId);
    if (module) {
      setActiveMenu(module.id);
    }
  };

  const handleSearchSelect = (
    result:
      | { type: 'module'; moduleId: AppModuleId }
      | { type: 'notification'; moduleId: string; notification: SystemNotificationRecord },
  ) => {
    if (result.type === 'notification') {
      handleNotificationClick(result.notification);
    } else {
      setActiveMenu(result.moduleId);
    }

    setSearchQuery('');
    setIsSearchOpen(false);
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-gray-50 font-sans text-gray-900">
      <aside className="z-10 flex h-full w-64 flex-shrink-0 flex-col border-r border-gray-200 bg-white shadow-sm">
        <div className="flex h-16 items-center border-b border-gray-100 px-6">
          <div className="flex items-center gap-2 text-blue-600">
            <Package className="h-6 w-6" />
            <span className="text-lg font-bold tracking-tight text-gray-900">RetailFlow Hub</span>
          </div>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {visibleModules.map((item) => {
            const Icon = item.icon;
            const isActive = activeMenu === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveMenu(item.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                )}
              >
                <Icon className={cn('h-5 w-5', isActive ? 'text-blue-600' : 'text-gray-400')} />
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="space-y-3 border-t border-gray-100 p-4">
          <div className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2 transition-colors">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">
              {user?.username.slice(0, 1).toUpperCase()}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{user?.username}</span>
              <span className="truncate text-xs text-gray-500">{user?.email}</span>
              <span className="truncate text-[11px] text-gray-400">{user?.roles.join(' / ')}</span>
            </div>
          </div>
          <button
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
            onClick={() => void logout()}
          >
            <LogOut className="h-4 w-4" /> 退出登录
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-10 flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 shadow-sm">
          <div className="flex flex-1 items-center gap-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-800">
                {visibleModules.find((item) => item.id === activeMenu)?.label || appModules[0].label}
              </h1>
              <div className="mt-1 text-xs text-gray-500">当前登录部门：{user?.department}</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="relative hidden md:block" ref={searchPanelRef}>
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setIsSearchOpen(true);
                }}
                onFocus={() => setIsSearchOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setIsSearchOpen(false);
                    return;
                  }

                  if (event.key === 'Enter' && searchResults[0]) {
                    handleSearchSelect(searchResults[0]);
                  }
                }}
                placeholder="搜索模块、提醒或页面..."
                className="h-9 w-64 rounded-full border border-gray-200 bg-gray-50 pl-9 pr-4 text-sm transition-all focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {isSearchOpen ? (
                <div className="absolute right-0 top-11 z-30 w-[360px] rounded-2xl border border-gray-200 bg-white p-2 shadow-xl">
                  <div className="px-2 pb-2 pt-1 text-xs text-gray-500">
                    {searchQuery.trim() ? '搜索结果' : '快捷入口'}
                  </div>
                  {searchResults.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-gray-200 px-3 py-8 text-center text-sm text-gray-500">
                      没有匹配到模块或业务提醒。
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {searchResults.map((result) => (
                        <button
                          key={result.key}
                          type="button"
                          onClick={() => handleSearchSelect(result)}
                          className="w-full rounded-xl px-3 py-2 text-left transition hover:bg-gray-50"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-gray-900">{result.label}</div>
                              <div className="mt-0.5 truncate text-xs text-gray-500">{result.description}</div>
                            </div>
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                result.type === 'module'
                                  ? 'bg-blue-50 text-blue-700'
                                  : 'bg-amber-50 text-amber-700',
                              )}
                            >
                              {result.type === 'module' ? '模块' : '提醒'}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            <div className="relative" ref={notificationPanelRef}>
              <button
                type="button"
                onClick={() => void toggleNotifications()}
                className="relative rounded-full p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                aria-label="打开消息中心"
                title="消息中心"
              >
                <Bell className="h-5 w-5" />
                {unreadCount > 0 ? (
                  <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-4 text-white">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                ) : null}
              </button>

              {isNotificationsOpen ? (
                <div className="absolute right-0 top-12 z-30 w-[360px] rounded-2xl border border-gray-200 bg-white shadow-xl">
                  <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">消息中心</div>
                      <div className="text-xs text-gray-500">库存、采购、发货、财务与审计提醒</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void loadNotifications()}
                        className="rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        aria-label="刷新通知"
                        title="刷新通知"
                      >
                        <RefreshCw className={cn('h-4 w-4', isNotificationsLoading ? 'animate-spin' : '')} />
                      </button>
                      <button
                        type="button"
                        onClick={markAllAsRead}
                        className="rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        aria-label="全部标记已读"
                        title="全部标记已读"
                      >
                        <CheckCheck className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={deleteReadNotifications}
                        disabled={readNotificationIds.length === 0}
                        className="rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="删除已读消息"
                        title="删除已读消息"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="max-h-[420px] overflow-y-auto p-2">
                    {notificationsError ? (
                      <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-4 text-sm text-red-600">
                        {notificationsError}
                      </div>
                    ) : null}

                    {!notificationsError && visibleNotifications.length === 0 && !isNotificationsLoading ? (
                      <div className="rounded-xl border border-dashed border-gray-200 px-3 py-10 text-center text-sm text-gray-500">
                        当前没有新的业务提醒。已处理通知会在下次刷新后自动消失。
                      </div>
                    ) : null}

                    {visibleNotifications.map((notification) => {
                      const isRead = readIds.includes(notification.id);
                      return (
                        <div
                          key={notification.id}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setNotificationContextMenu({
                              notificationId: notification.id,
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                          className={cn(
                            'mb-2 w-full rounded-xl border px-3 py-3 text-left transition-colors',
                            isRead
                              ? 'border-gray-100 bg-gray-50 hover:bg-gray-100'
                              : 'border-blue-100 bg-blue-50/70 hover:bg-blue-50',
                          )}
                        >
                          <button type="button" onClick={() => handleNotificationClick(notification)} className="w-full text-left">
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5">{renderNotificationIcon(notification.level)}</div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="truncate text-sm font-semibold text-gray-900">{notification.title}</div>
                                  {!isRead ? <span className="h-2 w-2 flex-shrink-0 rounded-full bg-blue-500"></span> : null}
                                </div>
                                <div className="mt-1 text-sm leading-5 text-gray-600">{notification.description}</div>
                                <div className="mt-2 flex items-center justify-between text-[11px] text-gray-400">
                                  <span>{findModuleById(notification.moduleId)?.label ?? '系统提醒'}</span>
                                  <span>{formatNotificationDate(notification.createdAt)}</span>
                                </div>
                              </div>
                            </div>
                          </button>
                        </div>
                      );
                    })}

                    {isNotificationsLoading && visibleNotifications.length === 0 ? (
                      <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-4 text-sm text-gray-500">
                        正在加载通知...
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {notificationContextMenu ? (
                <div
                  className="fixed z-40 min-w-36 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl"
                  style={{ left: notificationContextMenu.x, top: notificationContextMenu.y }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  {(() => {
                    const targetNotification = visibleNotifications.find((item) => item.id === notificationContextMenu.notificationId);
                    if (!targetNotification) {
                      return null;
                    }

                    const isRead = readIds.includes(targetNotification.id);
                    return (
                      <>
                        <button
                          type="button"
                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50"
                          onClick={() => {
                            toggleNotificationReadState(targetNotification.id, !isRead);
                            setNotificationContextMenu(null);
                          }}
                        >
                          {isRead ? '标为未读' : '标为已读'}
                        </button>
                        <button
                          type="button"
                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 transition hover:bg-red-50"
                          onClick={() => {
                            deleteNotification(targetNotification.id);
                            setNotificationContextMenu(null);
                          }}
                        >
                          删除消息
                        </button>
                      </>
                    );
                  })()}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
