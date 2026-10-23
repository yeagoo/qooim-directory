// Stand-in for toolso's SiteProvider (src/context/site-provider.tsx).
import { context } from "../runtime.js";

export const useSite = () => context().site;
