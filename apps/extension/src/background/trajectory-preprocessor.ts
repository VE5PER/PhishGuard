import type { PointerEventPoint } from '@phishguard/types';

export interface PreparedTrajectory {
  tensor: Float32Array;
  validPointCount: number;
  durationMs: number;
  available: boolean;
  invalidReason: string | null;
}

export function prepareTrajectory(points: readonly PointerEventPoint[], targetLength = 128): PreparedTrajectory {
  if (!Number.isInteger(targetLength) || targetLength < 1) throw new Error('targetLength must be positive');
  const tensor = new Float32Array(targetLength * 6);
  const unavailable = (reason: string): PreparedTrajectory => ({
    tensor, validPointCount: 0, durationMs: 0, available: false, invalidReason: reason,
  });
  const recent = points.slice(-128);
  const unique: PointerEventPoint[] = [];
  for (const point of recent) {
    if (![point.x, point.y, point.timestamp].every(Number.isFinite) ||
        point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || point.timestamp < 0) {
      return unavailable('invalid_point');
    }
    const previous = unique.at(-1);
    if (previous && point.timestamp < previous.timestamp) return unavailable('backward_timestamp');
    if (previous && point.timestamp === previous.timestamp) unique[unique.length - 1] = point;
    else unique.push(point);
  }
  if (!unique.length) return unavailable('empty');
  const features = new Float32Array(unique.length * 6);
  let motion = 0;
  for (let i = 0; i < unique.length; i++) {
    const current = unique[i];
    const previous = unique[i - 1];
    const dx = previous ? current.x - previous.x : 0;
    const dy = previous ? current.y - previous.y : 0;
    const distance = Math.hypot(dx, dy);
    const velocity = previous ? distance / (current.timestamp - previous.timestamp) : 0;
    features.set([current.x, current.y, dx, dy, velocity, distance > 0 ? Math.atan2(dy, dx) : 0], i * 6);
    motion += distance;
  }
  if (!features.every(Number.isFinite)) return unavailable('invalid_kinematics');
  for (let i = 0; i < targetLength; i++) {
    const position = targetLength > 1 ? i * (unique.length - 1) / (targetLength - 1) : 0;
    const left = Math.floor(position);
    const right = Math.min(left + 1, unique.length - 1);
    const fraction = position - left;
    for (let channel = 0; channel < 6; channel++) {
      const a = features[left * 6 + channel];
      tensor[i * 6 + channel] = a + fraction * (features[right * 6 + channel] - a);
    }
  }
  const durationMs = unique.at(-1)!.timestamp - unique[0].timestamp;
  const available = unique.length >= 16 && durationMs >= 100 && motion > 0;
  return {
    tensor, validPointCount: unique.length, durationMs, available,
    invalidReason: available ? null : motion === 0 ? 'stationary' : 'insufficient_coverage',
  };
}
