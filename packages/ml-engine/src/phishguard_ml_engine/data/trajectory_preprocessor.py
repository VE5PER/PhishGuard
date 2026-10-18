from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np


@dataclass(frozen=True)
class PreparedTrajectory:
    tensor: np.ndarray
    valid_point_count: int
    duration_ms: float
    available: bool
    invalid_reason: str | None


def prepare_trajectory(points: Sequence[Mapping[str, Any]], target_length: int = 128) -> PreparedTrajectory:
    if target_length < 1:
        raise ValueError("target_length must be positive")
    empty = np.zeros((target_length, 6), dtype=np.float32)

    def unavailable(reason: str) -> PreparedTrajectory:
        return PreparedTrajectory(empty, 0, 0.0, False, reason)

    unique: list[tuple[float, float, float]] = []
    for point in points[-128:]:
        try:
            x, y, timestamp = (float(point[key]) for key in ("x", "y", "timestamp"))
        except (KeyError, TypeError, ValueError):
            return unavailable("invalid_point")
        if not np.isfinite([x, y, timestamp]).all() or not 0 <= x <= 1 or not 0 <= y <= 1 or timestamp < 0:
            return unavailable("invalid_point")
        if unique and timestamp < unique[-1][2]:
            return unavailable("backward_timestamp")
        if unique and timestamp == unique[-1][2]:
            unique[-1] = (x, y, timestamp)
        else:
            unique.append((x, y, timestamp))
    if not unique:
        return unavailable("empty")
    features = np.zeros((len(unique), 6), dtype=np.float32)
    motion = 0.0
    for index, (x, y, timestamp) in enumerate(unique):
        dx = x - unique[index - 1][0] if index else 0.0
        dy = y - unique[index - 1][1] if index else 0.0
        distance = float(np.hypot(dx, dy))
        velocity = distance / (timestamp - unique[index - 1][2]) if index else 0.0
        features[index] = (x, y, dx, dy, velocity, np.arctan2(dy, dx) if distance > 0 else 0.0)
        motion += distance
    if not np.isfinite(features).all():
        return unavailable("invalid_kinematics")
    tensor = np.empty_like(empty)
    positions = np.linspace(0, len(unique) - 1, target_length)
    for channel in range(6):
        tensor[:, channel] = np.interp(positions, np.arange(len(unique)), features[:, channel])
    duration = unique[-1][2] - unique[0][2]
    available = len(unique) >= 16 and duration >= 100 and motion > 0
    reason = None if available else "stationary" if motion == 0 else "insufficient_coverage"
    return PreparedTrajectory(tensor, len(unique), duration, available, reason)
