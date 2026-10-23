// Ported from toolso-ai-open src/components/button.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: import paths and type-only React imports.
import type { ElementType, FC, ReactNode } from "react";
import { cn } from "../lib/utils.js";

export const Button: FC<{
  children?: ReactNode;
  className?: string;
  variant?: "simple" | "outline" | "primary";
  size?: "sm" | "md" | "lg";
  as?: ElementType;
  [x: string]: unknown;
}> = ({
  children,
  className,
  variant = "primary",
  size = "md",
  as: Tag = "button",
  ...props
}) => {
  const sizeClass =
    size === "sm"
      ? "text-xs px-3.5 h-8"
      : size === "lg"
      ? "text-base px-7 h-[3.25rem]"
      : "text-sm px-5 h-10";

  // 共享手感:按压回缩 + expo 缓动 + 键盘焦点环
  const base =
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border font-medium transition-[background-color,color,border-color,box-shadow,transform] duration-300 ease-expo active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

  const variantClass =
    variant === "simple"
      ? "border-transparent bg-transparent text-foreground hover:bg-hover hover:text-hover-foreground"
      : variant === "outline"
      ? "border-border bg-background text-foreground hover:border-foreground hover:bg-foreground hover:text-background"
      : variant === "primary"
      ? "border-transparent bg-primary text-primary-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.22),0_1px_2px_hsl(var(--shadow-ink)/0.2),0_8px_20px_-8px_hsl(var(--primary)/0.55)] hover:-translate-y-px hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_2px_4px_hsl(var(--shadow-ink)/0.2),0_14px_28px_-10px_hsl(var(--primary)/0.7)]"
      : "";
  return (
    <Tag
      className={cn(
        "relative z-10",
        base,
        variantClass,
        sizeClass,
        className
      )}
      {...props}
    >
      {children ?? `Get Started`}
    </Tag>
  );
};
