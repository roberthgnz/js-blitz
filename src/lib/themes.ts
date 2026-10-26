import { THEMES } from '../../utils/constants'

export const getThemeData = (themeDefinition: any) => {
  const { colors, tokenColors, ...rest } = themeDefinition

  const themeData: any = {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    // A soft current-line fill reads cleaner than the boxed outline.
    colors: {
      'editor.lineHighlightBackground': '#ffffff0a',
      ...colors,
      'editor.lineHighlightBorder': '#00000000',
    },
    ...rest,
  }

  tokenColors.forEach((tokenColor: any) => {
    const rule = {
      token: Array.isArray(tokenColor.scope)
        ? tokenColor.scope.join(', ')
        : tokenColor.scope,
      ...tokenColor.settings,
    }
    themeData.rules.push(rule)
  })

  return themeData
}

export const getThemes = async () => {
  return Promise.all(
    THEMES.map(async (theme) => {
      const themeDefinitions = await import(`../../themes/${theme.key}.json`)
      return {
        name: theme.key,
        label: theme.label,
        data: getThemeData(themeDefinitions.default),
      }
    })
  )
}

/** Hand-picked accents read better as UI chrome than the themes' button colors. */
const ACCENTS: Record<string, string> = {
  'ayu-dark': '#e6b450',
  dracula: '#bd93f9',
  'github-dark': '#79b8ff',
  'monokai-classic': '#a6e22e',
  'night-owl': '#82aaff',
  noctis: '#40d4e7',
}

function luminance(hex: string) {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(0, 6)
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(full.slice(i, i + 2), 16) / 255
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export type UiPalette = Record<`--ui-${string}`, string>

/** Base colors for the app chrome; every other surface is derived in CSS. */
export function getUiPalette(
  name: string,
  colors: Record<string, string | undefined>
): UiPalette {
  const accent = ACCENTS[name] || colors['textLink.foreground'] || '#bd93f9'
  return {
    '--ui-bg': colors['editor.background'] || '#282a36',
    '--ui-fg': colors['editor.foreground'] || '#f8f8f2',
    '--ui-accent': accent,
    '--ui-accent-fg': luminance(accent) > 0.35 ? '#0d0e12' : '#ffffff',
    '--ui-danger':
      colors['terminal.ansiRed'] ||
      colors['editorError.foreground'] ||
      '#ff6b6b',
    '--ui-warn': colors['terminal.ansiYellow'] || '#e5c07b',
    '--ui-success': colors['terminal.ansiGreen'] || '#50fa7b',
    '--ui-info': colors['terminal.ansiCyan'] || '#8be9fd',
  }
}
