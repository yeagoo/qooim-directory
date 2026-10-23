// Ported from toolso-ai-open tailwind.config.ts (Apache-2.0, Copyright 2025 CoolChange.AI).
// Changes: CommonJS, content paths point at the toolso template. See NOTICE.md.
const { default: flattenColorPalette } = require("tailwindcss/lib/util/flattenColorPalette");

const config = {
  content: [
    "./src/templates/toolso/**/*.{ts,tsx}",
    "./src/ui/toolso.js",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      transitionTimingFunction: {
        expo: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      // 主色作【文字】时走 --primary-ink:主色很亮的域(BHG 荧光绿)在浅色背景上对比度只有 ~1.5:1,
      // 这类域在 registry 里声明 accentTextHsl,浅色模式文字改用它;未声明/暗色模式回退到 --primary。
      // 只覆盖 textColor:bg-primary / border-primary / ring 仍是品牌原色。
      // 注意:带回退的嵌套 var 不支持透明度修饰(text-primary/70 不会生成);需要半透明主色文字时用 opacity 或自定义类。
      textColor: {
        primary: {
          DEFAULT: "hsl(var(--primary-ink, var(--primary)))",
          foreground: "hsl(var(--primary-foreground))",
        },
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        navbar: {
          DEFAULT: "hsl(var(--navbar-bg))",
          scrolled: "hsl(var(--navbar-bg-scrolled))",
        },
        hover: {
          DEFAULT: "hsl(var(--hover-bg))",
          foreground: "hsl(var(--hover-foreground))",
        },
      },
      animation: {
        scroll:
          "scroll var(--animation-duration, 40s) var(--animation-direction, forwards) linear infinite",
        marquee: "marquee var(--marquee-duration) linear infinite",
        "fade-in": "fade-in 0.5s linear forwards",
      },
      boxShadow: {
        // 带品牌色相的投影(单一光源自上而下);soft=静止,lift=悬浮/弹层
        soft: `0 1px 1px hsl(var(--shadow-ink) / 0.04), 0 8px 18px -10px hsl(var(--shadow-ink) / 0.12)`,
        lift: `0 1px 1px hsl(var(--shadow-ink) / 0.05), 0 14px 28px -14px hsl(var(--shadow-ink) / 0.18), 0 40px 64px -36px hsl(var(--shadow-ink) / 0.28)`,
        derek: `0px 0px 0px 1px hsl(var(--shadow-color) / 0.06),
        0px 1px 1px -0.5px hsl(var(--shadow-color) / 0.06),
        0px 3px 3px -1.5px hsl(var(--shadow-color) / 0.06),
        0px 6px 6px -3px hsl(var(--shadow-color) / 0.06),
        0px 12px 12px -6px hsl(var(--shadow-color) / 0.06),
        0px 24px 24px -12px hsl(var(--shadow-color) / 0.06)`,
        navbar: `0px -2px 0px 0px hsl(var(--shadow-color)), 0px 2px 0px 0px hsl(var(--shadow-color))`,
      },
      keyframes: {
        scroll: {
          to: {
            transform: "translate(calc(-50% - 0.5rem))",
          },
        },
        marquee: {
          "100%": {
            transform: "translateY(-50%)",
          },
        },
        "fade-in": {
          from: {
            opacity: "0",
          },
          to: {
            opacity: "1",
          },
        },
      },
    },
  },
  plugins: [addVariablesForColors, require("@tailwindcss/typography")],
};

function addVariablesForColors({ addBase, theme }) {
  const allColors = flattenColorPalette(theme("colors"));
  const newVars = Object.fromEntries(
    Object.entries(allColors).map(([key, val]) => [`--${key}`, val])
  );

  addBase({
    ":root": newVars,
  });
}

module.exports = config;
