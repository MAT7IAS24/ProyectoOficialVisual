"""Publica una corrida en un repositorio privado de Hugging Face."""

import argparse
import json
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.errors import RepositoryNotFoundError


def main() -> None:
    parser = argparse.ArgumentParser(description="Publicar una tabla Q versionada en Hugging Face")
    parser.add_argument("model_dir", type=Path, help="Directorio models/<id> de una corrida")
    parser.add_argument("--repo-id", required=True, help="Repositorio Hugging Face usuario/nombre")
    args = parser.parse_args()
    metadata = json.loads((args.model_dir / "metadata.json").read_text(encoding="utf-8"))
    for name in ("q_table.npy", "README.md"):
        if not (args.model_dir / name).is_file():
            raise FileNotFoundError(args.model_dir / name)
    api = HfApi()
    api.whoami()  # Fallar antes de crear nada si no hay credenciales válidas.
    try:
        info = api.repo_info(args.repo_id, repo_type="model")
    except RepositoryNotFoundError:
        api.create_repo(args.repo_id, repo_type="model", private=True, exist_ok=False)
    else:
        if not info.private:
            raise ValueError("El repositorio ya existe y es público; usa uno privado para esta publicación.")
    commit = api.upload_folder(repo_id=args.repo_id, repo_type="model", folder_path=args.model_dir, path_in_repo=f"runs/{metadata['experiment_id']}", commit_message=f"Add rally run {metadata['experiment_id']}")
    print(f"Modelo publicado: {commit.commit_url}")


if __name__ == "__main__":
    main()
