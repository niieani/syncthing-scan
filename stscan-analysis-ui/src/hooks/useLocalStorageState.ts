import { useEffect, useState } from "react";

export const useLocalStorageState = <T,>(key: string, initial: T) => {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") {
      return initial;
    }
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        return initial;
      }
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore storage errors
    }
  }, [key, value]);

  return [value, setValue] as const;
};
