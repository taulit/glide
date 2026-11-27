import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// Served by GitHub Pages at https://taulit.github.io/glide/.
export default defineConfig({
  site: 'https://taulit.github.io',
  base: '/glide',
  trailingSlash: 'always',
  integrations: [sitemap()],
});
