import { clipPaletteCanvas } from "./marker-canvas.js";
import { PlaneSurface, maxPlaneChroma, WIDTH, HEIGHT } from "./lightness-plane.js";
import { hexToRgb, lin2s, linearToOklab, oklabToLinear, oklchToOklab, rgb2oklch, rgbToHex } from "./oklch.js";

const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const SHEAR_X = 0.18;
const SHEAR_Y = 0.34;
const FOCUS_RADIUS = 0.16;
const ENDPOINT_RADIUS = 8;
const EPSILON = 1e-7;
const clamp = (value) => Math.max(0, Math.min(1, value));
const inGamut = (rgb) => rgb.every((value) => value >= -EPSILON && value <= 1 + EPSILON);
const vertices = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
const vertexLightness = vertices.map((rgb) => linearToOklab(...rgb)[0]);

// Along a linear RGB cube edge or face, OKLab L increases with the free
// RGB channel. Solve for the desired L without assuming a radial gamut.
function solveChannel(L, rgb, axis) {
  let low = 0, high = Math.min(1, (L / vertexLightness[1 << axis]) ** 3);
  for (let i = 0; i < 22; i++) {
    rgb[axis] = (low + high) / 2;
    if (linearToOklab(...rgb)[0] < L) low = rgb[axis];
    else high = rgb[axis];
  }
  rgb[axis] = (low + high) / 2;
  return rgb;
}

export function gamutSection(L) {
  if (L <= 0 || L >= vertexLightness[7]) return [];
  const faces = Array.from({ length: 6 }, () => new Map());
  for (const [i, corner] of vertices.entries()) {
    for (let axis = 0; axis < 3; axis++) {
      if (corner[axis]) continue;
      const end = i | (1 << axis);
      if (L < vertexLightness[i] || L > vertexLightness[end]) continue;
      const vertex = L === vertexLightness[i] ? i : L === vertexLightness[end] ? end : null;
      const key = vertex === null ? "e" + i + "-" + axis : "v" + vertex;
      const rgb = vertex === null ? solveChannel(L, [...corner], axis) : vertices[vertex];
      for (let fixed = 0; fixed < 3; fixed++) {
        if (fixed !== axis) faces[fixed * 2 + rgb[fixed]].set(key, rgb);
      }
    }
  }

  const segments = [];
  for (const [face, hits] of faces.entries()) {
    if (hits.size !== 2) continue;
    const [[first, start], [last, end]] = hits;
    const free = [0, 1, 2].filter((axis) => axis !== Math.floor(face / 2));
    const [along, solved] = free.sort((a, b) => Math.abs(end[b] - start[b]) - Math.abs(end[a] - start[a]));
    const points = [start];
    for (let i = 1; i < 40; i++) {
      const rgb = [...start];
      rgb[along] = start[along] + (end[along] - start[along]) * i / 40;
      points.push(solveChannel(L, rgb, solved));
    }
    points.push(end);
    segments.push({ first, last, points });
  }
  if (!segments.length) return [];

  const start = segments.pop();
  let endpoint = start.last;
  const contour = [...start.points];
  while (segments.length && endpoint !== start.first) {
    const next = segments.findIndex((segment) => segment.first === endpoint || segment.last === endpoint);
    if (next < 0) break;
    const [segment] = segments.splice(next, 1);
    const forward = segment.first === endpoint;
    endpoint = forward ? segment.last : segment.first;
    contour.push(...(forward ? segment.points : segment.points.reverse()).slice(1));
  }
  return contour.map((rgb) => linearToOklab(...rgb).slice(1));
}

// A fixed working scale lets the section grow and shrink with lightness.
// Only the vertical stretch near white makes the highlight strip easier to aim at.
export function brushScale(L, contour) {
  const highlight = clamp((L - 0.82) / 0.17);
  const bent = contour.map(([a, b]) => bend(a, b));
  const sx = Math.min(475, (CENTER_X - 9) / Math.max(0.001, ...bent.map(([u]) => Math.abs(u))));
  const sy = Math.min(
    350 * (1 + 1.25 * highlight * highlight * (3 - 2 * highlight)),
    (CENTER_Y - 9) / Math.max(0.001, ...bent.map(([, v]) => Math.abs(v))),
  );
  return [sx, sy];
}

// Successive shears curve the sides without folding the color coordinates.
// The inverse simply undoes the same shears in reverse order.
function bend(a, b) {
  const u = a + SHEAR_X * b;
  const v = b + SHEAR_Y * a + 0.9 * u * Math.abs(u);
  return [u + 0.85 * v * v, v];
}

export function abToPoint(a, b, [sx, sy]) {
  const [u, v] = bend(a, b);
  return [CENTER_X + u * sx, CENTER_Y - v * sy];
}

export function pointToAb(x, y, [sx, sy]) {
  const bentV = (CENTER_Y - y) / sy;
  const u = (x - CENTER_X) / sx - 0.85 * bentV * bentV;
  const v = bentV - 0.9 * u * Math.abs(u);
  const det = 1 - SHEAR_X * SHEAR_Y;
  return [(u - SHEAR_X * v) / det, (v - SHEAR_Y * u) / det];
}

function radialColor(L, a, b) {
  const rgb = oklabToLinear(L, a, b);
  if (inGamut(rgb)) return rgb;
  const C = Math.hypot(a, b);
  const hue = Math.atan2(b, a) * 180 / Math.PI;
  const factor = Math.min(1, maxPlaneChroma(L, hue) / C);
  return oklabToLinear(L, a * factor, b * factor);
}

function contains(x, y, outline) {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, ay] = outline[i], [bx, by] = outline[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

// Resample by display-space distance, then soften sharp joins. Each rounded
// vertex is kept in gamut, and the same polygon clips the texture and input.
function roundedOutline(points, L, scale) {
  const samples = [];
  let remainder = 0;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[(i + 1) % points.length];
    const length = Math.hypot(nx - x, ny - y);
    while (remainder < length) {
      const t = remainder / length;
      samples.push([x + t * (nx - x), y + t * (ny - y)]);
      remainder += 1.6;
    }
    remainder -= length;
  }
  if (samples.length < 12) return points;
  const reach = Math.min(7, Math.floor(samples.length / 12));
  return samples.map(([x, y], i) => {
    const prev = samples[(i + samples.length - reach) % samples.length];
    const next = samples[(i + reach) % samples.length];
    const p = [(prev[0] + 2 * x + next[0]) / 4, (prev[1] + 2 * y + next[1]) / 4];
    if (inGamut(oklabToLinear(L, ...pointToAb(...p, scale)))) return p;
    // The fixed 2% inset made neighboring points snap inward by several pixels.
    // Project only as far as needed to reach a valid fixed-lightness color.
    // The neutral center is always in gamut for 0 < L < 1.
    let inside = 0;
    let outside = 1;
    for (let iteration = 0; iteration < 22; iteration++) {
      const t = (inside + outside) / 2;
      const candidate = [
        CENTER_X + (p[0] - CENTER_X) * t,
        CENTER_Y + (p[1] - CENTER_Y) * t,
      ];
      if (inGamut(oklabToLinear(L, ...pointToAb(...candidate, scale)))) inside = t;
      else outside = t;
    }
    return [CENTER_X + (p[0] - CENTER_X) * inside, CENTER_Y + (p[1] - CENTER_Y) * inside];
  });
}

function closestPoint(x, y, outline) {
  let distance = Infinity;
  let nearest = [CENTER_X, CENTER_Y];
  for (let i = 0; i < outline.length; i++) {
    const [ax, ay] = outline[i];
    const [bx, by] = outline[(i + 1) % outline.length];
    const dx = bx - ax, dy = by - ay;
    const length = dx * dx + dy * dy;
    if (!length) continue;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / length);
    const nx = ax + t * dx, ny = ay + t * dy;
    const squared = (x - nx) ** 2 + (y - ny) ** 2;
    if (squared < distance) {
      distance = squared;
      nearest = [nx, ny];
    }
  }
  return nearest;
}

export class OklabPlane extends PlaneSurface {
  constructor(canvas, overlay) {
    super(canvas, overlay);
    this.baseL = 0.6;
    this.setCurrentColor("#808080");
  }

  setReferenceColor(hex) {
    this.baseL = this.rgbToAxis(...hexToRgb(hex));
  }

  rgbToAxis(r, g, b) {
    return clamp(rgb2oklch(r, g, b)[0]);
  }

  axisRange() {
    return [
      Math.min(this.entryL, clamp(this.baseL - FOCUS_RADIUS)),
      Math.max(this.entryL, clamp(this.baseL + FOCUS_RADIUS)),
    ];
  }

  selectedAxisRange(L) {
    const [low, high] = this.axisRange();
    const ab = this.selectedAb;
    const previous = this.selectedRange;
    if (previous?.ab === ab && previous.low === low && previous.high === high &&
        L >= previous.range[0] && L <= previous.range[1]) return previous.range;

    // Search outward from the actual color, not from either gamut extreme:
    // the connected interval must include the current lightness. Keep a
    // small numeric tolerance for the RGB/OKLab round trip at gamut faces.
    const valid = (value) => oklabToLinear(value, ...ab)
      .every((channel) => channel >= -1e-6 && channel <= 1 + 1e-6);
    function boundary(limit) {
      let inside = L;
      for (let step = 1; step <= 24; step++) {
        let outside = step === 24 ? limit : L + (limit - L) * step / 24;
        if (valid(outside)) {
          inside = outside;
          continue;
        }
        for (let iteration = 0; iteration < 15; iteration++) {
          const mid = (inside + outside) / 2;
          if (valid(mid)) inside = mid;
          else outside = mid;
        }
        return inside;
      }
      return limit;
    }
    const range = Math.hypot(...ab) < 1e-6
      ? [Math.min(low, L), Math.max(high, L)]
      : [boundary(Math.min(low, L)), boundary(Math.max(high, L))];
    // Slider moves leave selectedAb unchanged, including where the existing
    // radial gamut clamp absorbs tiny rounding differences at the boundary.
    this.selectedRange = { ab, low, high, range };
    return range;
  }

  section(L) {
    if (this.slice?.L === L) return this.slice;
    if (this.previousSlice?.L === L) return this.previousSlice;
    const contour = gamutSection(L);
    const scale = brushScale(L, contour);
    const neutral = !contour.length;
    const outline = neutral
      ? Array.from({ length: 48 }, (_, i) => {
        const angle = i * Math.PI / 24;
        return [CENTER_X + ENDPOINT_RADIUS * Math.cos(angle), CENTER_Y + ENDPOINT_RADIUS * Math.sin(angle)];
      })
      : roundedOutline(contour.map(([a, b]) => abToPoint(a, b, scale)), L, scale);
    this.previousSlice = this.slice;
    this.slice = { L, scale, outline, neutral };
    return this.slice;
  }

  render(L) {
    if (this.image && this.axis === L) return;
    this.axis = L;
    const { outline, scale, neutral } = this.section(L);
    const image = this.ctx.createImageData(WIDTH, HEIGHT);
    const xs = outline.map(([x]) => x);
    const ys = outline.map(([, y]) => y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
    const x1 = Math.min(WIDTH - 1, Math.ceil(Math.max(...xs)) + 2);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const y1 = Math.min(HEIGHT - 1, Math.ceil(Math.max(...ys)) + 2);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [a, b] = neutral ? [0, 0] : pointToAb(x, y, scale);
        const [r, g, blue] = oklabToLinear(L, a, b);
        const i = (y * WIDTH + x) * 4;
        // RGB clipping is for the texture's overscan. The outline and hit
        // test admit only the actual fixed-L section of the RGB cube.
        image.data[i] = lin2s(r) * 255;
        image.data[i + 1] = lin2s(g) * 255;
        image.data[i + 2] = lin2s(blue) * 255;
        image.data[i + 3] = 255;
      }
    }
    this.image = image;
    this.ctx.putImageData(image, 0, 0);
    clipPaletteCanvas(this.canvas, outline);
    this.drawMarker();
  }

  setCurrentColor(hex, point) {
    this.hex = hex;
    if (point) {
      this.point = point;
    } else {
      const [L, C, hue] = rgb2oklch(...hexToRgb(hex));
      this.entryL = clamp(L);
      const [, a, b] = oklchToOklab(L, C, hue);
      this.selectedAb = [a, b];
      this.point = abToPoint(a, b, this.section(this.entryL).scale);
    }
    this.drawMarker();
  }

  clampPoint(x, y) {
    const { scale, outline, neutral } = this.section(this.axis);
    if (neutral) return [CENTER_X, CENTER_Y];
    if (contains(x, y, outline) && inGamut(oklabToLinear(this.axis, ...pointToAb(x, y, scale)))) {
      return [x, y];
    }
    const [ex, ey] = closestPoint(x, y, outline);
    // Step a fraction of a pixel inside the visible edge. Near a curved
    // gamut face, check the inverse rather than accepting RGB clipping.
    for (const factor of [0.999, 0.995, 0.98, 0.94]) {
      const p = [CENTER_X + (ex - CENTER_X) * factor, CENTER_Y + (ey - CENTER_Y) * factor];
      if (contains(...p, outline) && inGamut(oklabToLinear(this.axis, ...pointToAb(...p, scale)))) return p;
    }
    return [CENTER_X, CENTER_Y];
  }

  pointAtAxis() {
    return this.point;
  }

  colorAtAxis(L) {
    const [a, b] = this.selectedAb;
    return rgbToHex(...radialColor(L, a, b).map((v) => clamp(lin2s(v))));
  }

  pickAt(x, y) {
    const { scale, outline, neutral } = this.section(this.axis);
    if (!contains(x, y, outline)) return null;
    const [a, b] = neutral ? [0, 0] : pointToAb(x, y, scale);
    const rgb = oklabToLinear(this.axis, a, b);
    if (!inGamut(rgb)) return null;
    this.selectedAb = [a, b];
    this.point = neutral ? [CENTER_X, CENTER_Y] : [x, y];
    return rgbToHex(...rgb.map((v) => clamp(lin2s(v))));
  }

  adjustPoint(hueDelta, chromaDelta) {
    const [a, b] = this.selectedAb;
    const angle = Math.atan2(b, a) + hueDelta * Math.PI / 180;
    const C = Math.max(0, Math.hypot(a, b) + chromaDelta * 0.25);
    return this.clampPoint(...abToPoint(C * Math.cos(angle), C * Math.sin(angle), this.section(this.axis).scale));
  }
}
