"""Arma rally-dashboard/dist/catalogo.json: cuántos modelos, episodios y pasos hay en cada experimento
y en total, de dónde sale cada número y cómo se versiona cada cosa. La pestaña "Modelos y versiones"
de la web solo dibuja este archivo.

De dónde sale cada número:
  * N1–N3 (Q-learning en tabla): los episodios están en la configuración. Los pasos se recuentan
    repitiendo el entrenamiento con las mismas semillas (es determinista y tarda segundos).
  * N4–N7 (pasos fijos): los pasos son exactos (presupuesto de cada modelo). Los episodios NO se
    contaron en su momento; se estiman dividiendo los pasos por la duración media de una carrera
    del modelo final de cada algoritmo. Van marcados como aproximados.
  * N8: episodios y pasos exactos (libro de episodios de training_v8.py).

Uso: python build_catalog.py
"""
import csv
import json
from pathlib import Path
import random
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "rally-dashboard" / "dist"
REPO = "https://github.com/MAT7IAS24/ProyectoOficialVisual"


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def count_rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        return sum(1 for _ in csv.reader(f)) - 1


def recount_n1(episodes=25, seed=7):
    """Repite el bucle de train.py (sin dibujar) y cuenta los pasos."""
    from race_env import OneKilometerRaceEnv
    random.seed(seed)
    env = OneKilometerRaceEnv()
    q = np.zeros((env.observation_space.n, env.action_space.n))
    steps = 0
    for ep in range(1, episodes + 1):
        state, _ = env.reset(seed=seed + ep)
        eps = max(0.05, 1.0 - (ep - 1) / max(1, episodes - 1) * 0.95)
        done = False
        while not done:
            a = random.randrange(2) if random.random() < eps else int(np.argmax(q[state]))
            nxt, r, term, trunc, _ = env.step(a)
            q[state, a] += 0.25 * ((r if (term or trunc) else r + 0.95 * np.max(q[nxt])) - q[state, a])
            state, done, steps = nxt, term or trunc, steps + 1
    return steps


def recount_tabular(version):
    """Repite el entrenamiento del N2 o del N3 en una carpeta temporal y cuenta las filas de transiciones."""
    steps, runs = 0, 0
    with tempfile.TemporaryDirectory() as tmp:
        if version == 2:
            import training_v2 as t
            from race_env_v2 import load_config
            cfg = load_config(ROOT / "configs" / "rally-v2.json")
            for seed in cfg["training"]["seeds"]:
                res = t.train_seed(cfg, seed, Path(tmp)); steps += count_rows(res["dataset"]); runs += 1
        else:
            import training_v3 as t
            from race_env_v3 import load_config
            cfg = load_config(ROOT / "configs" / "rally-v3.json")
            for cond in ("normal", "solo_lluvia", "clima_mixto"):
                for seed in cfg["training"]["seeds"]:
                    res = t.train_seed(cfg, seed, Path(tmp), condition=cond); steps += count_rows(res["dataset"]); runs += 1
    return steps, runs, cfg["training"]["episodes"]


def mean_steps(level, kind):
    cases = load(DIST / "modelos" / f"n{level}" / kind / "evaluation.json")["normal"]["cases"]
    return sum(c["steps"] for c in cases) / len(cases)


def estimate(level, ppo_steps, q_steps, attempts=1):
    """Episodios aproximados = pasos / duración media de una carrera del modelo final."""
    return attempts * (ppo_steps / mean_steps(level, "ppo-recomendado") + q_steps / mean_steps(level, "qlearning-mejor"))


def main():
    try:
        n1_steps = recount_n1()
    except Exception as err:                                   # el recuento es un extra: si falla, se deja sin dato
        print("N1: no se pudo recontar:", err); n1_steps = None
    out = {}
    for v in (2, 3):
        try:
            out[v] = recount_tabular(v)
        except Exception as err:
            print(f"N{v}: no se pudo recontar:", err); out[v] = (None, 3 if v == 2 else 9, 3000 if v == 2 else 4000)
    M = 1_000_000
    n7 = load(ROOT / "reports" / "rally-v7-e0b9ad006c6c410bb827baa0e4dd157e.json")
    n7_im_eps = sum(len(r["imitation"]["curve"]) for r in n7["runs"] if r.get("imitation")) * n7["config"]["training"]["imitation"]["episodes_per_round"]
    n7_im_steps = sum(r["imitation"]["env_steps"] for r in n7["runs"] if r.get("imitation"))
    n7_ppo = sum(r["manifest"]["budget"]["timesteps"] for r in n7["runs"] if r["algorithm"] == "ppo")
    n7_q = sum(r["manifest"]["budget"]["timesteps"] for r in n7["runs"] if r["algorithm"] == "qlearning")
    n7_eps = estimate(6, 3 * M, 3 * M, attempts=2) + n7_im_eps + n7_ppo / mean_steps(7, "ppo-recomendado") + n7_q / mean_steps(7, "qlearning-mejor")

    def row(**k):
        return k

    rows = [
        row(id="N1", tag="rally-v1-n1", date="28 oct", page="index.html", title="Pista de 1 km", tested="Montar el ciclo completo: entrenar, versionar datos y registrar",
            model_type="Q-learning en tabla (11 estados × 2 acciones)", models=1, episodes=25, episodes_exact=True, steps=n1_steps, steps_exact=True,
            best="100 % de vueltas", hypothesis="—"),
        row(id="N2", tag="rally-v2-n2", date="4 nov", page="v2.html", title="Velocidad, combustible y curvas", tested="Que el agente aprenda cuándo frenar",
            model_type="Q-learning en tabla (528 × 3)", models=out[2][1], episodes=out[2][2] * out[2][1], episodes_exact=True, steps=out[2][0], steps_exact=True,
            best="100 % de vueltas", hypothesis="—"),
        row(id="N3", tag="rally-v3-n3", date="4 nov", page="v3.html", title="4 carriles, rampas y lluvia", tested="Elegir carril y sobrevivir a un incidente de lluvia (2 intervenciones)",
            model_type="Q-learning en tabla (43.648 × 5)", models=out[3][1], episodes=out[3][2] * out[3][1], episodes_exact=True, steps=out[3][0], steps_exact=True,
            best="100 % (reglas: 53 %)", hypothesis="Sí"),
        row(id="N4", tag="rally-v4-n4", date="6 nov", page="v4.html", title="Física continua y red neuronal", tested="PPO contra la tabla en pistas nuevas en cada carrera",
            model_type="PPO, red 64×64 · Q-learning discretizado (720 × 15)", models=6, episodes=round(estimate(4, 3 * M, 3 * M)), episodes_exact=False, steps=6 * M, steps_exact=True,
            best="PPO 20 % (reglas: 87 %)", hypothesis="No"),
        row(id="N5", tag="rally-v5-n5", date="7 nov", page="v5.html", title="Llantas reales", tested="Física de dos ejes y llantas de Pacejka (2 intentos)",
            model_type="PPO, red 64×64 · Q-learning discretizado", models=12, episodes=round(estimate(5, 3 * M, 3 * M, attempts=2)), episodes_exact=False, steps=12 * M, steps_exact=True,
            best="PPO 10 %", hypothesis="No"),
        row(id="N6", tag="rally-v6-n6", date="8 nov", page="v6.html", title="Peso y suspensión", tested="Transferencia de peso, suspensión y pruebas de banco",
            model_type="PPO, red 64×64 · Q-learning discretizado", models=6, episodes=round(estimate(6, 3 * M, 3 * M)), episodes_exact=False, steps=6 * M, steps_exact=True,
            best="PPO 12 %", hypothesis="No (3 de 4)"),
        row(id="N7", tag="rally-v7-n7-maestro", date="11 nov", page="v7.html", title="Aprender de un maestro", tested="Mirada de piloto y, en el intento 3, imitar a las reglas antes de PPO (3 intentos)",
            model_type="PPO, red 256×256 con imitación (DAgger) · Q-learning discretizado", models=18, episodes=round(n7_eps), episodes_exact=False,
            steps=12 * M + n7_im_steps + n7_ppo + n7_q, steps_exact=True, best="PPO 80 %", hypothesis="Sí (intento 3)"),
    ]
    v8_path = DIST / "v8-results.json"
    if v8_path.exists():
        v8 = load(v8_path)
        tt, ppo, sel = v8["training_totals"], v8["summary"]["ppo"]["normal"], v8["selection"]
        rows.append(row(id="N8", tag="rally-v8-n8", date="15 nov", page="v8.html", title=v8["config"]["experiment"]["title"],
                        tested="Entrenar más y mejor: parada temprana, práctica con lluvia y ruido, libro de episodios",
                        model_type=f"PPO, red {'×'.join(map(str, v8['config']['training']['ppo']['net_arch']))} con imitación (DAgger)", models=tt["models"],
                        episodes=tt["episodes"], episodes_exact=True, steps=tt["steps"], steps_exact=True,
                        best=f"PPO {ppo['success_rate']:.0%} completas, {ppo['clean_rate']:.0%} limpias", hypothesis="Sí" if sel["accepted"] else f"No ({sum(sel['checks'].values())} de {len(sel['checks'])})"))
    totals = {"experiments": len(rows), "models": sum(r["models"] for r in rows), "episodes": sum(r["episodes"] for r in rows),
              "episodes_exact": sum(r["episodes"] for r in rows if r["episodes_exact"]), "steps": sum(r["steps"] or 0 for r in rows),
              "tags": len(rows) + 1, "planned": 12}
    catalog = {
        "experiments": rows, "totals": totals,
        "notes": {"episodes": "N1–N3 y N8: conteo exacto. N4–N7: aproximado (pasos ÷ duración media de una carrera del modelo final); en esos experimentos el entrenamiento se midió en pasos y no se guardó el número de episodios.",
                  "steps": "N1–N3: recontados repitiendo el entrenamiento con las mismas semillas. N4–N8: exactos."},
        "versioning": [
            {"what": "Código, configuración y documentación", "where": f"GitHub ({REPO})", "how": "Una rama y una etiqueta por experimento: rally-v1-n1 … rally-v8-n8. Volver a una versión: git checkout <etiqueta>"},
            {"what": "Configuración de cada experimento", "where": "configs/rally-vN.json", "how": "Cada modelo guarda el SHA-256 de la configuración con la que se entrenó"},
            {"what": "Modelos", "where": "Paquete por modelo: pesos, normalización, ONNX, manifiesto. N4–N8 publicados en esta web (modelos/nN/)", "how": "run_id único + SHA-256 de cada archivo + commit de Git + semilla, en manifest.json"},
            {"what": "Datos (pistas del examen y resultados por caso)", "where": "DVC: punteros .dvc en Git", "how": "Hash del contenido; el examen es siempre la suite rally-v7-suite-1 (30 pistas, semillas 100000–100029)"},
            {"what": "Corridas y métricas", "where": "MLflow (un experimento por nivel) e informe JSON en reports/", "how": "Un informe por corrida con su identificador; los intentos rechazados no se borran"},
            {"what": "Esta web", "where": "Vercel, publicada desde rally-dashboard/dist", "how": "Una página por experimento (index, v2 … v8) y el historial"},
        ],
        "model_types": [
            {"name": "Reglas escritas a mano", "what": "Un programa con «si pasa esto, haz aquello». No aprende.", "where": "Referencia desde el N3; maestro en N7 y N8",
             "why": "Sirve de vara de medir: si la IA no le gana a unas reglas simples, todavía no aprendió.", "limit": "Solo mira los carriles vecinos; no mejora con la práctica."},
            {"name": "Q-learning en tabla", "what": "Una tabla con una fila por situación y una columna por acción; cada casilla guarda qué tan buena resultó esa acción.", "where": "N1 a N7",
             "why": "Es el método más simple de aprendizaje por refuerzo y se puede leer la tabla entera. Perfecto para pistas pequeñas (N1–N3: 100 %).",
             "limit": "No generaliza: con física continua hay infinitas situaciones y la tabla se queda en 2–6 %."},
            {"name": "PPO con red neuronal (MLP)", "what": "Una red de 2 capas de 256 neuronas recibe los 250 sensores. Tiene dos salidas: el actor decide pedal y volante; el crítico estima cuánto falta por ganar.",
             "where": "N4 a N8 (Stable-Baselines3 + PyTorch)", "why": "Acciones continuas (cuánto girar, no solo izquierda/derecha), generaliza a pistas que nunca vio y es la referencia que pide la guía del curso.",
             "limit": "Desde cero necesita muchísima práctica: con 1 millón de pasos se quedó en 10–20 %."},
            {"name": "Imitación (DAgger) + PPO", "what": "La misma red, pero primero copia al maestro (aprendizaje supervisado) y luego practica sola con PPO.", "where": "N7 (intento 3) y N8",
             "why": "Empieza sabiendo manejar en vez de chocar al azar: pasó de 9 % a 80 % con la mitad de los pasos.", "limit": "Copiando solo se llega al nivel del maestro; para superarlo hace falta la práctica propia."},
        ],
    }
    (DIST / "catalogo.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    for r in rows:
        print(f"{r['id']}: {r['models']:>2} modelos · {r['episodes']:>7} episodios{'' if r['episodes_exact'] else ' (aprox.)'} · {r['steps']} pasos")
    print("TOTAL:", totals)


if __name__ == "__main__":
    main()
