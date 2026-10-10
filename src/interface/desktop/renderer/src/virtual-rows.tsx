import React, { useEffect, useRef, useState } from "react";

/** Fixed-height rows keep large file lists and patches from creating repository-sized DOM trees. */
export function VirtualRows<T>({
  rows,
  rowHeight,
  className = "",
  label,
  renderRow,
  maxHeight,
  contentWidth,
  keyboard = false,
}: {
  rows: T[];
  rowHeight: number;
  className?: string;
  label: string;
  maxHeight?: number;
  contentWidth?: number;
  keyboard?: boolean;
  renderRow(row: T, index: number): React.ReactNode;
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(500);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const start = Math.max(
    0,
    Math.min(Math.floor(top / rowHeight) - 6, Math.max(0, rows.length - 1)),
  );
  const end = Math.min(rows.length, start + Math.ceil(height / rowHeight) + 12);
  return (
    <div
      ref={root}
      className={`virtual-rows ${className}`}
      tabIndex={0}
      aria-label={label}
      style={maxHeight === undefined ? undefined : { height: maxHeight, maxHeight }}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        if (!keyboard || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
        const target = event.target as HTMLElement;
        const row = target.closest<HTMLElement>("[data-virtual-index]");
        if (!row) return;
        event.preventDefault();
        const index = Math.max(
          0,
          Math.min(
            rows.length - 1,
            Number(row.dataset.virtualIndex) + (event.key === "ArrowDown" ? 1 : -1),
          ),
        );
        const node = event.currentTarget;
        const rowTop = index * rowHeight;
        if (rowTop < node.scrollTop) node.scrollTop = rowTop;
        if (rowTop + rowHeight > node.scrollTop + node.clientHeight)
          node.scrollTop = rowTop + rowHeight - node.clientHeight;
        requestAnimationFrame(() =>
          node.querySelector<HTMLButtonElement>(`[data-virtual-index="${index}"] button`)?.focus(),
        );
      }}
    >
      <div
        className="virtual-row-content"
        style={{
          minWidth: contentWidth,
          paddingTop: start * rowHeight,
          paddingBottom: Math.max(0, rows.length - end) * rowHeight,
        }}
      >
        {rows.slice(start, end).map((row, offset) => (
          <div
            className="virtual-row"
            data-virtual-index={start + offset}
            key={start + offset}
            style={{ height: rowHeight }}
          >
            {renderRow(row, start + offset)}
          </div>
        ))}
      </div>
    </div>
  );
}
