// Runs before first paint (loaded synchronously in <head>): apply the saved or system color
// scheme so dark mode does not flash. Mirrors next-themes with attribute="class".
try {
  const saved = localStorage.getItem("theme");
  const dark =
    saved === "dark" ||
    ((saved === null || saved === "system") &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
} catch {}
