// Ported from toolso-ai-open src/features/tools/components/detail/faq.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes the listing's FAQ entries; imports point at the template.
import { Plus } from "lucide-react";
import type { PublicDetails } from "../../../../public/sdk.js";
import { DetailHeading, DetailMarkdown, PROSE } from "./shared.js";

/** 常见问题:原生 details 折叠列表(与 FAQPage JSON-LD 用同一份可见内容)。 */
export function DetailFaq({
  index,
  title,
  faq,
}: {
  index?: number;
  title: string;
  faq: NonNullable<PublicDetails["faqs"]>;
}) {
  return (
    <section id="section-faq" className="detail-section">
      <DetailHeading index={index}>{title}</DetailHeading>
      <div className="-mt-7">
        {faq.map((qa, i) => (
          <details
            key={i}
            className="group border-b border-border"
          >
            <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-5 text-[1.0625rem] font-medium leading-snug text-foreground transition-colors hover:text-primary [&::-webkit-details-marker]:hidden md:text-lg">
              <span className="flex-1">{qa.question}</span>
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-all duration-500 ease-expo group-open:rotate-[135deg] group-open:border-primary group-open:bg-primary group-open:text-primary-foreground">
                <Plus className="h-3.5 w-3.5" />
              </span>
            </summary>
            <div className={`pb-6 ${PROSE}`}>
              <DetailMarkdown>{qa.answer}</DetailMarkdown>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
