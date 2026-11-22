# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gitdivian/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gitdivian/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It reads a patch written by an AI
agent — a unified diff (even with wrong line numbers), a set of SEARCH/REPLACE
blocks, a V4A patch, or JSON tool calls — finds the lines each edit names at the
first of three matching tiers (exact, then whitespace-tolerant), and writes every
change or none of them: the tree is updated atomically, and mend prints what
changed or exactly why it failed.

## Run it

```sh
node main.ts patch.txt   # apply the patch file to the current tree
node main.ts < patch.txt # or read the patch from stdin
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=bpbf075h&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
