# Canvas Studio monorepo

Canvas Studio’s public-site code is maintained in this single repository. The main creator, prompt library, and workflow-template pages live in `studio/`; the Random Workshop lives in `random-studio/`. They remain separate app entry points because they have different generation workflows, but their source, review history, and release changes are managed together here.

## Layout

- `studio/` — primary image-creation app and its prompt/template subpages.
- `random-studio/` — random-generation workshop, prompt pools, LoRA controls, and its workflow-template page.
- `outputs/`, `work/`, `random-studio/data/` — local/runtime data; intentionally excluded from version control.

The standalone Anima Tools page has been removed from the Random Workshop navigation. Its old page URL redirects to the workshop home. The workshop’s own generation, prompt-pool, and LoRA-management APIs remain available.

## Local checks

Run the main app using its existing `studio/` instructions, or the workshop using `random-studio/README.md`. Python tests for the workshop are in `random-studio/tests/`. Do not add model weights, generated images, credentials, local encryption keys, or runtime databases to the repository.

The server’s services are intentionally left stopped; updating source does not start them or change their boot behavior.
