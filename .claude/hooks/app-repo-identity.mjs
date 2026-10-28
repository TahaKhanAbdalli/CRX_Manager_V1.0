// The CRX Manager app repository's GitHub identity, in one place.
//
// The repo is moving from Mason's personal account (`masonwells1`) to the
// `croprxsolutions` organization so an outside developer can have read-only
// access (docs/operations/github-org-move.md). Both owners are listed so the
// guards keep full strength on either side of the move: a push, merge or waiver
// check that knew only the old owner would read the moved repo as "some other
// repository" and skip its gate. Listing an owner here only ever gates MORE, so
// the old owner stays listed after the move.
export const APP_REPO_NAME = "CRX_Manager_V1.0";
export const APP_REPO_OWNERS = Object.freeze(["masonwells1", "croprxsolutions"]);
// `owner/name`, lowercased (GitHub compares both case-insensitively).
export const APP_REPO_PATHS = Object.freeze(
  APP_REPO_OWNERS.map((owner) => `${owner}/${APP_REPO_NAME}`.toLowerCase()),
);

export const isAppRepoPath = (ownerSlashName) =>
  APP_REPO_PATHS.includes(String(ownerSlashName ?? "").toLowerCase());
