import React from "react";
import { Dialog, DialogContent } from "./components/ui/dialog.js";

export function ModalFrame({
  labelledBy,
  blocked,
  onDismiss,
  children,
}: {
  labelledBy: string;
  blocked: boolean;
  onDismiss(): void;
  children: React.ReactNode;
}): React.JSX.Element {
  // Radix handles focus trapping and restoring focus to the opener; `blocked` pins the dialog open.
  return (
    <Dialog open onOpenChange={(open) => !open && !blocked && onDismiss()}>
      <DialogContent
        className="modal-host"
        aria-labelledby={labelledBy}
        aria-describedby={undefined}
        aria-busy={blocked}
        onEscapeKeyDown={(event) => blocked && event.preventDefault()}
        onInteractOutside={(event) => blocked && event.preventDefault()}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function KairoLogo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={`kairo-logo ${className ?? ""}`}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M18 4 6 16l6 6M14 28l12-12-6-6"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type IconName =
  | "plus"
  | "check"
  | "trash"
  | "folder"
  | "pin"
  | "archive"
  | "settings"
  | "sidebar"
  | "panel"
  | "close"
  | "refresh"
  | "arrow"
  | "stop"
  | "chevron";
export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}): React.JSX.Element {
  const paths: Record<IconName, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" />
      </>
    ),
    folder: <path d="M3 7V5h6l2 2h10v12H3Z" />,
    pin: (
      <>
        <path d="m16 3 5 5-4 1-3 5-4-4 5-3 1-4Z" />
        <path d="m2 22 8-8" />
      </>
    ),
    archive: (
      <>
        <path d="M3 4h18v4H3z" />
        <path d="M5 8v12h14V8M10 12h4" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="2" />
        <circle cx="15" cy="17" r="2" />
      </>
    ),
    sidebar: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15" />
      </>
    ),
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" />,
    chevron: <path d="m6 9 6 6 6-6" />,
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
