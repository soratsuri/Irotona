// The smallest supported picker is 240px + 12px gap + 24px slider + 8px padding.
export const MIN_PALETTE_W = 284;
export const MIN_PALETTE_H = 310;

export function clampWindowAxis(pos, size, min, max) {
  if (size >= max - min) return min;
  return Math.max(min, Math.min(pos, max - size));
}

export function measurePaletteLogicalSize(topbar, container, fitHeight = false) {
  const width = Math.max(
    MIN_PALETTE_W,
    Math.ceil(topbar?.scrollWidth || 0),
    Math.ceil(container?.scrollWidth || 0),
  );
  const height = Math.max(
    fitHeight ? 0 : MIN_PALETTE_H,
    Math.ceil(
      (topbar?.getBoundingClientRect().height || 0) +
      (container?.getBoundingClientRect().height || 0),
    ),
  );
  return { width, height };
}
