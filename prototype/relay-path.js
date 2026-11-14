// Centerline shared by the offline chrome tubes and the live handoff indicator.
// The camera faces -Z. Index 0 is the brass rail at the bottom of the image.
function relayPoint(u, index, time = 0) {
  const bend = Math.max(0, Math.min(1, (u - .19 - .06 * index) / .49));
  const ease = bend * bend * (3 - 2 * bend);
  const curve = Math.sin((u + .10) * 2 * Math.PI + .09 * Math.sin(time));
  return [
    -1.67 + 3.27 * u,
    (index - 1) * (.155 + .36 * ease) + .14 * curve * (.5 + .5 * ease),
    .09 * Math.sin(u * Math.PI + index * .46)
  ];
}
