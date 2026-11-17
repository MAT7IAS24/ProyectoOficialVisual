"""Recuperar y evaluar un modelo publicado (prueba de recuperación y de rollback).

Uso:
    python recuperar_modelo.py rally-dashboard/dist/modelos/n8/ppo-recomendado            # modelo recomendado
    python recuperar_modelo.py rally-dashboard/dist/modelos/n7/ppo-recomendado --pistas 5 # modelo histórico (N7)

Qué hace, en orden:
1. Lee el manifiesto del paquete (run, versión de ambiente, commit, hashes).
2. Verifica el SHA-256 de cada archivo del paquete contra el manifiesto.
3. Carga la configuración del paquete (la del ambiente compatible: rally-v7 o rally-v8) y el modelo
   (model.zip + normalization.json).
4. Corre el modelo en las primeras N pistas del examen (semillas 100000, 100001, ...) y compara pista por pista
   con la evaluación guardada en el paquete. Como la política y las pistas son deterministas, deben coincidir.

Si todo coincide, el modelo histórico quedó recuperado tal como se entregó: así se hace un rollback
(volver a servir una versión anterior) sabiendo que es exactamente la misma.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_hashes(folder, manifest):
    rows = []
    for name, expected in manifest.get("files_sha256", {}).items():
        path = folder / name
        if not path.exists():
            rows.append((name, "no está en el paquete publicado (queda en el run de MLflow)", True))
            continue
        rows.append((name, "OK" if sha256(path) == expected else "HASH DISTINTO", sha256(path) == expected))
    return rows


def evaluate_package(folder, tracks):
    config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    version = config.get("environment_version")
    if version not in ("rally-v7", "rally-v8"):
        raise SystemExit(f"Este script recupera modelos de los ambientes rally-v7 y rally-v8 (el paquete dice {version!r}).")
    import training_v7 as T7
    import training_v8 as T8
    layouts = T7.evaluation_layouts(config, tracks)
    factory = T8.packaged_policy_factory(folder)
    # La semilla de cada carrera es la del modelo (igual que en el pipeline), para reproducir el mismo azar.
    seed = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))["seed"]
    return version, T7.evaluate(factory, config, layouts, seed=seed)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("paquete", type=Path, help="Carpeta del modelo (con manifest.json)")
    p.add_argument("--pistas", type=int, default=3, help="Cuántas pistas del examen correr (1 a 30)")
    a = p.parse_args(argv)
    folder = a.paquete if a.paquete.is_absolute() else ROOT / a.paquete
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    print(f"Modelo: {manifest['run_id']}")
    print(f"  ambiente: {manifest['environment_version']} · algoritmo: {manifest['algorithm']} · semilla: {manifest['seed']}")
    print(f"  commit de origen: {manifest.get('git_commit', '?')}")

    print("\n1) Hashes del paquete")
    hashes = verify_hashes(folder, manifest)
    for name, state, _ in hashes:
        print(f"   {name:<22} {state}")
    hashes_ok = all(ok for *_, ok in hashes)

    print(f"\n2) Evaluación en {a.pistas} pistas del examen")
    version, ev = evaluate_package(folder, a.pistas)
    saved = json.loads((folder / "evaluation.json").read_text(encoding="utf-8"))["normal"]["cases"][: a.pistas]
    same = True
    for now, old in zip(ev["cases"], saved):
        match = now["success"] == old["success"] and now["accidents"] == old["accidents"] and abs(now["time_s"] - old["time_s"]) < 1e-6
        same &= match
        print(f"   pista {now['layout_seed']}: {'llega' if now['success'] else 'no llega'} · {now['accidents']} choques · "
              f"{now['time_s']:.2f} s   (guardado: {old['time_s']:.2f} s, {old['accidents']} choques) {'OK' if match else 'DISTINTO'}")
    ok = hashes_ok and same
    print(f"\nResultado: {'RECUPERADO · idéntico a la versión entregada' if ok else 'NO coincide: revisar versión del ambiente y dependencias'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
