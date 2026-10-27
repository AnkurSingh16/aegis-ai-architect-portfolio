# First-time macOS Apple Silicon setup

This repository already exists at https://github.com/AnkurSingh16/aegis-ai-architect-portfolio. Its public `main` originally had only a README, so clone it rather than creating a different remote.

## 1. Confirm architecture and tools

Open macOS **Terminal** (Finder > Applications > Utilities > Terminal):

```bash
uname -m
node --version
npm --version
git --version
code --version
```

`uname -m` should print `arm64`. You have installed Node and VS Code, so keep them. Choose Node **24 LTS** for stable dependency compatibility, even if your latest Node installation is 26. The repo's `.nvmrc` documents the selected version. You can manage Node versions with `fnm`.

If required, install Apple's command line tools:

```bash
xcode-select --install
```

Homebrew: see https://brew.sh and follow the current official instructions.

```bash
brew install gh git fnm
```

Add this **once** to your `~/.zshrc` (after Homebrew is usable):

```bash
eval "$(fnm env --use-on-cd --shell zsh)"
```

Open a **new** Terminal, then:

```bash
fnm install 24
fnm default 24
node --version
```

## 2. Connect GitHub

```bash
gh auth login
```

Choose GitHub.com > HTTPS > browser login > YES to authenticate Git. Do not paste tokens into any chat. Verify:

```bash
gh auth status
```

## 3. Clone the repository and apply this starter

```bash
mkdir -p ~/Developer
cd ~/Developer
gh repo clone AnkurSingh16/aegis-ai-architect-portfolio
cd aegis-ai-architect-portfolio
```

Copy this starter zip's files into the cloned repository (the download is prepared with paths rooted at the repository's top level). The initial repository README will be replaced by a more useful README. In the repo directory:

```bash
unzip -o ~/Downloads/Aegis_AI_Mac_Starter_Kit.zip
```

Replace that file path with the actual location of the downloaded zip, if different.

## 4. Install dependencies and run

```bash
npm install
npm run dev
```

Visit http://localhost:5173. Keep Terminal open while working. The API will run on http://localhost:4000/api/health. Press Ctrl+C to stop both servers.

## 5. Inspect tests, quality and coverage

Open a **second Terminal** in the same directory:

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
open apps/api/coverage/index.html
open apps/web/coverage/index.html
```

These reports are measured test coverage (not an AI estimate). Failing checks must be fixed before merging.

## 6. Install Codex

```bash
npm install -g @openai/codex
codex
```

Choose **Sign in with ChatGPT** during first run; start in this repository directory. Alternatively install the official Codex extension from the VS Code Marketplace. Codex picks up `AGENTS.md`, `.codex/config.toml` and `.codex/agents/*.toml`. The six specialist agents are instructions and roles, not six automatic always-on API calls.

Try this first prompt:

> Explore this repo and explain its API/web startup in beginner-friendly steps. Ask architect and challenger to evaluate the next vertical slice, then report their short decision. Make no edits yet.

Ask Codex to run `/status` and `/permissions` to inspect session settings. Do not give blanket write access to your home directory, GitHub main branch or cloud infrastructure.

## 7. Commit to a feature branch

Set Git commit identity once (use your own verified GitHub email or private noreply address):

```bash
git config --global user.name "Ankur Pawar"
git config --global user.email "YOUR-GITHUB-EMAIL"
```


```bash
git status
git switch -c chore/initial-monorepo
npm run lint && npm run typecheck && npm run test:coverage && npm run build
git add .
git diff --cached --stat
git commit -m "chore: bootstrap Aegis AI monorepo and agents"
git push -u origin chore/initial-monorepo
gh pr create --base main --fill
```

Review CI in GitHub. Merge only after the checks are green; use the GitHub web interface for initial PR approval. The `npm install` step creates `package-lock.json`, required for deterministic `npm ci` in CI.

## 8. Later: mobile, storage and deployment

1. Start Expo only after selecting iOS Simulator or physical iPhone. See `docs/REACT-NATIVE-SETUP.md`.
2. Optional: Docker Desktop or another Docker-compatible engine, then `docker compose up -d` to start PostgreSQL + pgvector. Neither is required for the first run.
3. Terraform is a preview-only template; it must be reviewed for AWS costs, IAM, remote state, teardown and environment segregation before applying.
4. Deploy the **static** React portfolio website first (e.g., Vercel), then the secure API and data layer after Auth0, rate-limits, tenant isolation and production monitoring are implemented.

## Troubleshooting

- `code: command not found`: VS Code Command Palette > `Shell Command: Install 'code' command in PATH`.
- `gh: command not found`: reinstall GitHub CLI via `brew install gh`, reopen Terminal.
- `codex: command not found`: check global npm prefix and restart Terminal.
- `EADDRINUSE`: port 4000/5173 is already occupied; close other dev servers.
- Web shows "API offline": run `npm run dev` from the repo root; check http://localhost:4000/api/health.
- `npm ci` fails in GitHub: verify the generated `package-lock.json` was committed.
