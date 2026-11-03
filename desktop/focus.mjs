import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const ps = (script) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 });
const user32 = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class JarvisFocus { [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; } [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }';`;

export async function captureFocus() {
  if (process.platform === 'win32') {
    return JSON.parse((await ps(`${user32} $window = [JarvisFocus]::GetForegroundWindow(); $rect = [JarvisFocus+Rect]::new(); [JarvisFocus]::GetWindowRect($window, [ref]$rect) | Out-Null; @{id=$window.ToInt64().ToString(); bounds=@{x=$rect.Left;y=$rect.Top;width=($rect.Right-$rect.Left);height=($rect.Bottom-$rect.Top)}} | ConvertTo-Json -Compress`)).stdout.trim());
  }
  if (process.platform === 'darwin') {
    const { stdout } = await exec('osascript', ['-e', 'tell application "System Events"\nset p to first application process whose frontmost is true\nset winPosition to position of front window of p\nset winSize to size of front window of p\nreturn {unix id of p, item 1 of winPosition, item 2 of winPosition, item 1 of winSize, item 2 of winSize}\nend tell']);
    const [id, x, y, width, height] = stdout.trim().split(',').map((part) => Number(part.trim()));
    return { id: String(id), bounds: { x, y, width, height } };
  }
  const id = (await exec('xdotool', ['getactivewindow'], { timeout: 3000 })).stdout.trim();
  const geometry = (await exec('xdotool', ['getwindowgeometry', '--shell', id], { timeout: 3000 })).stdout;
  const values = Object.fromEntries(geometry.trim().split('\n').map((line) => line.split('=')));
  return { id, bounds: { x: Number(values.X), y: Number(values.Y), width: Number(values.WIDTH), height: Number(values.HEIGHT) } };
}

export async function restoreFocus(target) {
  const id = target?.id;
  if (!/^\d+$/.test(id ?? '')) throw new Error('The previous app could not be identified. Text is available in the overlay; copy it manually.');
  if (process.platform === 'win32') {
    const { stdout } = await ps(`${user32} [JarvisFocus]::SetForegroundWindow([IntPtr]::new(${id}))`);
    if (!stdout.includes('True')) throw new Error('Windows could not focus the previous app. Copy the transcript manually.');
  } else if (process.platform === 'darwin') {
    await exec('osascript', ['-e', `tell application "System Events" to set frontmost of first application process whose unix id is ${id} to true`]);
  } else await exec('xdotool', ['windowactivate', '--sync', id], { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 150));
}

export async function paste() {
  if (process.platform === 'win32') await ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')");
  else if (process.platform === 'darwin') await exec('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  else await exec('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { timeout: 3000 });
}
