import React, { useState, useEffect, useRef } from 'react';

interface VirtualSongListProps<T> {
  items: T[];
  itemHeight?: number;
  overscan?: number;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}

/**
 * Virtualizador ligero sin dependencias externas.
 * Mantiene únicamente ~16-20 nodos en el DOM midiendo el scroll de main.app-content con rAF.
 */
function VirtualSongListInner<T>({
  items,
  itemHeight = 72,
  overscan = 4,
  scrollContainerRef,
  getKey,
  renderItem
}: VirtualSongListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: Math.min(items.length - 1, 18)
  });

  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) {
      setRange({ start: 0, end: Math.min(items.length - 1, 24) });
      return;
    }

    let rafId: number | null = null;

    const calcularRango = () => {
      rafId = null;
      const listEl = containerRef.current;
      if (!listEl || !scrollEl) return;

      const listRect = listEl.getBoundingClientRect();
      const scrollRect = scrollEl.getBoundingClientRect();
      const listTopRelative = listRect.top - scrollRect.top + scrollEl.scrollTop;
      const scrollTop = scrollEl.scrollTop;
      const viewportHeight = scrollEl.clientHeight || window.innerHeight || 720;

      const visibleTop = Math.max(0, scrollTop - listTopRelative);
      const visibleBottom = Math.max(0, scrollTop + viewportHeight - listTopRelative);

      const start = Math.max(0, Math.floor(visibleTop / itemHeight) - overscan);
      const end = Math.min(
        items.length - 1,
        Math.ceil(visibleBottom / itemHeight) + overscan
      );

      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };

    const onScrollOrResize = () => {
      if (rafId === null) {
        rafId = requestAnimationFrame(calcularRango);
      }
    };

    calcularRango();
    scrollEl.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize, { passive: true });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      scrollEl.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [items.length, itemHeight, overscan, scrollContainerRef]);

  if (items.length === 0) return null;

  const safeStart = Math.max(0, Math.min(range.start, items.length - 1));
  const safeEnd = Math.max(safeStart, Math.min(range.end, items.length - 1));
  const totalHeight = items.length * itemHeight;
  const visibleItems = items.slice(safeStart, safeEnd + 1);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height: `${totalHeight}px`,
        width: '100%'
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: `${safeStart * itemHeight}px`,
          left: 0,
          right: 0
        }}
      >
        {visibleItems.map((item, idx) => {
          const realIndex = safeStart + idx;
          return (
            <div
              key={getKey(item, realIndex)}
              style={{
                height: `${itemHeight}px`,
                boxSizing: 'border-box',
                overflow: 'hidden'
              }}
            >
              {renderItem(item, realIndex)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const VirtualSongList = React.memo(VirtualSongListInner) as typeof VirtualSongListInner;
