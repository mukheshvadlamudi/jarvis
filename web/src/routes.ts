import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Activity, BookOpen, CheckCircle2, Gauge, Home, KanbanSquare, PlayCircle, Settings, Sparkles } from 'lucide-react';

export interface PageProps {
  params: Record<string, string>;
}

export interface RouteDef {
  path: string;
  title: string;
  icon: LucideIcon;
  load: () => Promise<{ default: ComponentType<PageProps> }>;
  /** Sidebar group; omitted for detail routes. */
  nav?: 'main' | 'work' | 'knowledge' | 'system';
  badge?: 'approvals' | 'needs_you';
  /** `g <key>` shortcut. */
  key?: string;
  order?: number;
}

/** One line per page, so module branches stay mergeable. */
export const routes: RouteDef[] = [
  { path: '/', title: 'Home', icon: Home, load: () => import('./pages/Home.tsx'), nav: 'main', key: 'h', order: 1 },
  { path: '/board', title: 'Board', icon: KanbanSquare, load: () => import('./pages/Board.tsx'), nav: 'main', badge: 'needs_you', key: 'b', order: 2 },
  { path: '/approvals', title: 'Approvals', icon: CheckCircle2, load: () => import('./pages/Approvals.tsx'), nav: 'main', badge: 'approvals', key: 'a', order: 3 },
  { path: '/runs/:id', title: 'Run', icon: PlayCircle, load: () => import('./pages/Run.tsx') },
  { path: '/tasks/:id', title: 'Task', icon: Activity, load: () => import('./pages/Run.tsx') },
  { path: '/memory', title: 'Memory', icon: BookOpen, load: () => import('./pages/Memory.tsx'), nav: 'knowledge', key: 'm', order: 60 },
  { path: '/skills', title: 'Skills', icon: Sparkles, load: () => import('./pages/Skills.tsx'), nav: 'knowledge', key: 's', order: 61 },
  { path: '/usage', title: 'Usage', icon: Gauge, load: () => import('./pages/Usage.tsx'), nav: 'system', key: 'u', order: 90 },
  { path: '/settings', title: 'Settings', icon: Settings, load: () => import('./pages/Settings.tsx'), nav: 'system', key: ',', order: 99 },
];
