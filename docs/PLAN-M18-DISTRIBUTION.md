# M18 plan: site personas and multi-site distribution

Status: implemented in M18 (2026-10-25); see docs/ACCEPTANCE-M18-20261025.md. Planned 2026-10-24 and revised after Codex review. Base: main with M17 (admin redesign, toolso default) merged.

## Decisions confirmed by QooIM

| # | Question | Decision |
|---|---|---|
| Q1 | How AI drafts go live | Auto-publish when the similarity and format checks pass; failures stay as drafts for review |
| Q2 | Duplicate detection | Local shingle similarity first; embeddings re-check only near the threshold |
| Q3 | Canonical | Every site is its own canonical; an operator may pin one site as the primary for a resource |
| Q4 | Source updates (A1) | Mark affected publications "source updated"; a one-click rewrite creates drafts |
| Q5 | AI budget | Reuse each target site's existing monthly AI budget; over-budget sites are skipped with a notice |
| Q6 | Scheduled publish (B5) | A publish time per draft, plus an optional "stagger randomly over N days" when distributing |

## Scope

1. **Site persona** (new). Each site gets a persona: positioning, audience, tone, focus points (multi), section structure, banned/required terms, length (short/medium/long), up to 2 example passages, default locale. Three presets (technical, beginner, review). Edits are audited. The persona is passed to the model as data inside the user content, never in the system prompt, and stays subject to the existing "do not invent facts" rules.
2. **Distribution** (item 1). From a shared-library resource: choose target sites (or all) and locales, then a stagger window. This creates one distribution with one task per (site, locale).
3. **AI per-site rewrite** (item 2). A new AI kind `distribute` writes title, description, tagline and content from the resource facts plus the target persona. Its output is a draft through the existing `stage` path, with overrides.
4. **Duplicate check** (A2). Each task's output is compared with the same resource's other publications and drafts in the same locale. Above the threshold (with an embedding re-check in the grey zone), the task is retried once with a "differentiate" instruction; if it still fails, it is held for review.
5. **Queue and progress** (A3). Tasks run in the existing AI worker. States: queued → generating → checking → scheduled/published | review | failed | skipped(budget). There is a progress panel with retry and cancel.
6. **Source-updated sync** (A1). When `resource.version` > `publication.source_version`, the publication is flagged in the cross-site view and site lists; "rewrite" creates a new distribution for the flagged pairs.
7. **Scheduled publish** (B5). A `publish_at` on drafts; a worker job publishes due drafts through the normal `publish()` path, with version checks, and records misses.
8. **Cross-site overview** (B6). Per resource, a status matrix of sites × locales. Per site, a "popular resources missing here" list.
9. **Bulk unpublish/recategorize** (B7). Unpublish a resource everywhere, or map categories across chosen sites. A link-check failure surfaces a "take down everywhere" prompt.
10. **Section templates** (B8). These are the persona's structure field; no separate feature.

Out of scope: auto-distribution rules (A4), new locales beyond zh/en, multi-site submissions, analytics.

## Data model (migration 020)

- `site_persona(site_id PK, data jsonb, version, updated_at, updated_by)`
- `distribution(id, resource_id, created_by, created_at, stagger_days, status)`
- `distribution_task(id, distribution_id, site_id, locale, state, ai_job_id, similarity, publish_at, error, attempts, updated_at)`, unique on (distribution_id, site_id, locale)
- `content_draft.publish_at timestamptz NULL`
- `publication.primary_site boolean` (Q3 pin)
- Optional `content_embedding(site_id, resource_id, locale, model, vector real[])`. This is only filled when an embedding model is configured; otherwise the grey zone goes to review.

## Safety and limits

- Only operators with access to every target site may distribute; tasks are site-scoped.
- At most 50 sites × 2 locales per distribution, and at most 1 running distribution per resource.
- Auto-publish (Q1) also requires that the format validation passes and the facts are unchanged: the URL and name in the output must match the resource.
- The budget is checked per task at admission (Q5).
- Every state change is audited, and the operation ids are idempotent.

## Delivery

Branch `m18-distribution`: migration and persona API/UI → `distribute` AI kind → tasks and worker → similarity → schedule → overview and bulk actions. Tests go in `tests/p17/`; then Codex review, regression and preview. App code changes, so the image evidence must be regenerated as pending and QooIM must re-sign.

## Revisions after Codex review (2026-10-24)

- **Scheduled publish:** a dedicated `scheduled_publish` row (operation id, expected versions, state, attempts, claimed_until, error); worker `publishDue()` with `FOR UPDATE SKIP LOCKED`, system actor audit; `stage/publish/unpublish` clear the schedule; UTC, 24h late grace, then `missed`.
- **Budget:** atomic per-site token reservation at admission (ledger included in monthly usage, released on completion, covers the differentiate retry); `budget_exceeded` → terminal `skipped`.
- **Authorization:** creating new pairs is network-admin-only; grants rechecked at stage/publish; multi-site check inside the transaction; matrix filtered to accessible sites; unpublish-everywhere is all-or-nothing.
- **Auto-publish gates:** fixed `distribute` system prompt; strict persona schema (field caps, no URLs/control chars), persona JSON-escaped as data; deterministic banned/required/length checks; reject new URLs, numbers, prices, emails, raw HTML/H1/images, first-hand-testing claims; `task.source_version` must equal the current resource version; visibility preflight (site, module, locale, translation, AI enabled). Long content that fails any check → review.
- **Migration 020:** add `distribute` to the ai_job/ai_prompt kind constraints; `distribution_task.ai_job_id` uses `ON DELETE SET NULL`; `distribute` is not exposed through the generic `POST /ai/jobs`.
- **Duplicates:** compare the materialized title/description/SEO/tagline/content against the source master and committed outputs; character n-grams for Chinese; resource-level advisory lock; persist hash, similarity, persona and prompt versions. **Embeddings cut:** the grey zone goes to review (allowed by Q2; can be added later).
- **Candidate construction:** reuse the existing slug, category, rank and tags; new pairs default slug = resource id, and a collision goes to review; never overwrite a manual draft (it goes to review); AI cannot override url/image/logo.
- **Source updated:** stats-only changes do not flag; `source_version = 0` counts as unknown.
- **Primary pin:** `resource.primary_site_id`, operational only; canonical and hreflang are unchanged.
- **Persona:** the snapshot and version are stored on each task; "structure" limits only the H2/H3 order inside content.
- **SEO:** a stricter uniqueness margin across sites, example passages included in the duplicate corpus, and SEO length checks.
- **Cut/deferred:** popular-missing becomes curated rank/recent; the link-check prompt and bulk recategorize are deferred; audit logs only meaningful events, not every state change.

## Added: manual (copy/paste) AI mode

Zero API cost and no budget. For one resource × site × locale, or for distribute tasks set to "manual":
1. The admin shows the exact prompt (the same builder as `distribute`/`enrich`, with persona and facts) and a copy button.
2. The operator runs it in web ChatGPT/DeepSeek and pastes the JSON reply back.
3. The server parses it leniently: strip code fences and extract the first JSON object. It then validates with the same schema and the same auto-publish gates. The output becomes a draft; a manual paste is never auto-published, and the preview is shown before staging.
4. The audit records `source: manual`; the duplicate check still runs.
