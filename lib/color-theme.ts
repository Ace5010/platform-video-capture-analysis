export const COLOR_THEME_STORAGE_KEY = 'observer.color-theme.v1';

export const COLOR_THEMES = [
  { id: 'bay', name: '海湾流光' },
  { id: 'spectrum', name: '暮色光谱' },
  { id: 'sunset', name: '日落折光' },
] as const;

export type ColorTheme = typeof COLOR_THEMES[number]['id'];
export const DEFAULT_COLOR_THEME: ColorTheme = 'bay';

export function normalizeColorTheme(value: unknown): ColorTheme {
  return COLOR_THEMES.some((theme) => theme.id === value) ? value as ColorTheme : DEFAULT_COLOR_THEME;
}

// Apply before first paint. Only this browser's appearance preference is stored.
export const COLOR_THEME_INIT_SCRIPT = `(()=>{let theme=${JSON.stringify(DEFAULT_COLOR_THEME)};try{const saved=localStorage.getItem(${JSON.stringify(COLOR_THEME_STORAGE_KEY)});if(${JSON.stringify(COLOR_THEMES.map((theme) => theme.id))}.includes(saved))theme=saved;}catch{}document.documentElement.dataset.colorTheme=theme;})();`;
