// Decorative motion follows its displayed width in CSS pixels on every surface.
function artworkPlaybackRate(width) {
  const fraction = Math.max(0, Math.min(1, (width - 48) / 820));
  return 0.76 - 0.46 * Math.sqrt(fraction);
}
