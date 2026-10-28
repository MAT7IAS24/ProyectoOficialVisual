"""Entorno Gymnasium mínimo para una vuelta de 1 km en pista cerrada."""

from __future__ import annotations

from typing import Any

import gymnasium as gym
from gymnasium import spaces


class OneKilometerRaceEnv(gym.Env[int, int]):
    """Un coche debe completar una vuelta de 1.000 m en incrementos de 100 m.

    Acciones:
        0: reversa (el coche retrocede 100 m, sin pasar la salida)
        1: acelerar (el coche avanza 100 m)

    La observación es el tramo actual, de 0 a 10. Cada paso que no termina la
    carrera cuesta un punto y cruzar la meta obtiene diez puntos. El episodio
    se trunca después de 50 pasos para distinguir límite de tiempo de éxito.
    """

    metadata = {"render_modes": ["ansi"], "render_fps": 12}

    TRACK_LENGTH_METERS = 1_000
    SEGMENT_METERS = 100
    MAX_STEPS = 50
    GOAL_REWARD = 10.0
    STEP_PENALTY = -1.0

    def __init__(self) -> None:
        super().__init__()
        self.action_space = spaces.Discrete(2)
        self.observation_space = spaces.Discrete(11)
        self.position_meters = 0
        self.velocity_mps = 0
        self.steps = 0

    def reset(
        self, *, seed: int | None = None, options: dict[str, Any] | None = None
    ) -> tuple[int, dict[str, Any]]:
        super().reset(seed=seed)
        self.position_meters = 0
        self.velocity_mps = 0
        self.steps = 0
        return self._observation(), self._info()

    def step(self, action: int) -> tuple[int, float, bool, bool, dict[str, Any]]:
        if not self.action_space.contains(action):
            raise ValueError(f"Acción inválida: {action}. Usa 0 (reversa) o 1 (acelerar).")

        self.steps += 1
        self.velocity_mps = self.SEGMENT_METERS if action == 1 else -self.SEGMENT_METERS
        self.position_meters = max(0, min(
            self.TRACK_LENGTH_METERS, self.position_meters + self.velocity_mps
        ))

        terminated = self.position_meters >= self.TRACK_LENGTH_METERS
        truncated = not terminated and self.steps >= self.MAX_STEPS
        reward = self.GOAL_REWARD if terminated else self.STEP_PENALTY
        return self._observation(), reward, terminated, truncated, self._info()

    def _observation(self) -> int:
        return self.position_meters // self.SEGMENT_METERS

    def _info(self) -> dict[str, Any]:
        return {
            "position_meters": self.position_meters,
            "velocity_mps": self.velocity_mps,
            "steps": self.steps,
            "remaining_meters": self.TRACK_LENGTH_METERS - self.position_meters,
            "progress_pct": self.position_meters / self.TRACK_LENGTH_METERS * 100,
        }
