// Temporal model (Alloy 6 `var`): a set of "active" atoms that grows over time.
// Open Cope and Drag, then use the TIME panel (right edge) to step through trace
// states; "Next" fetches a different trace. (Top-level `var sig` — not an `in`
// subset sig, which the current Cope and Drag build can't parse.)
var sig Active {}

pred grow {
  one Active                     -- start with a single active atom
  always (Active in Active')     -- the active set only ever grows
  eventually (#Active > 1)       -- and it does grow
}

run grow for 4 but exactly 5 steps
