export const STARTUP_SCREENS = [
  [375, 667, 2],
  [375, 812, 3],
  [414, 896, 2],
  [390, 844, 3],
  [393, 852, 3],
  [402, 874, 3],
  [428, 926, 3],
  [430, 932, 3],
  [440, 956, 3],
] as const;

export const startupImages = STARTUP_SCREENS.flatMap(([width, height, scale]) =>
  (["light", "dark"] as const).map((theme) => ({
    rel: "apple-touch-startup-image",
    href: `/launch/${width * scale}x${height * scale}-${theme}.png`,
    media: `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${scale}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`,
  })),
);
