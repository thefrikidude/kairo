import * as React from "react";
import { cn } from "../../lib/utils.js";

function Input({ className, ...props }: React.ComponentProps<"input">): React.JSX.Element {
  return (
    <input
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-border bg-popover px-3 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
