import type { ComponentType } from 'react';

export interface HomeSection {
  id: string;
  column: 'main' | 'side';
  component: ComponentType;
}

/** Extra Home sections contributed by modules (schedule, follow-ups…). One line each. */
export const homeSections: HomeSection[] = [];
