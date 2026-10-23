// Stand-in for next/image: a native <img>. `fill` uses classes instead of next/image's inline
// style (the CSP forbids style attributes); images are served as-is, without optimization.
import type { ImgHTMLAttributes } from "react";
import { cn } from "../lib/utils.js";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> & {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  unoptimized?: boolean;
  placeholder?: string;
  blurDataURL?: string;
};
export default function Image({
  fill,
  priority,
  quality: _q,
  unoptimized: _u,
  placeholder: _ph,
  blurDataURL: _b,
  className,
  sizes: _sizes,
  ...rest
}: Props) {
  return (
    <img
      {...rest}
      className={cn(fill && "absolute inset-0 h-full w-full", className)}
      loading={priority ? "eager" : (rest.loading ?? "lazy")}
      decoding="async"
    />
  );
}
