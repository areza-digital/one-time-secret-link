// Loaded blocking in <head> so the page never flashes the wrong theme.
let theme: string | null = null;
try {
  theme = localStorage.getItem("theme");
} catch {
  theme = null;
}
if (theme !== "light" && theme !== "dark") {
  theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
document.documentElement.dataset.theme = theme;
