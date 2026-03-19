import React, { useEffect, useMemo, useState } from 'react';
import { Layout } from './components/Layout';
import { AuthContext } from '@/auth/AuthContext';
import { appModules, defaultModuleId, filterModulesByPermissions, findModuleById } from '@/config/modules';
import { getCurrentPathname, getModulePath, LOGIN_PATH, resolveModuleFromPath } from '@/router/navigation';
import { Login } from '@/pages/Login';
import { clearAuthToken, getAuthToken, initializeAuthTokenStore, setAuthToken } from '@/services/api/client';
import { fetchSession, login, logout } from '@/services/api/system';
import type { SessionPayload, SessionUser } from '@/types/auth';

const REDIRECT_PATH_KEY = 'retail-smart-hub-redirect-path';

function persistPathname(pathname: string, replace = false) {
  if (typeof window === 'undefined') {
    return;
  }

  const normalizedPathname = pathname || '/';
  if (window.location.pathname !== normalizedPathname) {
    const fn = replace ? window.history.replaceState : window.history.pushState;
    fn.call(window.history, null, '', normalizedPathname);
  }
}

export default function App() {
  const [pathname, setPathname] = useState(getCurrentPathname());
  const [user, setUser] = useState<SessionUser | null>(null);
  const [token, setToken] = useState('');
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const isSuperAdmin = useMemo(
    () => Boolean(user && (user.username === 'admin' || user.roles.includes('系统管理员'))),
    [user],
  );

  const visibleModules = useMemo(
    () => (isSuperAdmin ? appModules : filterModulesByPermissions(user?.permissions ?? [])),
    [isSuperAdmin, user?.permissions]
  );
  const requestedModuleId = useMemo(
    () => resolveModuleFromPath(pathname) ?? defaultModuleId,
    [pathname]
  );
  const resolvedActiveMenu = useMemo(() => {
    if (visibleModules.some((item) => item.id === requestedModuleId)) {
      return requestedModuleId;
    }

    return visibleModules[0]?.id ?? defaultModuleId;
  }, [requestedModuleId, visibleModules]);
  const ActivePage = useMemo(
    () => findModuleById(resolvedActiveMenu)?.component || appModules[0].component,
    [resolvedActiveMenu]
  );

  const syncPathname = (nextPathname: string, replace = false) => {
    persistPathname(nextPathname, replace);
    setPathname(nextPathname);
  };

  const applySession = (session: SessionPayload | null) => {
    if (!session) {
      setToken('');
      setUser(null);
      return;
    }

    setToken(session.token);
    setUser(session.user);
  };

  useEffect(() => {
    const handlePopState = () => {
      setPathname(getCurrentPathname());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // ignore logout transport errors and clear local session anyway
    }

    await clearAuthToken();
    setToken('');
    setUser(null);
    syncPathname(LOGIN_PATH, true);
  };

  const refreshSession = async () => {
    const response = await fetchSession();
    applySession(response.data);
  };

  useEffect(() => {
    const bootstrap = async () => {
      await initializeAuthTokenStore();
      const storedToken = getAuthToken() || '';
      if (!storedToken) {
        setIsBootstrapping(false);
        return;
      }

      try {
        await refreshSession();
      } catch {
        await clearAuthToken();
        setToken('');
        setUser(null);
      } finally {
        setIsBootstrapping(false);
      }
    };

    const handleExpired = () => {
      void clearAuthToken();
      setToken('');
      setUser(null);
      syncPathname(LOGIN_PATH, true);
    };

    void bootstrap();
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, []);

  useEffect(() => {
    if (isBootstrapping) {
      return;
    }

    if (!user || !token) {
      if (pathname !== LOGIN_PATH) {
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem(REDIRECT_PATH_KEY, pathname);
        }
        syncPathname(LOGIN_PATH, true);
      }
      return;
    }

    const fallbackPath = getModulePath(resolvedActiveMenu);
    if (pathname === LOGIN_PATH) {
      const redirectPath = typeof window !== 'undefined'
        ? window.sessionStorage.getItem(REDIRECT_PATH_KEY) || fallbackPath
        : fallbackPath;
      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(REDIRECT_PATH_KEY);
      }
      syncPathname(redirectPath, true);
      return;
    }

    if (pathname !== fallbackPath && resolveModuleFromPath(pathname) !== resolvedActiveMenu) {
      syncPathname(fallbackPath, true);
    }
  }, [isBootstrapping, pathname, resolvedActiveMenu, token, user]);

  const handleLogin = async (username: string, password: string) => {
    setIsLoggingIn(true);
    try {
      const response = await login({ username, password });
      await setAuthToken(response.data.token);
      applySession(response.data);

      const redirectPath = typeof window !== 'undefined'
        ? window.sessionStorage.getItem(REDIRECT_PATH_KEY) || getModulePath(defaultModuleId)
        : getModulePath(defaultModuleId);
      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(REDIRECT_PATH_KEY);
      }
      syncPathname(redirectPath, true);
    } finally {
      setIsLoggingIn(false);
      setIsBootstrapping(false);
    }
  };

  const authValue = useMemo(
    () => ({
      user,
      token,
      isAuthenticated: Boolean(user && token),
      isBootstrapping,
      login: handleLogin,
      logout: handleLogout,
      refreshSession,
      hasPermission: (permission: string) =>
        Boolean(isSuperAdmin || user?.permissions.includes(permission)),
    }),
    [isBootstrapping, isSuperAdmin, token, user]
  );

  if (isBootstrapping) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-gray-500">正在加载系统会话...</div>;
  }

  if (!user || !token) {
    return <Login onLogin={handleLogin} isLoading={isLoggingIn} />;
  }

  return (
    <AuthContext.Provider value={authValue}>
      <Layout activeMenu={resolvedActiveMenu} setActiveMenu={(menu) => syncPathname(getModulePath(menu))}>
        <ActivePage />
      </Layout>
    </AuthContext.Provider>
  );
}
