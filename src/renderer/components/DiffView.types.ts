export interface DiffViewProps {
  oldText: string;
  newText: string;
  fileName?: string;
  className?: string;
  stats?: { added: number; removed: number };
}

export interface CodeMirrorDiffViewProps extends DiffViewProps {
  labels: {
    noChanges: string;
    unified: string;
    split: string;
    collapseUnchanged: string;
    expandUnchanged: string;
    inlineChanges: string;
    lineChanges: string;
    readOnlyAria: string;
  };
}
