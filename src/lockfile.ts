/** The update commit waits on this branch until the workflow has added the matching lockfile. */
export const LOCK_BRANCH = "emdash-update-lockfile";
export const WORKFLOW_PATH = ".github/workflows/emdash-updater-lockfile.yml";

export const LOCKFILES = {
	"package-lock.json": "npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
	"pnpm-lock.yaml": "pnpm install --lockfile-only --ignore-scripts",
	"yarn.lock": "yarn install --mode update-lockfile",
	"bun.lock": "bun install --lockfile-only --ignore-scripts",
} as const;

export type Lockfile = keyof typeof LOCKFILES;

export const WORKFLOW = `name: EmDash updater lockfile
on:
  push:
    branches: [${LOCK_BRANCH}]
permissions:
  contents: write
jobs:
  lockfile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable
      - name: Update the lockfile
        run: |
          if [ -f pnpm-lock.yaml ]; then ${LOCKFILES["pnpm-lock.yaml"]}
          elif [ -f yarn.lock ]; then ${LOCKFILES["yarn.lock"]}
          elif [ -f bun.lock ]; then npm i -g bun && ${LOCKFILES["bun.lock"]}
          else ${LOCKFILES["package-lock.json"]}; fi
      - name: Commit the lockfile
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          for f in package-lock.json pnpm-lock.yaml yarn.lock bun.lock; do [ -f "$f" ] && git add "$f"; done
          git commit --allow-empty -m "Update the lockfile for the EmDash update"
          git push
`;
