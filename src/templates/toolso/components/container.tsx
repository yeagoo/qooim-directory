// Ported from toolso-ai-open src/components/container.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: import paths only.
import type { ReactNode } from "react";
import { cn } from "../lib/utils.js";

export const Container = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => {
  return (
    <div className={cn("mx-auto w-full max-w-7xl px-5 sm:px-8", className)}>{children}</div>
  );
};
