import { useCallback, useEffect, useState } from "react";
import {
  loadSavedFolders,
  openLocalFolder,
  removeSavedFolder,
  reopenSavedFolder,
  type SavedFolder,
} from "../lib/local-folder.js";

export interface LocalFolderResult {
  name: string;
  files: { path: string; content: string }[];
}

export interface UseLocalFolderCallbacks {
  onOpen: (result: LocalFolderResult) => void;
}

export interface UseLocalFolderReturn {
  localLoading: boolean;
  localError: string | null;
  savedFolders: SavedFolder[];
  setSavedFolders: (folders: SavedFolder[]) => void;
  handleLocalFolder: () => Promise<void>;
  handleReopenFolder: (saved: SavedFolder) => Promise<void>;
  removeSavedFolderAndUpdate: (name: string) => Promise<void>;
}

export function useLocalFolder(
  callbacks: UseLocalFolderCallbacks
): UseLocalFolderReturn {
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedFolders, setSavedFolders] = useState<SavedFolder[]>([]);

  // Load saved folders from IndexedDB on mount
  useEffect(() => {
    void loadSavedFolders().then(setSavedFolders);
  }, []);

  const handleLocalFolder = useCallback(async () => {
    setLocalError(null);
    setLocalLoading(true);
    try {
      const { name, files: loaded } = await openLocalFolder();
      callbacks.onOpen({ name, files: loaded });
      setSavedFolders(await loadSavedFolders());
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // User cancelled the picker
      } else {
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLocalLoading(false);
    }
  }, [callbacks]);

  const handleReopenFolder = useCallback(
    async (saved: SavedFolder) => {
      setLocalError(null);
      setLocalLoading(true);
      try {
        const { name, files: loaded } = await reopenSavedFolder(saved);
        callbacks.onOpen({ name, files: loaded });
      } catch (err: unknown) {
        setLocalError(err instanceof Error ? err.message : String(err));
      } finally {
        setLocalLoading(false);
      }
    },
    [callbacks]
  );

  const removeSavedFolderAndUpdate = useCallback(async (name: string) => {
    setSavedFolders(await removeSavedFolder(name));
  }, []);

  return {
    localLoading,
    localError,
    savedFolders,
    setSavedFolders,
    handleLocalFolder,
    handleReopenFolder,
    removeSavedFolderAndUpdate,
  };
}
