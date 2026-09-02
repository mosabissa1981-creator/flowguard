"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

function subscribe(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener("flowguard-storage", onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener("flowguard-storage", onStoreChange);
  };
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function usePersistentState<T>(key: string, fallback: T) {
  const getSnapshot = useCallback(() => readRaw(key), [key]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const value = useMemo(() => {
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }, [raw, fallback]);

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      let current = fallback;
      try {
        const stored = window.localStorage.getItem(key);
        if (stored != null) current = JSON.parse(stored) as T;
      } catch {
        current = fallback;
      }
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(current) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
        window.dispatchEvent(new Event("flowguard-storage"));
      } catch {
        // Ignore quota / private-mode failures.
      }
    },
    [key, fallback],
  );

  return [value, setValue] as const;
}
