// Ported verbatim from toolso-ai-open src/lib/utils.ts (Apache-2.0, Copyright 2025 CoolChange.AI).
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
