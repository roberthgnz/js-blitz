export const DEFAULT_TIMEOUT = 10000 as const // 10 second timeout

export const ES_IMPORT_REGEX =
  /import\s+(?:[\w*{}\s,]*\s+from\s+)?["'](.+?)["'];?/g

export const DYNAMIC_IMPORT_REGEX = /import\(["'](.+?)["']\)/g

export const REQUIRE_REGEX = /require\(["'](.+?)["']\)/g

export const THEMES = [
  {
    key: 'ayu-dark',
    label: 'Ayu Dark',
  },
  {
    key: 'dracula',
    label: 'Dracula',
  },
  {
    key: 'github-dark',
    label: 'GitHub Dark',
  },
  {
    key: 'monokai-classic',
    label: 'Monokai Classic',
  },
  {
    key: 'night-owl',
    label: 'Night Owl',
  },
  {
    key: 'noctis',
    label: 'Noctis',
  },
] as const
