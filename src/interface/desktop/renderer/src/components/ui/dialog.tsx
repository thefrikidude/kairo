import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "../../lib/utils.js";

const Dialog = DialogPrimitive.Root;

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

/** Centered surface; callers supply their own padded content, so it adds no chrome of its own. */
function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl text-foreground outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { Dialog, DialogContent };
