// Stand-in for next-themes. The theme class is applied before paint by /assets/toolso-init.js
// and toggled by /assets/toolso.js; the server always renders the light markup.
export const useTheme = () => ({
  theme: "system" as string | undefined,
  resolvedTheme: "light" as string | undefined,
  setTheme: (_theme: string) => {},
});
