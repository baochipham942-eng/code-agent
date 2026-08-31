import host from '../../../tailwind.config.js';

export default {
  content: [new URL('./src/renderer/**/*.{ts,tsx}', import.meta.url).pathname],
  darkMode: host.darkMode,
  theme: host.theme,
  plugins: host.plugins,
};
