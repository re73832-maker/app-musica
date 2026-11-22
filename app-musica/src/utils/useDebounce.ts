import { useState, useEffect } from 'react';

/**
 * Hook para retrasar la actualización de un valor hasta que haya transcurrido
 * un tiempo de inactividad (delay en ms). Ideal para búsquedas instantáneas y autocompletado.
 */
export function useDebounce<T>(value: T, delay: number = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}
