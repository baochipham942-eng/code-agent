# D3 seatbelt trial record

Host metadata and the complete probe capture from the real unattended macOS worker follow. The fenced blocks preserve raw command output; temporary paths are the real paths resolved below the worker's `$TMPDIR`.

## Host metadata and raw probe capture

```text
$ sw_vers
ProductName:	macOS
ProductVersion:	27.0.1
BuildVersion:	26A434
$ uname -m
arm64
$ bash scripts/sandbox-escalate-dir-seatbelt-probe.sh

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/treatment/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/treatment/new/a/b/f
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END TREATMENT missing directory (grant, create then write inside and below) ===

=== CONTROL existing directory (grant, write and mkdir below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/control/old"))
COMMAND:
/bin/sh -c set -e; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/control/old/f; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/control/old/sub
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END CONTROL existing directory (grant, write and mkdir below) ===

=== NEGATIVE no grant (mkdir must be denied) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/negative/none
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/negative/none: Operation not permitted
=== END NEGATIVE no grant (mkdir must be denied) ===

=== SIBLING mkdir outside granted subtree (must be denied) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/sibling
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/sibling: Operation not permitted
=== END SIBLING mkdir outside granted subtree (must be denied) ===

=== SIBLING parent traversal write (must be denied) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/new/../escape
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
/bin/sh: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/new/../escape: Operation not permitted
=== END SIBLING parent traversal write (must be denied) ===

=== SYMLINK grant in symlink spelling (parent symlink) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/symlink/link-spelling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/symlink/link-spelling/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/symlink/link-spelling/new/f
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/symlink/link-spelling/new: Operation not permitted
=== END SYMLINK grant in symlink spelling (parent symlink) ===

=== SYMLINK grant in realpath spelling (parent symlink) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/symlink/real-target/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/symlink/real-target/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/symlink/real-target/new/f
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END SYMLINK grant in realpath spelling (parent symlink) ===
```

## Mutation and restore capture

The working script was copied to a temporary backup, its dynamic grant assignment was replaced with an empty grant line, the treatment was rerun, and the script was restored with `cp <temporary-backup> scripts/sandbox-escalate-dir-seatbelt-probe.sh`.

```text
=== MUTATION CHECK: remove grant line from working script ===
$ python3 mutation: replace dynamic grant line with an empty grant line
$ bash scripts/sandbox-escalate-dir-seatbelt-probe.sh --case treatment

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.clyjgi/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.clyjgi/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.clyjgi/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.clyjgi/treatment/new/a/b/f
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.clyjgi/treatment/new: Operation not permitted
=== END TREATMENT missing directory (grant, create then write inside and below) ===
MUTATION_EXIT_CODE: 0
=== RESTORE CHECK: restore script from backup copy ===
$ cp <temporary-backup> scripts/sandbox-escalate-dir-seatbelt-probe.sh
$ bash scripts/sandbox-escalate-dir-seatbelt-probe.sh --case treatment

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.P9OGPl/treatment/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.P9OGPl/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.P9OGPl/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.P9OGPl/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.P9OGPl/treatment/new/a/b/f
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END TREATMENT missing directory (grant, create then write inside and below) ===
RESTORE_EXIT_CODE: 0
```

## Recorded outcomes (raw lines, labelled)

- TREATMENT allowed: `EXIT_CODE: 0`
- CONTROL allowed: `EXIT_CODE: 0`
- NEGATIVE denied, raw stderr: `mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/negative/none: Operation not permitted`
- SIBLING mkdir denied, raw stderr: `mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/sibling: Operation not permitted`
- SIBLING parent-traversal write denied, raw stderr: `/bin/sh: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/sibling/new/../escape: Operation not permitted`
- SYMLINK spelling denied, raw stderr: `mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.I6o2xJ/symlink/link-spelling/new: Operation not permitted`
- SYMLINK realpath spelling allowed: `EXIT_CODE: 0`
- MUTATION with the grant line removed denied, raw stderr: `mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.clyjgi/treatment/new: Operation not permitted`
- RESTORE from the backup copy allowed: `EXIT_CODE: 0`

The symlink result is therefore realpath spelling only: a grant written through the symlink spelling did not match, while the canonical parent spelling did.

## Fresh rerun capture (2026-10-11, after rebase)

The following block is the complete raw output from a fresh invocation on this worker, including host metadata and every case. Temporary paths are resolved below the real `$TMPDIR` by the probe.

```text
$ sw_vers
ProductName:		macOS
ProductVersion:		27.0.1
BuildVersion:		26A434
$ uname -m
arm64
$ bash scripts/sandbox-escalate-dir-seatbelt-probe.sh

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/treatment/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/treatment/new/a/b/f
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END TREATMENT missing directory (grant, create then write inside and below) ===

=== CONTROL existing directory (grant, write and mkdir below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/control/old"))
COMMAND:
/bin/sh -c set -e; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/control/old/f; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/control/old/sub
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END CONTROL existing directory (grant, write and mkdir below) ===

=== NEGATIVE no grant (mkdir must be denied) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/negative/none
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/negative/none: Operation not permitted
=== END NEGATIVE no grant (mkdir must be denied) ===

=== SIBLING mkdir outside granted subtree (must be denied) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/sibling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/sibling/sibling
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/sibling/sibling: Operation not permitted
=== END SIBLING mkdir outside granted subtree (must be denied) ===

=== SIBLING parent traversal write (must be denied) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/sibling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/sibling/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/sibling/new/../escape
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
/bin/sh: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/sibling/new/../escape: Operation not permitted
=== END SIBLING parent traversal write (must be denied) ===

=== SYMLINK grant in symlink spelling (parent symlink) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/symlink/link-spelling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/symlink/link-spelling/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/symlink/link-spelling/new/f
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/symlink/link-spelling/new: Operation not permitted
=== END SYMLINK grant in symlink spelling (parent symlink) ===

=== SYMLINK grant in realpath spelling (parent symlink) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/symlink/real-target/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/symlink/real-target/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.cFSdLj/symlink/real-target/new/f
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END SYMLINK grant in realpath spelling (parent symlink) ===
```

### Fresh mutation and restore capture

The script was copied to `$HOME/work/out/N-SANDBOX-ESCALATE-DIR-SEATBELT/probe-backup-current.sh`, its dynamic grant assignment was replaced by an empty grant line, treatment was rerun, and the backup copy was restored with `cp`.

Mutation raw output:

```text

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.Hhn5Xu/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.Hhn5Xu/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.Hhn5Xu/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.Hhn5Xu/treatment/new/a/b/f
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.Hhn5Xu/treatment/new: Operation not permitted
=== END TREATMENT missing directory (grant, create then write inside and below) ===
```

Restore raw output:

```text

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.4BQTh5/treatment/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.4BQTh5/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.4BQTh5/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.4BQTh5/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.4BQTh5/treatment/new/a/b/f
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END TREATMENT missing directory (grant, create then write inside and below) ===
```
