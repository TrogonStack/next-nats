compose() {
  docker compose -f "$MISE_PROJECT_ROOT/devops/docker/compose/compose.yaml" "$@"
}
