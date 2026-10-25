'use client';

import { useSyncExternalStore } from 'react';
import { COLOR_THEMES, COLOR_THEME_STORAGE_KEY, DEFAULT_COLOR_THEME, normalizeColorTheme, type ColorTheme } from '../lib/color-theme';

const themeChangeEvent = 'observer-color-theme-change';

function currentTheme() {
  return normalizeColorTheme(document.documentElement.dataset.colorTheme);
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== COLOR_THEME_STORAGE_KEY && event.key !== null) return;
    document.documentElement.dataset.colorTheme = normalizeColorTheme(event.newValue);
    onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(themeChangeEvent, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(themeChangeEvent, onChange);
  };
}

function chooseTheme(theme: ColorTheme) {
  document.documentElement.dataset.colorTheme = theme;
  try {
    window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, theme);
  } catch {
    // Private/limited storage still allows switching for this page session.
  }
  window.dispatchEvent(new Event(themeChangeEvent));
}

export function ColorThemePicker() {
  const selected = useSyncExternalStore(subscribe, currentTheme, () => DEFAULT_COLOR_THEME);
  return <fieldset className="colorThemePicker">
    <legend>配色</legend>
    <div className="colorThemeOptions">
      {COLOR_THEMES.map((theme) => <button
        key={theme.id}
        type="button"
        className="colorThemeOption"
        data-color-option={theme.id}
        aria-pressed={selected === theme.id}
        onClick={() => chooseTheme(theme.id)}
      >
        <span className="colorThemeSwatch" aria-hidden="true">{selected === theme.id && <span>✓</span>}</span>
        <span>{theme.name}</span>
      </button>)}
    </div>
  </fieldset>;
}
