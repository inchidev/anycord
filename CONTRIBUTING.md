# Contributing to Anycord

Create a feature branch and open a PR targeting `main`. Do not push changes directly to main. The required `check` job runs the shared contracts, isolation/draft/navigation checks and production build. Use a disposable local installation for behavioral validation. Isolated hosted PR previews are tracked in #2 and are not available yet.

Merging a PR updates source only. Publishing a stable version and promoting it to the reference production installation are separate manual workflows. Independently hosted installations update only when their owner chooses a published version.

See [release and recovery procedures](docs/releases.md).
