/** A conservative signal for the all-black frames returned by protected capture. */
export function isLikelyBlankFrame(pixels: Uint8ClampedArray): boolean {
  if (pixels.length < 4) return true
  let min = 255
  let max = 0
  let alphaVisible = false
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]
    if (alpha > 8) alphaVisible = true
    const luma = Math.round(
      pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722
    )
    min = Math.min(min, luma)
    max = Math.max(max, luma)
  }
  return !alphaVisible || max < 5 || (max - min < 2 && max < 20)
}
