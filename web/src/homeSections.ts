import type { ComponentType } from 'react';
import { TodaySection } from './components/TodaySection.tsx';

export interface HomeSection {
  id: string;
  column: 'main' | 'side';
  component: ComponentType;
}

/** Extra Home sections contributed by modules (schedule, follow-ups…). One line each. */
export const homeSections: HomeSection[] = [
  { id: 'today', column: 'side', component: TodaySection },
];
