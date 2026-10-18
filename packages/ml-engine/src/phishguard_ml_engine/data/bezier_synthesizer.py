"""Synthetic human mouse trajectory generator.

Implements cubic Bézier curve trajectory synthesis with physiological
neuromuscular tremor and kinematic parameterization (velocity, acceleration, angles).
"""

import math
import random
from typing import List, Tuple, Dict, Any


def _cubic_bezier(
    p0: Tuple[float, float],
    p1: Tuple[float, float],
    p2: Tuple[float, float],
    p3: Tuple[float, float],
    t: float,
) -> Tuple[float, float]:
    """Evaluate cubic Bézier polynomial at parameter t in [0, 1]."""
    u = 1.0 - t
    tt = t * t
    uu = u * u
    uuu = uu * u
    ttt = tt * t

    x = uuu * p0[0] + 3.0 * uu * t * p1[0] + 3.0 * u * tt * p2[0] + ttt * p3[0]
    y = uuu * p0[1] + 3.0 * uu * t * p1[1] + 3.0 * u * tt * p2[1] + ttt * p3[1]
    return (x, y)


def synthesize_human_trajectory_curve(
    start: Tuple[float, float],
    end: Tuple[float, float],
    num_steps: int = 128,
    jitter_std: float = 0.002,
    tremor_freq: float = 8.0,
    tremor_amp: float = 0.003,
    total_time_ms: float = 800.0,
) -> List[Dict[str, Any]]:
    """Synthesize human-like pointer trajectory sequence between start and end.

    Args:
        start: Normalized start coordinate (x0, y0) in [0, 1].
        end: Normalized target coordinate (x1, y1) in [0, 1].
        num_steps: Number of trajectory points to generate.
        jitter_std: Standard deviation of microscopic neuromuscular jitter.
        tremor_freq: Physiological hand tremor frequency in Hz.
        tremor_amp: Physiological hand tremor amplitude.
        total_time_ms: Total duration of movement in milliseconds.

    Returns:
        List of trajectory point dictionaries with kinematic features.
    """
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    dist = math.hypot(dx, dy)

    # Generate random control points with perpendicular deviation
    normal_x = -dy / (dist + 1e-6)
    normal_y = dx / (dist + 1e-6)

    dev1 = random.uniform(-0.15, 0.15) * dist
    dev2 = random.uniform(-0.15, 0.15) * dist

    p0 = start
    p1 = (
        start[0] + 0.33 * dx + dev1 * normal_x,
        start[1] + 0.33 * dy + dev1 * normal_y,
    )
    p2 = (
        start[0] + 0.66 * dx + dev2 * normal_x,
        start[1] + 0.66 * dy + dev2 * normal_y,
    )
    p3 = end

    points: List[Dict[str, Any]] = []
    prev_x, prev_y = p0
    prev_v = 0.0

    for i in range(num_steps):
        s = i / float(num_steps - 1) if num_steps > 1 else 0.0
        # Human velocity profile follows bell-shaped minimum-jerk model:
        # s_t = 10*s^3 - 15*s^4 + 6*s^5
        s_kinematic = 10.0 * (s**3) - 15.0 * (s**4) + 6.0 * (s**5)
        raw_x, raw_y = _cubic_bezier(p0, p1, p2, p3, s_kinematic)

        # Inject physiological tremor (sinusoidal neuromuscular oscillation + Gaussian jitter)
        current_time_sec = (s * total_time_ms) / 1000.0
        tremor_x = tremor_amp * math.sin(2.0 * math.pi * tremor_freq * current_time_sec)
        tremor_y = tremor_amp * math.cos(2.0 * math.pi * tremor_freq * current_time_sec)
        jitter_x = random.gauss(0.0, jitter_std)
        jitter_y = random.gauss(0.0, jitter_std)

        # Clip within [0, 1] viewport bounds
        curr_x = min(max(raw_x + tremor_x + jitter_x, 0.0), 1.0)
        curr_y = min(max(raw_y + tremor_y + jitter_y, 0.0), 1.0)

        dt = total_time_ms / float(num_steps) if num_steps > 0 else 1.0
        step_dx = curr_x - prev_x
        step_dy = curr_y - prev_y
        dist_step = math.hypot(step_dx, step_dy)
        velocity = dist_step / (dt + 1e-6)
        acceleration = (velocity - prev_v) / (dt + 1e-6)
        angle = math.atan2(step_dy, step_dx) if dist_step > 1e-6 else 0.0

        timestamp = s * total_time_ms
        event_type = "down" if i == num_steps - 1 else ("move" if i > 0 else "down")

        points.append({
            "x": round(curr_x, 5),
            "y": round(curr_y, 5),
            "dx": round(step_dx, 5),
            "dy": round(step_dy, 5),
            "velocity": round(velocity, 5),
            "acceleration": round(acceleration, 5),
            "angle": round(angle, 5),
            "timestamp": round(timestamp, 2),
            "eventType": event_type,
        })

        prev_x, prev_y = curr_x, curr_y
        prev_v = velocity

    return points


def generate_synthetic_trajectory(is_phishing: bool = False, num_steps: int = 128) -> List[Dict[str, Any]]:
    """Generate a synthetic mouse trajectory sample.

    Phishing interactions often exhibit hesitant / erratic micro-movements,
    higher angular jitter, and sudden pauses near credential inputs.
    """
    start = (random.uniform(0.1, 0.9), random.uniform(0.1, 0.9))
    end = (random.uniform(0.1, 0.9), random.uniform(0.1, 0.9))

    jitter = 0.006 if is_phishing else 0.002
    tremor_amp = 0.008 if is_phishing else 0.002
    total_time = random.uniform(1200.0, 2500.0) if is_phishing else random.uniform(500.0, 1000.0)

    return synthesize_human_trajectory_curve(
        start=start,
        end=end,
        num_steps=num_steps,
        jitter_std=jitter,
        tremor_amp=tremor_amp,
        total_time_ms=total_time,
    )
