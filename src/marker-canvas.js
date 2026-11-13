// Keep pointer coordinates and the color texture in their logical space.
// Only the transparent marker backing store follows the display pixel grid.
export function resizeMarkerCanvas(surface, marker, context, dpr = 1) {
  if (!marker || !surface.clientWidth || !surface.clientHeight) return false;
  const width = Math.max(1, Math.round(surface.clientWidth * dpr));
  const height = Math.max(1, Math.round(surface.clientHeight * dpr));
  if (marker.width === width && marker.height === height) return false;
  marker.width = width;
  marker.height = height;
  context.setTransform(width / surface.width, 0, 0, height / surface.height, 0, 0);
  return true;
}

export function clipPaletteCanvas(canvas, points) {
  if (!canvas.style) return;
  canvas.style.clipPath = "polygon(" + points.map(([x, y]) =>
    (100 * x / canvas.width).toFixed(4) + "% " + (100 * y / canvas.height).toFixed(4) + "%",
  ).join(", ") + ")";
}
