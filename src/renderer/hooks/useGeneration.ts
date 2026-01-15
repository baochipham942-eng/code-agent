// ============================================================================
// useGeneration - Generation Management Hook
// ============================================================================

import { useCallback, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import type { Generation, GenerationId } from '@shared/types';

export const useGeneration = () => {
  const {
    currentGeneration,
    setCurrentGeneration,
    availableGenerations,
    clearChat,
  } = useAppStore();

  // Load available generations on mount
  useEffect(() => {
    const loadGenerations = async () => {
      try {
        const generations = await window.electronAPI?.invoke('generation:list');
        if (generations) {
          // Store generations (handled by main process)
        }
      } catch (error) {
        console.error('Failed to load generations:', error);
      }
    };

    loadGenerations();
  }, []);

  // Switch to a different generation
  const switchGeneration = useCallback(
    async (generationId: GenerationId) => {
      try {
        const generation = await window.electronAPI?.invoke(
          'generation:switch',
          generationId
        );

        if (generation) {
          setCurrentGeneration(generation);
          // Optionally clear chat when switching generations
          // clearChat();
        }
      } catch (error) {
        console.error('Failed to switch generation:', error);
      }
    },
    [setCurrentGeneration]
  );

  // Get details about a specific generation
  const getGenerationInfo = useCallback(async (generationId: GenerationId) => {
    try {
      const info = await window.electronAPI?.invoke('generation:get-prompt', generationId);
      return info;
    } catch (error) {
      console.error('Failed to get generation info:', error);
      return null;
    }
  }, []);

  // Compare two generations
  const compareGenerations = useCallback(
    async (gen1Id: GenerationId, gen2Id: GenerationId) => {
      try {
        const comparison = await window.electronAPI?.invoke(
          'generation:compare',
          gen1Id,
          gen2Id
        );
        return comparison;
      } catch (error) {
        console.error('Failed to compare generations:', error);
        return null;
      }
    },
    []
  );

  return {
    currentGeneration,
    availableGenerations,
    switchGeneration,
    getGenerationInfo,
    compareGenerations,
  };
};
