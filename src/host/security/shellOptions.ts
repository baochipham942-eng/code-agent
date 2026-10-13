// Scanner for bash/sh/zsh/dash startup-option words, probed on real shells (FB-330):
//   - zsh reads an attached value (`zsh -opipefail -c '…'` runs the script), bash/sh take the
//     NEXT word as the -o/-O value and then die on it (`bash -oposix -c '…'` errors before
//     running anything). Reading attached values keeps both safe: the zsh script keeps its
//     targets, the bash spelling over-reports a script that never runs.
//   - `c` never carries an attached value (`bash -cecho AAA` makes the trailing `o` of the
//     cluster eat `AAA` as an option name, on zsh too): the command string is always the word
//     after the cluster.
//   - `+x`-style boolean clusters are legal on all four shells (unset the flag), so both signs
//     are accepted for flag letters.
//   - Almost any letter is a legal zsh flag (probed: `zsh -dc`/`-Zc`/`+dc` really run the script;
//     bash/sh/dash reject the unknown letter and exit before running anything), and no letter but
//     `o`/`O` takes a value. A cluster with an unknown letter before a `c` is therefore treated as
//     command-carrying: exact on zsh, safe over-report elsewhere.
// A word the scanner cannot classify is returned as `unknownOption`: the caller must mark the
// command uncertain instead of dropping the inner script's write targets on the floor.

const FLAG_LETTERS = new Set('abefhiklmnprstuvxBCEHPT'.split(''));
// Startup options whose value may attach to the option word (-oposix) or follow as the next
// word (-o posix). `c` is handled separately: its value is the command string.
const VALUE_LETTERS = new Set(['o', 'O']);
const BOOLEAN_LONG_OPTIONS = new Set([
  '--norc', '--noprofile', '--posix', '--restricted', '--verbose', '--login',
]);
const VALUE_LONG_OPTIONS = new Set(['--rcfile', '--init-file']);

export type ShellScriptLookup =
  | { command: string }
  | { scriptIndex: number }
  | { unknownOption: string };

export function shellScript(args: string[]): ShellScriptLookup | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return index + 1 < args.length ? { scriptIndex: index + 1 } : null;
    if (!arg.startsWith('-') && !arg.startsWith('+')) return { scriptIndex: index };
    if (arg === '-') return null;
    if (arg.startsWith('--')) {
      const [name, attached] = arg.split('=', 2);
      if (VALUE_LONG_OPTIONS.has(name)) {
        if (attached !== undefined) continue;
        // Missing value is a usage error: the shell exits before running anything.
        if (args[index + 1] === undefined) return null;
        index += 1;
        continue;
      }
      if (attached === undefined && BOOLEAN_LONG_OPTIONS.has(name)) continue;
      return { unknownOption: arg };
    }
    const letters = arg.slice(1);
    for (let position = 0; position < letters.length; position += 1) {
      const letter = letters[position];
      if (letter === 'c' && arg.startsWith('-')) {
        return args[index + 1] === undefined ? null : { command: args[index + 1] };
      }
      if (VALUE_LETTERS.has(letter)) {
        // Attached value ends the cluster; otherwise the next word is the value.
        if (letters.length > position + 1) break;
        if (args[index + 1] === undefined) return null;
        index += 1;
        break;
      }
      if (!FLAG_LETTERS.has(letter)) {
        // Unknown letter with a `c` strictly after it: `zsh -dc '…'` really runs, bash/sh/dash die
        // on the unknown letter first — read the command string (safe over-report). A `c` AT the
        // unknown letter keeps the word unclassified (bare `+c` stays unknownOption).
        if (letters.slice(position + 1).includes('c')) {
          return args[index + 1] === undefined ? null : { command: args[index + 1] };
        }
        return { unknownOption: arg };
      }
    }
  }
  return null;
}

// True when `word` is a short option cluster that may be followed by the command string. This is
// the launcher scan's recall side: a `c` inside an option value (`-Ocheckwinsize`) never counts
// and a value letter seen first (`-opipefail`) means any later `c` belongs to the value, but a
// letter outside the flag set may still be a real flag (zsh accepts nearly all, e.g. `-dc`), so
// the answer is yes and the strict, fail-closed classification is left to shellScript().
export function isShellCommandOption(word: string): boolean {
  if ((!word.startsWith('-') && !word.startsWith('+')) || word.startsWith('--') || word.length < 2) {
    return false;
  }
  const letters = word.slice(1);
  for (let position = 0; position < letters.length; position += 1) {
    const letter = letters[position];
    if (letter === 'c' && word.startsWith('-')) return true;
    if (VALUE_LETTERS.has(letter)) return false;
    if (!FLAG_LETTERS.has(letter)) return true;
  }
  return false;
}
