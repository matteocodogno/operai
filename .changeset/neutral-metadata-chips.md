---
"@operai/refund-ui": patch
---

The currency and entity chips are now neutral, so green means one thing again.

Green was doing three jobs at once on a single expense row: marking the
approved amount (where it carries a decision), and colouring the CHF chip and
the WellD CH chip (where it carries nothing). A reader had to learn which of
the three greens mattered. The currency chip also spent three more
meaning-bearing colours — accent, orange, red — on EUR, USD and GBP.

Both chips now render in one neutral tone. Nothing is lost: the ISO code and
the flag-plus-entity-name were always what told the variants apart, and the
suite's own chip convention already pairs several kinds with a single colour,
distinguished by glyph and text. Green is left to mean "approved", and the
accent to mean "interactive".
