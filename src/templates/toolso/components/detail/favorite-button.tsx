// Ported from toolso-ai-open src/features/tools/components/favorite-button.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: no client state or server action: renders Qoo.IM's `<button class="favorite" data-id>` handled by /assets/directory.js (which signs in, saves and reports in #message); always the "add" state, since favorites are per visitor and the page is shared; cordis like-count mode dropped.

import { Heart } from "lucide-react";

interface Props {
  resourceId: string;
  labelAdd: string;
}

export function FavoriteButton({ resourceId, labelAdd }: Props) {
  return (
    <button
      type="button"
      data-id={resourceId}
      aria-label={labelAdd}
      title={labelAdd}
      className="favorite inline-flex h-12 w-12 items-center justify-center gap-1.5 rounded-full border transition-all duration-300 ease-expo active:scale-90 bg-card border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 disabled:opacity-60"
    >
      <Heart className="h-5 w-5" />
    </button>
  );
}
