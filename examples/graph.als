// Static model: a small directed graph. Use "Open Cope and Drag" (graph icon),
// then the Next button in the graph header to enumerate instances.
sig Node { edges: set Node }
pred show { some edges and no (iden & edges) }   -- some edges, no self-loops
run show for 4
