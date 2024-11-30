import { THEMES } from '../../utils/constants'

export const getThemeData = (themeDefinition: any) => {
  const { colors, tokenColors, ...rest } = themeDefinition

  const themeData: any = {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors,
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
        data: getThemeData(themeDefinitions.default),
      }
    })
  )
}
