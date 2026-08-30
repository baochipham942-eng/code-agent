# Internal Evaluation Center

This private package owns Neo's evaluation runner, replay explorer, trajectory attribution,
evaluation UI, and eval/trajectory scripts. It is distributed only through the internal
dogfood channel and its manifest requires administrator installation.

The default application bundle must not import this directory. User feedback submission,
telemetry preferences, telemetry health, and diagnostic/log export remain in the core app.

## Known limitation

The checked-in `index.cjs` is the sandboxed lifecycle entry used by the manual package
installer. Host and renderer assets are built by the internal distribution pipeline; they
are intentionally absent from the default release artifacts.
