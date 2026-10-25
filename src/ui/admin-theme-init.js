// Runs synchronously in <head> so the saved admin theme applies before first
// paint (admin.js is a deferred module and would otherwise flash the system theme).
try {
  const choice = localStorage.getItem("admin-theme");
  if (choice === "light" || choice === "dark")
    document.documentElement.dataset.theme = choice;
} catch {
  // Storage unavailable: follow the system theme.
}
