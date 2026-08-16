import type { ArchiveBrowserApi } from '../preload/trusted-preload';

declare global {
  interface Window {
    archiveBrowser: ArchiveBrowserApi;
  }
}

export {};
