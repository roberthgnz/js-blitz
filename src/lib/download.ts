const DEFAULT_FILENAME = 'main'
const DEFAULT_EXTENSION = 'ts'

export async function downloadCode(input: string) {
  const filename = `${DEFAULT_FILENAME}.${DEFAULT_EXTENSION}`
  const blob = new Blob([input], { type: 'text/plain' })
  return createDownloadURL({ blob, filename })
}

function createDownloadURL({
  blob,
  filename,
}: {
  blob: Blob
  filename: string
}) {
  const element = window.document.createElement('a')
  element.href = window.URL.createObjectURL(blob)
  element.download = filename
  element.click()
  element.remove()
}
