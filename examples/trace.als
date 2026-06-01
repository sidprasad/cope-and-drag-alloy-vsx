// Temporal model (Alloy 6 `var`): an activation wave over a fixed node set.
// Active nodes only grow until all are active. Cope and Drag shows the whole
// trace and lets you step through states; "Next" gets a different trace.
sig Node {}
var sig Active in Node {}

pred wave {
  no Active                    -- start: nothing active
  always (Active in Active')   -- activation only grows
  eventually (Active = Node)   -- ends with everything active
}

run wave for exactly 3 Node
