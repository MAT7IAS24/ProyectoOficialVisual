"""Selector aditivo: v1 y v2 conservan su implementación y comportamiento originales."""
def make_env(environment_version="rally-v1", config=None, perturbation=None):
    if environment_version == "rally-v1":
        from race_env import OneKilometerRaceEnv
        return OneKilometerRaceEnv()
    if environment_version == "rally-v2":
        from race_env_v2 import RallyV2Env, DEFAULT_CONFIG
        return RallyV2Env(DEFAULT_CONFIG if config is None else config)
    if environment_version == "rally-v3":
        from race_env_v3 import RallyV3Env, DEFAULT_CONFIG
        return RallyV3Env(DEFAULT_CONFIG if config is None else config, perturbation)
    if environment_version == "rally-v4":
        from race_env_v4 import RallyV4Env, DEFAULT_CONFIG
        return RallyV4Env(DEFAULT_CONFIG if config is None else config, perturbation)
    if environment_version == "rally-v5":
        from race_env_v5 import RallyV5Env, DEFAULT_CONFIG
        return RallyV5Env(DEFAULT_CONFIG if config is None else config, perturbation)
    raise ValueError(f"Versión desconocida: {environment_version}")
