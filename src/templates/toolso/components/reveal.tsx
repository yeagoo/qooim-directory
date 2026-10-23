// Ported from toolso-ai-open src/components/reveal.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: no inline style (CSP) — the --reveal-* variables come from literal Tailwind arbitrary-property classes per motion preset, y offset and index; motionPreset (src/lib/motion.ts) values inlined into those classes; mode="mount" renders site-reveal-visible on the server, mode="inView" leaves it to src/ui/toolso.js; no ref/IntersectionObserver.
/**
 * 按当前站点 motion 变体入场的通用包装组件。
 *
 * 用法:
 *   <Reveal as="h1" index={0}>{title}</Reveal>
 *   <Reveal as="p"  index={1}>{desc}</Reveal>     // index 驱动错峰
 *
 * mode="mount" 挂载即播(首屏 Hero);mode="inView" 滚动进入视口才播(下方版块)。
 * 自动尊重 prefers-reduced-motion → 退化为瞬时淡入。
 */
import type { ElementType, HTMLAttributes } from "react";
import { useSite } from "../shims/site.js";
import { cn } from "../lib/utils.js";

type RevealElement = "div" | "h1" | "h2" | "h3" | "p" | "span" | "section" | "li" | "ul";

type RevealProps = {
  /** 渲染成哪个元素,默认 div */
  as?: RevealElement;
  /** 错峰序号(0,1,2…),按变体 stagger 递增延迟 */
  index?: number;
  /** 入场 y 位移基准(px),会乘以变体 distance;默认 24 */
  y?: number;
  /** mount=挂载即播;inView=进入视口才播 */
  mode?: "mount" | "inView";
} & Omit<HTMLAttributes<HTMLElement>, "style">;

// motionPreset() of toolso src/lib/motion.ts: distance × y, duration, ease (cssEase), stagger × index.
// Classes are spelled out so Tailwind can find them; values must stay literal.
const PRESET_CLASS: Record<string, string> = {
  smooth:
    "[--reveal-duration:0.9s] [--reveal-ease:cubic-bezier(0.16,1,0.3,1)] [--reveal-y:calc(var(--reveal-base)*1px)] [--reveal-delay:calc(var(--reveal-index)*0.09s)]",
  crisp:
    "[--reveal-duration:0.26s] [--reveal-ease:cubic-bezier(0.4,0,0.2,1)] [--reveal-y:calc(var(--reveal-base)*0.55px)] [--reveal-delay:calc(var(--reveal-index)*0.07s)]",
  playful:
    "[--reveal-duration:0.75s] [--reveal-ease:cubic-bezier(0.34,1.4,0.64,1)] [--reveal-y:calc(var(--reveal-base)*1.3px)] [--reveal-delay:calc(var(--reveal-index)*0.11s)]",
  minimal:
    "[--reveal-duration:0.2s] [--reveal-ease:linear] [--reveal-y:0px] [--reveal-delay:calc(var(--reveal-index)*0.04s)]",
};
const Y_CLASS: Record<number, string> = {
  16: "[--reveal-base:16]",
  20: "[--reveal-base:20]",
  24: "[--reveal-base:24]",
  28: "[--reveal-base:28]",
  36: "[--reveal-base:36]",
  48: "[--reveal-base:48]",
};
const INDEX_CLASS = [
  "[--reveal-index:0]",
  "[--reveal-index:1]",
  "[--reveal-index:2]",
  "[--reveal-index:3]",
  "[--reveal-index:4]",
  "[--reveal-index:5]",
  "[--reveal-index:6]",
  "[--reveal-index:7]",
];

export function Reveal({
  as = "div",
  index = 0,
  y = 24,
  mode = "mount",
  children,
  className,
  ...rest
}: RevealProps) {
  const motion = useSite().motion ?? "smooth";
  const Comp = as as ElementType;
  const visible = mode === "mount";

  return (
    <Comp
      className={cn(
        "site-reveal",
        PRESET_CLASS[motion] ?? PRESET_CLASS.smooth,
        Y_CLASS[y] ?? Y_CLASS[24],
        INDEX_CLASS[Math.min(Math.max(index, 0), INDEX_CLASS.length - 1)],
        visible && "site-reveal-visible",
        className,
      )}
      {...rest}
    >
      {children}
    </Comp>
  );
}
