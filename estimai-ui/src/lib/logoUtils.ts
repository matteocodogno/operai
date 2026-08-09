
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load: ${src}`))
    img.src = src
  })
}

/** Rasterise an SVG (or any image) to a PNG data URL at the given pixel size. */
export async function svgToDataUrl(svgPath: string, size: number): Promise<string> {
  const img = await loadImage(svgPath)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  canvas.getContext('2d')!.drawImage(img, 0, 0, size, size)
  return canvas.toDataURL('image/png')
}
