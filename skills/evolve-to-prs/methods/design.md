# Design quality

The owner's bar: clean, calm and intentional, never default and never flashy. A visitor should feel that a
careful designer made every screen. "It works" is not done; "it works and looks considered" is done.

Read the species' `DESIGN.md` first: it holds the product's identity, tokens and component inventory. This file
is the shared standard every species follows.

## Principles

- **Intentional colour.** Neutrals carry the page; the accent marks the one thing to do or the one thing that
  changed, and means the same everywhere. Semantic colours (success, warning, danger) only for state. Use the
  existing tokens; add a token instead of a one-off hex.
- **Hierarchy through type and space, not boxes.** One clear focal point per screen. Use the type scale and the
  spacing scale from DESIGN.md; align to a grid; let things breathe. Fewer borders and cards, more whitespace.
- **Every control is designed.** Never ship an unstyled browser default where a person interacts with it: no raw
  `<input type="color">`, file input, range slider, select, checkbox or radio. Build a component that fits the
  product (and stays accessible: real form controls underneath, keyboard, labels, focus ring).
  - Colour: a row of curated swatches that suit the use (e.g. print-safe colours for QR codes) + a "custom" swatch
    that opens a small popover with a saturation/brightness area, hue slider and hex field; current value shown
    as a swatch with its hex. Warn about poor contrast where it matters.
  - Choice between a few options: a segmented control or option cards with a small preview, not a dropdown.
  - File upload: a drop zone with an icon, a clear call to action, accepted types, and a thumbnail after upload.
  - Sliders: a styled track and thumb with the current value shown.
- **All the states.** Hover, focus-visible, active, disabled, loading, empty, error and success are each designed.
  Empty states invite the next action. Errors say what happened and how to fix it, next to the field.
- **Previews over descriptions.** Show the result live (the QR code, the resume page, the wall) and let options
  show what they do (template thumbnails, style swatches rendered on the real content).
- **Small, deliberate motion.** 120–200 ms transitions on state changes; one moment of delight at most (e.g. the
  result appearing). Respect `prefers-reduced-motion`.
- **Mobile is a first-class layout**, not a squeezed desktop: thumb-reachable primary action, 44 px targets,
  no horizontal scroll.
- **Icons**: one consistent inline-SVG set (stroke width and size), used sparingly, always with a label.

## Never

Purple-to-blue (or any decorative) gradients, glassmorphism, glowing blobs, emoji as icons, drop shadows on
everything, centred walls of text, every section in an identical rounded card, stock "AI startup" hero layouts,
random accent colours per section, ALL-CAPS labels everywhere, lorem-style filler copy, fake testimonials or
fake numbers.

## Learn from good products (adjacent niches count)

Before building a visible feature, look at how two or three well-designed products solve the same interaction
(use web search; describe what you learned in the plan). Good references for calm, precise tools: Linear,
Raycast, Stripe Dashboard and Checkout, Vercel, Figma's colour picker, Things, Notion Calendar, Arc, Tally,
Cal.com, Read.cv, iA Writer, Craft. Learn the principle (spacing, hierarchy, how a control behaves), never copy
their branding or assets.

## Review rubric (reviewers use it; blocking if any line is a clear "no")

1. No unstyled browser-default controls in the changed UI.
2. Uses the species' tokens (colour, type, spacing, radius); no stray one-off values.
3. One clear focal point per screen; hierarchy readable at a glance.
4. Hover, focus, disabled, empty, loading and error states exist where relevant.
5. Looks right at 390 px and 1280 px wide (check screenshots of both).
6. Nothing from the "Never" list.
7. Would a careful designer at a good product company be comfortable shipping it?
