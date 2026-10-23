// Ported from toolso-ai-open src/components/background.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: the two glow layers use the bg-primary class instead of an inline style (CSP); background-client.tsx's DeferredBackground wrapper folded away.
/**
 * 页面氛围背景:发丝网格 + 品牌色光晕,纯 CSS、零 JS、零动画节点。
 * (原实现是 60 格 × 2 个无限循环的 SMIL SVG 渐变,源站渲染与客户端合成都很重。)
 * 只铺在首屏高度内并向下渐隐,避免长页面整页都是网格噪音。
 */
export const Background = () => {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[64rem] overflow-hidden">
      <div className="hairline-grid absolute inset-0 [mask-image:radial-gradient(ellipse_75%_60%_at_50%_0%,#000_30%,transparent_78%)]" />
      <div className="absolute -top-48 left-[8%] h-[34rem] w-[46rem] rounded-full bg-primary opacity-[0.16] blur-[110px] dark:opacity-[0.22]" />
      <div className="absolute -top-24 right-[-10%] h-[26rem] w-[34rem] rounded-full bg-primary opacity-[0.09] blur-[120px] dark:opacity-[0.14]" />
      <div className="absolute inset-x-0 bottom-0 h-64 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
};
