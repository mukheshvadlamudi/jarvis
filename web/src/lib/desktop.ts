/** Bridge exposed by the Electron preload (undefined in a normal browser). */
export interface DesktopBridge {
  platform: string;
  login: (agent: 'claude' | 'codex') => Promise<{ ok: boolean; message: string }>;
  openPath: (which: 'data' | 'logs') => Promise<string>;
  info: () => Promise<{ version: string; packaged: boolean; dataDir: string; attached: boolean }>;
  onCapture: (fn: () => void) => () => void;
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? (window as unknown as { jarvisDesktop?: DesktopBridge }).jarvisDesktop : undefined;
