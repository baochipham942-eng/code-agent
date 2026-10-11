# D3 seatbelt trial record

Host metadata and the complete probe capture from the real unattended macOS worker follow. The fenced block is the raw command output; temporary paths are the real paths resolved below the worker's `$TMPDIR`.

## Host metadata and raw probe capture

```text
$ sw_vers
ProductName:		macOS
ProductVersion:		27.0.1
BuildVersion:		26A434
$ uname -m
arm64
$ ./scripts/sandbox-escalate-dir-seatbelt-probe.sh

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/treatment/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/treatment/new/a/b/f
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
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/control/old"))
COMMAND:
/bin/sh -c set -e; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/control/old/f; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/control/old/sub
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
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/negative/none
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/negative/none: Operation not permitted
=== END NEGATIVE no grant (mkdir must be denied) ===

=== SIBLING mkdir outside granted subtree (must be denied) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/sibling
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/sibling: Operation not permitted
=== END SIBLING mkdir outside granted subtree (must be denied) ===

=== SIBLING parent traversal write (must be denied) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/new/../escape
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
/bin/sh: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/new/../escape: Operation not permitted
=== END SIBLING parent traversal write (must be denied) ===

=== SYMLINK grant in symlink spelling (parent symlink) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/symlink/link-spelling/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/symlink/link-spelling/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/symlink/link-spelling/new/f
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/symlink/link-spelling/new: Operation not permitted
=== END SYMLINK grant in symlink spelling (parent symlink) ===

=== SYMLINK grant in realpath spelling (parent symlink) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/symlink/real-target/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/symlink/real-target/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/symlink/real-target/new/f
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END SYMLINK grant in realpath spelling (parent symlink) ===

=== MUTATION CHECK: remove grant line from working script ===
$ cp scripts/sandbox-escalate-dir-seatbelt-probe.sh <temporary-backup>
$ python3 mutation: replace dynamic grant line with an empty grant line
$ ./scripts/sandbox-escalate-dir-seatbelt-probe.sh --case treatment

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.JZCGq9/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.JZCGq9/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.JZCGq9/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.JZCGq9/treatment/new/a/b/f
EXIT_CODE: 1
STDOUT (raw):
(empty)
STDERR (raw):
mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.JZCGq9/treatment/new: Operation not permitted
=== END TREATMENT missing directory (grant, create then write inside and below) ===

=== RESTORE CHECK: restore script from backup copy ===
$ cp <temporary-backup> scripts/sandbox-escalate-dir-seatbelt-probe.sh
$ ./scripts/sandbox-escalate-dir-seatbelt-probe.sh --case treatment

=== TREATMENT missing directory (grant, create then write inside and below) ===
PROFILE:
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.ROv433/treatment/new"))
COMMAND:
/bin/sh -c set -e; mkdir /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.ROv433/treatment/new; echo x > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.ROv433/treatment/new/f; mkdir -p /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.ROv433/treatment/new/a/b; echo y > /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.ROv433/treatment/new/a/b/f
EXIT_CODE: 0
STDOUT (raw):
(empty)
STDERR (raw):
(empty)
=== END TREATMENT missing directory (grant, create then write inside and below) ===

```

## Recorded outcomes (raw lines, labelled)

- TREATMENT allowed: `EXIT_CODE: 0`
- CONTROL allowed: `EXIT_CODE: 0`
- NEGATIVE denied, raw stderr: `mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/negative/none: Operation not permitted`
- SIBLING mkdir denied, raw stderr: `mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/sibling: Operation not permitted`
- SIBLING parent-traversal write denied, raw stderr: `/bin/sh: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/sibling/new/../escape: Operation not permitted`
- SYMLINK spelling denied, raw stderr: `mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.QaYI9N/symlink/link-spelling/new: Operation not permitted`
- SYMLINK realpath spelling allowed: `EXIT_CODE: 0`
- MUTATION with the grant line removed denied, raw stderr: `mkdir: /private/var/folders/13/fzr7_7vd25zfb_608yrj8h240000gn/T/sandbox-escalate-dir-seatbelt.JZCGq9/treatment/new: Operation not permitted`
- RESTORE from the backup copy allowed: `EXIT_CODE: 0`

The symlink result is therefore realpath spelling only: a grant written through the symlink spelling did not match, while the canonical parent spelling did.
