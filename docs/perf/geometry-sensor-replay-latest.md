# geometry-sensor historical replay

generatedAt: 2026-09-25T10:38:07.431Z
repeats: 5
harnessRoot: .

# N-EVAL-CASELIST-STICKY-PAD (PR #1844)
pre-fix: 5d67be41edd8b1c68e3a5b3e81e2c0a8f0e3cbcd
fix: 756e44763bb3fae12badea5662399f61325a0627
probe: sticky-header on caselist

## N-EVAL-CASELIST-STICKY-PAD pre-fix

expected: red 5/5
actual: red 5/5 (PASS)

- repeat 1: RED kinds=["sticky-header"] sticky-header: row content is painted 8.0px above sticky header
- repeat 2: RED kinds=["sticky-header"] sticky-header: row content is painted 8.0px above sticky header
- repeat 3: RED kinds=["sticky-header"] sticky-header: row content is painted 8.0px above sticky header
- repeat 4: RED kinds=["sticky-header"] sticky-header: row content is painted 8.0px above sticky header
- repeat 5: RED kinds=["sticky-header"] sticky-header: row content is painted 8.0px above sticky header

## N-EVAL-CASELIST-STICKY-PAD fix

expected: green 5/5
actual: green 5/5 (PASS)

- repeat 1: GREEN kinds=[]
- repeat 2: GREEN kinds=[]
- repeat 3: GREEN kinds=[]
- repeat 4: GREEN kinds=[]
- repeat 5: GREEN kinds=[]

# N-SCROLLGUTTER (PR #1251)
pre-fix: d1ddbdfb5d0f293fbe358657a8f7ee0afe11523c
fix: 1cd157912e59b5567f74a7286ec66c4b36a95453
probe: right-overhang on sidebar

## N-SCROLLGUTTER pre-fix

expected: red 5/5
actual: red 5/5 (PASS)

- repeat 1: RED kinds=["right-overhang"] right-overhang: content-box right overhangs [data-testid="sidebar-capability-zone"] by 6.0px
- repeat 2: RED kinds=["right-overhang"] right-overhang: content-box right overhangs [data-testid="sidebar-capability-zone"] by 6.0px
- repeat 3: RED kinds=["right-overhang"] right-overhang: content-box right overhangs [data-testid="sidebar-capability-zone"] by 6.0px
- repeat 4: RED kinds=["right-overhang"] right-overhang: content-box right overhangs [data-testid="sidebar-capability-zone"] by 6.0px
- repeat 5: RED kinds=["right-overhang"] right-overhang: content-box right overhangs [data-testid="sidebar-capability-zone"] by 6.0px

## N-SCROLLGUTTER fix

expected: green 5/5
actual: green 5/5 (PASS)

- repeat 1: GREEN kinds=[]
- repeat 2: GREEN kinds=[]
- repeat 3: GREEN kinds=[]
- repeat 4: GREEN kinds=[]
- repeat 5: GREEN kinds=[]
