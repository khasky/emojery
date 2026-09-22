<!-- The title is what lands on main: a squash merge takes it verbatim, so it follows the
     commit convention in CONTRIBUTING.md and carries no count of what changed.

     Keep the four sections. Write prose, not a form. Each heading takes a short lead
     before any bullets, and that lead says what kind of thing the section holds rather
     than summarizing its own list. Delete a comment once its section is written. -->

## Summary

<!-- What the change does, and how. Open on the change rather than on the breakage, and
     name the things it touches instead of counting them. Link an issue with "Closes #123". -->

## Problem

<!-- What led to the change, how it surfaced, and why nothing caught it earlier. The last
     part is the one a reviewer cannot reconstruct: a check that agreed with the defect, a
     value with nothing comparing it against its twin, a path no lane reaches.
     One bullet per item once there is more than one. -->

## Verification

<!-- What was run and what it showed. Leave out the gate that runs on every pull request
     anyway; state the check that had to be written, the regression test made to fail
     before the fix, the probe constructed to settle a question. A new site adapter has its
     own list of steps in docs/adding-a-site.md. -->

## Confidence

<!-- What is still unproven and what a mistake there would cost: a lane that could not run
     here, a surface only a signed-in browser reaches, an assumption the change rests on.
     A description that claims nothing is left is the one nobody believes. -->
