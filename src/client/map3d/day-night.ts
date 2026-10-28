/** Lighting for a local hour (0–24, fractional): how much daylight, where the sun is and what colours to use. */
export type Lighting = {
  daylight: number; // 0 night … 1 full day
  sunAzimuth: number; // radians, east (sunrise) → west (sunset)
  sunElevation: number; // radians above the horizon (kept ≥ a small angle so shadows stay sensible)
  sunColor: number; sunIntensity: number;
  skyColor: number; ambientIntensity: number;
  lampIntensity: number; // interior lights, strongest at night
};

const SUNRISE = 6; const SUNSET = 18; const TWILIGHT = 1.2;
const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
const smooth = (value: number): number => { const t = clamp(value); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number): number => {
  const channel = (shift: number): number => Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
};

const DAY_SKY = 0x9ec9f5; const DUSK_SKY = 0xf0a36b; const NIGHT_SKY = 0x0b1326;
const NOON_SUN = 0xfff4e0; const LOW_SUN = 0xffa45c;

export const lightingAt = (hour: number): Lighting => {
  const h = ((hour % 24) + 24) % 24;
  // Daylight ramps across a twilight window around sunrise and sunset.
  const daylight = smooth((h - (SUNRISE - TWILIGHT / 2)) / TWILIGHT) * (1 - smooth((h - (SUNSET - TWILIGHT / 2)) / TWILIGHT));
  const dayProgress = clamp((h - SUNRISE) / (SUNSET - SUNRISE));
  const sunHeight = Math.sin(dayProgress * Math.PI); // 0 at the horizon, 1 at noon
  const golden = daylight > 0 ? 1 - smooth(sunHeight / 0.45) : 0; // low sun → warm light and sky
  const sky = daylight >= 1 ? mix(DAY_SKY, DUSK_SKY, golden * 0.85) : mix(NIGHT_SKY, mix(DAY_SKY, DUSK_SKY, golden), daylight);
  return {
    daylight,
    sunAzimuth: -Math.PI / 2 + dayProgress * Math.PI,
    sunElevation: 0.25 + sunHeight * 0.95,
    sunColor: mix(NOON_SUN, LOW_SUN, golden),
    sunIntensity: 0.15 + daylight * 2.6,
    skyColor: sky,
    ambientIntensity: 0.55 + daylight * 1.35,
    lampIntensity: 1 - daylight * 0.85,
  };
};

/** 'auto' follows the local clock; 'day' and 'night' pin the scene to a fixed hour chosen by the viewer. */
export type TimeOfDay = 'auto' | 'day' | 'night';
const FIXED_HOUR = { day: 13, night: 21.5 } as const;
export const hourFor = (mode: TimeOfDay): number => mode === 'auto' ? currentHour() : FIXED_HOUR[mode];

/** Fractional local hour; `?hour=21.5` in the page URL previews another time of day. */
export const currentHour = (search = typeof location === 'undefined' ? '' : location.search): number => {
  const override = Number(new URLSearchParams(search).get('hour'));
  if (new URLSearchParams(search).has('hour') && Number.isFinite(override)) return ((override % 24) + 24) % 24;
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
};
