COMPOSE_PROJECT="${NEXT_NATS_COMPOSE_PROJECT:-next-nats}"
export COMPOSE_FILE="${COMPOSE_FILE:-$MISE_PROJECT_ROOT/devops/docker/compose/compose.yaml}"

compose() {
  docker compose -p "$COMPOSE_PROJECT" "$@"
}
