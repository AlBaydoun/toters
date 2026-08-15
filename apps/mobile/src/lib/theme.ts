/**
 * A deliberately calm palette. Delivery apps default to loud orange/red urgency;
 * a German audience reads that as cheap. Deep green signals reliability and is
 * also legible against the food photography that dominates the grid.
 */
export const theme = {
  colors: {
    primary: "#0B7A5B",
    primaryDark: "#075C44",
    accent: "#F2A65A",
    background: "#FFFFFF",
    surface: "#F6F7F5",
    border: "#E3E6E2",
    text: "#14201B",
    textMuted: "#5F6B65",
    danger: "#C2452D",
    success: "#0B7A5B",
  },
  spacing: (n: number) => n * 8,
  radius: { sm: 8, md: 12, lg: 20 },
  type: {
    h1: { fontSize: 26, fontWeight: "700" as const },
    h2: { fontSize: 20, fontWeight: "700" as const },
    body: { fontSize: 15, fontWeight: "400" as const },
    caption: { fontSize: 13, fontWeight: "400" as const },
    price: { fontSize: 15, fontWeight: "600" as const },
  },
};
