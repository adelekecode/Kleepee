/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        kleepee: {
          bg: "#F3EDE3",
          panel: "#F7F0E6",
          surface: "#FFFCF7",
          espresso: "#352B24",
          muted: "#75685B",
          border: "#DED4C6",
          focus: "#8A704F",
          buttonHover: "#4A3A30",
          green: "#4D7C5B",
          danger: "#A44836",
          warning: "#9A6A2F",
          accent: "#496F79",
        },
      },
      boxShadow: {
        kleepee: "0 18px 45px rgba(53, 43, 36, 0.08)",
      },
    },
  },
  plugins: [],
};
