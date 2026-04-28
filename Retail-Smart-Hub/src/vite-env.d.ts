/// <reference types="vite/client" />

interface DesktopShellBridge {
  platform: string;
  apiBaseUrl?: string;
  auth?: {
    getToken: () => Promise<string>;
    setToken: (token: string) => Promise<boolean>;
    clearToken: () => Promise<boolean>;
  };
  documents?: {
    printHtml: (html: string) => Promise<boolean>;
  };
}

interface Window {
  desktopShell?: DesktopShellBridge;
}
