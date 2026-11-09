/* Grow Insights — the one file that brands the whole site.
   Each theme sets the company name, logo, fonts and every colour the pages and charts use.
   Add a theme here and it appears in the switcher; nothing else needs to change. */
window.GI_THEMES = {
  grow: {
    label: "Grow", company: "Grow Computer", product: "Insights", logo: "assets/brand/logo.png", mode: "light",
    fonts: { body: "'Open Sans', system-ui, sans-serif", display: "'Open Sans', system-ui, sans-serif" },
    vars: {
      bg: "#F6FAFB", surface: "#FFFFFF", surface2: "#F0F7F8", border: "#DDE5E8", borderStrong: "#BFC9CD",
      text: "#2E3438", muted: "#6D6E71", faint: "#9A9CA0",
      accent: "#2FBFFF", accent2: "#3DDBB0", accent3: "#3B8FD9", accentInk: "#0B8FC9",
      grad: "linear-gradient(120deg, #2FBFFF 0%, #3FD3D9 50%, #4DE6B8 100%)",
      gradSoft: "linear-gradient(120deg, #E6F7FF 0%, #E7FAF4 100%)",
      good: "#1FA67A", goodBg: "#E3F7EF", warn: "#D98A1C", warnBg: "#FDF2E1", bad: "#E0564B", badBg: "#FCE9E7",
      grid: "#E8EEF0", shadow: "0 1px 2px rgba(30,60,70,.05), 0 6px 24px rgba(30,60,70,.06)",
    },
    series: ["#2FBFFF", "#3DDBB0", "#3B8FD9", "#8FD8F0", "#6D6E71", "#A8E9D2", "#B9C2C6"],
    heat: ["#F0F7F8", "#2FBFFF"],
  },
  night: {
    label: "Grow Night", company: "Grow Computer", product: "Insights", logo: "assets/brand/logo.png", mode: "dark",
    fonts: { body: "'Open Sans', system-ui, sans-serif", display: "'Open Sans', system-ui, sans-serif" },
    vars: {
      bg: "#0B161D", surface: "#112029", surface2: "#152833", border: "#21363F", borderStrong: "#33505C",
      text: "#E4EEF1", muted: "#9DB0B7", faint: "#6E838B",
      accent: "#38C6FF", accent2: "#45E3B6", accent3: "#5BA6EE", accentInk: "#6FD5FF",
      grad: "linear-gradient(120deg, #2FBFFF 0%, #3FD3D9 50%, #4DE6B8 100%)",
      gradSoft: "linear-gradient(120deg, #0F2A36 0%, #0F2E29 100%)",
      good: "#45D39B", goodBg: "#0F2E25", warn: "#F0AE4A", warnBg: "#33260F", bad: "#FF7B70", badBg: "#3A1A18",
      grid: "#1B2E37", shadow: "0 1px 2px rgba(0,0,0,.3), 0 8px 28px rgba(0,0,0,.25)",
    },
    series: ["#38C6FF", "#45E3B6", "#5BA6EE", "#8FD8F0", "#9DB0B7", "#2F8F7A", "#4E6670"],
    heat: ["#152833", "#38C6FF"],
  },
  ember: {
    label: "White-label demo", company: "Ember Home", product: "Analytics", logo: null, mark: "E", mode: "light",
    fonts: { body: "'Inter', system-ui, sans-serif", display: "'Fraunces', Georgia, serif" },
    vars: {
      bg: "#FBF8F5", surface: "#FFFFFF", surface2: "#F6F0EA", border: "#EADFD5", borderStrong: "#D6C6B8",
      text: "#2B2420", muted: "#7A6A5F", faint: "#A8988C",
      accent: "#E8692F", accent2: "#2F6F6A", accent3: "#B8462A", accentInk: "#B8462A",
      grad: "linear-gradient(120deg, #E8692F 0%, #F2A65A 100%)",
      gradSoft: "linear-gradient(120deg, #FCEEE4 0%, #F5EFE6 100%)",
      good: "#2F7D5A", goodBg: "#E6F2EB", warn: "#C17A12", warnBg: "#FBF0DC", bad: "#C2412D", badBg: "#F9E5E1",
      grid: "#F0E7DF", shadow: "0 1px 2px rgba(60,40,20,.05), 0 6px 24px rgba(60,40,20,.06)",
    },
    series: ["#E8692F", "#2F6F6A", "#F2A65A", "#8FB8B2", "#7A6A5F", "#D9B99B", "#C9BDB2"],
    heat: ["#F6F0EA", "#E8692F"],
  },
};
