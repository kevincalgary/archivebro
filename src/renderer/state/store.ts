import { create } from 'zustand';
import type { AppSettings, TabState } from '../../shared/types';

export type Screen = 'browser' | 'library' | 'settings';

interface AppState {
  tabs: TabState[];
  activeTabId: string | null;
  screen: Screen;
  settings: AppSettings | null;
  setTabs: (tabs: TabState[]) => void;
  upsertTab: (tab: TabState) => void;
  removeTab: (tabId: string) => void;
  setActiveTabId: (id: string | null) => void;
  setScreen: (screen: Screen) => void;
  setSettings: (settings: AppSettings) => void;
}

export const useAppStore = create<AppState>((set) => ({
  tabs: [],
  activeTabId: null,
  screen: 'browser',
  settings: null,
  setTabs: (tabs) => set({ tabs }),
  upsertTab: (tab) =>
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === tab.id);
      if (idx === -1) return { tabs: [...state.tabs, tab] };
      const next = [...state.tabs];
      next[idx] = tab;
      return { tabs: next };
    }),
  removeTab: (tabId) => set((state) => ({ tabs: state.tabs.filter((t) => t.id !== tabId) })),
  setActiveTabId: (id) => set({ activeTabId: id }),
  setScreen: (screen) => set({ screen }),
  setSettings: (settings) => set({ settings }),
}));
