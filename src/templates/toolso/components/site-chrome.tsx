// Navbar + footer around page content, as toolso's src/app/[locale]/(marketing)/layout.tsx
// placed <NavBarShell /> and <Footer /> (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: no
// <main> wrapper here — each page renders its own <main>, so nav and footer stay outside it;
// the upperstory/nexablocks compare tray is dropped.
import type { ReactNode } from "react";
import { NavBarShell } from "./navigation/navbar-shell.js";
import { Footer } from "./footer.js";

export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <NavBarShell />
      {children}
      <Footer />
    </>
  );
}
