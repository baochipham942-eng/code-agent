// ============================================================================
// useFileAutocomplete - @ 文件引用自动完成
// ============================================================================

import { useState, useCallback, useRef } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';

export interface FileMatch {
  path: string;
  name: string;
}

export function useFileAutocomplete() {
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback((text: string, cursorPos: number) => {
    // Find @ symbol before cursor
    const beforeCursor = text.slice(0, cursorPos);
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);

    if (!atMatch) {
      setIsOpen(false);
      return;
    }

    const searchQuery = atMatch[1];
    setQuery(searchQuery);

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const files = await ipcService.invoke(
          IPC_CHANNELS.WORKSPACE_LIST_FILES,
          searchQuery || '.'
        );
        if (!files) {
          setIsOpen(false);
          return;
        }
        setMatches(
          (files as Array<{ name: string; path?: string }>)
            .filter((f) => !searchQuery || f.name.toLowerCase().includes(searchQuery.toLowerCase()))
            .slice(0, 8)
            .map((f) => ({ path: f.path || f.name, name: f.name }))
        );
        setIsOpen(true);
      } catch {
        setIsOpen(false);
      }
    }, 200);
  }, []);

  const dismiss = useCallback(() => {
    setIsOpen(false);
    setMatches([]);
  }, []);

  return { matches, isOpen, query, search, dismiss };
}
