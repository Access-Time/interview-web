"use client";

import { cn } from "@interview-web/ui/lib/utils";
import type * as React from "react";

function Label({
  className,
  htmlFor,
  children,
  ...props
}: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "flex select-none items-center gap-2 text-xs leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        className
      )}
      data-slot="label"
      {...props}
      htmlFor={htmlFor}
    >
      {children}
    </label>
  );
}

export { Label };
