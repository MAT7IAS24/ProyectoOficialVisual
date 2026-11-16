"""N8: la física y los sensores son EXACTAMENTE los del N7 (race_env_v7.py). Este archivo solo deja claro
qué ambiente usa el experimento 8 y con qué configuración; lo que cambia en el N8 es cómo se entrena
(training_v8.py) y tres números de la recompensa (v8, en configs/rally-v8.json)."""
from pathlib import Path

from race_env_v7 import RallyV7Env, Track, generate_layout, load_config as _load

DEFAULT_CONFIG = Path(__file__).resolve().parent / "configs" / "rally-v8.json"


def load_config(path=DEFAULT_CONFIG, perturbation=None):
    return _load(path, perturbation)


class RallyV8Env(RallyV7Env):
    def __init__(self, config=DEFAULT_CONFIG, perturbation=None, layout_seed=None, fixed_layout=None):
        super().__init__(config, perturbation, layout_seed, fixed_layout)
