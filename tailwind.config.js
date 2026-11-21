/** @type {import('tailwindcss').Config} */
// Colours and fonts come from src/styles/tokens.ts — never add hex values here.
import { fonts, palette, safety } from './src/styles/tokens.ts';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { ...palette, safety },
      fontFamily: { display: [...fonts.display], body: [...fonts.body] },
      borderRadius: { blob: '1.25rem' },
      boxShadow: { soft: '0 6px 20px -8px rgba(59, 42, 32, 0.35)' },
    },
  },
  plugins: [],
};
