"""Entrena y visualiza en tiempo real un agente Q-learning para la carrera."""

from __future__ import annotations

import argparse
import os
import random
import sys
import time

import numpy as np

from race_env import OneKilometerRaceEnv


ACTION_NAMES = ("REVERSA", "ACELERAR")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Carrera lineal con Q-learning y tablero CLI.")
    parser.add_argument("--episodes", type=int, default=25, help="Episodios de entrenamiento.")
    parser.add_argument("--delay", type=float, default=0.08, help="Segundos entre actualizaciones.")
    parser.add_argument("--seed", type=int, default=7, help="Semilla reproducible.")
    return parser.parse_args()


def choose_action(q_table: np.ndarray, state: int, epsilon: float) -> int:
    if random.random() < epsilon:
        return random.randrange(2)
    return int(np.argmax(q_table[state]))


def draw_track(position: int, episode_return: float, width: int = 50) -> str:
    """Dibuja una pista de una sola línea; el coche ocupa su posición actual."""
    car_index = min(width - 1, round(position / OneKilometerRaceEnv.TRACK_LENGTH_METERS * width))
    road = ["·"] * width
    road[car_index] = "🚗" if car_index < width - 1 else "🏁"
    score = f" PUNTOS {episode_return:+5.1f} "
    scale_left, scale_right = " 0 m", "1000 m "
    padding = " " * max(1, width - len(scale_left) - len(score) - len(scale_right))
    return "\n".join(
        (
            "┌" + "─" * width + "┐",
            "│" + "".join(road) + "│",
            "│" + scale_left + padding + score + scale_right + "│",
            "└" + "─" * width + "┘",
        )
    )


def render_dashboard(
    *, episode: int, total_episodes: int, state: int, q_state: int, action: int, reward: float,
    episode_return: float, epsilon: float, q_table: np.ndarray, info: dict[str, object],
    status: str,
) -> None:
    # En una terminal interactiva se redibuja siempre el mismo tablero. No se
    # imprimen resúmenes entre episodios: el siguiente cuadro reemplaza al anterior.
    if sys.stdout.isatty():
        print("\033[2J\033[H", end="")

    print("AUTONOMOUS RALLY · Q-LEARNING")
    print("=" * 62)
    print(f"Episodio {episode:>3}/{total_episodes}  |  estado (tramo): {state}/10  |  {status}")
    print(draw_track(int(info["position_meters"]), episode_return))
    print(
        f"Coche: posición {info['position_meters']:>4} m | "
        f"velocidad {info['velocity_mps']:>3} m/paso | "
        f"restante {info['remaining_meters']:>4} m"
    )
    print(
        f"Paso {info['steps']:>2}/{OneKilometerRaceEnv.MAX_STEPS} | "
        f"acción {ACTION_NAMES[action]:<9} | recompensa {reward:+.1f} | "
        f"retorno {episode_return:+.1f}"
    )
    print(f"Exploración ε: {epsilon:.3f}")
    print("-" * 62)
    print(f"MÉTRICAS Q DEL ESTADO DE DECISIÓN (tramo {q_state}/10)")
    print(f"Q(reversa)   = {q_table[q_state, 0]:+8.3f}")
    print(f"Q(acelerar)  = {q_table[q_state, 1]:+8.3f}")
    print(f"V(s)         = {np.max(q_table[q_state]):+8.3f}")
    print("Regla: +10 al cruzar 1000 m; -1 en todo paso sin meta.", flush=True)


def main() -> None:
    args = parse_args()
    if args.episodes < 1 or args.delay < 0:
        raise ValueError("--episodes debe ser >= 1 y --delay debe ser >= 0.")

    random.seed(args.seed)
    env = OneKilometerRaceEnv()
    q_table = np.zeros((env.observation_space.n, env.action_space.n), dtype=float)
    alpha, gamma = 0.25, 0.95
    successes = 0

    for episode in range(1, args.episodes + 1):
        state, info = env.reset(seed=args.seed + episode)
        epsilon = max(0.05, 1.0 - (episode - 1) / max(1, args.episodes - 1) * 0.95)
        episode_return = 0.0
        terminated = truncated = False

        while not (terminated or truncated):
            decision_state = state
            action = choose_action(q_table, decision_state, epsilon)
            next_state, reward, terminated, truncated, info = env.step(action)
            episode_return += reward
            target = reward if (terminated or truncated) else reward + gamma * np.max(q_table[next_state])
            q_table[decision_state, action] += alpha * (target - q_table[decision_state, action])
            state = next_state
            status = "META ALCANZADA" if terminated else "TRUNCADO: 50 pasos" if truncated else "EN CARRERA"
            render_dashboard(
                episode=episode, total_episodes=args.episodes, state=state, q_state=decision_state, action=action,
                reward=reward, episode_return=episode_return, epsilon=epsilon,
                q_table=q_table, info=info, status=status,
            )
            if args.delay:
                time.sleep(args.delay)

        successes += int(terminated)
    print("ENTRENAMIENTO COMPLETADO")
    print(f"Éxitos: {successes}/{args.episodes} ({successes / args.episodes:.0%})")
    print("Política aprendida por tramo (0=reversa, 1=acelerar):")
    print(" ".join(map(str, np.argmax(q_table, axis=1))))
    env.close()


if __name__ == "__main__":
    main()
