// Ported from toolso-ai-open src/features/tools/components/cover-lightbox.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: the overlay is a native <dialog> opened/closed by the data-lightbox-open / data-lightbox-close hooks of /assets/toolso.js (showModal gives Esc, focus trap and inert background) instead of a React portal with hand-written focus/scroll handling; a transparent backdrop button keeps "click outside closes".
import { ExternalLink, X } from "lucide-react";
import Image from "../../shims/next-image.js";
import { useId } from "../../shims/react-hooks.js";

interface Props {
  src: string;
  alt: string;
  websiteUrl: string | null;
  domain: string | null;
  closeLabel: string;
  fit?: "cover" | "contain";
  aspect?: "theme" | "banner";
}

export function CoverLightbox({ src, alt, websiteUrl, domain, closeLabel, fit = "cover", aspect }: Props) {
  const dialogId = `cover-lightbox-${useId()}`;
  return (
    <>
      <button
        type="button"
        data-testid="cover-lightbox-trigger"
        data-lightbox-open={dialogId}
        aria-haspopup="dialog"
        className={`block w-full relative ${aspect === "banner" ? "aspect-[1544/500]" : aspect === "theme" ? "aspect-[4/3] max-h-[600px]" : "aspect-[16/9]"} rounded-2xl overflow-hidden border border-border group bg-secondary`}
      >
        <Image
          src={src}
          alt={alt}
          fill
          priority
          className={fit === "contain" ? "object-contain" : "object-cover group-hover:scale-[1.02] transition-transform duration-500"}
        />
        {websiteUrl && domain && (
          <div className="absolute inset-0 flex items-end justify-end p-4 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-t from-black/60 via-transparent to-transparent">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 text-black text-xs font-semibold backdrop-blur">
              <ExternalLink className="h-3 w-3" />
              {domain}
            </span>
          </div>
        )}
      </button>

      {/* 原生 <dialog>:showModal 进入顶层(top layer),不受祖先 transform 影响;!m-0 抵消父容器 space-y 的 margin。 */}
      <dialog
        id={dialogId}
        aria-label={alt}
        className="fixed inset-0 z-[100] !m-0 h-full max-h-none w-full max-w-none items-center justify-center bg-black/85 p-4 backdrop-blur-sm open:flex md:p-12 backdrop:bg-transparent"
      >
        <button
          type="button"
          data-lightbox-close
          tabIndex={-1}
          aria-hidden
          className="absolute inset-0 h-full w-full cursor-default"
        />
        <button
          type="button"
          data-lightbox-close
          className="absolute top-4 right-4 z-10 h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          aria-label={closeLabel}
        >
          <X className="h-5 w-5" />
        </button>
        <div className="relative w-full max-w-6xl aspect-[16/9]">
          <Image
            src={src}
            alt={alt}
            fill
            className="object-contain rounded-xl"
          />
        </div>
      </dialog>
    </>
  );
}
