import { useCallback, useEffect, useRef, useState } from "react";

export type Rect = { left: number; top: number; width: number; height: number };

const same = (a: Record<string, Rect>, b: Record<string, Rect>) => {
  const keys = Object.keys(b);
  return (
    keys.length === Object.keys(a).length &&
    keys.every((key) => {
      const x = a[key];
      const y = b[key];
      return (
        x && x.left === y.left && x.top === y.top && x.width === y.width && x.height === y.height
      );
    })
  );
};

/**
 * Tracks where each pane's body is, relative to the pane area, so live terminals can be laid over
 * them. Slots are registered by pane id; sizes are re-measured whenever any of them changes.
 */
export function usePaneSlots() {
  const area = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<string, HTMLElement>());
  const callbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const [rects, setRects] = useState<Record<string, Rect>>({});

  const measure = useCallback(() => {
    const base = area.current?.getBoundingClientRect();
    if (!base) return;
    const next: Record<string, Rect> = {};
    slots.current.forEach((element, id) => {
      const box = element.getBoundingClientRect();
      if (box.width && box.height)
        next[id] = {
          left: Math.round(box.left - base.left),
          top: Math.round(box.top - base.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
    });
    setRects((previous) => (same(previous, next) ? previous : next));
  }, []);

  useEffect(() => {
    const watcher = new ResizeObserver(() => measure());
    observer.current = watcher;
    if (area.current) watcher.observe(area.current);
    slots.current.forEach((element) => watcher.observe(element));
    window.addEventListener("resize", measure);
    measure();
    return () => {
      watcher.disconnect();
      observer.current = undefined;
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  /** Stable per-pane ref callback, so React does not detach and reattach it on every render. */
  const register = useCallback(
    (id: string) => {
      let callback = callbacks.current.get(id);
      if (!callback) {
        callback = (element) => {
          const previous = slots.current.get(id);
          if (previous) observer.current?.unobserve(previous);
          if (element) {
            slots.current.set(id, element);
            observer.current?.observe(element);
          } else slots.current.delete(id);
          measure();
        };
        callbacks.current.set(id, callback);
      }
      return callback;
    },
    [measure],
  );

  return { area, rects, register, measure };
}
