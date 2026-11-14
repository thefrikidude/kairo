import * as React from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "./ui/button.js";
import { Textarea } from "./ui/textarea.js";
import { cn } from "../lib/utils.js";

/**
 * The message box shared by the start screens and chats: a soft rounded card that grows with the
 * text, with controls (location, agent) in the row beneath it.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  label,
  sendLabel = "Send",
  canSend,
  autoFocus,
  leading,
  trailing,
  className,
}: {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  placeholder: string;
  label: string;
  sendLabel?: string;
  canSend: boolean;
  autoFocus?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <form
      className={cn(
        "rounded-[22px] border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.12),0_10px_30px_rgb(0_0_0/0.14)] transition-colors focus-within:border-muted-foreground/40",
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        rows={1}
        autoFocus={autoFocus}
        className="field-sizing-content max-h-56 min-h-[56px] px-5 pt-[18px] pb-1 text-[15px] leading-6"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) onSubmit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3 px-3 pb-3 pt-1">
        <div className="flex min-w-0 items-center gap-1">{leading}</div>
        <div className="flex items-center gap-1.5">
          {trailing}
          <Button
            type="submit"
            size="icon"
            className="size-8"
            aria-label={sendLabel}
            disabled={!canSend}
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </form>
  );
}
