#!/bin/sh
# Set an issue's Status on the "workadventurer board" (github.com/users/campey/projects/1).
#
#   scripts/board-status.sh <issue-number> [todo|in-progress|done]   (default: in-progress)
#
# Adds the issue to the board first if it isn't there. Needs the `project` scope:
#   gh auth refresh -h github.com -s project
# Closing an issue moves it to Done on its own; the only manual transition is
# starting work (Todo -> In Progress), per CLAUDE.md.
set -e
n=${1:?usage: board-status.sh <issue-number> [todo|in-progress|done]}
case "${2:-in-progress}" in
  todo) option=f75ad846 ;;
  in-progress) option=47fc9ee4 ;;
  done) option=98236657 ;;
  *) echo "unknown status '$2' (todo|in-progress|done)" >&2; exit 2 ;;
esac
PROJECT=PVT_kwHOABI3hM4BmDEC
FIELD=PVTSSF_lAHOABI3hM4BmDECzhktj94
# item-add is idempotent: it returns the existing item if the issue is already on the board.
id=$(gh project item-add 1 --owner campey --url "https://github.com/campey/workadventurer/issues/$n" --format json -q .id)
gh project item-edit --id "$id" --project-id "$PROJECT" --field-id "$FIELD" --single-select-option-id "$option" >/dev/null
echo "#$n -> ${2:-in-progress}"
