"""Selector aditivo: v1 conserva su implementación y comportamiento originales."""
def make_env(environment_version="rally-v1", config=None):
    if environment_version == "rally-v1":
        from race_env import OneKilometerRaceEnv
        return OneKilometerRaceEnv()
    if environment_version == "rally-v2":
        from race_env_v2 import RallyV2Env, DEFAULT_CONFIG
        return RallyV2Env(DEFAULT_CONFIG if config is None else config)
    raise ValueError(f"Versión desconocida: {environment_version}")
