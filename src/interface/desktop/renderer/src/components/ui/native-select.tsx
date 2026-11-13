import * as React from "react";
import { cn } from "../../lib/utils.js";

/** A styled native <select>: forms and the Electron smoke scripts rely on its real `.value`/options. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">): React.JSX.Element {
  return (
    <select
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-border bg-popover px-2 py-0 text-sm leading-9 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
