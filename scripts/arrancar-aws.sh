#!/bin/bash
# Arranque en AWS: lee la clave del modelo desde Parameter Store (SecureString) y
# levanta el contenedor con ella en el entorno. La clave no se escribe en disco ni
# en el repositorio; la instancia la obtiene con un rol que solo puede leer ese parámetro.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-us-east-1}"
PARAMETRO="${PARAMETRO_CLAVE:-/reto-03/KIMI_API_KEY}"

KIMI_API_KEY="$(aws ssm get-parameter --region "$REGION" --name "$PARAMETRO" --with-decryption --query Parameter.Value --output text)"
export KIMI_API_KEY

docker compose up -d --no-build --force-recreate
