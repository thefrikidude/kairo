import * as React from "react";
import { cn } from "../../lib/utils.js";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">): React.JSX.Element {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-none border-0 bg-transparent p-0 shadow-none text-[15px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
