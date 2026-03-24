import QRCode from 'qrcode'

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

/** Generate a QR code with the EstimAI logo centred inside it.
 *  Uses error-correction level H so the logo occlusion doesn't break scanning. */
export async function generateQrWithLogo(
  url: string,
  { size, dark, light }: { size: number; dark: string; light: string },
): Promise<string> {
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: size,
    margin: 1,
    color: { dark, light },
    errorCorrectionLevel: 'H',
  })

  const [qrImg, logoImg] = await Promise.all([
    loadImage(qrDataUrl),
    loadImage('/estimai-light.svg'),
  ])

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  ctx.drawImage(qrImg, 0, 0, size, size)

  const logoSize = Math.round(size * 0.22)
  const x = Math.round((size - logoSize) / 2)
  const y = Math.round((size - logoSize) / 2)
  const pad = Math.round(logoSize * 0.15)

  // White background pad so the logo sits cleanly on the QR pattern
  ctx.fillStyle = light
  ctx.fillRect(x - pad, y - pad, logoSize + pad * 2, logoSize + pad * 2)
  ctx.drawImage(logoImg, x, y, logoSize, logoSize)

  return canvas.toDataURL('image/png')
}
